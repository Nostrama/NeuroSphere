(function (root) {
  "use strict";
  const clamp = (x, min = 0, max = 1) => Math.max(min, Math.min(max, x));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const localTargets = new WeakMap();
  function localView(neuron) {
    const view = Object.freeze({
      id: neuron.id, x: neuron.x, y: neuron.y, alive: neuron.alive,
      activity: neuron.activity, youth: neuron.youth, demand: neuron.demand
    });
    localTargets.set(view, neuron);
    return view;
  }
  const DEFAULTS = Object.freeze({
    dt: 0.02, radius: 195, restLevel: 0, threshold: 1.02, leakRate: 1.4,
    refractory: 1.35, inputPeriod: 1.8, initialWeight: 1.25, weightFloor: 0.15,
    maxWeight: 1.65, weightDecay: 0.0015, unusedDecay: 0.004,
    hebbianRate: 0.018, stdpWindow: 0.32, eligibilityTau: 1.8,
    growthPeriod: 1.8, maxSynapses: 3, healthLoss: 0.0006,
    healthGain: 0.016, maturation: 90, rewardRate: 0.07, outputRateTau: 60,
    youthAttraction: 0.65, gradientAttraction: 2.8, competitionMargin: 0.35,
    competitionCost: 0.12, demandAttraction: 1.4, exploration: 0.3
  });

  class Synapse {
    constructor(id, source, target, config, time, weight = config.initialWeight) {
      this.id = id;
      this.sourceId = source.id;
      this.targetId = target.id;
      this.target = target;
      this.weight = weight;
      this.createdAt = time;
      this.lastPreSpike = null;
      this.lastPostSpike = null;
      this.eligibility = 0;
      this.active = true;
      this.delay = 0.04 + distance(source, target) / 1800;
      this.deliveries = 0;
      target.incoming.push(this);
    }

    // The only transmission interface. No neuron calls another neuron's methods.
    deliver(spike) {
      if (!this.active || !this.target.alive) return;
      this.lastPreSpike = spike.time;
      this.deliveries++;
      this.target.inbox.push({
        at: spike.time + this.delay, sentAt: spike.time, spikeId: spike.id,
        synapseId: this.id, weight: this.weight
      });
    }

    notePostSpike(time, config, hebbian) {
      this.lastPostSpike = time;
      if (this.lastPreSpike === null) return;
      const lag = time - this.lastPreSpike;
      if (lag < 0 || lag > config.stdpWindow) return;
      const association = Math.exp(-lag / config.stdpWindow);
      this.eligibility = clamp(this.eligibility + association);
      if (hebbian) this.weight = clamp(this.weight + config.hebbianRate * association, 0, config.maxWeight);
    }

    step(dt, env, config) {
      this.eligibility *= Math.exp(-dt / config.eligibilityTau);
      const unused = this.lastPostSpike === null || env.time - this.lastPostSpike > 20;
      this.weight -= dt * (config.weightDecay + (unused ? config.unusedDecay : 0));
      if (env.features.reward && env.reward !== 0) {
        this.weight = clamp(this.weight + config.rewardRate * this.eligibility * env.reward, 0, config.maxWeight);
      }
      return this.target.alive && this.weight >= config.weightFloor;
    }

    prune() {
      if (!this.active) return;
      this.active = false;
      this.target.incoming = this.target.incoming.filter(synapse => synapse !== this);
    }

    toJSON() {
      const { target, ...state } = this;
      return state;
    }
  }

  class Neuron {
    constructor({ id, x, y, config = DEFAULTS, drivePeriod = null, recordOutput = false, secretionRate = 0, bornAt = 0 }) {
      this.id = id;
      this.x = x;
      this.y = y;
      this.config = config;
      this.radius = config.radius;
      this.potential = config.restLevel;
      this.restLevel = config.restLevel;
      this.threshold = config.threshold;
      this.leakRate = config.leakRate;
      this.refractoryUntil = 0;
      this.health = 0.95;
      this.age = 0;
      this.bornAt = bornAt;
      this.alive = true;
      this.activity = 0;
      this.adaptation = 0;
      this.growthBudget = 0;
      this.nextGrowthAt = bornAt;
      this.drivePeriod = drivePeriod;
      this.nextDriveAt = drivePeriod === null ? null : bornAt + drivePeriod;
      this.recordOutput = recordOutput;
      this.secretionRate = secretionRate;
      this.spikeCount = 0;
      this.lastSpikeAt = null;
      this.nextSynapseId = 1;
      this.synapses = [];
      this.incoming = [];
      this.inbox = [];
      this.charges = [];
      this.lastTrigger = null;
      this.deathAt = null;
    }

    get youth() { return Math.exp(-this.age / this.config.maturation); }
    // A trophic cue derived solely from this cell's activity and own dendrites.
    // Dormant, uninnervated cells advertise the greatest unmet demand.
    get demand() { return (1 - clamp(this.activity)) / (1 + this.incoming.filter(synapse => synapse.active).length); }
    get firingThreshold() { return this.threshold - 0.14 * this.youth + this.adaptation; }

    connect(target, time, weight) {
      target = localTargets.get(target) || target;
      if (!this.alive || !target.alive || target === this || distance(this, target) > this.radius) return null;
      if (this.synapses.some(synapse => synapse.targetId === target.id)) return null;
      if (this.synapses.length >= this.config.maxSynapses) return null;
      const synapse = new Synapse(this.id + "/s" + this.nextSynapseId++, this, target, this.config, time, weight);
      this.synapses.push(synapse);
      return synapse;
    }

    fire(env, driven = false) {
      const time = env.time;
      this.spikeCount++;
      const spike = {
        id: this.id + "/p" + this.spikeCount, neuronId: this.id, time,
        triggerSynapseId: driven ? null : this.lastTrigger,
        parents: driven ? [] : this.charges.filter(charge => charge.amount > 1e-7).map(charge => ({
          spikeId: charge.spikeId, synapseId: charge.synapseId, contribution: charge.amount
        })),
        driven
      };
      this.lastSpikeAt = time;
      this.activity = 1;
      this.health = clamp(this.health + this.config.healthGain);
      this.growthBudget = Math.min(3, this.growthBudget + 1);
      this.adaptation += 0.08;
      this.potential = this.restLevel;
      this.refractoryUntil = time + this.config.refractory;
      this.charges = [];
      this.lastTrigger = null;
      for (const synapse of this.incoming) synapse.notePostSpike(time, this.config, env.features.hebbian);
      for (const synapse of this.synapses) synapse.deliver(spike);
      env.observe({ type: "spike", spike, output: this.recordOutput });
    }

    grow(env) {
      if (this.activity < 0.2 || this.growthBudget < 1 || env.time < this.nextGrowthAt) return;
      this.nextGrowthAt = env.time + this.config.growthPeriod;
      const connected = new Set(this.synapses.map(synapse => synapse.targetId));
      const neighbors = env.sense().filter(neighbor => neighbor.alive);
      const candidates = neighbors.filter(neighbor => !connected.has(neighbor.id));
      if (!candidates.length) return;
      const ownChemical = env.chemical(this);
      const chemicalRange = Math.max(1e-8, ...neighbors.map(neighbor => Math.abs(env.chemical(neighbor) - ownChemical)));
      const score = neighbor => neighbor.activity + this.config.youthAttraction * neighbor.youth +
        this.config.demandAttraction * neighbor.demand +
        0.02 * (1 - distance(this, neighbor) / this.radius) +
        (env.features.gradient ? this.config.gradientAttraction * (env.chemical(neighbor) - ownChemical) / chemicalRange : 0);
      // Demand and youth are local trophic cues. Exploration is a fresh seeded
      // local choice at each growth attempt, never a route or destination hint.
      const ranked = candidates.map(neighbor => ({
        neuron: neighbor,
        score: score(neighbor) + env.random() * this.config.exploration
      })).sort((a, b) => b.score - a.score || a.neuron.id - b.neuron.id);
      if (this.synapses.length >= this.config.maxSynapses) {
        // Structural competition gradually weakens a poorly aligned terminal.
        // Existing objects survive until their weight actually crosses the floor.
        const local = new Map(neighbors.map(neighbor => [neighbor.id, neighbor]));
        const weakest = this.synapses.map(synapse => ({ synapse, score: local.has(synapse.targetId) ? score(local.get(synapse.targetId)) : -Infinity })).sort((a, b) => a.score - b.score)[0];
        if (weakest && ranked[0].score > weakest.score + this.config.competitionMargin) weakest.synapse.weight -= this.config.competitionCost;
        return;
      }
      const synapse = this.connect(ranked[0].neuron, env.time);
      if (synapse) {
        this.growthBudget--;
        env.observe({ type: "formed", synapse: synapse.toJSON() });
      }
    }

    step(dt, env) {
      if (!this.alive) return;
      if (env.features.gradient && this.secretionRate > 0) env.secrete(this.secretionRate * dt);
      const decay = Math.exp(-this.leakRate * dt);
      this.potential = this.restLevel + (this.potential - this.restLevel) * decay;
      for (const charge of this.charges) charge.amount *= decay;
      this.charges = this.charges.filter(charge => charge.amount > 1e-7);
      this.activity *= Math.exp(-dt / 2.2);
      this.adaptation *= Math.exp(-dt / 2.5);
      const due = [];
      const pending = [];
      for (const message of this.inbox) (message.at <= env.time + 1e-9 ? due : pending).push(message);
      this.inbox = pending;
      due.sort((a, b) => a.at - b.at || a.synapseId.localeCompare(b.synapseId));
      if (env.time >= this.refractoryUntil) {
        for (const message of due) {
          this.potential += message.weight;
          this.charges.push({ spikeId: message.spikeId, synapseId: message.synapseId, amount: message.weight });
          this.lastTrigger = message.synapseId;
        }
        const driven = this.nextDriveAt !== null && env.time + 1e-9 >= this.nextDriveAt;
        if (driven) {
          this.nextDriveAt += this.drivePeriod;
          this.fire(env, true);
        } else if (this.potential >= this.firingThreshold) {
          this.fire(env);
        }
      }
      const kept = [];
      for (const synapse of this.synapses) {
        if (synapse.step(dt, env, this.config)) kept.push(synapse);
        else {
          synapse.prune();
          env.observe({ type: "pruned", synapseId: synapse.id, sourceId: this.id, targetId: synapse.targetId });
        }
      }
      this.synapses = kept;
      this.grow(env);
      this.health = Math.max(0, this.health - dt * this.config.healthLoss);
      this.age += dt;
      if (this.health <= 0) {
        this.alive = false;
        this.deathAt = env.time;
        this.potential = this.restLevel;
        this.charges = [];
        this.inbox = [];
        for (const synapse of this.synapses) {
          synapse.prune();
          env.observe({ type: "pruned", synapseId: synapse.id, sourceId: this.id, targetId: synapse.targetId });
        }
        this.synapses = [];
        env.observe({ type: "died", neuronId: this.id });
      }
    }

    toJSON() {
      const { config, incoming, synapses, ...state } = this;
      return { ...state, synapses: synapses.map(synapse => synapse.toJSON()) };
    }
  }

  const api = { Neuron, Synapse, DEFAULTS, clamp, distance, localView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NeuronCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
