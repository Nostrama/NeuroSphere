const test = require('node:test'), assert = require('node:assert/strict');
const { SpikingField } = require('../../src/neuron/field.js');
const { SpikingField: HistoricalField } = require('../fixtures/neuron/history/results-v4/source-phase10/field.js');
const { compile, resume, LockedController, structure } = require('../../src/neuron/controller.js');
const { SpikeIO } = require('../../src/neuron/spike-io.js');
const { DevelopmentSession, sourcesFromDestinations } = require('../../src/neuron/development.js');
function relay(features = {}) {
  const f = new SpikingField({ empty: true, features, config: { dimensions: 2 } });
  const a = f.addNeuron({ x: 80, y: 310, drivePeriod: 1.8 });
  const b = f.addNeuron({ x: 240, y: 310 });
  const c = f.addNeuron({ x: 400, y: 310, recordOutput: true });
  a.connect(b, 0, 1.5); b.connect(c, 0, 1.5);
  f.endpointPlacement = f.assessEndpointPlacement(); f.metrics = []; f.logMetrics();
  return f;
}
const frozen = f => f.neurons.map(c => ({ id: c.id, age: c.age, health: c.health, threshold: c.threshold, growthBudget: c.growthBudget,
  synapses: c.synapses.map(s => [s.id, s.targetId, s.weight, s.consolidated, s.strongSince, s.eligibility]) }));
test('circuit lock keeps growth, health, age, homeostasis and all weight updates fixed', () => {
  const f = relay({ homeostasis: true, reward: true, consolidation: true, stdpDepression: true });
  f.advance(2); f.lockCircuit(); const before = frozen(f); f.advance(120);
  assert.deepEqual(frozen(f), before); assert.ok(f.stats.outputSpikes > 40); assert.equal(f.time, 122);
  assert.throws(() => f.addNeuron({ x: 600, y: 310 }), /locked/);
  assert.throws(() => f.setFeatures({ reward: false }), /locked/);
  assert.equal(f.neurons[2].connect(f.neurons[1], f.time), null);
});
test('locked cells survive an hour of silence without pausing fast dynamics', () => {
  const f = relay(); f.neurons.forEach(c => { c.drivePeriod = null; c.nextDriveAt = null; c.health = .001; c.age = 100; });
  f.lockCircuit(); const a = compile(f), r = new LockedController(a), before = frozen(r);
  r.neurons[0].potential = .5; r.neurons[0].adaptation = .1; r.advance(3600);
  assert.deepEqual(frozen(r), before); assert.ok(r.neurons.every(c => c.alive)); assert.ok(r.neurons[0].potential < 1e-100); assert.ok(r.neurons[0].adaptation < 1e-100);
});
test('lock snapshots restore and reject missing per-terminal locks', () => {
  const f = relay(); f.lockCircuit(); f.advance(3); const s = f.snapshot(), g = SpikingField.fromSnapshot(s);
  f.advance(5); g.advance(5); assert.deepEqual(g.snapshot(), f.snapshot());
  delete s.neurons[0].synapses[0].circuitLocked; assert.throws(() => SpikingField.fromSnapshot(s), /lock/);
});
test('disabled foundation reproduces historical field state exactly', () => {
  for (const features of [{ gradient: false, reward: true }, { gradient: true, reward: false }]) {
    const options = { seed: 3, population: 16, features };
    const f = new SpikingField(options), old = new HistoricalField(options); f.advance(30); old.advance(30);
    assert.deepEqual(f.snapshot(), old.snapshot());
  }
});
test('reset export repeats exact complete spike traces and reports directed structure', () => {
  const f = relay(); f.lockCircuit(); const a = compile(f), traces = [];
  for (let n = 0; n < 2; n++) { const trace = [], r = new LockedController(JSON.parse(JSON.stringify(a)), s => trace.push(s)); r.io.pulse('In1', 1); r.advance(3); traces.push(trace); }
  assert.deepEqual(traces[0], traces[1]); assert.deepEqual(traces[0].map(s => s.neuronId), [1, 2, 3]);
  assert.equal(traces[0][2].time, .3);
  assert.equal(structure(a).paths[0].shortestHops, 2); assert.equal(structure(a).edgesBeyondSpanningForest, 0);
});
test('warm checkpoint preserves pending spikes, adaptation, decoder and scheduled inputs', () => {
  const f = relay(); f.lockCircuit(); const r = new LockedController(compile(f)); r.io.pulse('In1', 1); r.io.pulse('In1', 101); r.advance(.08);
  const s = r.checkpoint(), g = LockedController.restore(s); r.advance(5); g.advance(5); assert.deepEqual(g.checkpoint(), r.checkpoint());
  s.state.neurons[1].inbox[0].weight = null; assert.throws(() => LockedController.restore(s), /weight/);
});
test('warm compiled execution matches the locked research engine with the same external drive', () => {
  const f = relay({ lateralInhibition: true, consolidation: true, homeostasis: true });
  const session = new DevelopmentSession(f, {}, { inputs: [{ name: 'signal', cells: [1] }], outputs: [{ name: 'response', cells: [3] }] });
  session.io.pulse('signal', 1); for (let n = 0; n < 5; n++) session.step(); f.lockCircuit();
  const r = resume(f), expected = [], actual = [];
  f.onEvent = e => { if (e.type === 'spike') expected.push(e.spike); };
  r.onSpike = s => actual.push(s);
  for (let n = 0; n < 150; n++) { session.step(); r.step(); }
  assert.deepEqual(actual, expected);
});
test('controller export refuses unlocked circuits and incompatible or malformed artifacts', () => {
  const f = relay(); assert.throws(() => compile(f), /Lock/); f.lockCircuit(); const a = compile(f);
  const bad = clone => { assert.throws(() => new LockedController(clone)); };
  bad({ ...a, runtime: 'future' }); bad({ ...a, edges: [...a.edges, a.edges[0]] }); bad({ ...a, nodes: a.nodes.map((c,i) => i ? c : { ...c, health: 0 }) });
  const r = new LockedController(a), s = r.checkpoint(); s.state.io.tick = 2; assert.throws(() => LockedController.restore(s), /clocks/);
});
test('decoder windows, array normalization and deterministic rate encoding', () => {
  const io = new SpikeIO({ inputs: [{ name: 'x', cells: [1], min: -1, max: 1, maxRate: 5 }], outputs: [{ name: 'y', cells: [2], mode: 'rate' }] }, [{id:1},{id:2}], .02);
  assert.deepEqual(io.encode([9]), [1]); let pulses = 0;
  for (let t = 1; t <= 50; t++) { io.prepare(t); if (io.pulsed.has(1)) pulses++; if (t % 10 === 0) io.observe({ neuronId: 2 }); }
  assert.equal(pulses, 5); assert.equal(io.decode().values.y, 5); assert.equal(io.decode().duration, 0);
  assert.throws(() => io.encode([NaN])); assert.throws(() => io.pulse('missing')); assert.throws(() => io.pulse('x', 1));
});
test('clamped inputs ignore network feedback and preserve input ancestry', () => {
  const f = relay(), session = new DevelopmentSession(f, {}, { inputs: [{name:'x',cells:[1]}], outputs:[{name:'y',cells:[3],mode:'presence'}] });
  f.neurons[0].potential = 100; session.step(); assert.equal(f.neurons[0].spikeCount, 0);
  session.io.pulse('x'); session.step(); assert.equal(f.neurons[0].spikeCount, 1); assert.equal(f.inputSpikes.length, 1);
  for(let n=0;n<25;n++)session.step(); assert.equal(session.io.decode().values.y,true); assert.equal(f.outputs[0].origins[0],f.inputSpikes[0].id);
});
test('synthetic sources preserve total secretion; permissions affect local growth candidates', () => {
  const f = new SpikingField({ empty:true,features:{gradient:true} });
  const a=f.addNeuron({x:100,y:300}),b=f.addNeuron({x:200,y:300});
  const sources=sourcesFromDestinations([{x:100,y:300,weight:1},{x:200,y:300,weight:3}]); assert.deepEqual(sources.map(s=>s.rate),[2,6]);
  const d=new DevelopmentSession(f,{domains:[{name:'left',bounds:{x:[0,150],y:[0,620]}},{name:'right',bounds:{x:[150,1000],y:[0,620]}}],communication:[],sources});
  assert.equal(d.permits(a.id,b.id),false); d.step(); assert.ok(f.chemical.active); assert.ok(f.chemical.sample(b)>f.chemical.sample(a));
  assert.throws(()=>sourcesFromDestinations([{weight:-1}]));
});
test('time and measured-validation triggers lock only after their explicit conditions', () => {
  const f=relay(), d=new DevelopmentSession(f,{lock:{kind:'time',seconds:.04}});d.step();assert.equal(f.circuitLock,undefined);d.step();assert.ok(f.circuitLock);
  const g=relay(), e=new DevelopmentSession(g,{lock:{kind:'validated',minimumDelivery:.8,samples:2}});
  for(let n=0;n<999;n++)e.step();assert.equal(g.circuitLock,undefined);e.step();assert.ok(g.circuitLock);
});
test('development checkpoint preserves adapters, sources and trigger progress',()=>{
  const f=relay(), d=new DevelopmentSession(f,{lock:{kind:'time',seconds:2}},{inputs:[{name:'x',cells:[1]}],outputs:[]});d.io.pulse('x',2);d.step();
  const e=DevelopmentSession.restore(d.checkpoint(),SpikingField);for(let n=0;n<110;n++){d.step();e.step();}assert.deepEqual(e.checkpoint(),d.checkpoint());
});
test('regional runtime cap limits membership while allowing repeated members and exempt cues',()=>{
  const f=relay();f.lockCircuit();const a=compile(f,{cap:{k:1,windowTicks:90,zones:{B:[2,3]}}}),r=new LockedController(a);
  r.neurons[1].potential=2;r.neurons[2].potential=3;r.step();assert.deepEqual(r.events.map(e=>e.spike.neuronId),[3]);assert.equal(r.members.B.size,1);
  const restored=LockedController.restore(r.checkpoint());assert.deepEqual(restored.checkpoint(),r.checkpoint());
});
