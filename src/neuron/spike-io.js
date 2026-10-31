(function (root) {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  const finite = (value, label, min, max) => {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error("Invalid " + label);
    return value;
  };
  // External transduction only. No encoder sees network activity or finds paths.
  class SpikeIO {
    constructor(config, cells, dt, saved = null) {
      this.dt = dt;
      const ids = new Set(cells.map(cell => cell.id)), names = new Set(), occupied = new Set();
      const channels = (list, input) => (list ?? []).map(channel => {
        if (!channel || typeof channel.name !== "string" || !/^[A-Za-z][\w-]{0,31}$/.test(channel.name) || names.has(channel.name)) throw new Error("Channel names must be unique short names.");
        names.add(channel.name);
        if (!Array.isArray(channel.cells) || !channel.cells.length || new Set(channel.cells).size !== channel.cells.length || channel.cells.some(id => !ids.has(id))) throw new Error("A channel needs distinct living cells.");
        if (input && channel.cells.some(id => occupied.has(id))) throw new Error("Input zones must not overlap.");
        if (input) channel.cells.forEach(id => occupied.add(id));
        const result = { name: channel.name, cells: [...channel.cells] };
        if (input) {
          result.min = finite(channel.min ?? 0, "input minimum", -1e9, 1e9);
          result.max = finite(channel.max ?? 1, "input maximum", result.min + 1e-9, 1e9);
          result.maxRate = finite(channel.maxRate ?? 1 / 1.8, "maximum input rate", 0, 1 / dt);
        } else {
          result.mode = channel.mode ?? "count";
          if (!["count", "rate", "presence"].includes(result.mode)) throw new Error("Unknown output decoding mode.");
        }
        return result;
      });
      this.config = { inputs: channels(config?.inputs, true), outputs: channels(config?.outputs, false) };
      this.inputIds = occupied;
      this.values = this.config.inputs.map(() => 0);
      this.phases = this.config.inputs.map(() => 0);
      this.queue = [];
      this.pulsed = new Set();
      this.counts = this.config.outputs.map(() => 0);
      this.elapsed = 0;
      this.tick = 0;
      if (saved) this.restore(saved);
    }
    encode(values) {
      if (!Array.isArray(values) || values.length !== this.config.inputs.length || values.some(v => !Number.isFinite(v))) throw new Error("Supply one finite value per input channel.");
      this.values = values.map((v, i) => Math.max(0, Math.min(1, (v - this.config.inputs[i].min) / (this.config.inputs[i].max - this.config.inputs[i].min))));
      return [...this.values];
    }
    pulse(name, atTick = this.tick + 1) {
      const index = this.config.inputs.findIndex(c => c.name === name);
      if (index < 0 || !Number.isSafeInteger(atTick) || atTick <= this.tick) throw new Error("Schedule a known input on a future whole tick.");
      if (!this.queue.some(e => e.tick === atTick && e.index === index)) this.queue.push({ tick: atTick, index });
      this.queue.sort((a, b) => a.tick - b.tick || a.index - b.index);
    }
    prepare(tick) {
      if (tick !== this.tick + 1) throw new Error("Adapter ticks must be consecutive.");
      this.tick = tick;
      this.pulsed.clear();
      const fire = index => this.config.inputs[index].cells.forEach(id => this.pulsed.add(id));
      this.phases = this.phases.map((phase, i) => {
        phase += this.values[i] * this.config.inputs[i].maxRate * this.dt;
        if (phase + 1e-12 >= 1) { fire(i); phase = Math.max(0, phase - 1); }
        return phase;
      });
      while (this.queue.length && this.queue[0].tick <= tick) fire(this.queue.shift().index);
      this.elapsed++;
    }
    environment(cell, env) {
      if (this.inputIds.has(cell.id)) {
        env.inputExempt = true;
        env.inputClamped = true;
        env.inputPulse = this.pulsed.has(cell.id);
      }
      return env;
    }
    observe(spike) {
      this.config.outputs.forEach((c, i) => { if (c.cells.includes(spike.neuronId)) this.counts[i]++; });
    }
    decode(reset = true) {
      const duration = this.elapsed * this.dt;
      const result = { duration, values: Object.fromEntries(this.config.outputs.map((c, i) => [c.name,
        c.mode === "presence" ? this.counts[i] > 0 : c.mode === "rate" ? (duration ? this.counts[i] / duration : 0) : this.counts[i]])), counts: [...this.counts] };
      if (reset) { this.counts.fill(0); this.elapsed = 0; }
      return result;
    }
    checkpoint() { return clone({ values: this.values, phases: this.phases, queue: this.queue, counts: this.counts, elapsed: this.elapsed, tick: this.tick }); }
    restore(saved) {
      if (!saved || !Number.isSafeInteger(saved.tick) || saved.tick < 0 || !Number.isSafeInteger(saved.elapsed) || saved.elapsed < 0 || saved.elapsed > saved.tick) throw new Error("Invalid adapter clock.");
      for (const key of ["values", "phases", "counts"]) {
        if (!Array.isArray(saved[key]) || saved[key].length !== this[key].length) throw new Error("Invalid adapter channels.");
        saved[key].forEach(v => finite(v, "adapter " + key, 0, key === "counts" ? Number.MAX_SAFE_INTEGER : 1));
      }
      if (!Array.isArray(saved.queue) || saved.queue.length > 100000 || saved.queue.some(e => !Number.isSafeInteger(e.tick) || e.tick <= saved.tick || !Number.isInteger(e.index) || e.index < 0 || e.index >= this.values.length)) throw new Error("Invalid adapter schedule.");
      for (const key of ["values", "phases", "queue", "counts", "elapsed", "tick"]) this[key] = clone(saved[key]);
      this.queue.sort((a, b) => a.tick - b.tick || a.index - b.index);
    }
  }
  const api = { SpikeIO };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NeuronIO = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
