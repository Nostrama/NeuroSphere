(function (root) {
  "use strict";
  const { SpikeIO } = typeof module !== "undefined" && module.exports ? require("./spike-io.js") : root.NeuronIO;
  const clone = value => JSON.parse(JSON.stringify(value));
  // A supplied spatial design, not an emergent identity or a routing oracle.
  class DevelopmentSession {
    constructor(field, plan = {}, io = null) {
      if (field.task || field.assembly) throw new Error("Use a plain field for a development plan; research apparatus already owns its stimuli.");
      if (field._developmentSession) throw new Error("This field already has a development session.");
      this.field = field;
      this.plan = clone(plan);
      this.domains = plan.domains ?? [];
      const names = new Set();
      for (const d of this.domains) {
        if (typeof d.name !== "string" || !/^[A-Za-z][\w-]{0,31}$/.test(d.name) || names.has(d.name)) throw new Error("Invalid domain name.");
        names.add(d.name);
        for (const axis of field.axes) if (!Array.isArray(d.bounds?.[axis]) || d.bounds[axis].length !== 2 || !d.bounds[axis].every(Number.isFinite) || d.bounds[axis][0] < 0 || d.bounds[axis][1] > field.config.extent[axis] || d.bounds[axis][0] >= d.bounds[axis][1]) throw new Error("Domain bounds must lie inside the volume.");
      }
      this.membership = new Map(field.neurons.map(cell => {
        const found = this.domains.filter(d => field.axes.every(a => cell[a] >= d.bounds[a][0] && (cell[a] < d.bounds[a][1] || d.bounds[a][1] === field.config.extent[a] && cell[a] === d.bounds[a][1])));
        if (found.length > 1) throw new Error("A cell cannot belong to overlapping domains.");
        return [cell.id, found[0]?.name ?? null];
      }));
      if (plan.communication !== undefined && (!Array.isArray(plan.communication) || plan.communication.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(name => !names.has(name))))) throw new Error("Communication pairs must name two configured domains.");
      this.sources = plan.sources ?? [];
      if (!Array.isArray(this.sources) || this.sources.length > 10000 || this.sources.some(s => !Number.isFinite(s.rate) || s.rate < 0 || s.rate > 10000 || field.axes.some(a => !Number.isFinite(s[a]) || s[a] < 0 || s[a] > field.config.extent[a]))) throw new Error("Invalid synthetic attractant sources.");
      if (this.sources.length && !field.features.gradient) throw new Error("Enable the existing gradient feature to use synthetic sources.");
      this.trigger = plan.lock ?? null;
      if (this.trigger && (this.trigger.kind === "time" ? !Number.isFinite(this.trigger.seconds) || this.trigger.seconds < field.time
        : this.trigger.kind === "validated" ? !Number.isFinite(this.trigger.minimumDelivery) || this.trigger.minimumDelivery < 0 || this.trigger.minimumDelivery > 1 || !Number.isInteger(this.trigger.samples) || this.trigger.samples < 1
          : true)) throw new Error("Lock trigger must specify a future time or validated delivery and sample count.");
      if (field.links.some(s => !this.permits(s.sourceId, s.targetId))) throw new Error("Existing connections violate this plan; apply it before growth.");
      this.io = io ? new SpikeIO(io, field.neurons, field.config.dt) : null;
      if (this.io) this.io.tick = field.tick;
      this.streak = 0;
      this.lastValidationTick = -1;
      const previous = field.env.forNeuron.bind(field.env);
      field.env.forNeuron = (cell, frame) => {
        const env = previous(cell, frame), sense = env.sense;
        env.sense = () => sense().filter(peer => this.permits(cell.id, peer.id));
        return this.io ? this.io.environment(cell, env) : env;
      };
      const observe = field.onEvent;
      field.onEvent = event => { if (event.type === "spike") this.io?.observe(event.spike); observe(event); };
      Object.defineProperty(field, "_developmentSession", { value: this });
    }
    permits(source, target) {
      if (!this.plan.communication) return true;
      const a = this.membership.get(source), b = this.membership.get(target);
      return a === b || this.plan.communication.some(pair => pair[0] === a && pair[1] === b);
    }
    step() {
      const f = this.field;
      if (!f.circuitLock) for (const source of this.sources) f.chemical.deposit(source, source.rate * f.config.dt);
      this.io?.prepare(f.tick + 1);
      f.step();
      if (!this.trigger || f.circuitLock) return;
      if (this.trigger.kind === "time" && f.time + 1e-9 >= this.trigger.seconds) f.lockCircuit("scheduled at " + this.trigger.seconds + " s");
      if (this.trigger.kind === "validated" && f.tick % Math.round(10 / f.config.dt) === 0 && this.lastValidationTick !== f.tick) {
        this.lastValidationTick = f.tick;
        const m = f.metrics.at(-1);
        this.streak = m.freshOutputCount > 0 && m.deliveryRate >= this.trigger.minimumDelivery ? this.streak + 1 : 0;
        if (this.streak >= this.trigger.samples) f.lockCircuit("external delivery validation");
      }
    }
    checkpoint() { return { schema: "neuron-development/v1", snapshot: this.field.snapshot(), plan: clone(this.plan), io: this.io ? clone(this.io.config) : null, ioState: this.io?.checkpoint() ?? null, streak: this.streak, lastValidationTick: this.lastValidationTick }; }
    static restore(saved, SpikingField) {
      if (saved?.schema !== "neuron-development/v1") throw new Error("Unsupported development checkpoint.");
      const plan = clone(saved.plan), trigger = plan.lock; delete plan.lock;
      const session = new DevelopmentSession(SpikingField.fromSnapshot(saved.snapshot), plan, saved.io);
      session.plan.lock = trigger; session.trigger = trigger;
      session.streak = saved.streak; session.lastValidationTick = saved.lastValidationTick;
      if (session.io) session.io.restore(saved.ioState);
      return session;
    }
  }
  function sourcesFromDestinations(destinations, totalRate = 8) {
    if (!Array.isArray(destinations) || !destinations.length || !Number.isFinite(totalRate) || totalRate < 0) throw new Error("Supply destinations and a nonnegative total secretion rate.");
    const weights = destinations.map(d => d.weight ?? 1);
    if (weights.some(w => !Number.isFinite(w) || w < 0) || !weights.some(w => w > 0)) throw new Error("Destination weights must have a positive total.");
    const total = weights.reduce((sum, w) => sum + w, 0);
    return destinations.map((d, i) => ({ x: d.x, y: d.y, ...(d.z !== undefined ? { z: d.z } : {}), rate: totalRate * weights[i] / total }));
  }
  const api = { DevelopmentSession, sourcesFromDestinations };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NeuronDevelopment = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
