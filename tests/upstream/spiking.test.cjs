const test = require("node:test");
const assert = require("node:assert/strict");
const { SpikingField, Neuron } = require("../../src/neuron/field.js");

function pair(features = { hebbian: true }) {
  const field = new SpikingField({ empty: true, features });
  const source = field.addNeuron({ x: 100, y: 100, drivePeriod: 1.8 });
  const target = field.addNeuron({ x: 200, y: 100, recordOutput: true });
  source.connect(target, 0, 1.2);
  return { field, source, target };
}

test("two neurons integrate a delayed spike and reset through the same class", () => {
  const { field, source, target } = pair();
  assert.ok(source instanceof Neuron && target instanceof Neuron);
  field.advance(1.8);
  assert.equal(source.spikeCount, 1);
  assert.equal(target.spikeCount, 0);
  field.advance(0.2);
  assert.equal(target.spikeCount, 1);
  assert.equal(target.potential, 0);
  assert.ok(target.refractoryUntil > field.time);
  assert.equal(field.outputs[0].triggerSynapseId, source.synapses[0].id);
  assert.deepEqual(field.outputs[0].origins, ["1/p1"]);
});

test("dormant cells age and metabolize without spikes or structural growth", () => {
  const field = new SpikingField({ inputEnabled: false });
  field.advance(60);
  assert.equal(field.stats.spikes, 0);
  assert.equal(field.stats.formed, 0);
  assert.equal(field.links.length, 0);
  assert.ok(field.neurons.every(neuron => neuron.age > 59 && neuron.health < 0.95));
});

test("synapses persist by identity, strengthen with Hebbian association, and prune when weak", () => {
  const { field, source } = pair();
  const synapse = source.synapses[0];
  field.advance(20);
  assert.equal(source.synapses[0], synapse);
  assert.ok(synapse.weight > 1.2);
  synapse.weight = 0.1;
  field.advance(0.02);
  assert.ok(!source.synapses.includes(synapse));
  assert.ok(!synapse.target.incoming.includes(synapse));
});

test("membrane leakage and refractory period suppress residual and repeat input", () => {
  const field = new SpikingField({ empty: true });
  const neuron = field.addNeuron({ x: 100, y: 100 });
  neuron.potential = 0.4;
  field.advance(1);
  assert.ok(neuron.potential < 0.11);
  neuron.refractoryUntil = field.time + 2;
  neuron.inbox.push({ at: field.time, sentAt: field.time, spikeId: "test", synapseId: "test", weight: 10 });
  field.advance(1);
  assert.equal(neuron.spikeCount, 0);
});

test("neurons only receive local neighbors and no graph or output location", () => {
  const field = new SpikingField({ empty: true });
  const source = field.addNeuron({ x: 100, y: 100 });
  const near = field.addNeuron({ x: 130, y: 100 });
  field.addNeuron({ x: 900, y: 100, recordOutput: true });
  const { localView } = require("../../src/neuron/neuron.js");
  const frame = field.neurons.map(localView);
  const env = field.env.forNeuron(source, frame);
  assert.deepEqual(env.sense().map(neuron => neuron.id), [near.id]);
  assert.equal(env.neurons, undefined);
  assert.equal(env.links, undefined);
  assert.equal(env.output, undefined);
  assert.equal(env.sense()[0].synapses, undefined);
  assert.equal(env.sense()[0].recordOutput, undefined);
  assert.equal(env.sense()[0].demand, 1);
  assert.ok(Object.isFrozen(env.sense()[0]));
  assert.equal(source.connect(field.neurons[2], 0), null);
});

test("local trophic demand falls with stimulation and innervation, independent of cell role", () => {
  const field = new SpikingField({ empty: true });
  const a = field.addNeuron({ x: 100, y: 100 });
  const b = field.addNeuron({ x: 200, y: 100, recordOutput: true });
  assert.equal(a.demand, b.demand);
  const synapse = a.connect(b, 0);
  assert.equal(b.demand, 0.5);
  b.activity = 1;
  assert.equal(b.demand, 0);
  b.activity = 0;
  synapse.prune();
  assert.equal(b.demand, 1);
});

test("demand attracts growth to an unstimulated neighbor without identifying the output", () => {
  function choose(demandAttraction) {
    const field = new SpikingField({ empty: true, config: { demandAttraction, exploration: 0 } });
    const source = field.addNeuron({ x: 200, y: 100 });
    const active = field.addNeuron({ x: 100, y: 100 });
    const dormant = field.addNeuron({ x: 300, y: 100 });
    source.activity = active.activity = 1;
    source.growthBudget = 1;
    const { localView } = require("../../src/neuron/neuron.js");
    source.grow(field.env.forNeuron(source, field.neurons.map(localView)));
    return { chosen: source.synapses[0].targetId, active: active.id, dormant: dormant.id };
  }
  const without = choose(0), withDemand = choose(1.4);
  assert.equal(without.chosen, without.active);
  assert.equal(withDemand.chosen, withDemand.dormant);
});

test("exploration can try a lower-scoring local neighbor while preserving the activity gate", () => {
  function choose(exploration, activeSource = true) {
    const field = new SpikingField({ empty: true, config: { demandAttraction: 0, exploration } });
    const source = field.addNeuron({ x: 200, y: 100 });
    const a = field.addNeuron({ x: 100, y: 100 });
    const b = field.addNeuron({ x: 300, y: 100 });
    field.addNeuron({ x: 900, y: 100 });
    a.activity = 1; b.activity = 0.95;
    source.activity = Number(activeSource); source.growthBudget = 1;
    const { localView } = require("../../src/neuron/neuron.js");
    const env = field.env.forNeuron(source, field.neurons.map(localView));
    const draws = [0, 0.99];
    source.grow({ ...env, random: () => draws.shift() });
    return { chosen: source.synapses[0]?.targetId, a: a.id, b: b.id };
  }
  const without = choose(0), exploring = choose(0.3);
  assert.equal(without.chosen, without.a);
  assert.equal(exploring.chosen, exploring.b);
  assert.equal(choose(0.3, false).chosen, undefined);
});

test("an in-flight spike creates the apparent 32/33 ceiling until its arrival", () => {
  const { field, source } = pair();
  // Isolate measurement timing from pruning: the long artificial delay is
  // outside the normal STDP window and would otherwise lose this test synapse.
  field.config.weightDecay = field.config.unusedDecay = 0;
  source.synapses[0].delay = 1;
  field.advance(600);
  const boundary = field.measure();
  assert.equal(boundary.inputCount, 33);
  assert.equal(boundary.deliveredInputCount, 32);
  assert.equal(boundary.pendingOrUndeliveredInputCount, 1);
  assert.equal(boundary.deliveryRate, 32 / 33);
  field.advance(0.5);
  assert.equal(field.measure().inputCount, 33);
  assert.equal(field.measure().deliveryRate, 1);
});

test("reward uses eligibility and remains independent of the Hebbian switch", () => {
  const rewarded = pair({ hebbian: false, reward: true });
  const control = pair({ hebbian: false, reward: false });
  rewarded.field.advance(12);
  control.field.advance(12);
  assert.ok(rewarded.source.synapses[0].weight > control.source.synapses[0].weight);
  assert.ok(rewarded.source.synapses[0].eligibility > 0);
});

test("prediction error uses the pre-tick rate and an exact 60-second EMA", () => {
  const field = new SpikingField({ empty: true });
  const output = field.addNeuron({ x: 100, y: 100, recordOutput: true, drivePeriod: 0.02 });
  field.step();
  const alpha = -Math.expm1(-field.config.dt / 60);
  assert.equal(field.outputSpikesThisTick, 1);
  assert.equal(field.rewardPulse, 1);
  assert.equal(field.outputRateEMA, alpha / field.config.dt);
  output.drivePeriod = output.nextDriveAt = null;
  const rate = field.outputRateEMA;
  field.step();
  assert.equal(field.outputSpikesThisTick, 0);
  assert.ok(Math.abs(field.rewardPulse + rate * field.config.dt) < 1e-14);
  assert.ok(field.rewardPulse < 0);
  field.advance(59.98);
  assert.ok(Math.abs(field.outputRateEMA - rate * Math.exp(-1)) < 1e-12);
});

test("signed reward depresses only eligible synapses and respects the reward switch", () => {
  function updatedWeight(pulse, eligibility, reward = true) {
    const { field, source } = pair({ hebbian: false, reward });
    const synapse = source.synapses[0];
    synapse.eligibility = eligibility;
    field.config.weightDecay = field.config.unusedDecay = 0;
    synapse.step(0.02, { time: 1, features: field.features, reward: pulse }, field.config);
    return synapse.weight;
  }
  assert.ok(updatedWeight(-0.5, 1) < 1.2);
  assert.ok(updatedWeight(0.5, 1) > 1.2);
  assert.equal(updatedWeight(-0.5, 0), 1.2);
  assert.equal(updatedWeight(-0.5, 1, false), 1.2);
});

test("snapshot resumes a negative prediction-error pulse and its EMA exactly", () => {
  const { field } = pair({ hebbian: false, reward: true });
  field.advance(12);
  assert.ok(field.rewardPulse < 0 && field.outputRateEMA > 0);
  const restored = SpikingField.fromSnapshot(field.snapshot());
  field.advance(15);
  restored.advance(15);
  assert.deepEqual(restored.snapshot(), field.snapshot());
});

test("chemical diffusion stays nonnegative and sensing cannot leave the local radius", () => {
  const { ChemicalField } = require("../../src/neuron/field.js");
  const chemical = new ChemicalField();
  chemical.deposit({ x: 500, y: 300 }, 1);
  for (let index = 0; index < 100; index++) chemical.step(0.02);
  assert.ok(chemical.values.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(chemical.sample({ x: 525, y: 300 }) > 0);
  assert.ok(chemical.values.reduce((sum, value) => sum + value, 0) < 1);
  const field = new SpikingField({ features: { gradient: true } });
  const env = field.env.forNeuron(field.input, []);
  assert.throws(() => env.chemical({ x: 920, y: 310 }), /radius/);
});

test("the seed and fixed step reproduce the run regardless of viewer frame chunks", () => {
  const a = new SpikingField({ seed: 72 });
  const b = new SpikingField({ seed: 72 });
  a.advance(20);
  for (let index = 0; index < 200; index++) b.advance(0.1);
  assert.deepEqual(a.exportLog(), b.exportLog());
  assert.deepEqual(a.neurons.map(neuron => neuron.toJSON()), b.neurons.map(neuron => neuron.toJSON()));
});

test("snapshot round trip preserves pending spikes, RNG, chemistry and future metrics exactly", () => {
  const original = new SpikingField({ seed: 4, features: { gradient: true, reward: true } });
  original.advance(12.13);
  const restored = SpikingField.fromSnapshot(original.snapshot());
  assert.deepEqual(restored.snapshot(), original.snapshot());
  original.advance(20);
  restored.advance(20);
  assert.deepEqual(restored.snapshot(), original.snapshot());
});

test("malformed or non-versioned snapshots fail without modifying a running field", () => {
  assert.throws(() => SpikingField.fromSnapshot({}), /Unsupported/);
  const original = new SpikingField();
  const snapshot = original.snapshot();
  snapshot.neurons[0].x = "unsafe";
  assert.throws(() => SpikingField.fromSnapshot(snapshot), /cell x/);
  assert.equal(original.neurons[0].x, 80);
  const legacy = original.snapshot();
  legacy.model = "local-spiking-v1";
  assert.throws(() => SpikingField.fromSnapshot(legacy), /local-spiking-v4/);
});

test("newcomer intervention is gated by observed route stability", () => {
  const field = new SpikingField();
  assert.throws(() => field.addNewcomers(), /stable route/);
  assert.equal(field.neurons.length, 50);
});

test("newcomers use the same class, age law and local code with observer-only labels", () => {
  const field = new SpikingField({ seed: 1, features: { gradient: true, reward: true } });
  field.advance(600);
  assert.ok(field.measure().routeStable);
  const before = field.neurons.length;
  const cohort = field.addNewcomers();
  assert.equal(field.neurons.length, before + 12);
  for (const member of cohort.cells) {
    const neuron = field.getNeuron(member.id);
    assert.ok(neuron instanceof Neuron);
    assert.equal(neuron.age, 0);
    assert.equal(neuron.isNew, undefined);
    assert.equal(neuron.group, undefined);
    assert.ok(member.group === "near" ? member.routeDistance <= 70 : member.routeDistance >= field.config.radius);
  }
});

test("converging spikes retain both causal parents without double-counting their input origin", () => {
  const field = new SpikingField({ empty: true });
  const input = field.addNeuron({ x: 100, y: 100, drivePeriod: 1.8 });
  const a = field.addNeuron({ x: 160, y: 100 });
  const b = field.addNeuron({ x: 160, y: 170 });
  const output = field.addNeuron({ x: 220, y: 135, recordOutput: true });
  input.connect(a, 0, 1.2); input.connect(b, 0, 1.2);
  a.connect(output, 0, 0.6); b.connect(output, 0, 0.6);
  field.advance(2.2);
  assert.equal(field.outputs.length, 1);
  assert.equal(field.outputs[0].parents.length, 2);
  assert.deepEqual(field.outputs[0].origins, ["1/p1"]);
  assert.deepEqual(field.outputs[0].ancestors, [1, 2, 3, 4]);
  assert.equal(field.delivered.size, 1);
  assert.equal(field.measure().deliveryRate, 1);
});

// Observer fixtures emit actual parent-linked records through the normal
// observation interface; no global route or fabricated stability flag is used.
function causalFixture() {
  const field = new SpikingField({ empty: true });
  const input = field.addNeuron({ x: 100, y: 100, drivePeriod: 1.8 });
  const relay = field.addNeuron({ x: 200, y: 100 });
  const other = field.addNeuron({ x: 220, y: 160 });
  const output = field.addNeuron({ x: 300, y: 100, recordOutput: true });
  function emit(cell, time, parents = [], driven = false) {
    field.time = time;
    const spike = {
      id: cell.id + "/p" + ++cell.spikeCount, neuronId: cell.id, time, driven,
      triggerSynapseId: parents.length ? "fixture" : null,
      parents: parents.map(spikeId => ({ spikeId, synapseId: "fixture", contribution: 1 }))
    };
    field.observe({ type: "spike", spike, output: cell.recordOutput });
    return spike.id;
  }
  return { field, input, relay, other, output, emit };
}

test("stale loops cannot retain a core or stability after their input origin expires", () => {
  const { field, input, relay, output, emit } = causalFixture();
  let previous = null;
  for (let t = 10; t <= 310; t += 10) {
    if (t <= 240) previous = emit(input, t - 0.3, [], true);
    previous = emit(relay, t - 0.2, [previous]);
    previous = emit(output, t - 0.1, [previous]);
    field.time = t;
    field.logMetrics();
    if (t === 240) assert.equal(field.measure().routeStable, true);
  }
  const metric = field.measure();
  assert.ok(metric.outputCount > 0);
  assert.equal(metric.freshOutputCount, 0);
  assert.equal(metric.staleOutputCount, metric.outputCount);
  assert.deepEqual(metric.trafficShare, {});
  assert.deepEqual(metric.routeCore, []);
  assert.equal(metric.routeStable, false);
  assert.equal(metric.softStable, false);
  assert.equal(metric.functionalStable, false);
  assert.throws(() => field.addNewcomers(), /stable route/);
});

test("stale branches cannot join a fresh core by merging into a qualifying output", () => {
  const { field, input, relay, other, output, emit } = causalFixture();
  const oldInput = emit(input, 0, [], true);
  const oldBranch = emit(other, 1, [oldInput]);
  const freshInput = emit(input, 100, [], true);
  const freshBranch = emit(relay, 101, [freshInput]);
  emit(output, 102, [oldBranch, freshBranch]);
  field.time = 110;
  const metric = field.measure();
  assert.equal(metric.freshOutputCount, 1);
  assert.deepEqual(metric.routeCore, [relay.id]);
  assert.equal(metric.trafficShare[other.id], undefined);
  field.time = 160; // The lower window boundary is strictly excluded.
  assert.equal(field.measure().freshOutputCount, 0);
  assert.deepEqual(field.measure().routeCore, []);
});

test("a changed fresh-input core invalidates stability even with continued delivery", () => {
  const { field, input, relay, other, output, emit } = causalFixture();
  for (let t = 10; t <= 240; t += 10) {
    const origin = emit(input, t - 0.3, [], true);
    const parent = emit(relay, t - 0.2, [origin]);
    emit(output, t - 0.1, [parent]);
    field.time = t; field.logMetrics();
  }
  assert.equal(field.measure().routeStable, true);
  for (let t = 250; t <= 310; t += 10) {
    const origin = emit(input, t - 0.3, [], true);
    const parent = emit(other, t - 0.2, [origin]);
    emit(output, t - 0.1, [parent]);
    field.time = t; field.logMetrics();
  }
  assert.equal(field.measure().deliveryRate, 1);
  assert.deepEqual(field.measure().routeCore, [other.id]);
  assert.equal(field.measure().routeStable, false);
  assert.equal(field.measure().softStable, false);
  assert.equal(field.measure().functionalStable, true);
});

test("exact 0.8 Jaccard overlap passes soft and functional while failing strict", () => {
  const { field, input, relay, other, output, emit } = causalFixture();
  const fixed = [relay, ...[350, 400, 450].map(x => field.addNeuron({ x, y: 100 }))];
  for (let t = 10; t <= 360; t += 10) {
    let parent = emit(input, t - 0.9, [], true);
    for (let i = 0; i < fixed.length; i++) parent = emit(fixed[i], t - 0.8 + i * 0.1, [parent]);
    if (Math.floor(t / 60) % 2) parent = emit(other, t - 0.2, [parent]);
    emit(output, t - 0.1, [parent]);
    field.time = t; field.logMetrics();
    if (t === 180) assert.equal(field.measure().functionalStable, false, "No fresh input at the t=0 boundary");
    if (t === 190) assert.equal(field.measure().functionalStable, true);
  }
  assert.equal(field.measure().strictStable, false);
  assert.equal(field.measure().softStable, true);
  assert.equal(field.measure().functionalStable, true);
  assert.ok(field.metrics.filter(row => row.time >= 180).every(row => row.coreJaccard >= 0.8));
});
