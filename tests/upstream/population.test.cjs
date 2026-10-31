const test = require("node:test");
const assert = require("node:assert/strict");
const Population = require("../../src/neuron/population.js");
const { SpikingField, distance } = require("../../src/neuron/simulation.js");

test("custom density places the exact count, obeys spacing and bounds, and sets each cell's reach", () => {
  for (const dimensions of [2, 3]) {
    const settings = { ...Population.defaults, dimensions, population: 48, minimumSpacing: 60, radius: 150 };
    const field = Population.create(settings, { seed: 7 });
    assert.equal(field.neurons.length, 50);
    assert.equal(field.metrics.length, 1);
    assert.equal(field.metrics[0].population, 50);
    assert.ok(Population.measuredSpacing(field) > 60);
    assert.deepEqual([field.input.x, field.output.x], [80, 920]);
    for (const cell of field.neurons) {
      assert.equal(cell.radius, 150);
      for (const axis of field.axes) assert.ok(cell[axis] >= 0 && cell[axis] <= field.config.extent[axis]);
      assert.equal(cell.z === undefined, dimensions === 2);
    }
    field.advance(20);
    for (const link of field.links)
      assert.ok(distance(field.getNeuron(link.sourceId), field.getNeuron(link.targetId)) <= 150);
  }
});

test("zero and maximum populations include exactly two additional I/O cells", () => {
  for (const population of [0, 148, Population.limits.population]) {
    const field = Population.create({ ...Population.defaults, population, minimumSpacing: 0 });
    assert.equal(field.neurons.length, population + 2);
    assert.equal(field.neurons.filter(cell => cell.drivePeriod !== null).length, 1);
    assert.equal(field.neurons.filter(cell => cell.recordOutput).length, 1);
  }
});

test("regeneration is deterministic and snapshots retain density settings and continuation", () => {
  const settings = { ...Population.defaults, population: 32, minimumSpacing: 70, radius: 180, x: 800, y: 500, z: 450 };
  const field = Population.create(settings, { seed: 42, features: { reward: true } });
  const initial = field.snapshot();
  field.advance(15);
  assert.deepEqual(Population.replay(field).snapshot(), initial);
  const restored = SpikingField.fromSnapshot(field.snapshot());
  assert.deepEqual(Population.fromField(restored), settings);
  field.advance(2); restored.advance(2);
  assert.deepEqual(restored.snapshot(), field.snapshot());
  assert.equal(field.exportLog().config.placement.minimumSpacing, 70);
  const other = Population.replay(field, 43);
  assert.notDeepEqual(other.neurons.map(cell => [cell.x, cell.y, cell.z]), initial.neurons.map(cell => [cell.x, cell.y, cell.z]));
});

test("existing research setups replay through the unchanged historical placement", () => {
  for (const dimensions of [2, 3]) {
    const field = new SpikingField({ seed: 3, population: 48, config: { dimensions } });
    const initial = field.snapshot();
    field.advance(1);
    assert.deepEqual(Population.replay(field).snapshot(), initial);
  }
});

test("unplaceable or invalid settings reject without changing the active field or its configuration", () => {
  const current = new SpikingField({ seed: 1 });
  const before = current.snapshot();
  assert.throws(() => Population.create({ ...Population.defaults, population: 148, x: 100, y: 100, z: 100, minimumSpacing: 80 },
    { seed: current.seed, config: current.config, features: current.features }), /Could place only/);
  assert.deepEqual(current.snapshot(), before);
  for (const population of [-1, 1001, 2.5, NaN]) assert.throws(() => Population.validate({ ...Population.defaults, population }), /Number of neurons/);
  assert.throws(() => Population.validate({ ...Population.defaults, x: 10000, y: 10000, z: 10000 }), /too large/);
  assert.throws(() => Population.validate({ ...Population.defaults, x: 100, minimumSpacing: 90 }), /input and output/);
});

test("large custom populations opt into capacity and preserve snapshot continuation and replay", () => {
  const field = Population.create({ ...Population.defaults, population: 200, minimumSpacing: 40 });
  assert.equal(field.neurons.length, 202);
  assert.equal(field.cellLimit, 214);
  const initial = field.snapshot();
  assert.deepEqual(Population.replay(field).snapshot(), initial);
  field.advance(0.04);
  const restored = SpikingField.fromSnapshot(field.snapshot());
  restored.advance(0.04); field.advance(0.04);
  assert.deepEqual(restored.snapshot(), field.snapshot());
  const small = Population.create(Population.defaults, { config: field.config });
  assert.equal(small.config.maxCells, undefined);
  assert.equal(small.cellLimit, 400);
  const missingCapacity = structuredClone(initial); delete missingCapacity.config.maxCells;
  assert.equal(SpikingField.fromSnapshot(missingCapacity).cellLimit, 400);
});

test("capacity remains bounded and the implicit limit is 400", () => {
  for (const maxCells of [149, 2001, NaN, 250.5, "500"])
    assert.throws(() => new SpikingField({ config: { maxCells } }), /capacity/);
  assert.throws(() => new SpikingField({ population: 399 }), /Population/);
  const field = new SpikingField({ empty: true, config: { maxCells: 151 } });
  for (let i = 0; i < 151; i++) field.addNeuron({ x: 100, y: 100 });
  assert.throws(() => field.addNeuron({ x: 100, y: 100 }), /151 live cells/);
});

test("double-size volume fits the viewer budget without changing diffusion resolution", () => {
  const settings = { ...Population.defaults, population: 300, x: 2000, y: 1240, z: 1240 };
  const field = Population.create(settings);
  assert.equal(field.neurons.length, 302);
  assert.deepEqual(field.config.extent, { x: 2000, y: 1240, z: 1240 });
  assert.equal(field.chemical.spacing, 25);
  assert.equal(Population.summary(settings).gridSites, field.chemical.values.length);
  assert.deepEqual([field.input.x, field.output.x], [160, 1840]);
});

test("density preview uses ordinary-cell count and the correct area or volume units", () => {
  const volume = Population.summary({ ...Population.defaults, population: 100, x: 1000, y: 1000, z: 1000 });
  assert.equal(volume.total, 102); assert.equal(volume.density, 0.1);
  const plane = Population.summary({ ...Population.defaults, dimensions: 2, population: 100, x: 1000, y: 1000 });
  assert.equal(plane.density, 1); assert.match(plane.densityUnit, /u²/);
});
