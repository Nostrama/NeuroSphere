const test = require("node:test");
const assert = require("node:assert/strict");
const { SpikingField, ChemicalField, SeededRandom, distance } = require("../../src/neuron/field.js");
const { localView } = require("../../src/neuron/neuron.js");
const reference = require("../fixtures/neuron/results-v3/source/field.js");

test("2D chemistry preserves every reference value and interpolation bit exactly", () => {
  const a = new ChemicalField({ dimensions: 2 }), b = new reference.ChemicalField();
  const rng = new SeededRandom(65);
  for (let i = 0; i < 30; i++) {
    const p = { x: rng.next() * 1000, y: rng.next() * 620 }, amount = rng.next();
    a.deposit(p, amount); b.deposit(p, amount);
  }
  for (let i = 0; i < 200; i++) { a.step(0.02); b.step(0.02); }
  assert.deepEqual(a.values, b.values);
  for (let i = 0; i < 100; i++) {
    const p = { x: rng.next() * 1000, y: rng.next() * 620 };
    assert.equal(a.sample(p), b.sample(p));
  }
});

test("3D locality, reach census and synapse delays use depth", () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 12 }), 13);
  const field = new SpikingField({ empty: true, config: { dimensions: 3 } });
  const a = field.addNeuron({ x: 100, y: 100, z: 100 });
  const b = field.addNeuron({ x: 100, y: 100, z: 200 });
  const c = field.addNeuron({ x: 100, y: 100, z: 500 });
  const env = field.env.forNeuron(a, field.neurons.map(localView));
  assert.deepEqual(env.sense().map(cell => cell.id), [b.id]);
  assert.equal(env.sense()[0].z, 200);
  assert.equal(a.connect(c, 0), null);
  assert.equal(a.connect(b, 0).delay, 0.04 + 100 / 1800);
  assert.throws(() => env.chemical(c), /radius/);
  assert.equal(field.measure().meanNeighborsInReach, 2 / 3);
});

test("3D diffusion has six symmetric faces, preserves decayed mass and interpolates all axes", () => {
  const field = new ChemicalField({ dimensions: 3, extent: { x: 200, y: 200, z: 200 } });
  assert.deepEqual(field.shape, [9, 9, 9]);
  field.deposit({ x: 100, y: 100, z: 100 }, 1);
  field.step(0.02);
  const retention = Math.exp(-0.03 * 0.02), expected = 1100 * 0.02 / 625 * retention;
  for (const axis of ["x", "y", "z"]) {
    for (const sign of [-1, 1]) assert.equal(field.sample({ x: 100, y: 100, z: 100, [axis]: 100 + sign * 25 }), expected);
  }
  assert.ok(Math.abs(field.values.reduce((a, b) => a + b) - retention) < 1e-14);
  field.deposit({ x: 0, y: 0, z: 0 }, 1);
  const mass = field.values.reduce((a, b) => a + b);
  field.step(0.02);
  assert.ok(Math.abs(field.values.reduce((a, b) => a + b) - mass * retention) < 1e-14);
  for (let z = 0; z < 9; z++) for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    field.values[x + 9 * y + 81 * z] = x * 25 + 2 * y * 25 + 3 * z * 25;
  }
  assert.equal(field.sample({ x: 12.5, y: 37.5, z: 62.5 }), 275);
  assert.throws(() => field.step(1), /stability limit/);
});

test("extent controls initial placement, bounds and exact 3D snapshot continuation", () => {
  const config = { dimensions: 3, extent: { x: 800, y: 400, z: 300 } };
  const field = new SpikingField({ seed: 4, population: 12, config, features: { gradient: true, reward: true } });
  assert.deepEqual([field.input.x, field.input.y, field.input.z], [64, 200, 150]);
  assert.deepEqual([field.output.x, field.output.y, field.output.z], [736, 200, 150]);
  assert.ok(field.neurons.every(cell => cell.z >= 0 && cell.z <= 300));
  assert.throws(() => field.addNeuron({ x: 100, y: 100, z: 301 }), /extent/);
  assert.throws(() => field.addNeuron({ x: 100, y: 100 }), /extent/);
  field.advance(4.13);
  const restored = SpikingField.fromSnapshot(field.snapshot());
  assert.deepEqual(restored.snapshot(), field.snapshot());
  field.advance(2); restored.advance(2);
  assert.deepEqual(restored.snapshot(), field.snapshot());
  const malformed = field.snapshot();
  malformed.neurons[0].z = 301;
  assert.throws(() => SpikingField.fromSnapshot(malformed), /cell z/);
});

test("2D newcomer placement retains the original RNG sequence and coordinates exactly", () => {
  const options = { seed: 1, features: { gradient: true, reward: true } };
  const a = new SpikingField(options), b = new reference.SpikingField(options);
  a.advance(600); b.advance(600);
  assert.deepEqual(a.addNewcomers(), b.addNewcomers());
  assert.equal(a.rng.state, b.rng.state);
  const originalState = a.neurons.map(cell => ({ ...cell.toJSON(),
    synapses: cell.synapses.map(synapse => {
      const { consolidated, strongSince, ...original } = synapse.toJSON();
      assert.equal(consolidated, false); assert.equal(strongSince, null);
      return original;
    }) }));
  assert.deepEqual(originalState, b.neurons.map(cell => cell.toJSON()));
});

test("3D newcomer placement uses volume and full-dimensional near/far distances", () => {
  const field = new SpikingField({ empty: true, seed: 4, config: { dimensions: 3 } });
  field.addNeuron({ x: 80, y: 310, z: 310, drivePeriod: 1.8 });
  field.addNeuron({ x: 920, y: 310, z: 310, recordOutput: true });
  const route = [200, 350, 500, 650, 800].map(x => field.addNeuron({ x, y: 310, z: 310 }));
  // Isolate placement from dynamics; the stability observer itself has causal tests.
  field.measure = () => ({ routeStable: true, routeCore: route.map(cell => cell.id), trafficShare: {} });
  const cohort = field.addNewcomers();
  assert.equal(cohort.cells.length, 12);
  assert.ok(cohort.cells.some(cell => cell.z !== 310));
  for (const member of cohort.cells) {
    assert.ok(member.z >= 25 && member.z <= 595);
    assert.ok(member.group === "near" ? member.routeDistance <= 70 : member.routeDistance >= 195);
    const actual = Math.min(...field.neurons.slice(0, 7).map(cell => distance(cell, member)));
    assert.equal(member.routeDistance, actual);
  }
});
