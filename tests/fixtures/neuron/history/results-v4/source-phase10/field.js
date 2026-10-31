(function (root) {
  "use strict";
  const { Neuron, Synapse, DEFAULTS, CONSOLIDATION_DEFAULTS, COMPETITION_DEFAULTS, CRITICAL_INHIBITION_DEFAULTS, HOMEOSTASIS_DEFAULTS, AXES, geometry, positionOf, clamp, distance, localView } = typeof module !== "undefined" && module.exports ? require("./neuron.js") : root.NeuronCore;
  const { LogicTask } = typeof module !== "undefined" && module.exports ? require("./logic-task.js") : root.NeuronLogicTask;
  const { SpatialHash } = typeof module !== "undefined" && module.exports ? require("./spatial.js") : root.NeuronSpatial;
  const { AssemblyTask } = typeof module !== "undefined" && module.exports ? require("./assembly-task.js") : root.NeuronAssemblies;

  // Optional endpoint configuration. Labels and pair identities are observers,
  // never part of a neuron's locally sensed view or plasticity rules.
  function endpointConfig(io, config) {
    if (!io || !Array.isArray(io.inputs) || !Array.isArray(io.outputs) ||
        !io.inputs.length || !io.outputs.length || io.inputs.length + io.outputs.length > 20)
      throw new Error("Configure at least one input and output, with at most 20 endpoints.");
    const labels = new Set(), axes = AXES.slice(0, config.dimensions);
    const normalize = (cells, input, offset) => cells.map((cell, index) => {
      const label = cell.label ?? (input ? "In" : "Out") + (index + 1), id = offset + index + 1;
      if (typeof label !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(label) || labels.has(label)) throw new Error("Endpoint labels must be unique short names.");
      labels.add(label);
      if (cell.id !== undefined && cell.id !== id) throw new Error("Endpoint ID does not match configured order.");
      for (const axis of axes) if (!Number.isFinite(cell[axis]) || cell[axis] < 0 || cell[axis] > config.extent[axis]) throw new Error("Endpoint is outside the configured extent.");
      if (config.dimensions === 2 && cell.z !== undefined) throw new Error("A 2D endpoint cannot contain z.");
      const phase = cell.phase ?? 0;
      if (input && (!Number.isFinite(phase) || phase < 0 || phase >= config.inputPeriod)) throw new Error("Input phase must be within its period.");
      return { id, label, ...Object.fromEntries(axes.map(axis => [axis, cell[axis]])), ...(input ? { phase } : {}) };
    });
    return { inputs: normalize(io.inputs, true, 0), outputs: normalize(io.outputs, false, io.inputs.length) };
  }

  class SeededRandom {
    constructor(seed) { this.state = seed >>> 0; }
    next() {
      this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
      return this.state / 4294967296;
    }
  }

  class ChemicalField {
    constructor(config = {}) {
      const { dimensions, extent } = geometry(config);
      this.axes = AXES.slice(0, dimensions);
      this.extent = extent;
      this.spacing = 25;
      this.shape = this.axes.map(axis => Math.ceil(extent[axis] / this.spacing) + 1);
      this.strides = this.shape.map((_, axis) => this.shape.slice(0, axis).reduce((a, b) => a * b, 1));
      this.columns = this.shape[0];
      this.rows = this.shape[1];
      this.diffusion = 1100;
      this.decay = 0.03;
      const size = this.shape.reduce((a, b) => a * b, 1);
      if (size > 2000000) throw new Error("Chemical grid exceeds two million sites.");
      this.values = new Float64Array(size);
      this.buffer = new Float64Array(this.values.length);
      // x-fast layout, clamped (zero-flux) faces. Cache topology, not chemistry.
      this.neighbors = this.axes.flatMap((_, axis) => [-1, 1].map(direction => {
        const indices = new Uint32Array(size), stride = this.strides[axis];
        for (let i = 0; i < size; i++) {
          const coordinate = Math.floor(i / stride) % this.shape[axis];
          indices[i] = i + (coordinate + direction < 0 || coordinate + direction >= this.shape[axis] ? 0 : direction * stride);
        }
        return indices;
      }));
      this.active = false;
    }
    deposit(position, amount) {
      const index = this.axes.reduce((sum, axis, d) => sum +
        clamp(Math.round(position[axis] / this.spacing), 0, this.shape[d] - 1) * this.strides[d], 0);
      this.values[index] += amount;
      this.active = true;
    }
    sample(position) {
      const coordinates = this.axes.map((axis, d) => clamp(position[axis] / this.spacing, 0, this.shape[d] - 1));
      // Interpolate x first, then y, then z; preserves the original 2D
      // parenthesization and therefore its exact floating-point results.
      const interpolate = (d, offset) => {
        if (d < 0) return this.values[offset];
        const lo = Math.floor(coordinates[d]), hi = Math.min(lo + 1, this.shape[d] - 1);
        const fraction = coordinates[d] - lo;
        return (1 - fraction) * interpolate(d - 1, offset + lo * this.strides[d]) +
          fraction * interpolate(d - 1, offset + hi * this.strides[d]);
      };
      return interpolate(this.axes.length - 1, 0);
    }
    step(dt) {
      const coefficient = this.diffusion * dt / this.spacing ** 2;
      if (2 * this.axes.length * coefficient > 1) throw new Error("Diffusion time step exceeds the explicit stability limit.");
      const retention = Math.exp(-this.decay * dt);
      const values = this.values, buffer = this.buffer, neighbors = this.neighbors;
      for (let i = 0; i < values.length; i++) {
        const center = values[i];
        let sum = values[neighbors[0][i]];
        for (let face = 1; face < neighbors.length; face++) sum += values[neighbors[face][i]];
        buffer[i] = Math.max(0, (center + coefficient * (sum - neighbors.length * center)) * retention);
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
        ...(field.features.homeostasis ? { inputExempt: field.isInputCell(neuron.id) } : {}),
        reward: field.rewardPulse,
        ...(field.task?.config.rewardScope === "output-only" ? {
          // Declared nonlocal diagnostic: the field knows the endpoint identity.
          synapseReward: targetId => field.config.io.outputs.some(cell => cell.id === targetId) ? field.rewardPulse : 0
        } : {}),
        random: () => field.rng.next(),
        sense: () => (field._frame === frame ? field._spatial.indices(neuron, neuron.radius).map(i => frame[i])
          : new SpatialHash(frame).query(neuron, neuron.radius)).filter(peer => peer.id !== neuron.id),
        chemical: position => {
          if (distance(neuron, position) > neuron.radius + 1e-9) throw new Error("Chemical sensing is limited to the cell's radius.");
          return field.features.gradient ? field.chemical.sample(position) : 0;
        },
        secrete: amount => field.chemical.deposit(neuron, amount),
        inhibit: (activityBeforeSpike = neuron.activity) => {
          if (!(field.features.lateralInhibition || field.features.activityScaledInhibition || field.features.criticalPeriodInhibition) || field.endpointIds.includes(neuron.id) || neuron.drivePeriod !== null || neuron.recordOutput) return;
          const defaults = field.features.criticalPeriodInhibition ? CRITICAL_INHIBITION_DEFAULTS : COMPETITION_DEFAULTS;
          const strength = field.config.inhibitionStrength ?? defaults.inhibitionStrength;
          const radiusFactor = field.config.inhibitionRadiusFactor ?? defaults.inhibitionRadiusFactor;
          const weight = -strength * (field.features.criticalPeriodInhibition
            ? Math.exp(-neuron.age / (field.config.criticalPeriod ?? CRITICAL_INHIBITION_DEFAULTS.criticalPeriod))
            : field.features.activityScaledInhibition ? clamp(activityBeforeSpike) : 1);
          if (weight === 0) return;
          const recipients = field.onInhibition ? [] : null;
          const spatial = field._stepping ? field._spatial : new SpatialHash(field.neurons);
          for (const peer of spatial.query(neuron, radiusFactor * neuron.radius)) {
            if (peer === neuron || !peer.alive || field.endpointIds.includes(peer.id) || peer.drivePeriod !== null || peer.recordOutput) continue;
            const separation = distance(neuron, peer);
            if (separation <= radiusFactor * neuron.radius) {
              peer.inbox.push({
              inhibition: true, inhibitionId: `inh/${neuron.id}/${neuron.spikeCount}`,
              at: field.time + 0.04 + separation / 1800, weight
              });
              if (recipients) recipients.push(peer.id);
            }
          }
          // Passive experiment observer; never enters model state or event history.
          if (recipients) field.onInhibition(Object.freeze({ time: field.time, emitterId: neuron.id,
            spikeId: `${neuron.id}/p${neuron.spikeCount}`, age: neuron.age, weight,
            recipientIds: Object.freeze(recipients) }));
        },
        observe: event => field.observe(event)
      };
    }
  }

  class SpikingField {
    constructor(options = {}) {
      this.seed = options.seed === undefined ? 1 : options.seed;
      if (!Number.isSafeInteger(this.seed) || this.seed < 0 || this.seed > 0xffffffff) throw new Error("Seed must be an unsigned 32-bit integer.");
      this.config = { ...DEFAULTS, ...(options.config || {}), ...geometry(options.config) };
      if (this.config.pairingClock !== undefined && !["emission", "arrival"].includes(this.config.pairingClock))
        throw new Error("Invalid pairing clock.");
      // Capacity is infrastructure; the implicit limit does not enter model state.
      if (this.config.maxCells !== undefined && (!Number.isInteger(this.config.maxCells) || this.config.maxCells < 150 || this.config.maxCells > 2000))
        throw new Error("Cell capacity must be a whole number from 150 to 2000.");
      for (const [key, maximum] of [["inhibitionStrength", 10], ["inhibitionRadiusFactor", 1]]) {
        if (this.config[key] !== undefined && (!Number.isFinite(this.config[key]) || this.config[key] < 0 || this.config[key] > maximum))
          throw new Error("Invalid inhibition configuration: " + key);
      }
      if (this.config.criticalPeriod !== undefined && (!Number.isFinite(this.config.criticalPeriod) || this.config.criticalPeriod <= 0))
        throw new Error("Critical period must be positive and finite.");
      if (options.io !== undefined || this.config.io !== undefined) this.config.io = endpointConfig(options.io ?? this.config.io, this.config);
      this.features = { hebbian: true, reward: false, gradient: false, consolidation: false, ...(options.features || {}) };
      for(const key of ["assemblies","zoneCap","windowCap","distributedAttractant","tracts","persistentTracts","tractsFixed"]) if(this.features[key]!==undefined&&typeof this.features[key]!=="boolean") throw new Error("Invalid assembly switch.");
      if(this.features.tractsFixed&&(!this.features.persistentTracts||this.config.maxWeight<0.3))throw new Error("Fixed scaffold requires persistent tract slots and maxWeight >= 0.3.");
      if(this.features.persistentTracts&&!this.features.tracts)throw new Error("Persistent tracts require placement tracts and assembly zones.");
      if((this.features.zoneCap||this.features.windowCap||this.features.distributedAttractant||this.features.tracts)&&!this.features.assemblies)throw new Error("Regional cap, sources and tracts require assembly zones.");
      if (this.features.homeostasis !== undefined && typeof this.features.homeostasis !== "boolean") throw new Error("Homeostasis must be a boolean.");
      if (this.config.homeostasisTargetFactor !== undefined && (!Number.isFinite(this.config.homeostasisTargetFactor) || this.config.homeostasisTargetFactor < 0 || this.config.homeostasisTargetFactor > 10))
        throw new Error("Homeostasis target factor must be between zero and ten.");
      if (this.features.homeostasis && (!Number.isFinite(this.config.inputPeriod) || this.config.inputPeriod <= 0)) throw new Error("Homeostasis requires a positive nominal input period.");
      if (this.config.inhibitoryFraction !== undefined && (!Number.isFinite(this.config.inhibitoryFraction) || this.config.inhibitoryFraction < 0 || this.config.inhibitoryFraction > 1))
        throw new Error("Inhibitory fraction must be between zero and one.");
      if (this.features.inhibitoryPopulation) this.features.lateralInhibition = false;
      this.axes = AXES.slice(0, this.config.dimensions);
      this.width = this.config.extent.x;
      this.height = this.config.extent.y;
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
      if (this.config.io) {
        this.outputRewards = this.config.io.outputs.map(cell => ({ outputId: cell.id, rateEMA: 0, pulse: 0, spikesThisTick: 0 }));
        this.pairDelivered = new Map(this.config.io.outputs.map(cell => [cell.id, new Map()]));
        this.pairFirstDelivery = {};
      }
      this.chemical = new ChemicalField(this.config);
      this.env = new Environment(this);
      this.onEvent = options.onEvent || (() => {});
      this.onInhibition = options.onInhibition || null;
      if (options.task !== undefined) this.task = new LogicTask(options.task, this.config);
      if (this.features.assemblies) this.assembly = new AssemblyTask(this);
      const population = options.population === undefined ? 48 : options.population;
      if (!Number.isInteger(population) || population < 0 || population > this.cellLimit - 2) throw new Error("Population must be 0–" + (this.cellLimit - 2) + " ordinary cells.");
      if (population + (this.config.io ? this.endpointIds.length : 2) > this.cellLimit) throw new Error("Population and endpoints exceed the " + this.cellLimit + "-cell limit.");
      if (!options.empty) {
        if(this.assembly)this.assembly.place(this);
        else {
        const middle = Object.fromEntries(this.axes.map(axis => [axis, this.config.extent[axis] / 2]));
        if (this.config.io) this.placeEndpoints(options.inputEnabled !== false);
        else {
        this.addNeuron({ ...middle, x: this.width * 0.08, drivePeriod: options.inputEnabled === false ? null : this.config.inputPeriod });
        this.addNeuron({ ...middle, x: this.width * 0.92, recordOutput: true, secretionRate: 8 });
        }
        for (let index = 0; index < population; index++) {
          let position;
          for (let attempt = 0; attempt < 30; attempt++) {
            position = Object.fromEntries(this.axes.map(axis => {
              const scale = this.config.extent[axis] / (axis === "x" ? 1000 : 620);
              return [axis, (axis === "x" ? 150 : 55) * scale + this.rng.next() * (axis === "x" ? 700 : 510) * scale];
            }));
            if (this.neurons.every(neuron => distance(neuron, position) > 48)) break;
          }
          this.addNeuron(position);
        }
        }
        this.assignInhibitoryPopulation();
        this.endpointPlacement = this.assessEndpointPlacement();
      }
      this.logMetrics();
    }

    assignInhibitoryPopulation() {
      if (!this.features.inhibitoryPopulation) return;
      if (this.time !== 0 || this.links.length) throw new Error("Assign cell types only at initial placement.");
      const ordinary = this.neurons.filter(cell => !this.endpointIds.includes(cell.id));
      const rng = new SeededRandom((this.seed ^ 0x7da1e001) >>> 0);
      const shuffled = [...ordinary];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      for (const cell of this.neurons) delete cell.inhibitory;
      for (const cell of shuffled.slice(0, Math.round(ordinary.length * (this.config.inhibitoryFraction ?? 0.2)))) cell.inhibitory = true;
    }

    // Placement observer only: never moves cells, retries placement, or draws RNG.
    // Include dead original cells when reconstructing an older saved snapshot.
    assessEndpointPlacement() {
      if(this.features.assemblies)return {endpointIsolated:false,notApplicable:true,endpoints:[]};
      const original = [...this.neurons, ...this.archive].filter(cell => cell.bornAt === 0);
      if (this.config.io) {
        const ordinary = original.filter(cell => !this.endpointIds.includes(cell.id));
        const endpoints = [...this.config.io.inputs, ...this.config.io.outputs].map(endpoint => {
          const cell = original.find(cell => cell.id === endpoint.id);
          return { id: endpoint.id, label: endpoint.label,
            ordinaryNeighbors: cell ? ordinary.filter(peer => distance(cell, peer) <= cell.radius).length : 0 };
        });
        return { endpointIsolated: endpoints.some(cell => !cell.ordinaryNeighbors), endpoints };
      }
      const input = original.find(cell => cell.id === 1);
      const output = original.find(cell => cell.recordOutput);
      const ordinary = original.filter(cell => cell !== input && cell !== output && cell.drivePeriod === null && !cell.recordOutput);
      const count = endpoint => endpoint ? ordinary.filter(cell => distance(cell, endpoint) <= endpoint.radius).length : 0;
      const inputOrdinaryNeighbors = count(input), outputOrdinaryNeighbors = count(output);
      return { endpointIsolated: !inputOrdinaryNeighbors || !outputOrdinaryNeighbors,
        inputOrdinaryNeighbors, outputOrdinaryNeighbors };
    }

    get cellLimit() { return this.config.maxCells ?? 400; }

    addNeuron(properties) {
      if (this.neurons.length >= this.cellLimit) throw new Error("The field supports at most " + this.cellLimit + " live cells.");
      for (const axis of this.axes) {
        if (!Number.isFinite(properties[axis]) || properties[axis] < 0 || properties[axis] > this.config.extent[axis]) throw new Error("Cell " + axis + " is outside the configured extent.");
      }
      if (this.config.dimensions === 2 && properties.z !== undefined) throw new Error("A 2D position cannot contain z.");
      const neuron = new Neuron({ ...properties, id: this.nextId++, config: this.config, bornAt: this.time });
      if (this.features.homeostasis && !this.isInputCell(neuron.id)) neuron.initializeHomeostasis();
      if (this.features.inhibitoryPopulation && !this.endpointIds.includes(neuron.id) && !neuron.recordOutput && neuron.drivePeriod === null) {
        const typeRng = new SeededRandom((this.seed ^ 0x7da1e001 ^ Math.imul(neuron.id, 2654435761)) >>> 0);
        if (typeRng.next() < (this.config.inhibitoryFraction ?? 0.2)) neuron.inhibitory = true;
      }
      this.neurons.push(neuron);
      return neuron;
    }
    getNeuron(id) { return this.neurons.find(neuron => neuron.id === id); }
    get input() { return this.neurons.find(neuron => neuron.drivePeriod !== null); }
    isInputCell(id) { return this.features.assemblies ? false : this.config.io ? this.config.io.inputs.some(cell => cell.id === id) : id === 1; }
    get output() { return this.neurons.find(neuron => neuron.recordOutput); }
    get endpointIds() { return this.features.assemblies ? [] : this.config.io ? [...this.config.io.inputs, ...this.config.io.outputs].map(cell => cell.id) : [1, this.output?.id ?? 2]; }
    endpointLabel(id) { return this.config.io ? [...this.config.io.inputs, ...this.config.io.outputs].find(cell => cell.id === id)?.label ?? null : null; }
    placeEndpoints(enabled = true) {
      if (!this.config.io || this.nextId !== 1) throw new Error("Configured endpoints must be placed first.");
      for (const cell of this.config.io.inputs) {
        const input = this.addNeuron({ ...positionOf(cell), drivePeriod: enabled ? this.config.inputPeriod : null });
        if (enabled) input.nextDriveAt += cell.phase;
      }
      for (const cell of this.config.io.outputs) this.addNeuron({ ...positionOf(cell), recordOutput: true, secretionRate: 8 });
    }
    // A fresh read-only census for the viewer/observer, never given to a neuron.
    get links() { return this.neurons.flatMap(neuron => neuron.synapses); }

    observe(event) {
      if(event.type==='pruned'&&this.features.persistentTracts)this.assembly.notePruned(this,event.synapseId);
      if (event.type === "formed") this.stats.formed++;
      if (event.type === "pruned") this.stats.pruned++;
      if (event.type === "died") this.stats.deaths++;
      if (event.type === "spike") {
        const spike = event.spike;
        this.stats.spikes++;
        const origins = new Set();
        const ancestors = new Set([spike.neuronId]);
        if (spike.driven && !spike.externalDrive) {
          origins.add(spike.id);
          this.inputSpikes.push({ id: spike.id, time: spike.time, ...(this.config.io ? { inputId: spike.neuronId } : {}) });
        }
        for (const parent of spike.parents) {
          const previous = this.spikeRecords.get(parent.spikeId);
          if (!previous) continue;
          for (const origin of previous.origins) origins.add(origin);
          for (const id of previous.ancestors) ancestors.add(id);
        }
        const record = { ...spike, origins: [...origins].sort(), ancestors: [...ancestors].sort((a, b) => a - b) };
        if (this.config.io) record.originInputs = record.origins.map(id => ({ spikeId: id, inputId: Number(id.split("/")[0]) }));
        this.spikeRecords.set(spike.id, record);
        if (this.task) this.task.noteSpike(this, spike, event.output);
        if (this.assembly) this.assembly.noteSpike(this, spike);
        if (event.output) {
          this.stats.outputSpikes++;
          this.outputs.push(record);
          if (origins.size && this.firstDelivery === null) this.firstDelivery = this.time;
          for (const origin of origins) if (!this.delivered.has(origin)) this.delivered.set(origin, this.time);
          if (this.config.io) {
            const reward = this.outputRewards.find(state => state.outputId === spike.neuronId);
            if (!reward) throw new Error("Output is not in the endpoint configuration.");
            reward.spikesThisTick++;
            const delivered = this.pairDelivered.get(spike.neuronId);
            for (const origin of origins) {
              if (!delivered.has(origin)) delivered.set(origin, this.time);
              const key = Number(origin.split("/")[0]) + "->" + spike.neuronId;
              if (!(key in this.pairFirstDelivery)) this.pairFirstDelivery[key] = this.time;
            }
          }
        }
      }
      this.events.push({ time: this.time, ...event });
      if (this.events.length > 200) this.events.shift();
      this.onEvent(event);
    }

    step(forcedSpikes = null) {
      this.tick++;
      this.time = this.tick * this.config.dt;
      if (this.task) this.task.prepareTick(this);
      if (this.assembly) this.assembly.prepareTick(this);
      const outputsBeforeTick = this.stats.outputSpikes;
      if (this.config.io) for (const state of this.outputRewards) state.spikesThisTick = 0;
      const frame = this.neurons.map(localView);
      if (!this._spatial) this._spatial = new SpatialHash(this.neurons);
      else this._spatial.update(this.neurons);
      this._frame = frame;
      this._stepping = true;
      for (const neuron of this.neurons) {
        const local = this.env.forNeuron(neuron, frame);
        if(this.assembly) {
          local.assemblyClamped=this.assembly.clamped.has(neuron.id);
          local.assemblyPulse=this.assembly.pulsed.has(neuron.id);
          local.zoneCapBlocked=this.assembly.blocked.has(neuron.id);
        }
        // External experiment intervention, never chosen by neurons or a route.
        if (forcedSpikes?.has(neuron.id) && neuron.id !== 1 && neuron.drivePeriod === null && !neuron.recordOutput)
          local.forcedSpike = true;
        neuron.step(this.config.dt, local);
      }
      this._stepping = false;
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
      if (this.config.io) {
        const alpha = -Math.expm1(-this.config.dt / this.config.outputRateTau);
        for (const state of this.outputRewards) {
          state.pulse = state.spikesThisTick - state.rateEMA * this.config.dt;
          state.rateEMA += alpha * (state.spikesThisTick / this.config.dt - state.rateEMA);
        }
        this.rewardPulse = this.outputRewards.reduce((sum, state) => sum + state.pulse, 0);
        this.outputRateEMA = this.outputRewards.reduce((sum, state) => sum + state.rateEMA, 0);
      } else {
      this.rewardPulse = this.outputSpikesThisTick - this.outputRateEMA * this.config.dt;
      const alpha = -Math.expm1(-this.config.dt / this.config.outputRateTau);
      this.outputRateEMA += alpha * (this.outputSpikesThisTick / this.config.dt - this.outputRateEMA);
      }
      if (this.task) {
        // External task outcome replaces, rather than adds to, rate prediction error.
        this.rewardPulse = this.task.finishTick(this);
        this.outputRewards[0].pulse = this.rewardPulse;
      }
      if(this.assembly)this.assembly.finishTick(this);
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
      if(patch.assemblies!==undefined&&Boolean(patch.assemblies)!==Boolean(this.features.assemblies))throw new Error("Start a new assembly layout to change its apparatus.");
      for(const key of ["windowCap","distributedAttractant","tracts","persistentTracts","tractsFixed"])if(patch[key]!==undefined&&Boolean(patch[key])!==Boolean(this.features[key]))throw new Error("Start a new assembly layout to change its window, source or tract apparatus.");
      if(patch.zoneCap&&!this.assembly)throw new Error("Regional cap requires assembly zones.");
      if (patch.inhibitoryPopulation && !this.features.inhibitoryPopulation && this.time !== 0) throw new Error("Regenerate the field to enable an inhibitory population.");
      for (const key of ["hebbian", "reward", "gradient", "consolidation", "stdpDepression", "lateralInhibition", "activityScaledInhibition", "criticalPeriodInhibition", "inhibitoryPopulation", "homeostasis", "zoneCap"]) {
        if (key in patch && typeof patch[key] !== "boolean") throw new Error("Feature values must be booleans.");
        if (key in patch) this.features[key] = patch[key];
      }
      if (this.features.inhibitoryPopulation) {
        this.features.lateralInhibition = false;
        if (this.time === 0 && patch.inhibitoryPopulation) this.assignInhibitoryPopulation();
      }
      if (this.features.homeostasis) for (const cell of this.neurons) if (!this.isInputCell(cell.id)) cell.initializeHomeostasis();
      this.featureHistory.push({ time: this.time, ...this.features });
    }

    traffic(start = this.time - 60, end = this.time, inputId = null, outputId = null) {
      const outputs = this.outputs.filter(spike => spike.time > start && spike.time <= end && (outputId === null || spike.neuronId === outputId));
      const recentOrigins = new Set(this.inputSpikes.filter(spike => spike.time > start && spike.time <= end &&
        (inputId === null || (spike.inputId ?? Number(spike.id.split("/")[0])) === inputId)).map(spike => spike.id));
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
      const inputIds = new Set(this.config.io ? this.config.io.inputs.map(cell => cell.id) : this.inputSpikes.map(spike => Number(spike.id.split("/")[0])));
      const outputIds = new Set(this.config.io ? this.config.io.outputs.map(cell => cell.id) : this.outputs.map(spike => spike.neuronId));
      const ranked = [...counts].filter(([id]) => !inputIds.has(id) && !outputIds.has(id)).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const core = ranked.filter(([, count]) => freshOutputs.length > 0 && count / freshOutputs.length >= 0.8).map(([id]) => id);
      return { outputCount: outputs.length, freshOutputCount: freshOutputs.length, shares, core: core.sort((a, b) => a - b) };
    }

    measurePairs() {
      if (!this.config.io) return null;
      const recent = this.inputSpikes.filter(spike => spike.time > this.time - 60 && spike.time <= this.time);
      const pairs = [];
      const overlap = (a, b) => a.length && b.length ? a.filter(id => b.includes(id)).length / new Set([...a, ...b]).size : 0;
      for (const input of this.config.io.inputs) for (const output of this.config.io.outputs) {
        const key = input.id + "->" + output.id, inputs = recent.filter(spike => spike.inputId === input.id);
        const traffic = this.traffic(this.time - 60, this.time, input.id, output.id);
        const deliveredInputCount = inputs.filter(spike => this.pairDelivered.get(output.id).has(spike.id)).length;
        const deliveryRate = inputs.length ? deliveredInputCount / inputs.length : 0;
        const history = this.metrics.filter(m => m.time >= this.time - 180).map(m => ({ time: m.time, ...m.pairs?.find(p => p.key === key) }));
        const strict = this.time >= 180 && traffic.freshOutputCount > 0 && traffic.core.length > 0 && history.length >= 18 &&
          history.every(m => m.freshOutputCount > 0 && JSON.stringify(m.routeCore) === JSON.stringify(traffic.core));
        const samples = [...history.filter(m => m.time < this.time), { time: this.time, routeCore: traffic.core, freshOutputCount: traffic.freshOutputCount, inputCount: inputs.length, deliveryRate }];
        const fullWindow = this.time >= 180 && samples.length >= 19 && samples[0].time <= this.time - 180 + 1e-8 &&
          samples.every((m, i) => !i || Math.abs(m.time - samples[i - 1].time - 10) < 1e-8);
        const soft = fullWindow && samples.every((m, i) => m.freshOutputCount > 0 && m.routeCore.length > 0 && (!i || overlap(samples[i - 1].routeCore, m.routeCore) >= .8));
        const functional = fullWindow && samples.every(m => m.inputCount > 0 && m.freshOutputCount > 0 && m.deliveryRate >= .8);
        pairs.push({ key, inputId: input.id, outputId: output.id, inputLabel: input.label, outputLabel: output.label,
          inputCount: inputs.length, deliveredInputCount, pendingOrUndeliveredInputCount: inputs.length - deliveredInputCount,
          deliveryRate, outputCount: traffic.outputCount, freshOutputCount: traffic.freshOutputCount, routeCore: traffic.core, trafficShare: traffic.shares,
          timeToFirstDelivery: this.pairFirstDelivery[key] ?? null, strictStable: strict, routeStable: strict, softStable: soft, functionalStable: functional });
      }
      const crosstalk = this.config.io.outputs.map((output, index) => {
        const intended = this.config.io.inputs[index];
        const originIds = new Set(recent.map(spike => spike.id));
        const fresh = this.outputs.filter(spike => spike.neuronId === output.id && spike.time > this.time - 60 && spike.time <= this.time && spike.origins.some(id => originIds.has(id)));
        const wrong = intended ? fresh.filter(spike => spike.origins.some(id => originIds.has(id) && Number(id.split("/")[0]) !== intended.id)).length : null;
        return { outputId: output.id, outputLabel: output.label, intendedInputId: intended?.id ?? null,
          freshOutputCount: fresh.length, crossOriginOutputCount: wrong, fraction: fresh.length && wrong !== null ? wrong / fresh.length : null };
      });
      return { pairs, crosstalk, outputRewards: this.outputRewards.map(state => ({ ...state })) };
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
      const deliveryRate = recentInputs.length ? deliveredInputCount / recentInputs.length : 0;
      const samples = [...history.filter(metric => metric.time < this.time), {
        time: this.time, routeCore: recent.core, freshOutputCount: recent.freshOutputCount,
        inputCount: recentInputs.length, deliveryRate
      }];
      const overlap = (a, b) => {
        if (!a.length || !b.length) return 0;
        const right = new Set(b);
        return a.filter(id => right.has(id)).length / new Set([...a, ...b]).size;
      };
      const fullWindow = this.time >= 180 && samples.length >= 19 &&
        samples[0].time <= this.time - 180 + 1e-8 &&
        samples.every((sample, i) => !i || Math.abs(sample.time - samples[i - 1].time - 10) < 1e-8);
      const soft = fullWindow && samples.every((sample, i) => sample.freshOutputCount > 0 && sample.routeCore.length > 0 &&
        (!i || overlap(samples[i - 1].routeCore, sample.routeCore) >= 0.8));
      const functional = fullWindow && samples.every(sample => sample.inputCount > 0 && sample.freshOutputCount > 0 && sample.deliveryRate >= 0.8);
      const previous = this.metrics.filter(metric => metric.time < this.time).at(-1);
      const census = new SpatialHash(this.neurons);
      const neighborCounts = this.neurons.map(cell => census.query(cell, cell.radius).filter(peer => peer !== cell).length);
      const ordinary = this.neurons.map((cell, i) => ({ cell, count: neighborCounts[i] })).filter(({ cell }) => cell.drivePeriod === null && !cell.recordOutput);
      const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      const active = this.neurons.filter(neuron => neuron.lastSpikeAt !== null && this.time - neuron.lastSpikeAt <= 60 && !neuron.recordOutput);
      const coreIds = new Set(recent.core), coreWithIO = new Set(this.config.io ? [...recent.core, ...this.endpointIds] : [...recent.core, 1, this.output?.id]);
      const coreLinks = links.filter(link => coreWithIO.has(link.sourceId) && coreWithIO.has(link.targetId) &&
        (coreIds.has(link.sourceId) || coreIds.has(link.targetId)));
      const consolidatedCoreSynapses = coreLinks.filter(link => link.consolidated).length;
      return {
        ...(this.config.io ? this.measurePairs() : {}),
        ...(this.assembly ? this.assembly.measure(this) : {}),
        ...(this.task ? this.task.measure() : {}),
        ...(this.features.homeostasis ? { homeostasis: [...this.neurons, ...this.archive].sort((a,b) => a.id-b.id).map(cell => ({
          id: cell.id, alive: cell.alive, inputExempt: this.isInputCell(cell.id), output: cell.recordOutput,
          threshold: cell.threshold, effectiveThreshold: cell.threshold - 0.14 * Math.exp(-cell.age / this.config.maturation) + cell.adaptation,
          rate: cell.homeostaticRate ?? null, targetRate: cell.homeostaticTargetRate ?? null, adaptation: cell.adaptation,
          spikeCount: cell.spikeCount
        })) } : {}),
        time: this.time,
        consolidatedSynapses: links.filter(link => link.consolidated).length,
        coreSynapses: coreLinks.length, consolidatedCoreSynapses,
        coreConsolidatedFraction: coreLinks.length ? consolidatedCoreSynapses / coreLinks.length : null,
        endpointIsolated: (this.endpointPlacement || this.assessEndpointPlacement()).endpointIsolated,
        endpointPlacement: this.endpointPlacement || this.assessEndpointPlacement(),
        deliveryRate,
        deliveredInputCount, pendingOrUndeliveredInputCount: recentInputs.length - deliveredInputCount,
        inputCount: recentInputs.length, outputCount: recent.outputCount,
        freshOutputCount: recent.freshOutputCount,
        staleOutputCount: recent.outputCount - recent.freshOutputCount,
        outputRateEMA: this.outputRateEMA, rewardPulse: this.rewardPulse,
        timeToFirstDelivery: this.firstDelivery, routeStable: stable, routeCore: recent.core,
        strictStable: stable, softStable: soft, functionalStable: functional,
        coreJaccard: previous ? overlap(previous.routeCore, recent.core) : null,
        meanNeighborsInReach: mean(neighborCounts),
        meanOrdinaryNeighborsInReach: mean(ordinary.map(({ count }) => count)),
        inputNeighborsInReach: this.input ? neighborCounts[this.neurons.indexOf(this.input)] : null,
        outputNeighborsInReach: this.output ? neighborCounts[this.neurons.indexOf(this.output)] : null,
        trafficShare: recent.shares,
        synapses: { formed: this.stats.formed, pruned: this.stats.pruned, alive: links.length, meanWeight: links.length ? links.reduce((sum, synapse) => sum + synapse.weight, 0) / links.length : 0 },
        deadEndFraction: active.length ? active.filter(neuron => !neuron.synapses.length).length / active.length : 0,
        population: this.neurons.length, deaths: this.stats.deaths, totalOutputSpikes: this.stats.outputSpikes
      };
    }
    logMetrics() { const metric = this.measure(); this.metrics.push(metric); return metric; }

    snapshot() {
      return JSON.parse(JSON.stringify({
        schema: "neuron-snapshot/v1", model: "local-spiking-v4",
        consolidationDefaults: CONSOLIDATION_DEFAULTS,
        endpointPlacement: this.endpointPlacement || this.assessEndpointPlacement(),
        seed: this.seed, config: this.config, features: this.features, time: this.time,
        tick: this.tick, accumulator: this.accumulator, nextId: this.nextId, rngState: this.rng.state,
        neurons: this.neurons.map(neuron => neuron.toJSON()), archive: this.archive,
        stats: this.stats, inputSpikes: this.inputSpikes, outputs: this.outputs,
        delivered: [...this.delivered], spikeRecords: [...this.spikeRecords],
        firstDelivery: this.firstDelivery, metrics: this.metrics, events: this.events,
        featureHistory: this.featureHistory, newcomerCohort: this.newcomerCohort,
        rewardPulse: this.rewardPulse, outputRateEMA: this.outputRateEMA, outputSpikesThisTick: this.outputSpikesThisTick,
        ...(this.task ? { task: this.task.toJSON() } : {}),
        ...(this.assembly ? { assembly: this.assembly.toJSON() } : {}),
        ...(this.config.io ? { multiIO: { outputRewards: this.outputRewards, pairDelivered: [...this.pairDelivered].map(([id, entries]) => [id, [...entries]]), pairFirstDelivery: this.pairFirstDelivery } } : {}),
        chemical: { values: [...this.chemical.values], active: this.chemical.active }
      }));
    }

    static fromSnapshot(snapshot, options = {}) {
      const s = typeof snapshot === "string" ? JSON.parse(snapshot) : JSON.parse(JSON.stringify(snapshot));
      if (!s || s.schema !== "neuron-snapshot/v1" || s.model !== "local-spiking-v4") throw new Error("Unsupported Neuron snapshot. This model requires local-spiking-v4 (dimension-aware geometry and three stability observers).");
      const finite = (value, name, min = 0, max = Number.MAX_SAFE_INTEGER) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("Invalid snapshot " + name + ".");
      };
      if (!s.config || !s.features || !Array.isArray(s.neurons) || s.neurons.length > (s.config.maxCells ?? 400) || !Array.isArray(s.archive) || s.archive.length > 10000) throw new Error("Invalid snapshot population.");
      for (const key of Object.keys(DEFAULTS).filter(key => typeof DEFAULTS[key] === "number")) finite(s.config[key], "configuration " + key, key === "restLevel" ? -10 : 0, 10000);
      for (const key of Object.keys(CONSOLIDATION_DEFAULTS)) if (s.config[key] !== undefined)
        finite(s.config[key], "consolidation configuration " + key, 0, key === "d_slow" ? 1 : 10000);
      geometry(s.config);
      finite(s.config.dt, "time step", 0.001, 0.1);
      finite(s.config.outputRateTau, "output rate time constant", 0.001, 10000);
      finite(s.config.radius, "sensing radius", 1, 1000);
      finite(s.config.maxSynapses, "synapse capacity", 1, 10);
      for (const key of ["hebbian", "reward", "gradient"]) if (typeof s.features[key] !== "boolean") throw new Error("Invalid feature switches.");
      if (s.features.consolidation !== undefined && typeof s.features.consolidation !== "boolean") throw new Error("Invalid consolidation switch.");
      for (const key of ["stdpDepression", "lateralInhibition", "activityScaledInhibition", "criticalPeriodInhibition", "inhibitoryPopulation"]) if (s.features[key] !== undefined && typeof s.features[key] !== "boolean") throw new Error("Invalid competition switch.");
      if (s.features.inhibitoryPopulation && s.features.lateralInhibition) throw new Error("Population inhibition replaces fixed R2.");
      finite(s.tick, "tick"); finite(s.time, "time"); finite(s.accumulator, "accumulator", 0, s.config.dt);
      finite(s.rngState, "random state", 0, 0xffffffff);
      if (!Number.isInteger(s.tick) || !Number.isInteger(s.rngState) || Math.abs(s.time - s.tick * s.config.dt) > 1e-7) throw new Error("Inconsistent snapshot clock.");
      const field = new SpikingField({ empty: true, seed: s.seed, config: s.config, features: s.features, onEvent: options.onEvent, onInhibition: options.onInhibition });
      const allCells = [...s.neurons, ...s.archive];
      const byId = new Map();
      const synapseIds = new Set();
      for (const saved of allCells) {
        finite(saved.id, "cell ID", 1);
        if (!Number.isInteger(saved.id) || byId.has(saved.id)) throw new Error("Duplicate or invalid cell ID.");
        for (const axis of field.axes) finite(saved[axis], "cell " + axis, 0, field.config.extent[axis]);
        if (field.config.dimensions === 2 && saved.z !== undefined) throw new Error("Invalid 2D cell z.");
        for (const key of ["age", "health", "activity", "adaptation", "growthBudget", "refractoryUntil", "spikeCount", "bornAt", "radius", "threshold", "leakRate", "nextSynapseId", "secretionRate"]) finite(saved[key], key);
        finite(saved.potential, "potential", -Number.MAX_SAFE_INTEGER);
        finite(saved.restLevel, "rest level", -10, 10);
        if (typeof saved.alive !== "boolean" || typeof saved.recordOutput !== "boolean") throw new Error("Invalid cell flags.");
        for (const key of ["drivePeriod", "nextDriveAt", "lastSpikeAt", "deathAt"]) if (saved[key] !== null) finite(saved[key], key);
        if (saved.drivePeriod !== null && saved.drivePeriod <= 0) throw new Error("Invalid drive period.");
        const axonOwner=field.features.persistentTracts&&saved.id<=150;
        if(saved.tractSlotCapacity!==undefined&&(!axonOwner||saved.tractSlotCapacity!==2))throw new Error("Invalid tract slot capacity.");
        if (!Array.isArray(saved.synapses) || saved.synapses.length > field.config.maxSynapses+(axonOwner?2:0) || (axonOwner&&saved.synapses.filter(s=>!s.tract).length>field.config.maxSynapses) || !Array.isArray(saved.inbox) || !Array.isArray(saved.charges)) throw new Error("Invalid cell state.");
        if (saved.inhibitory !== undefined && typeof saved.inhibitory !== "boolean") throw new Error("Invalid inhibitory type.");
        if (saved.inhibitory && (field.endpointIds.includes(saved.id) || saved.recordOutput || saved.drivePeriod !== null)) throw new Error("Endpoints cannot be inhibitory cells.");
        const cell = new Neuron({ id: saved.id, ...positionOf(saved), config: field.config, inhibitory: saved.inhibitory });
        if(axonOwner)cell.tractSlotCapacity=2;
        for (const key of Object.keys(cell)) {
          if (!["config", "incoming", "synapses"].includes(key)) {
            if (!(key in saved)) throw new Error("Missing cell state: " + key);
            cell[key] = saved[key];
          }
        }
        if (saved.homeostaticRate !== undefined || saved.homeostaticTargetRate !== undefined || (field.features.homeostasis && saved.alive && !field.isInputCell(saved.id))) {
          finite(saved.homeostaticRate, "homeostatic rate");
          finite(saved.homeostaticTargetRate, "homeostatic target rate");
          if (field.isInputCell(saved.id)) throw new Error("Input ports are exempt from homeostasis.");
          const target = (field.config.homeostasisTargetFactor ?? HOMEOSTASIS_DEFAULTS.targetFactor) / field.config.inputPeriod;
          if (saved.homeostaticTargetRate !== target) throw new Error("Homeostatic target disagrees with configuration.");
          if (field.features.homeostasis && (saved.threshold < HOMEOSTASIS_DEFAULTS.floor || saved.threshold > HOMEOSTASIS_DEFAULTS.ceiling)) throw new Error("Homeostatic threshold is outside its bounds.");
          cell.homeostaticRate = saved.homeostaticRate;
          cell.homeostaticTargetRate = saved.homeostaticTargetRate;
        }
        for (const message of cell.inbox) {
          if (message.synapticInhibition === true) {
            finite(message.at, "synaptic inhibition arrival"); finite(message.weight, "synaptic inhibitory magnitude", -field.config.maxWeight, 0);
            if (message.inhibition || typeof message.spikeId !== "string" || typeof message.synapseId !== "string") throw new Error("Invalid inhibitory synaptic message.");
            continue;
          }
          if (message.inhibition === true) {
            finite(message.at, "inhibition arrival time");
            finite(message.weight, "inhibitory weight", -(field.config.inhibitionStrength ?? COMPETITION_DEFAULTS.inhibitionStrength), 0);
            if (typeof message.inhibitionId !== "string" ||
                "spikeId" in message || "synapseId" in message || field.endpointIds.includes(cell.id) || cell.recordOutput || cell.drivePeriod !== null)
              throw new Error("Invalid ancestry-free inhibition message.");
            continue;
          }
          finite(message.at, "arrival time"); finite(message.weight, "incoming weight");
          if (typeof message.spikeId !== "string" || typeof message.synapseId !== "string") throw new Error("Invalid queued spike.");
        }
        for (const charge of cell.charges) {
          if (charge.synapticInhibition === true) {
            finite(charge.amount, "synaptic inhibitory charge", -field.config.maxWeight, 0);
            if (charge.inhibition || typeof charge.spikeId !== "string" || typeof charge.synapseId !== "string") throw new Error("Invalid inhibitory synaptic charge.");
            continue;
          }
          if (charge.inhibition === true) {
            finite(charge.amount, "inhibitory charge", -(field.config.inhibitionStrength ?? COMPETITION_DEFAULTS.inhibitionStrength), 0);
            if ("spikeId" in charge || "synapseId" in charge || field.endpointIds.includes(cell.id) || cell.recordOutput || cell.drivePeriod !== null)
              throw new Error("Invalid inhibitory charge ancestry.");
            continue;
          }
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
          if (Boolean(savedSynapse.inhibitory) !== Boolean(source.inhibitory)) throw new Error("Synapse sign disagrees with its source type.");
          const synapse = new Synapse(savedSynapse.id, source, target, field.config, savedSynapse.createdAt, savedSynapse.weight);
          if(savedSynapse.tract!==undefined){
            if(savedSynapse.tract!==true||!field.features.tracts||!field.assembly||(!field.features.persistentTracts&&savedSynapse.createdAt!==0)||source.id>150||target.id<=150||
              distance(source,target)>(field.config.tractReach??Math.hypot(880,620,620)))throw new Error("Invalid developmental tract provenance.");
            synapse.tract=true;
            if(field.features.persistentTracts){if(![0,1].includes(savedSynapse.tractSlot))throw new Error("Invalid tract slot.");synapse.tractSlot=savedSynapse.tractSlot;}
          }
          if(savedSynapse.fixed!==undefined||field.features.tractsFixed&&savedSynapse.tract){
            if(savedSynapse.fixed!==true||!field.features.tractsFixed||!savedSynapse.tract||savedSynapse.createdAt!==0||savedSynapse.active!==true||savedSynapse.weight<0.3)throw new Error("Invalid fixed scaffold synapse.");
            synapse.fixScaffold(source);
          }
          const state = { consolidated: false, strongSince: null, ...savedSynapse };
          if (field.config.pairingClock === "arrival") {
            if (!Array.isArray(state.pendingPreSpikes) || state.pendingPreSpikes.length > 10000)
              throw new Error("Invalid pending arrival clocks.");
            for (let i = 0; i < state.pendingPreSpikes.length; i++) {
              finite(state.pendingPreSpikes[i], "pending arrival clock", s.time - 1e-9, s.time + savedSynapse.delay + 1e-9);
              if (i && state.pendingPreSpikes[i] < state.pendingPreSpikes[i-1]) throw new Error("Unordered arrival clocks.");
            }
            if (state.lastPreSpike !== null) finite(state.lastPreSpike, "last arrival clock", 0, s.time + 1e-9);
          } else if (state.pendingPreSpikes !== undefined) throw new Error("Arrival clocks require arrival pairing.");
          if (typeof state.consolidated !== "boolean") throw new Error("Invalid consolidated flag.");
          if (state.strongSince !== null) finite(state.strongSince, "strong-since time", savedSynapse.createdAt, s.time);
          for (const key of Object.keys(synapse)) if (key !== "target") synapse[key] = state[key];
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
      for (const cell of byId.values()) for (const item of [...cell.inbox, ...cell.charges]) if (item.synapticInhibition) {
        const sourceId = Number(item.spikeId.split("/")[0]);
        if (!byId.get(sourceId)?.inhibitory || !item.synapseId.startsWith(sourceId + "/s") || !records.has(item.spikeId)) throw new Error("Invalid inhibitory source identity.");
      }
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
      finite(s.outputSpikesThisTick, "output spike count", 0, field.cellLimit);
      if (!Number.isInteger(s.outputSpikesThisTick)) throw new Error("Invalid output spike count.");
      for (const key of ["time", "tick", "accumulator", "nextId", "stats", "inputSpikes", "outputs", "firstDelivery", "metrics", "events", "featureHistory", "newcomerCohort", "rewardPulse", "outputRateEMA", "outputSpikesThisTick"]) field[key] = s[key];
      field.neurons = s.neurons.map(saved => byId.get(saved.id));
      field.archive = s.archive;
      field.delivered = new Map(s.delivered);
      field.spikeRecords = new Map(s.spikeRecords);
      if (field.config.io) {
        if (!s.multiIO || !Array.isArray(s.multiIO.outputRewards) || !Array.isArray(s.multiIO.pairDelivered)) throw new Error("Missing multi-I/O state.");
        const outputIds = field.config.io.outputs.map(cell => cell.id);
        if (JSON.stringify(s.multiIO.outputRewards.map(state => state.outputId)) !== JSON.stringify(outputIds) ||
            JSON.stringify(s.multiIO.pairDelivered.map(entry => entry[0])) !== JSON.stringify(outputIds)) throw new Error("Invalid per-output state identities.");
        for (const endpoint of [...field.config.io.inputs, ...field.config.io.outputs]) {
          const cell = byId.get(endpoint.id);
          if (!cell || field.axes.some(axis => cell[axis] !== endpoint[axis]) || cell.recordOutput !== outputIds.includes(cell.id)) throw new Error("Snapshot endpoint metadata does not match cells.");
        }
        for (const state of s.multiIO.outputRewards) {
          finite(state.rateEMA, "per-output EMA"); finite(state.pulse, "per-output pulse", -Number.MAX_SAFE_INTEGER);
          finite(state.spikesThisTick, "per-output spike count", 0, 1);
        }
        if (s.multiIO.outputRewards.reduce((sum, state) => sum + state.rateEMA, 0) !== s.outputRateEMA ||
            s.multiIO.outputRewards.reduce((sum, state) => sum + state.pulse, 0) !== s.rewardPulse) throw new Error("Inconsistent summed output reward.");
        for (const spike of s.inputSpikes) if (!field.config.io.inputs.some(cell => cell.id === spike.inputId) || records.get(spike.id).neuronId !== spike.inputId) throw new Error("Invalid input origin identity.");
        for (const [, record] of records) if (JSON.stringify(record.originInputs) !== JSON.stringify(record.origins.map(id => ({ spikeId: id, inputId: Number(id.split("/")[0]) })))) throw new Error("Invalid per-origin ancestry.");
        for (const [, entries] of s.multiIO.pairDelivered) for (const [id, time] of entries) {
          if (!s.inputSpikes.some(spike => spike.id === id)) throw new Error("Invalid delivered input origin.");
          finite(time, "pair delivery time", 0, s.time);
        }
        if (!s.multiIO.pairFirstDelivery || typeof s.multiIO.pairFirstDelivery !== "object") throw new Error("Invalid pair first contact.");
        field.outputRewards = s.multiIO.outputRewards;
        field.pairDelivered = new Map(s.multiIO.pairDelivered.map(([id, entries]) => [id, new Map(entries)]));
        field.pairFirstDelivery = s.multiIO.pairFirstDelivery;
      }
      field.rng.state = s.rngState;
      field.chemical.values = Float64Array.from(s.chemical.values);
      field.chemical.active = s.chemical.active;
      if (s.task !== undefined) field.task = LogicTask.fromJSON(s.task, field);
      if(field.features.assemblies)field.assembly=AssemblyTask.fromJSON(s.assembly,field);
      else if(s.assembly!==undefined)throw new Error("Assembly state requires its feature switch.");
      field.endpointPlacement = field.assessEndpointPlacement();
      // Add observer metadata to the restored copy; the source file is untouched.
      field.metrics = field.metrics.map(metric => ({ ...metric,
        endpointIsolated: field.endpointPlacement.endpointIsolated, endpointPlacement: field.endpointPlacement }));
      return field;
    }

    addNewcomers(variant = "default") {
      if (this.config.io) throw new Error("The newcomer experiment requires a single-I/O snapshot.");
      if (this.newcomerCohort) throw new Error("This branch already contains a newcomer experiment. Load its original snapshot to start another.");
      const before = this.measure();
      if (!before.routeStable) throw new Error("Experiment 2 needs a currently stable route measured over 180 seconds.");
      if (!["default", "input-side", "output-side", "burst-30", "lesion"].includes(variant)) throw new Error("Unknown newcomer variant.");
      const perGroup = variant === "burst-30" ? 15 : 6;
      const route = before.routeCore.map(id => this.getNeuron(id)).filter(Boolean);
      const reference = [...route, this.input, this.output].filter(Boolean);
      const anchors = variant === "input-side" ? route.filter(cell => cell.x < this.width / 2) : variant === "output-side" ? route.filter(cell => cell.x >= this.width / 2) : route;
      if (!anchors.length) throw new Error("No route cells exist on the requested side.");
      const occupied = this.neurons.map(positionOf);
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
            // A circle in 2D; a uniform spherical direction in 3D. The extra
            // random draw exists only in 3D, retaining the old 2D RNG sequence.
            const vertical = this.config.dimensions === 3 ? 2 * placementRandom.next() - 1 : 0;
            const horizontal = Math.sqrt(1 - vertical * vertical);
            const direction = { x: Math.cos(angle) * horizontal, y: Math.sin(angle) * horizontal, z: vertical };
            const point = Object.fromEntries(this.axes.map(axis => [axis, group === "near"
              ? clamp(anchor[axis] + direction[axis] * radius, 30, this.config.extent[axis] - 30)
              : 25 + placementRandom.next() * (this.config.extent[axis] - 50)]));
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
      if (this.neurons.length + placements.length > this.cellLimit) throw new Error("Not enough population capacity for this experiment.");
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
            if (!synapse.fixed && (owner.id === victim.id || synapse.targetId === victim.id)) {
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
        return { id: cell.id, group: placement.group, ...positionOf(cell), routeDistance: placement.routeDistance };
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
        schema: "neuron-metrics/v5", model: "local-spiking-v4", seed: this.seed, config: this.config,
        consolidationDefaults: CONSOLIDATION_DEFAULTS,
        endpointPlacement: this.endpointPlacement || this.assessEndpointPlacement(),
        features: this.features, featureHistory: this.featureHistory, duration: this.time,
        ...(this.assembly ? {assembly:this.assembly.toJSON(),assemblyDefinition:this.assembly.revised?"Opt-in external cues and distributed secretion; regional window membership cap is explicitly nonlocal. Repeats are allowed, scheduled cues excluded. Readouts are final-five-second unions; endpoint delivery does not apply.":"Opt-in external cues and non-neuronal attractant source; regional top-k cap is explicitly nonlocal. Cue spikes are exempt. Readouts are final-five-second unions, not per-tick counts. Endpoint delivery is not applicable."} : {}),
        ...(this.features.homeostasis ? { homeostasisDefinition: { ...HOMEOSTASIS_DEFAULTS,
          targetFactor: this.config.homeostasisTargetFactor ?? HOMEOSTASIS_DEFAULTS.targetFactor,
          targetRate: (this.config.homeostasisTargetFactor ?? HOMEOSTASIS_DEFAULTS.targetFactor) / this.config.inputPeriod,
          definition: "Own-spike EMA updated at tick end, then additive base-threshold update. Input ports are clamped and exempt. Youth and fast adaptation are unchanged. Per-cell observations include frozen death states." } } : {}),
        ...(this.features.inhibitoryPopulation ? { inhibitoryPopulation: { fraction: this.config.inhibitoryFraction ?? 0.2, initialIds: [...this.neurons, ...this.archive].filter(n => n.bornAt === 0 && n.inhibitory).map(n => n.id).sort((a,b) => a-b), definition: "Seed-selected ordinary cells transmit negative synaptic weight magnitudes. Fixed R2 is off. Positive causal ancestry excludes inhibitory effects." } } : {}),
        ...(this.task?.config.rewardScope === "output-only" ? { diagnostic: { localityViolation: true, rewardScope: "output-only", label: "NONLOCAL DIAGNOSTIC: task reward only reaches output-target synapses." } } : {}),
        ...(this.task ? { task: this.task.toJSON(), taskDefinition: `Clamped input ports; uniform seeded patterns every ${this.task.config.period} s; any output in the first ${this.task.config.responseWindow} s is the Boolean response. Truth-table reward +/-1 at scoring end replaces rate reward and is broadcast next tick. Accuracy uses the last 100 scored trials; task data never enters local sensing.` } : {}),
        ...(this.config.io ? { pairDefinitions: {
          originInputs: "Passive origin spike/input cell identities; never read by neuronal decisions.",
          pairs: "Every configured input/output combination, with fresh ancestry restricted to that input and output. All endpoints are excluded from ordinary cores. Delivery, strict, soft and functional use the original definitions per pair.",
          crosstalk: "Fraction of each output's fresh spikes containing a recent origin from an input other than its index-matched input. Mixed-origin spikes count once; no fresh denominator gives null.",
          outputRewards: this.task ? "Task reward replaces rate prediction error; EMA is observational. One scalar truth-table outcome is broadcast next tick, without origin-specific synapse credit." : "Separate 60-s EMAs and prediction-error pulses per output. Their sum is the scalar broadcast next tick; no origin-specific reward sign or synapse credit."
        } } : {}),
        definitions: {
          consolidatedSynapses: "Count of living active synapses whose local consolidated flag is true; the flag affects dynamics only with consolidation enabled.",
          coreConsolidatedFraction: "Consolidated / active directed synapses within the fresh ordinary core plus I/O, with at least one core endpoint; null for an empty denominator. Induced-edge observer, not a claim of edge traffic; never used in learning.",
          endpointIsolated: "Initial-layout flag: at least one endpoint has zero ordinary cells within its sensing radius. Recorded after initial placement, never repaired; retained after deaths and newcomer additions. Such runs are reported separately from mechanism failures.",
          deliveryRate: "Unique input spikes in the last 60 seconds with a causally descended output, divided by input spikes in that window. In-flight spikes count as undelivered: 32/33 = 96.97% can be a measurement-boundary artifact, not a transport ceiling or a 3% loss rate. The ratio varies with sampling phase and path latency.",
          deliveredInputCount: "Numerator of deliveryRate: recent unique input spikes already observed at output.",
          pendingOrUndeliveredInputCount: "Recent input spikes without an output descendant yet. Includes in-flight spikes and genuine losses; these are not distinguished at this observation time.",
          freshOutputCount: "Output spikes in (t-60,t] with at least one input origin also in (t-60,t]. Outputs carrying only older origins are excluded.",
          staleOutputCount: "Output spikes in (t-60,t] without an input origin in that same window, including autonomous activity.",
          trafficShare: "Fraction of fresh-input-descended outputs with this cell on a causal branch from a recent input. Stale merged branches are excluded; shares overlap.",
          routeCore: "Ordinary cells on recent-input causal branches of >=80% of fresh-input-descended outputs. Driven and output cells are excluded.",
          routeStable: "Nonempty fresh-input route core identical at every 10-second sample over 180 seconds, with freshOutputCount > 0 at every sample and now.",
          strictStable: "Alias of routeStable, retained unchanged from local-spiking-v3.",
          softStable: "Nonempty fresh-input cores with Jaccard >=0.8 at each of 18 consecutive 10-second transitions (19 samples over 180 seconds). Empty cores fail.",
          functionalStable: "Fresh-input delivery >=0.8 at all 19 consecutive 10-second samples over 180 seconds; no-input or no-fresh-output windows fail.",
          coreJaccard: "Intersection / union of current and previous sample's fresh-input route cores. Empty cores score zero; no previous sample gives null.",
          meanNeighborsInReach: "Mean other living cells within radius using all configured axes; includes I/O, excludes self. No synapses are required. Observer only.",
          meanOrdinaryNeighborsInReach: "Same census restricted to ordinary cells as observers; their neighbors still include I/O.",
          outputRateEMA: "Output rate in spikes/s, initialized at zero. After each tick: EMA += (1-exp(-dt/60)) * (outputSpikesThisTick/dt - EMA). Updated even when reward is disabled.",
          rewardPulse: this.task ? `Truth-table correctness gives +1 or -1 at the ${this.task.config.responseWindow}-s scoring boundary; zero on other ticks. Broadcast next tick with existing eligibility; replaces rate prediction error.` : "outputSpikesThisTick - pre-update outputRateEMA * dt; computed at tick end and broadcast on the next tick. Signed pulses potentiate or depress eligible synapses when reward is enabled."
        },
        metrics: this.metrics, newcomerOutcomes: this.newcomerOutcomes()
      };
    }
  }
  const api = { SpikingField, Environment, ChemicalField, SeededRandom, Neuron, Synapse, DEFAULTS, CONSOLIDATION_DEFAULTS, clamp, distance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SpikingSimulation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
