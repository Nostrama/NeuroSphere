(function (root) {
  "use strict";
  const { Neuron, Synapse, Environment } = typeof module !== "undefined" && module.exports ? require("./field.js") : root.SpikingSimulation;
  const { SpatialHash } = typeof module !== "undefined" && module.exports ? require("./spatial.js") : root.NeuronSpatial;
  const { localView, geometry, positionOf, DEFAULTS } = typeof module !== "undefined" && module.exports ? require("./neuron.js") : root.NeuronCore;
  const { SpikeIO } = typeof module !== "undefined" && module.exports ? require("./spike-io.js") : root.NeuronIO;
  const VERSION = "local-spiking-v4-locked/1";
  const clone = value => JSON.parse(JSON.stringify(value));
  const STATIC = ["id", "x", "y", "z", "age", "health", "radius", "threshold", "restLevel", "leakRate", "drivePeriod", "recordOutput", "inhibitory"];
  const DYNAMIC = ["potential", "refractoryUntil", "activity", "adaptation", "nextDriveAt", "spikeCount", "lastSpikeAt", "inbox", "charges", "lastTrigger"];
  const pick = (object, keys) => Object.fromEntries(keys.filter(k => object[k] !== undefined).map(k => [k, clone(object[k])]));
  function number(v, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isFinite(v) || v < min || v > max) throw new Error("Invalid controller " + label);
    return v;
  }
  function integer(v, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
    number(v, label, min, max); if (!Number.isSafeInteger(v)) throw new Error("Invalid controller " + label); return v;
  }
  function defaultIO(field) {
    return { inputs: field.neurons.filter(c => field.isInputCell(c.id)).map((c, i) => ({ name: "In" + (i + 1), cells: [c.id] })),
      outputs: field.neurons.filter(c => c.recordOutput).map((c, i) => ({ name: "Out" + (i + 1), cells: [c.id], mode: "count" })) };
  }
  function compile(field, { io = null, name = "Locked circuit", cap = null } = {}) {
    if (!field.circuitLock || field.neurons.some(c => !c.circuitLocked) || field.links.some(s => !s.circuitLocked)) throw new Error("Lock the complete circuit before exporting it.");
    if (field.task) throw new Error("Logic trial scheduling and teaching rewards are external. Export a plain locked circuit with explicit input adapters.");
    const live = new Set(field.neurons.map(c => c.id));
    const adapter = new SpikeIO(io ?? field._developmentSession?.io?.config ?? defaultIO(field), field.neurons, field.config.dt);
    const regional = cap ?? (field.assembly && field.features.zoneCap ? {
      k: field.assembly.k, windowTicks: field.features.windowCap ? field.assembly.windowTicks : 0,
      zones: Object.fromEntries(Object.entries(field.assembly.zones).map(([z, ids]) => [z, ids.filter(id => live.has(id))]))
    } : null);
    const nodes = field.neurons.map(c => pick(c, STATIC));
    const edges = field.links.filter(s => s.active && live.has(s.targetId)).map(s => pick(s, ["id", "sourceId", "targetId", "weight", "delay", "inhibitory", "consolidated", "tract"]));
    const artifact = { schema: "neuron-controller/v1", runtime: VERSION, name, model: "local-spiking-v4", seed: field.seed,
      provenance: { lockedAt: field.circuitLock.time, reason: field.circuitLock.reason, sourceTime: field.time, omittedDeadTargetEdges: field.links.length - edges.length },
      config: clone(field.config), features: clone(field.features), nodes, edges, io: adapter.config, cap: clone(regional),
      endpointIds: field.endpointIds.filter(id => live.has(id)), inputIds: field.neurons.filter(c => field.isInputCell(c.id)).map(c => c.id),
      domains: field._developmentSession ? clone(field._developmentSession.domains) : [],
      reset: "Rest membrane, zero fast adaptation/activity, empty queues, input schedules start from adapters. Age and threshold retain their locked values." };
    // Export is also validation; consumers never receive a silently truncated graph.
    new LockedController(artifact);
    return artifact;
  }
  class LockedController {
    constructor(artifact, onSpike = null) {
      if (artifact?.schema !== "neuron-controller/v1" || artifact.runtime !== VERSION || artifact.model !== "local-spiking-v4") throw new Error("Unsupported controller format or runtime version.");
      this.artifact = clone(artifact);
      const a = this.artifact;
      this.config = { ...DEFAULTS, ...a.config, ...geometry(a.config) };
      number(this.config.dt, "time step", .001, .1);
      for (const [key, v] of Object.entries(DEFAULTS)) if (typeof v === "number") number(this.config[key], key, key === "restLevel" ? -10 : 0, 10000);
      if (this.config.pairingClock !== undefined && !["emission", "arrival"].includes(this.config.pairingClock)) throw new Error("Invalid controller pairing clock.");
      if (!a.features || Object.values(a.features).some(v => typeof v !== "boolean")) throw new Error("Invalid controller features.");
      for (const key of ["inhibitionStrength", "inhibitionRadiusFactor", "criticalPeriod"]) if (this.config[key] !== undefined) number(this.config[key], key, 0, key === "inhibitionRadiusFactor" ? 1 : 10000);
      if (!Array.isArray(a.nodes) || !a.nodes.length || a.nodes.length > 2000 || !Array.isArray(a.edges) || a.edges.length > 24000) throw new Error("Invalid controller population.");
      this.features = clone(a.features);
      this.axes = Object.keys(this.config.extent); this.width = this.config.extent.x; this.height = this.config.extent.y;
      this.seed = a.seed;
      this.time = 0; this.tick = 0; this.accumulator = 0;
      this.circuitLock = clone(a.provenance);
      this.neurons = []; this.archive = [];
      const byId = new Map();
      for (const saved of a.nodes) {
        integer(saved.id, "cell ID", 1);
        if (byId.has(saved.id)) throw new Error("Duplicate controller cell.");
        for (const axis of this.axes) number(saved[axis], "cell position", 0, this.config.extent[axis]);
        if (this.config.dimensions === 2 && saved.z !== undefined) throw new Error("Unexpected depth in 2D controller.");
        for (const key of ["age", "radius", "threshold", "leakRate"]) number(saved[key], key, 0, 1e8);
        number(saved.health, "health", Number.MIN_VALUE, 1); number(saved.restLevel, "rest level", -10, 10);
        if (saved.drivePeriod !== null) number(saved.drivePeriod, "drive period", .001, 1e8);
        if (typeof saved.recordOutput !== "boolean" || saved.inhibitory !== undefined && typeof saved.inhibitory !== "boolean") throw new Error("Invalid controller cell type.");
        const cell = new Neuron({ id: saved.id, ...positionOf(saved), config: this.config, inhibitory: saved.inhibitory });
        Object.assign(cell, pick(saved, STATIC));
        cell.potential = cell.restLevel; cell.nextDriveAt = cell.drivePeriod;
        cell.circuitLocked = true;
        this.neurons.push(cell); byId.set(cell.id, cell);
      }
      for (const key of ["endpointIds", "inputIds"]) if (!Array.isArray(a[key]) || new Set(a[key]).size !== a[key].length || a[key].some(id => !byId.has(id))) throw new Error("Invalid controller endpoint identities.");
      this.endpointIds = [...a.endpointIds]; this.inputIds = new Set(a.inputIds);
      const edgeIds = new Set(), pairs = new Set();
      for (const saved of a.edges) {
        if (typeof saved.id !== "string" || !saved.id.startsWith(saved.sourceId + "/s") || edgeIds.has(saved.id) || !byId.has(saved.sourceId) || !byId.has(saved.targetId) || saved.sourceId === saved.targetId || pairs.has(saved.sourceId + "/" + saved.targetId)) throw new Error("Invalid controller connection.");
        number(saved.weight, "weight", -1, this.config.maxWeight); number(saved.delay, "delay", .001, 10);
        if (Boolean(saved.inhibitory) !== Boolean(byId.get(saved.sourceId).inhibitory) || typeof saved.consolidated !== "boolean") throw new Error("Invalid controller terminal type.");
        const source = byId.get(saved.sourceId), target = byId.get(saved.targetId);
        const synapse = new Synapse(saved.id, source, target, this.config, 0, saved.weight);
        Object.assign(synapse, pick(saved, ["delay", "consolidated", "tract"]));
        synapse.circuitLocked = true; source.synapses.push(synapse);
        edgeIds.add(saved.id); pairs.add(saved.sourceId + "/" + saved.targetId);
      }
      this.cap = clone(a.cap); this.members = {};
      if (this.cap) {
        integer(this.cap.k, "cap size", 1, 2000); integer(this.cap.windowTicks, "cap window", 0, 100000);
        const assigned = new Set();
        if (!this.cap.zones || !Object.keys(this.cap.zones).length) throw new Error("Missing cap zones.");
        for (const [zone, ids] of Object.entries(this.cap.zones)) {
          if (!Array.isArray(ids) || ids.some(id => !byId.has(id) || assigned.has(id)) || new Set(ids).size !== ids.length) throw new Error("Invalid cap zones.");
          ids.forEach(id => assigned.add(id)); this.members[zone] = new Map();
        }
      }
      this.io = new SpikeIO(a.io, this.neurons, this.config.dt);
      this.env = new Environment(this);
      // Chemistry and reward cannot influence a locked circuit. Keep the same
      // environment interface without allocating a grid or training histories.
      this.chemical = { sample: () => 0, deposit: () => {} };
      this.rewardPulse = 0;
      this.onSpike = onSpike;
      this.events = [];
      this.stats = { spikes: 0, outputSpikes: 0 };
      this._byId = byId;
    }
    isInputCell(id) { return this.inputIds.has(id); }
    getNeuron(id) { return this._byId.get(id); }
    get links() { return this.neurons.flatMap(c => c.synapses); }
    observe(event) {
      if (event.type !== "spike") throw new Error("A locked controller attempted a structural change.");
      this.stats.spikes++;
      if (event.output) this.stats.outputSpikes++;
      this.events.push(event);
      this.io.observe(event.spike);
      if (this.cap?.windowTicks && !this.io.pulsed.has(event.spike.neuronId)) for (const [zone, ids] of Object.entries(this.cap.zones)) {
        if (ids.includes(event.spike.neuronId)) this.members[zone].set(event.spike.neuronId, this.tick);
      }
      this.onSpike?.(event.spike, event.output);
    }
    step() {
      this.tick++; this.time = this.tick * this.config.dt; this.events = [];
      this.io.prepare(this.tick);
      const blocked = new Set();
      if (this.cap) for (const [zone, ids] of Object.entries(this.cap.zones)) {
        const members = this.members[zone];
        for (const [id, tick] of members) if (tick <= this.tick - this.cap.windowTicks) members.delete(id);
        const candidates = ids.map(id => this.getNeuron(id)).filter(c => !this.io.inputIds.has(c.id) && this.time >= c.refractoryUntil)
          .map(c => ({ cell: c, ...c.previewThreshold(this.config.dt, this.time) })).filter(c => c.potential >= c.threshold)
          .sort((a, b) => b.potential - a.potential || a.cell.id - b.cell.id);
        const admitted = new Set(this.cap.windowTicks ? members.keys() : []);
        for (const { cell } of candidates) {
          if (!admitted.has(cell.id) && admitted.size >= this.cap.k) blocked.add(cell.id);
          else admitted.add(cell.id);
        }
      }
      const frame = this.neurons.map(localView);
      if (!this._spatial) this._spatial = new SpatialHash(this.neurons); else this._spatial.update(this.neurons);
      this._frame = frame;
      for (const cell of this.neurons) {
        const env = this.io.environment(cell, this.env.forNeuron(cell, frame));
        if (blocked.has(cell.id)) env.zoneCapBlocked = true;
        cell.step(this.config.dt, env);
      }
      return this.events;
    }
    advance(seconds) {
      number(seconds, "duration");
      const total = this.accumulator + seconds, steps = Math.floor((total + 1e-10) / this.config.dt);
      this.accumulator = Math.max(0, total - steps * this.config.dt);
      for (let i = 0; i < steps; i++) this.step();
    }
    checkpoint() {
      return clone({ schema: "neuron-controller-checkpoint/v1", artifact: this.artifact, state: {
        time: this.time, tick: this.tick, accumulator: this.accumulator, stats: this.stats,
        neurons: this.neurons.map(c => ({ id: c.id, ...pick(c, DYNAMIC) })), io: this.io.checkpoint(),
        members: Object.fromEntries(Object.entries(this.members).map(([z, map]) => [z, [...map]])) } });
    }
    static restore(saved, onSpike = null) {
      if (saved?.schema !== "neuron-controller-checkpoint/v1") throw new Error("Unsupported controller checkpoint.");
      const runtime = new LockedController(saved.artifact, onSpike), s = clone(saved.state);
      integer(s.tick, "checkpoint tick"); number(s.time, "checkpoint time");
      if (s.time !== s.tick * runtime.config.dt) throw new Error("Inconsistent controller clock.");
      number(s.accumulator, "accumulator", 0, runtime.config.dt);
      if (!Array.isArray(s.neurons) || JSON.stringify(s.neurons.map(c => c.id)) !== JSON.stringify(runtime.neurons.map(c => c.id))) throw new Error("Checkpoint population does not match circuit.");
      for (const savedCell of s.neurons) {
        const cell = runtime.getNeuron(savedCell.id);
        for (const key of ["potential", "refractoryUntil", "activity", "adaptation", "spikeCount"]) number(savedCell[key], key, key === "potential" ? -1e9 : 0);
        for (const key of ["nextDriveAt", "lastSpikeAt"]) if (savedCell[key] !== null) number(savedCell[key], key);
        if (!Array.isArray(savedCell.inbox) || !Array.isArray(savedCell.charges) || savedCell.inbox.length > 100000 || savedCell.charges.length > 100000) throw new Error("Invalid checkpoint messages.");
        for (const m of savedCell.inbox) {
          number(m.at, "message time", 0); number(m.weight, "message weight", -1e9, 1e9);
          if (typeof (m.synapseId ?? m.inhibitionId) !== "string") throw new Error("Invalid message identity.");
        }
        for (const c of savedCell.charges) { number(c.amount, "charge", -1e9, 1e9); if (!c.inhibition && typeof c.spikeId !== "string") throw new Error("Invalid charge identity."); }
        Object.assign(cell, pick(savedCell, DYNAMIC));
      }
      runtime.io.restore(s.io);
      if (runtime.io.tick !== s.tick) throw new Error("Adapter and runtime clocks differ.");
      if (JSON.stringify(Object.keys(s.members ?? {})) !== JSON.stringify(Object.keys(runtime.members))) throw new Error("Invalid cap checkpoint.");
      for (const [zone, entries] of Object.entries(s.members)) {
        if (!Array.isArray(entries) || entries.length > runtime.cap.k || new Set(entries.map(e => e[0])).size !== entries.length || entries.some(e => !runtime.cap.zones[zone].includes(e[0]) || !Number.isInteger(e[1]) || e[1] > s.tick || e[1] <= s.tick - runtime.cap.windowTicks)) throw new Error("Invalid cap membership.");
        runtime.members[zone] = new Map(entries);
      }
      for (const key of ["spikes", "outputSpikes"]) integer(s.stats?.[key], "spike counter");
      runtime.time = s.time; runtime.tick = s.tick; runtime.accumulator = s.accumulator; runtime.stats = s.stats;
      return runtime;
    }
  }
  // Warm import carries electrical state, not the research observer's history.
  function resume(field, options = {}) {
    if (field.assembly || field.task) throw new Error("Keep the full research snapshot to resume its external presentation schedule. Reset export supports an explicit replacement cue schedule.");
    if (!options.io && !field._developmentSession?.io) options = { ...options, io: { inputs: [], outputs: defaultIO(field).outputs } };
    const runtime = new LockedController(compile(field, options));
    const checkpoint = runtime.checkpoint();
    checkpoint.state.time = field.time; checkpoint.state.tick = field.tick; checkpoint.state.accumulator = field.accumulator;
    checkpoint.state.neurons = field.neurons.map(c => ({ id: c.id, ...pick(c, DYNAMIC) }));
    checkpoint.state.io = field._developmentSession?.io?.checkpoint() ?? { ...runtime.io.checkpoint(), tick: field.tick };
    if (field.assembly && runtime.cap?.windowTicks) checkpoint.state.members = Object.fromEntries(Object.entries(field.assembly.windowMembers).map(([z, map]) => [z, [...map].filter(([id]) => runtime.cap.zones[z].includes(id))]));
    return LockedController.restore(checkpoint);
  }
  function structure(artifact) {
    const outgoing = new Map(artifact.nodes.map(c => [c.id, []]));
    for (const e of artifact.edges) outgoing.get(e.sourceId).push(e);
    const inputs = [...new Set(artifact.io.inputs.flatMap(c => c.cells))], outputs = new Set(artifact.io.outputs.flatMap(c => c.cells)), paths = [];
    for (const input of inputs) {
      const costs = new Map([[input, 0]]), hops = new Map([[input, 0]]), unsettled = new Set(outgoing.keys());
      while (unsettled.size) {
        const id = [...unsettled].sort((a, b) => (costs.get(a) ?? Infinity) - (costs.get(b) ?? Infinity) || a - b)[0];
        unsettled.delete(id); if (!costs.has(id)) break;
        for (const edge of outgoing.get(id)) if (costs.get(id) + edge.delay < (costs.get(edge.targetId) ?? Infinity)) costs.set(edge.targetId, costs.get(id) + edge.delay);
      }
      const queue = [input];
      while (queue.length) { const id = queue.shift(); for (const e of outgoing.get(id)) if (!hops.has(e.targetId)) { hops.set(e.targetId, hops.get(id) + 1); queue.push(e.targetId); } }
      for (const output of outputs) paths.push({ input, output, shortestHops: hops.get(output) ?? null, shortestDelay: costs.get(output) ?? null });
    }
    // Weak-component surplus is a structural redundancy measure, not a count
    // of successful or independent computational paths.
    const adjacency = new Map(artifact.nodes.map(c => [c.id, new Set()]));
    for (const e of artifact.edges) { adjacency.get(e.sourceId).add(e.targetId); adjacency.get(e.targetId).add(e.sourceId); }
    const unseen = new Set(adjacency.keys()); let components = 0;
    while (unseen.size) { components++; const queue = [unseen.values().next().value]; unseen.delete(queue[0]); while (queue.length) for (const peer of adjacency.get(queue.shift())) if (unseen.delete(peer)) queue.push(peer); }
    return { cells: artifact.nodes.length, synapses: artifact.edges.length, bytes: new TextEncoder().encode(JSON.stringify(artifact)).length,
      weakComponents: components, edgesBeyondSpanningForest: artifact.edges.length - artifact.nodes.length + components, paths,
      interpretation: "Shortest paths use directed anatomical edges (including inhibitory edges), not proof of signal delivery. Surplus counts edges beyond a weak spanning forest." };
  }
  const api = { VERSION, compile, resume, LockedController, structure, defaultIO };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NeuronController = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
