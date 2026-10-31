(function (root) {
  "use strict";
  const clamp = (x, min = 0, max = 1) => Math.max(min, Math.min(max, x));
  const AXES = Object.freeze(["x", "y", "z"]);
  const positionOf = point => Object.fromEntries(AXES.filter(axis => point[axis] !== undefined).map(axis => [axis, point[axis]]));
  function distance(a, b) {
    const deltas = [a.x - b.x, a.y - b.y];
    if (a.z !== undefined || b.z !== undefined) deltas.push((a.z ?? 0) - (b.z ?? 0));
    return Math.hypot(...deltas);
  }
  const localTargets = new WeakMap();
  function localView(neuron) {
    const view = Object.freeze({
      id: neuron.id, ...positionOf(neuron), alive: neuron.alive,
      activity: neuron.activity, youth: neuron.youth, demand: neuron.demand
    });
    localTargets.set(view, neuron);
    return view;
  }
  const DEFAULTS = Object.freeze({
    dimensions: 2, extent: Object.freeze({ x: 1000, y: 620 }),
    dt: 0.02, radius: 195, restLevel: 0, threshold: 1.02, leakRate: 1.4,
    refractory: 1.35, inputPeriod: 1.8, initialWeight: 1.25, weightFloor: 0.15,
    maxWeight: 1.65, weightDecay: 0.0015, unusedDecay: 0.004,
    hebbianRate: 0.018, stdpWindow: 0.32, eligibilityTau: 1.8,
    growthPeriod: 1.8, maxSynapses: 3, healthLoss: 0.0006,
    healthGain: 0.016, maturation: 90, rewardRate: 0.07, outputRateTau: 60,
    youthAttraction: 0.65, gradientAttraction: 2.8, competitionMargin: 0.35,
    competitionCost: 0.12, demandAttraction: 1.4, exploration: 0.3
  });
  // Separate, opt-in constants: existing A–D configuration values stay intact.
  const CONSOLIDATION_DEFAULTS = Object.freeze({ w_lock: 1.45, t_lock: 120, d_slow: 0.01, t_thaw: 300 });
  const COMPETITION_DEFAULTS = Object.freeze({ ltdFactor: 0.6, inhibitionRadiusFactor: 0.6, inhibitionStrength: 0.5 });
  const CRITICAL_INHIBITION_DEFAULTS = Object.freeze({ inhibitionStrength: 0.3, inhibitionRadiusFactor: 0.8, criticalPeriod: 600 });
  const HOMEOSTASIS_DEFAULTS = Object.freeze({ rateTau: 60, targetFactor: 0.25, gain: 0.02, floor: 0.5, ceiling: 2.0 });
  function geometry(config = {}) {
    const dimensions = config.dimensions ?? 2;
    if (![2, 3].includes(dimensions)) throw new Error("Dimensions must be 2 or 3.");
    const axes = AXES.slice(0, dimensions);
    const defaults = { x: 1000, y: 620, z: 620 };
    const extent = Object.fromEntries(axes.map(axis => [axis, config.extent?.[axis] ?? defaults[axis]]));
    if (axes.some(axis => !Number.isFinite(extent[axis]) || extent[axis] < 100 || extent[axis] > 10000)) {
      throw new Error("Each extent must be between 100 and 10000.");
    }
    return { dimensions, extent };
  }

  class Synapse {
    constructor(id, source, target, config, time, weight = config.initialWeight) {
      this.id = id;
      this.sourceId = source.id;
      this.targetId = target.id;
      this.target = target;
      if (source.inhibitory) this.inhibitory = true;
      this.weight = weight;
      this.createdAt = time;
      this.lastPreSpike = null;
      this.lastPostSpike = null;
      this.eligibility = 0;
      this.active = true;
      this.delay = 0.04 + distance(source, target) / 1800;
      this.deliveries = 0;
      this.consolidated = false;
      this.strongSince = null;
      if (config.pairingClock === "arrival") this.pendingPreSpikes = [];
      target.incoming.push(this);
    }

    fixScaffold(source) {
      this.fixed = true;
      Object.defineProperty(this, "fixedSource", { value: source, enumerable: false });
      this.weight = clamp(this.weight, 0.3, source.config.maxWeight);
    }

    // The only transmission interface. No neuron calls another neuron's methods.
    deliver(spike, config, features = {}) {
      if (!this.active || !this.target.alive || this.fixed && !this.fixedSource.alive) return;
      if (config.pairingClock === "arrival" && !this.circuitLocked) this.pendingPreSpikes.push(spike.time + this.delay);
      else this.notePreSpike(spike.time, config, features);
      this.deliveries++;
      this.target.inbox.push({
        at: spike.time + this.delay, sentAt: spike.time, spikeId: spike.id,
        synapseId: this.id, weight: features.inhibitoryPopulation && this.inhibitory ? -this.weight : this.weight,
        ...(features.inhibitoryPopulation && this.inhibitory ? { synapticInhibition: true } : {})
      });
    }

    notePreSpike(time, config, features) {
      if (this.circuitLocked) return;
      if (this.fixed && (!this.fixedSource.alive || !this.target.alive)) return;
      if (features.stdpDepression && !this.consolidated && this.lastPostSpike !== null) {
        const lag = this.lastPostSpike - time;
        if (lag < 0 && -lag <= config.stdpWindow)
          this.weight = Math.max(this.fixed ? 0.3 : 0, this.weight - COMPETITION_DEFAULTS.ltdFactor * config.hebbianRate * Math.exp(lag / config.stdpWindow));
      }
      this.lastPreSpike = time;
    }

    noteArrivals(time, config, features) {
      if (this.circuitLocked) return;
      if (!this.active || !this.target.alive) return;
      while (this.pendingPreSpikes.length && this.pendingPreSpikes[0] <= time + 1e-9)
        this.notePreSpike(this.pendingPreSpikes.shift(), config, features);
    }

    notePostSpike(time, config, hebbian) {
      if (this.circuitLocked) return;
      if (this.fixed && (!this.fixedSource.alive || !this.target.alive)) return;
      this.lastPostSpike = time;
      if (this.lastPreSpike === null) return;
      const lag = time - this.lastPreSpike;
      if (lag < 0 || lag > config.stdpWindow) return;
      const association = Math.exp(-lag / config.stdpWindow);
      this.eligibility = clamp(this.eligibility + association);
      if (hebbian) this.weight = clamp(this.weight + config.hebbianRate * association, 0, config.maxWeight);
    }

    updateConsolidation(time, config) {
      const wLock = config.w_lock ?? CONSOLIDATION_DEFAULTS.w_lock;
      const tLock = config.t_lock ?? CONSOLIDATION_DEFAULTS.t_lock;
      const tThaw = config.t_thaw ?? CONSOLIDATION_DEFAULTS.t_thaw;
      if (this.weight >= wLock) {
        if (this.strongSince === null) this.strongSince = time;
      } else this.strongSince = null;
      if (!this.consolidated && this.strongSince !== null && time - this.strongSince >= tLock)
        this.consolidated = true;
      // Only this synapse's own post-spike clock matters. Thaw wins a tie.
      if (this.consolidated && time - (this.lastPostSpike ?? this.createdAt) >= tThaw) {
        this.consolidated = false;
        this.strongSince = null;
      }
    }

    step(dt, env, config) {
      if (this.circuitLocked) return true;
      this.eligibility *= Math.exp(-dt / config.eligibilityTau);
      if (env.features.consolidation) this.updateConsolidation(env.time, config);
      const unused = this.lastPostSpike === null || env.time - this.lastPostSpike > 20;
      const loss = dt * (config.weightDecay + (unused ? config.unusedDecay : 0));
      this.weight -= env.features.consolidation && this.consolidated
        ? loss * (config.d_slow ?? CONSOLIDATION_DEFAULTS.d_slow) : loss;
      // Only the explicit nonlocal diagnostic installs this external mask.
      const reward = env.synapseReward ? env.synapseReward(this.targetId) : env.reward;
      if (env.features.reward && reward !== 0) {
        this.weight = clamp(this.weight + config.rewardRate * this.eligibility * reward, 0, config.maxWeight);
      }
      if (this.fixed) {
        this.weight = clamp(this.weight, 0.3, config.maxWeight);
        if (!this.target.alive && this.pendingPreSpikes) this.pendingPreSpikes = [];
        return true;
      }
      return this.target.alive && this.weight >= config.weightFloor;
    }

    prune() {
      if (!this.active || this.fixed || this.circuitLocked) return;
      this.active = false;
      this.target.incoming = this.target.incoming.filter(synapse => synapse !== this);
    }

    toJSON() {
      const { target, ...state } = this;
      if (this.fixed && this.pendingPreSpikes) state.pendingPreSpikes = [...this.pendingPreSpikes];
      return state;
    }
  }

  class Neuron {
    constructor({ id, x, y, z, config = DEFAULTS, drivePeriod = null, recordOutput = false, secretionRate = 0, bornAt = 0, inhibitory = false }) {
      this.id = id;
      if (inhibitory) this.inhibitory = true;
      this.x = x;
      this.y = y;
      if (z !== undefined) this.z = z;
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

    initializeHomeostasis() {
      // Optional state is absent in historical/off snapshots. The target uses
      // configuration, never an observed input rate or another cell's activity.
      if (this.homeostaticRate === undefined) {
        this.homeostaticRate = 0;
        this.homeostaticTargetRate = (this.config.homeostasisTargetFactor ?? HOMEOSTASIS_DEFAULTS.targetFactor) / this.config.inputPeriod;
      }
    }

    updateHomeostasis(dt, spikesThisTick) {
      this.initializeHomeostasis();
      const rule = HOMEOSTASIS_DEFAULTS;
      this.homeostaticRate += -Math.expm1(-dt / rule.rateTau) * (spikesThisTick / dt - this.homeostaticRate);
      this.threshold = clamp(this.threshold + rule.gain * (this.homeostaticRate - this.homeostaticTargetRate) * dt, rule.floor, rule.ceiling);
    }

    connect(target, time, weight) {
      target = localTargets.get(target) || target;
      if (this.circuitLocked || target.circuitLocked) return null;
      if (!this.alive || !target.alive || target === this || distance(this, target) > this.radius) return null;
      if (this.synapses.some(synapse => synapse.targetId === target.id)) return null;
      if ((this.tractSlotCapacity ? this.synapses.filter(s => !s.tract).length : this.synapses.length) >= this.config.maxSynapses) return null;
      const synapse = new Synapse(this.id + "/s" + this.nextSynapseId++, this, target, this.config, time, weight);
      this.synapses.push(synapse);
      return synapse;
    }

    fire(env, driven = false, externalDrive = false) {
      const time = env.time;
      const activityBeforeSpike = this.activity;
      this.spikeCount++;
      const spike = {
        id: this.id + "/p" + this.spikeCount, neuronId: this.id, time,
        triggerSynapseId: driven ? null : this.lastTrigger,
        parents: driven ? [] : this.charges.filter(charge => charge.amount > 1e-7).map(charge => ({
          spikeId: charge.spikeId, synapseId: charge.synapseId, contribution: charge.amount
        })),
        driven, ...(externalDrive ? { externalDrive: true } : {})
      };
      this.lastSpikeAt = time;
      this.activity = 1;
      if (!this.circuitLocked) {
        this.health = clamp(this.health + this.config.healthGain);
        this.growthBudget = Math.min(3, this.growthBudget + 1);
      }
      this.adaptation += 0.08;
      this.potential = this.restLevel;
      this.refractoryUntil = time + this.config.refractory;
      this.charges = [];
      this.lastTrigger = null;
      for (const synapse of this.incoming) synapse.notePostSpike(time, this.config, env.features.hebbian);
      for (const synapse of this.synapses) synapse.deliver(spike, this.config, env.features);
      if (env.features.lateralInhibition || env.features.activityScaledInhibition || env.features.criticalPeriodInhibition) env.inhibit(activityBeforeSpike);
      env.observe({ type: "spike", spike, output: this.recordOutput });
    }

    grow(env) {
      if (this.circuitLocked) return;
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
      if ((this.tractSlotCapacity ? this.synapses.filter(s => !s.tract).length : this.synapses.length) >= this.config.maxSynapses) {
        // Structural competition gradually weakens a poorly aligned terminal.
        // Existing objects survive until their weight actually crosses the floor.
        const local = new Map(neighbors.map(neighbor => [neighbor.id, neighbor]));
        const weakest = this.synapses.filter(synapse => !synapse.fixed).map(synapse => ({ synapse, score: local.has(synapse.targetId) ? score(local.get(synapse.targetId)) : -Infinity })).sort((a, b) => a.score - b.score)[0];
        if (weakest && ranked[0].score > weakest.score + this.config.competitionMargin &&
          !(env.features.consolidation && weakest.synapse.consolidated)) weakest.synapse.weight -= this.config.competitionCost;
        return;
      }
      const synapse = this.connect(ranked[0].neuron, env.time);
      if (synapse) {
        this.growthBudget--;
        env.observe({ type: "formed", synapse: synapse.toJSON() });
      }
    }

    // Pure preview for the opt-in regional controller. Preserve exactly the
    // integration and due-message order used below; no RNG or state mutation.
    previewThreshold(dt, time) {
      let potential=this.restLevel+(this.potential-this.restLevel)*Math.exp(-this.leakRate*dt);
      const due=this.inbox.filter(m=>m.at<=time+1e-9).sort((a,b)=>a.at-b.at||(a.synapseId??a.inhibitionId).localeCompare(b.synapseId??b.inhibitionId));
      if(time>=this.refractoryUntil)for(const message of due)potential+=message.weight;
      return {potential,threshold:this.threshold-0.14*this.youth+this.adaptation*Math.exp(-dt/2.5)};
    }

    step(dt, env) {
      if (!this.alive) return;
      // Arrival belongs to the terminal, including during postsynaptic refractoriness
      // or a cue clamp that discards membrane messages. No future clock is exposed.
      if (this.config.pairingClock === "arrival")
        for (const synapse of this.incoming) synapse.noteArrivals(env.time, this.config, env.features);
      const spikesBefore = this.spikeCount;
      const inputExempt = env.inputExempt ?? this.drivePeriod !== null;
      if (env.assemblyClamped || env.inputClamped) {
        this.potential=this.restLevel;this.inbox=[];this.charges=[];this.lastTrigger=null;
        if(env.assemblyPulse || env.inputPulse)this.refractoryUntil=Math.min(this.refractoryUntil,env.time);
      }
      if (env.features.homeostasis && inputExempt) {
        // Configured input ports obey only their external schedule under R3.
        this.potential = this.restLevel;
        this.inbox = [];
        this.charges = [];
        this.lastTrigger = null;
      }
      if (env.features.gradient && this.secretionRate > 0 && !(env.features.inhibitoryPopulation && this.inhibitory)) env.secrete(this.secretionRate * dt);
      const decay = Math.exp(-this.leakRate * dt);
      this.potential = this.restLevel + (this.potential - this.restLevel) * decay;
      for (const charge of this.charges) charge.amount *= decay;
      this.charges = this.charges.filter(charge => charge.inhibition || charge.synapticInhibition ? Math.abs(charge.amount) > 1e-7 : charge.amount > 1e-7);
      this.activity *= Math.exp(-dt / 2.2);
      this.adaptation *= Math.exp(-dt / 2.5);
      const due = [];
      const pending = [];
      for (const message of this.inbox) (message.at <= env.time + 1e-9 ? due : pending).push(message);
      this.inbox = pending;
      due.sort((a, b) => a.at - b.at || (a.synapseId ?? a.inhibitionId).localeCompare(b.synapseId ?? b.inhibitionId));
      if (env.time >= this.refractoryUntil) {
        for (const message of due) {
          this.potential += message.weight;
          if (message.inhibition) this.charges.push({ inhibition: true, amount: message.weight });
          else if (message.synapticInhibition) this.charges.push({ synapticInhibition: true, spikeId: message.spikeId, synapseId: message.synapseId, amount: message.weight });
          else {
            this.charges.push({ spikeId: message.spikeId, synapseId: message.synapseId, amount: message.weight });
            this.lastTrigger = message.synapseId;
          }
        }
        const driven = !env.inputClamped && this.nextDriveAt !== null && env.time + 1e-9 >= this.nextDriveAt;
        if (env.inputPulse) {
          this.fire(env, true);
        } else if (env.assemblyPulse) {
          this.fire(env,true,true);
        } else if (driven || env.forcedSpike) {
          if (driven) this.nextDriveAt += this.drivePeriod;
          this.fire(env, true, !driven && env.forcedSpike === true);
        } else if (!env.assemblyClamped && !env.inputClamped && !(env.features.homeostasis && inputExempt) && this.potential >= this.firingThreshold) {
          if(env.zoneCapBlocked)this.potential=this.firingThreshold-0.05;
          else this.fire(env);
        }
      }
      if (env.features.homeostasis && !inputExempt && !this.circuitLocked) this.updateHomeostasis(dt, this.spikeCount - spikesBefore);
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
      if (!this.circuitLocked) {
        this.health = Math.max(0, this.health - dt * this.config.healthLoss);
        this.age += dt;
      }
      if (this.health <= 0) {
        this.alive = false;
        this.deathAt = env.time;
        this.potential = this.restLevel;
        this.charges = [];
        this.inbox = [];
        for (const synapse of this.synapses) {
          if (synapse.fixed) { if (synapse.pendingPreSpikes) synapse.pendingPreSpikes = []; continue; }
          synapse.prune();
          env.observe({ type: "pruned", synapseId: synapse.id, sourceId: this.id, targetId: synapse.targetId });
        }
        this.synapses = this.synapses.filter(synapse => synapse.fixed);
        env.observe({ type: "died", neuronId: this.id });
      }
    }

    toJSON() {
      const { config, incoming, synapses, ...state } = this;
      return { ...state, synapses: synapses.map(synapse => synapse.toJSON()) };
    }
  }

  const api = { Neuron, Synapse, DEFAULTS, CONSOLIDATION_DEFAULTS, COMPETITION_DEFAULTS, CRITICAL_INHIBITION_DEFAULTS, HOMEOSTASIS_DEFAULTS, AXES, geometry, positionOf, clamp, distance, localView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NeuronCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
