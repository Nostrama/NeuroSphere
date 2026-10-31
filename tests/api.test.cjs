'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const api = require('..');

test('package loads and processes spikes without a DOM or a UI module', () => {
  const result = spawnSync(process.execPath, ['-e', `
    for (const name of ['window', 'document', 'localStorage', 'navigator', 'requestAnimationFrame', 'fetch']) {
      Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('Browser dependency: ' + name); } });
    }
    const api = require(${JSON.stringify(path.resolve(__dirname, '..'))});
    const f = new api.SpikingField({ empty: true });
    f.advance(0.02);
    if (f.tick !== 1) throw new Error('No processing');
    const modules = Object.keys(require.cache);
    if (modules.some(p => /(?:-view|ui|serve)\\.(?:js|cjs)$/.test(p))) throw new Error('UI or server imported');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('public relay example delivers exactly one pulse through three 3D cells', () => {
  const { runRelay } = require('../examples/relay.cjs');
  const first = runRelay();
  assert.deepEqual(first, runRelay());
  assert.equal(first.outputs.values.response, 1);
  assert.deepEqual(first.spikes.map(s => s.cell), [1, 2, 3]);
  assert.equal(first.spikes[2].time, 0.3);
});

test('public development API restores a pending digital input and continues exactly', () => {
  const field = new api.SpikingField({ empty: true, config: { dimensions: 3 } });
  const a = field.addNeuron({ x: 100, y: 100, z: 100 });
  const b = field.addNeuron({ x: 200, y: 100, z: 100, recordOutput: true });
  a.connect(b, 0, 1.5);
  const session = new api.DevelopmentSession(field, {}, {
    inputs: [{ name: 'sensor', cells: [a.id] }], outputs: [{ name: 'result', cells: [b.id], mode: 'count' }]
  });
  session.io.pulse('sensor', 10);
  session.step();
  const restored = api.DevelopmentSession.restore(JSON.parse(JSON.stringify(session.checkpoint())), api.SpikingField);
  for (let tick = 0; tick < 50; tick++) { session.step(); restored.step(); }
  assert.deepEqual(restored.checkpoint(), session.checkpoint());
  assert.equal(restored.io.decode().values.result, 1);
});

test('public growth example reaches its scheduled lock and round-trips the checkpoint', () => {
  const { runGrowth } = require('../examples/growth.cjs');
  const result = runGrowth();
  assert.equal(result.seconds, 10);
  assert.equal(result.circuitLocked, true);
  assert.equal(result.checkpointRestoredExactly, true);
});
