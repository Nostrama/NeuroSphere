(function (root) {
  "use strict";
  const { Neuron, Synapse, DEFAULTS, clamp, distance, localView } = typeof module !== "undefined" && module.exports ? require("./neuron.js") : root.NeuronCore;

  class SeededRandom {
    constructor(seed) { this.state = seed >>> 0; }
    next() {
      this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
      return this.state / 4294967296;
    }
  }

  class ChemicalField {
    constructor() {
      this.spacing = 25;
      this.columns = 41;
      this.rows = 26;
      this.diffusion = 1100;
      this.decay = 0.03;
      this.values = new Float64Array(this.columns * this.rows);
      this.buffer = new Float64Array(this.values.length);
      this.active = false;
    }
    deposit(position, amount) {
      const x = clamp(Math.round(position.x / this.spacing), 0, this.columns - 1);
      const y = clamp(Math.round(position.y / this.spacing), 0, this.rows - 1);
      this.values[y * this.columns + x] += amount;
      this.active = true;
    }
    sample(position) {
      const x = clamp(position.x / this.spacing, 0, this.columns - 1);
      const y = clamp(position.y / this.spacing, 0, this.rows - 1);
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, this.columns - 1), y1 = Math.min(y0 + 1, this.rows - 1);
      const a = x - x0, b = y - y0;
      return (1 - b) * ((1 - a) * this.values[y0 * this.columns + x0] + a * this.values[y0 * this.columns + x1]) +
        b * ((1 - a) * this.values[y1 * this.columns + x0] + a * this.values[y1 * this.columns + x1]);
    }
    step(dt) {
      const coefficient = this.diffusion * dt / this.spacing ** 2;
      const retention = Math.exp(-this.decay * dt);
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.columns; x++) {
          const i = y * this.columns + x;
          const center = this.values[i];
          const left = this.values[y * this.columns + Math.max(0, x - 1)];
          const right = this.values[y * this.columns + Math.min(this.columns - 1, x + 1)];
          const up = this.values[Math.max(0, y - 1) * this.columns + x];
          const down = this.values[Math.min(this.rows - 1, y + 1) * this.columns + x];
          this.buffer[i] = Math.max(0, (center + coefficient * (left + right + up + down - 4 * center)) * retention);
        }
      }
      [this.values, this.buffer] = [this.buffer, this.values];
    }
  }

  // The environment stores positions and samples local space. It never owns a
  // synapse registry, routes spikes, or creates/rebuilds connections.
  class Environment {
    constructor(field) { this.field = field; }
    forNeuron(neuron, frame) {
      const field = this.field;
      return {
        time: field.time,
        features: field.features,
        reward: field.rewardPulse,
        random: () => field.rng.next(),
        sense: () => frame.filter(peer => peer.id !== neuron.id && distance(neuron, peer) <= neuron.radius),
        chemical: position => {
          if (distance(neuron, position) > neuron.radius + 1e-9) throw new Error("Chemical sensing is limited to the cell's radius.");
          return field.features.gradient ? field.chemical.sample(position) : 0;
        },
        secrete: amount => field.chemical.deposit(neuron, amount),
        observe: event => field.observe(event)
      };
    }
  }

  class SpikingField {
    constructor(options = {}) {
      this.seed = options.seed === undefined ? 1 : options.seed;
      if (!Number.isSafeInteger(this.seed) || this.seed < 0 || this.seed > 0xffffffff) throw new Error("Seed must be an unsigned 32-bit integer.");
      this.config = { ...DEFAULTS, ...(options.config || {}) };
      this.features = { hebbian: true, reward: false, gradient: false, ...(options.features || {}) };
      this.width = 1000;
      this.height = 620;
      this.rng = new SeededRandom(this.seed);
      this.time = 0;
      this.tick = 0;
      this.accumulator = 0;
      this.nextId = 1;
      this.neurons = [];
      this.archive = [];
      this.stats = { formed: 0, pruned: 0, deaths: 0, spikes: 0, outputSpikes: 0 };
      this.inputSpikes = [];
      this.outputs = [];
      this.firstDelivery = null;
      this.delivered = new Map();
      this.spikeRecords = new Map();
      this.metrics = [];
      this.events = [];
      this.featureHistory = [{ time: 0, ...this.features }];
      this.newcomerCohort = null;
      this.rewardPulse = 0;
      this.outputRateEMA = 0;
      this.outputSpikesThisTick = 0;
      this.chemical = new ChemicalField();
      this.env = new Environment(this);
      this.onEvent = options.onEvent || (() => {});
      const population = options.population === undefined ? 48 : options.population;
      if (!options.empty) {
        this.addNeuron({ x: 80, y: 310, drivePeriod: options.inputEnabled === false ? null : this.config.inputPeriod });
        this.addNeuron({ x: 920, y: 310, recordOutput: true, secretionRate: 8 });
        for (let index = 0; index < population; index++) {
          let position;
          for (let attempt = 0; attempt < 30; attempt++) {
            position = { x: 150 + this.rng.next() * 700, y: 55 + this.rng.next() * 510 };
            if (this.neurons.every(neuron => distance(neuron, position) > 48)) break;
          }
          this.addNeuron(position);
        }
      }
      this.logMetrics();
    }

    addNeuron(properties) {
      if (this.neurons.length >= 150) throw new Error("The field supports at most 150 live cells.");
      const neuron = new Neuron({ ...properties, id: this.nextId++, config: this.config, bornAt: this.time });
      this.neurons.push(neuron);
      return neuron;
    }
    getNeuron(id) { return this.neurons.find(neuron => neuron.id === id); }
    get input() { return this.neurons.find(neuron => neuron.drivePeriod !== null); }
    get output() { return this.neurons.find(neuron => neuron.recordOutput); }
    // A fresh read-only census for the viewer/observer, never given to a neuron.
    get links() { return this.neurons.flatMap(neuron => neuron.synapses); }

    observe(event) {
      if (event.type === "formed") this.stats.formed++;
      if (event.type === "pruned") this.stats.pruned++;
      if (event.type === "died") this.stats.deaths++;
      if (event.type === "spike") {
        const spike = event.spike;
        this.stats.spikes++;
        const origins = new Set();
        const ancestors = new Set([spike.neuronId]);
        if (spike.driven) {
          origins.add(spike.id);
          this.inputSpikes.push({ id: spike.id, time: spike.time });
        }
        for (const parent of spike.parents) {
          const previous = this.spikeRecords.get(parent.spikeId);
          if (!previous) continue;
          for (const origin of previous.origins) origins.add(origin);
          for (const id of previous.ancestors) ancestors.add(id);
        }
        const record = { ...spike, origins: [...origins].sort(), ancestors: [...ancestors].sort((a, b) => a - b) };
        this.spikeRecords.set(spike.id, record);
        if (event.output) {
          this.stats.outputSpikes++;
          this.outputs.push(record);
          if (origins.size && this.firstDelivery === null) this.firstDelivery = this.time;
          for (const origin of origins) if (!this.delivered.has(origin)) this.delivered.set(origin, this.time);
        }
      }
      this.events.push({ time: this.time, ...event });
      if (this.events.length > 200) this.events.shift();
      this.onEvent(event);
    }

    step() {
      this.tick++;
      this.time = this.tick * this.config.dt;
      const outputsBeforeTick = this.stats.outputSpikes;
      const frame = this.neurons.map(localView);
      for (const neuron of this.neurons) neuron.step(this.config.dt, this.env.forNeuron(neuron, frame));
      if (this.features.gradient || this.chemical.active) this.chemical.step(this.config.dt);
      const live = [];
      for (const neuron of this.neurons) {
        if (neuron.alive) live.push(neuron);
        else this.archive.push(neuron.toJSON());
      }
      this.neurons = live;
      // Broadcast the completed tick's prediction error on the next tick, so
      // every cell sees the same pulse, independent of stepping order.
      this.outputSpikesThisTick = this.stats.outputSpikes - outputsBeforeTick;
      this.rewardPulse = this.outputSpikesThisTick - this.outputRateEMA * this.config.dt;
      const alpha = -Math.expm1(-this.config.dt / this.config.outputRateTau);
      this.outputRateEMA += alpha * (this.outputSpikesThisTick / this.config.dt - this.outputRateEMA);
      if (this.tick % Math.round(10 / this.config.dt) === 0) this.logMetrics();
    }

    advance(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Duration must be a finite nonnegative number.");
      const total = this.accumulator + seconds;
      const steps = Math.floor((total + 1e-10) / this.config.dt);
      this.accumulator = Math.max(0, total - steps * this.config.dt);
      for (let index = 0; index < steps; index++) this.step();
    }

    setFeatures(patch) {
      for (const key of ["hebbian", "reward", "gradient"]) {
        if (key in patch && typeof patch[key] !== "boolean") throw new Error("Feature values must be booleans.");
        if (key in patch) this.features[key] = patch[key];
      }
      this.featureHistory.push({ time: this.time, ...this.features });
    }

    traffic(start = this.time - 60, end = this.time) {
      const outputs = this.outputs.filter(spike => spike.time > start && spike.time <= end);
      const recentOrigins = new Set(this.inputSpikes.filter(spike => spike.time > start && spike.time <= end).map(spike => spike.id));
      const isFresh = spike => spike && spike.origins.some(origin => recentOrigins.has(origin));
      const freshOutputs = outputs.filter(isFresh);
      // Follow only branches connecting recent input origins to each output.
      // A cumulative ancestor union would also admit stale, merged loop branches.
      // Iterative postorder traversal avoids recursion limits on long lineages.
      const memo = new Map();
      const ancestorsFor = output => {
        const stack = [[output, false]];
        while (stack.length) {
          const [spike, expanded] = stack.pop();
          if (!spike || memo.has(spike.id)) continue;
          if (!isFresh(spike)) { memo.set(spike.id, new Set()); continue; }
          if (!expanded) {
            stack.push([spike, true]);
            for (const parent of spike.parents) {
              const previous = this.spikeRecords.get(parent.spikeId);
              if (previous && !memo.has(previous.id)) stack.push([previous, false]);
            }
          } else {
            const ancestors = new Set([spike.neuronId]);
            for (const parent of spike.parents) {
              for (const id of memo.get(parent.spikeId) || []) ancestors.add(id);
            }
            memo.set(spike.id, ancestors);
          }
        }
        return memo.get(output.id) || new Set();
      };
      const counts = new Map();
      for (const spike of freshOutputs) {
        for (const id of ancestorsFor(spike)) counts.set(id, (counts.get(id) || 0) + 1);
      }
      const shares = Object.fromEntries([...counts].sort((a, b) => a[0] - b[0]).map(([id, count]) => [id, count / Math.max(1, freshOutputs.length)]));
      // Each member carries >=80% of fresh-input-descended output spikes on a
      // qualifying causal branch. Shares overlap, rather than partition traffic.
      const inputIds = new Set(this.inputSpikes.map(spike => Number(spike.id.split("/")[0])));
      const outputIds = new Set(this.outputs.map(spike => spike.neuronId));
      const ranked = [...counts].filter(([id]) => !inputIds.has(id) && !outputIds.has(id)).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const core = ranked.filter(([, count]) => freshOutputs.length > 0 && count / freshOutputs.length >= 0.8).map(([id]) => id);
      return { outputCount: outputs.length, freshOutputCount: freshOutputs.length, shares, core: core.sort((a, b) => a - b) };
    }

    measure() {
      const links = this.links;
      const recentInputs = this.inputSpikes.filter(spike => spike.time > this.time - 60 && spike.time <= this.time);
      const deliveredInputCount = recentInputs.filter(spike => this.delivered.has(spike.id)).length;
      const recent = this.traffic();
      const key = JSON.stringify(recent.core);
      const history = this.metrics.filter(metric => metric.time >= this.time - 180);
      const stable = this.time >= 180 && recent.freshOutputCount > 0 && recent.core.length > 0 &&
        history.length >= 18 && history.every(metric => metric.freshOutputCount > 0 && JSON.stringify(metric.routeCore) === key);
      const active = this.neurons.filter(neuron => neuron.lastSpikeAt !== null && this.time - neuron.lastSpikeAt <= 60 && !neuron.recordOutput);
      return {
        time: this.time,
        deliveryRate: recentInputs.length ? deliveredInputCount / recentInputs.length : 0,
        deliveredInputCount, pendingOrUndeliveredInputCount: recentInputs.length - deliveredInputCount,
        inputCount: recentInputs.length, outputCount: recent.outputCount,
        freshOutputCount: recent.freshOutputCount,
        staleOutputCount: recent.outputCount - recent.freshOutputCount,
        outputRateEMA: this.outputRateEMA, rewardPulse: this.rewardPulse,
        timeToFirstDelivery: this.firstDelivery, routeStable: stable, routeCore: recent.core,
        trafficShare: recent.shares,
        synapses: { formed: this.stats.formed, pruned: this.stats.pruned, alive: links.length, meanWeight: links.length ? links.reduce((sum, synapse) => sum + synapse.weight, 0) / links.length : 0 },
        deadEndFraction: active.length ? active.filter(neuron => !neuron.synapses.length).length / active.length : 0,
        population: this.neurons.length, deaths: this.stats.deaths, totalOutputSpikes: this.stats.outputSpikes
      };
    }
    logMetrics() { const metric = this.measure(); this.metrics.push(metric); return metric; }

    snapshot() {
      return JSON.parse(JSON.stringify({
        schema: "neuron-snapshot/v1", model: "local-spiking-v3",
        seed: this.seed, config: this.config, features: this.features, time: this.time,
        tick: this.tick, accumulator: this.accumulator, nextId: this.nextId, rngState: this.rng.state,
        neurons: this.neurons.map(neuron => neuron.toJSON()), archive: this.archive,
        stats: this.stats, inputSpikes: this.inputSpikes, outputs: this.outputs,
        delivered: [...this.delivered], spikeRecords: [...this.spikeRecords],
        firstDelivery: this.firstDelivery, metrics: this.metrics, events: this.events,
        featureHistory: this.featureHistory, newcomerCohort: this.newcomerCohort,
        rewardPulse: this.rewardPulse, outputRateEMA: this.outputRateEMA, outputSpikesThisTick: this.outputSpikesThisTick,
        chemical: { values: [...this.chemical.values], active: this.chemical.active }
      }));
    }

    static fromSnapshot(snapshot, options = {}) {
      const s = typeof snapshot === "string" ? JSON.parse(snapshot) : JSON.parse(JSON.stringify(snapshot));
      if (!s || s.schema !== "neuron-snapshot/v1" || s.model !== "local-spiking-v3") throw new Error("Unsupported Neuron snapshot. This model requires local-spiking-v3 (prediction-error reward and fresh-input stability).");
      const finite = (value, name, min = 0, max = Number.MAX_SAFE_INTEGER) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("Invalid snapshot " + name + ".");
      };
      if (!s.config || !s.features || !Array.isArray(s.neurons) || s.neurons.length > 150 || !Array.isArray(s.archive) || s.archive.length > 10000) throw new Error("Invalid snapshot population.");
      for (const key of Object.keys(DEFAULTS)) finite(s.config[key], "configuration " + key, key === "restLevel" ? -10 : 0, 10000);
      finite(s.config.dt, "time step", 0.001, 0.1);
      finite(s.config.outputRateTau, "output rate time constant", 0.001, 10000);
      finite(s.config.radius, "sensing radius", 1, 1000);
      finite(s.config.maxSynapses, "synapse capacity", 1, 10);
      for (const key of ["hebbian", "reward", "gradient"]) if (typeof s.features[key] !== "boolean") throw new Error("Invalid feature switches.");
      finite(s.tick, "tick"); finite(s.time, "time"); finite(s.accumulator, "accumulator", 0, s.config.dt);
      finite(s.rngState, "random state", 0, 0xffffffff);
      if (!Number.isInteger(s.tick) || !Number.isInteger(s.rngState) || Math.abs(s.time - s.tick * s.config.dt) > 1e-7) throw new Error("Inconsistent snapshot clock.");
      const field = new SpikingField({ empty: true, seed: s.seed, config: s.config, features: s.features, onEvent: options.onEvent });
      const allCells = [...s.neurons, ...s.archive];
      const byId = new Map();
      const synapseIds = new Set();
      for (const saved of allCells) {
        finite(saved.id, "cell ID", 1);
        if (!Number.isInteger(saved.id) || byId.has(saved.id)) throw new Error("Duplicate or invalid cell ID.");
        finite(saved.x, "cell x", 0, 1000); finite(saved.y, "cell y", 0, 620);
        for (const key of ["age", "health", "potential", "activity", "adaptation", "growthBudget", "refractoryUntil", "spikeCount", "bornAt", "radius", "threshold", "leakRate", "nextSynapseId", "secretionRate"]) finite(saved[key], key);
        finite(saved.restLevel, "rest level", -10, 10);
        if (typeof saved.alive !== "boolean" || typeof saved.recordOutput !== "boolean") throw new Error("Invalid cell flags.");
        for (const key of ["drivePeriod", "nextDriveAt", "lastSpikeAt", "deathAt"]) if (saved[key] !== null) finite(saved[key], key);
        if (saved.drivePeriod !== null && saved.drivePeriod <= 0) throw new Error("Invalid drive period.");
        if (!Array.isArray(saved.synapses) || saved.synapses.length > field.config.maxSynapses || !Array.isArray(saved.inbox) || !Array.isArray(saved.charges)) throw new Error("Invalid cell state.");
        const cell = new Neuron({ id: saved.id, x: saved.x, y: saved.y, config: field.config });
        for (const key of Object.keys(cell)) {
          if (!["config", "incoming", "synapses"].includes(key)) {
            if (!(key in saved)) throw new Error("Missing cell state: " + key);
            cell[key] = saved[key];
          }
        }
        for (const message of cell.inbox) {
          finite(message.at, "arrival time"); finite(message.weight, "incoming weight");
          if (typeof message.spikeId !== "string" || typeof message.synapseId !== "string") throw new Error("Invalid queued spike.");
        }
        for (const charge of cell.charges) {
          finite(charge.amount, "membrane charge");
          if (typeof charge.spikeId !== "string" || typeof charge.synapseId !== "string") throw new Error("Invalid charge lineage.");
        }
        byId.set(cell.id, cell);
      }
      for (const saved of allCells) {
        const source = byId.get(saved.id);
        for (const savedSynapse of saved.synapses) {
          const target = byId.get(savedSynapse.targetId);
          if (!target || savedSynapse.sourceId !== source.id || typeof savedSynapse.id !== "string" || synapseIds.has(savedSynapse.id)) throw new Error("Invalid synapse target or identity.");
          finite(savedSynapse.weight, "synapse weight", -1, field.config.maxWeight);
          finite(savedSynapse.eligibility, "eligibility", 0, 1);
          finite(savedSynapse.delay, "axon delay", 0.001, 10);
          const synapse = new Synapse(savedSynapse.id, source, target, field.config, savedSynapse.createdAt, savedSynapse.weight);
          for (const key of Object.keys(synapse)) if (key !== "target") synapse[key] = savedSynapse[key];
          source.synapses.push(synapse);
          synapseIds.add(synapse.id);
        }
      }
      for (const key of ["inputSpikes", "outputs", "delivered", "spikeRecords", "metrics", "events", "featureHistory"]) {
        if (!Array.isArray(s[key]) || s[key].length > 1000000) throw new Error("Invalid snapshot history.");
      }
      const recordIds = new Set();
      for (const entry of s.spikeRecords) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || recordIds.has(entry[0])) throw new Error("Invalid spike record.");
        const record = entry[1];
        if (!record || record.id !== entry[0] || !byId.has(record.neuronId) || !Array.isArray(record.origins) || !Array.isArray(record.ancestors) || !Array.isArray(record.parents)) throw new Error("Invalid causal record.");
        finite(record.time, "spike time", 0, s.time);
        if (record.origins.some(id => typeof id !== "string") || record.ancestors.some(id => !byId.has(id))) throw new Error("Invalid causal ancestry.");
        recordIds.add(record.id);
      }
      for (const entry of s.spikeRecords) {
        for (const parent of entry[1].parents) {
          if (!recordIds.has(parent.spikeId) || typeof parent.synapseId !== "string") throw new Error("Missing causal parent.");
          finite(parent.contribution, "causal contribution");
        }
      }
      const records = new Map(s.spikeRecords);
      for (const [, record] of records) {
        if (record.parents.some(parent => records.get(parent.spikeId).time >= record.time)) throw new Error("Causal parents must precede their spike.");
      }
      for (const spike of [...s.inputSpikes, ...s.outputs]) {
        if (!spike || !recordIds.has(spike.id)) throw new Error("Missing spike history.");
        finite(spike.time, "history time", 0, s.time);
      }
      for (const metric of s.metrics) {
        if (!metric || !Array.isArray(metric.routeCore) || typeof metric.routeStable !== "boolean" || typeof metric.trafficShare !== "object" || metric.trafficShare === null) throw new Error("Invalid metric history.");
        finite(metric.time, "metric time", 0, s.time);
        finite(metric.outputCount, "output count");
        finite(metric.freshOutputCount, "fresh output count", 0, metric.outputCount);
        if (metric.routeStable && (!metric.freshOutputCount || !metric.routeCore.length)) throw new Error("Stable history requires fresh-input traffic.");
      }
      if (!s.stats || Object.values(s.stats).some(value => !Number.isFinite(value) || value < 0)) throw new Error("Invalid snapshot counters.");
      if (!s.chemical || !Array.isArray(s.chemical.values) || s.chemical.values.length !== field.chemical.values.length || s.chemical.values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Invalid chemical field.");
      finite(s.nextId, "next cell ID", Math.max(0, ...byId.keys()) + 1);
      finite(s.rewardPulse, "reward pulse", -Number.MAX_SAFE_INTEGER);
      finite(s.outputRateEMA, "output rate EMA");
      finite(s.outputSpikesThisTick, "output spike count", 0, 150);
      if (!Number.isInteger(s.outputSpikesThisTick)) throw new Error("Invalid output spike count.");
      for (const key of ["time", "tick", "accumulator", "nextId", "stats", "inputSpikes", "outputs", "firstDelivery", "metrics", "events", "featureHistory", "newcomerCohort", "rewardPulse", "outputRateEMA", "outputSpikesThisTick"]) field[key] = s[key];
      field.neurons = s.neurons.map(saved => byId.get(saved.id));
      field.archive = s.archive;
      field.delivered = new Map(s.delivered);
      field.spikeRecords = new Map(s.spikeRecords);
      field.rng.state = s.rngState;
      field.chemical.values = Float64Array.from(s.chemical.values);
      field.chemical.active = s.chemical.active;
      return field;
    }

    addNewcomers(variant = "default") {
      if (this.newcomerCohort) throw new Error("This branch already contains a newcomer experiment. Load its original snapshot to start another.");
      const before = this.measure();
      if (!before.routeStable) throw new Error("Experiment 2 needs a currently stable route measured over 180 seconds.");
      if (!["default", "input-side", "output-side", "burst-30", "lesion"].includes(variant)) throw new Error("Unknown newcomer variant.");
      const perGroup = variant === "burst-30" ? 15 : 6;
      const route = before.routeCore.map(id => this.getNeuron(id)).filter(Boolean);
      const reference = [...route, this.input, this.output].filter(Boolean);
      const anchors = variant === "input-side" ? route.filter(cell => cell.x < 500) : variant === "output-side" ? route.filter(cell => cell.x >= 500) : route;
      if (!anchors.length) throw new Error("No route cells exist on the requested side.");
      const occupied = this.neurons.map(cell => ({ x: cell.x, y: cell.y }));
      const placements = [];
      const placementRandom = new SeededRandom(this.rng.state);
      const distanceFromRoute = position => Math.min(...reference.map(cell => distance(position, cell)));
      for (const group of ["near", "far"]) {
        for (let index = 0; index < perGroup; index++) {
          let chosen = null;
          for (let attempt = 0; attempt < 12000; attempt++) {
            const anchor = anchors[Math.floor(placementRandom.next() * anchors.length)];
            const angle = placementRandom.next() * Math.PI * 2;
            const radius = 24 + placementRandom.next() * 40;
            const point = group === "near"
              ? { x: clamp(anchor.x + Math.cos(angle) * radius, 30, 970), y: clamp(anchor.y + Math.sin(angle) * radius, 30, 590) }
              : { x: 25 + placementRandom.next() * 950, y: 25 + placementRandom.next() * 570 };
            const routeDistance = distanceFromRoute(point);
            if (occupied.some(cell => distance(point, cell) < 22)) continue;
            if (group === "near" ? routeDistance > 70 : routeDistance < this.config.radius) continue;
            chosen = { ...point, group, routeDistance };
            break;
          }
          if (!chosen) throw new Error("This geometry has too little free space for the requested near/far placement.");
          placements.push(chosen);
          occupied.push(chosen);
        }
      }
      if (this.neurons.length + placements.length > 150) throw new Error("Not enough population capacity for this experiment.");
      this.rng.state = placementRandom.state;
      let removedId = null;
      if (variant === "lesion") {
        const victim = [...route].sort((a, b) => (before.trafficShare[b.id] || 0) - (before.trafficShare[a.id] || 0) || a.id - b.id)[0];
        removedId = victim.id;
        victim.health = 0;
        victim.alive = false;
        victim.deathAt = this.time;
        for (const owner of this.neurons) {
          const kept = [];
          for (const synapse of owner.synapses) {
            if (owner.id === victim.id || synapse.targetId === victim.id) {
              synapse.prune();
              this.observe({ type: "pruned", synapseId: synapse.id, sourceId: owner.id, targetId: synapse.targetId });
            } else kept.push(synapse);
          }
          owner.synapses = kept;
        }
        this.archive.push(victim.toJSON());
        this.neurons = this.neurons.filter(cell => cell !== victim);
        this.observe({ type: "died", neuronId: victim.id, intervention: true });
      }
      const cells = placements.map(placement => {
        const cell = this.addNeuron(placement);
        return { id: cell.id, group: placement.group, x: cell.x, y: cell.y, routeDistance: placement.routeDistance };
      });
      // Cohort labels exist exclusively in the observer, never in Neuron state.
      this.newcomerCohort = { time: this.time, variant, cells, baselineShares: before.trafficShare, priorCore: before.routeCore, removedId };
      return this.newcomerCohort;
    }

    newcomerOutcomes() {
      if (!this.newcomerCohort) return null;
      const current = this.measure();
      const prior = this.newcomerCohort.baselineShares;
      const displaced = this.newcomerCohort.priorCore.filter(id => (current.trafficShare[id] || 0) < 0.2 * prior[id]);
      const cells = this.newcomerCohort.cells.map(member => {
        const neuron = this.getNeuron(member.id);
        const archived = this.archive.find(cell => cell.id === member.id);
        const share = current.trafficShare[member.id] || 0;
        const survivingSynapses = neuron ? neuron.incoming.filter(synapse => synapse.active).length + neuron.synapses.length : 0;
        let outcome;
        if (!neuron) outcome = "Died";
        else if (neuron.spikeCount === 0 || survivingSynapses === 0) outcome = "Ignored";
        else if (share > 0 && displaced.length) outcome = "Disruptive";
        else if (share > 0.05) outcome = "Recruited";
        else outcome = "Active, low traffic";
        return { ...member, outcome, trafficShare: share, spikeCount: (neuron || archived)?.spikeCount || 0, survivingSynapses, health: neuron?.health || 0, age: (neuron || archived)?.age || 0 };
      });
      return { ...this.newcomerCohort, observedAt: this.time, displaced, cells };
    }
    exportLog() {
      return {
        schema: "neuron-metrics/v4", model: "local-spiking-v3", seed: this.seed, config: this.config,
        features: this.features, featureHistory: this.featureHistory, duration: this.time,
        definitions: {
          deliveryRate: "Unique input spikes in the last 60 seconds with a causally descended output, divided by input spikes in that window. In-flight spikes count as undelivered: 32/33 = 96.97% can be a measurement-boundary artifact, not a transport ceiling or a 3% loss rate. The ratio varies with sampling phase and path latency.",
          deliveredInputCount: "Numerator of deliveryRate: recent unique input spikes already observed at output.",
          pendingOrUndeliveredInputCount: "Recent input spikes without an output descendant yet. Includes in-flight spikes and genuine losses; these are not distinguished at this observation time.",
          freshOutputCount: "Output spikes in (t-60,t] with at least one input origin also in (t-60,t]. Outputs carrying only older origins are excluded.",
          staleOutputCount: "Output spikes in (t-60,t] without an input origin in that same window, including autonomous activity.",
          trafficShare: "Fraction of fresh-input-descended outputs with this cell on a causal branch from a recent input. Stale merged branches are excluded; shares overlap.",
          routeCore: "Ordinary cells on recent-input causal branches of >=80% of fresh-input-descended outputs. Driven and output cells are excluded.",
          routeStable: "Nonempty fresh-input route core identical at every 10-second sample over 180 seconds, with freshOutputCount > 0 at every sample and now.",
          outputRateEMA: "Output rate in spikes/s, initialized at zero. After each tick: EMA += (1-exp(-dt/60)) * (outputSpikesThisTick/dt - EMA). Updated even when reward is disabled.",
          rewardPulse: "outputSpikesThisTick - pre-update outputRateEMA * dt; computed at tick end and broadcast on the next tick. Signed pulses potentiate or depress eligible synapses when reward is enabled."
        },
        metrics: this.metrics, newcomerOutcomes: this.newcomerOutcomes()
      };
    }
  }
  const api = { SpikingField, Environment, ChemicalField, SeededRandom, Neuron, Synapse, DEFAULTS, clamp, distance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SpikingSimulation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
