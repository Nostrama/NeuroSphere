'use strict';
const path = require('node:path');
function run({ jitterTicks, clock }, projectRoot = path.join(__dirname, '..')) {
  const { SpikingField } = require(path.join(path.resolve(projectRoot), 'src/neuron/field.js'));
  const field = new SpikingField({ empty: true, seed: 5,
    config: { dimensions: 3, extent: { x: 800, y: 800, z: 800 }, maxCells: 2000, radius: 60, maxSynapses: 8,
      growthPeriod: 1e9, initialWeight: 0.4, weightFloor: 0.001, weightDecay: 0, unusedDecay: 0, healthLoss: 0, pairingClock: clock },
    features: { hebbian: true, reward: false, gradient: false, consolidation: false } });
  const add = (p, r) => { const c = field.addNeuron(p); c.nextGrowthAt = 1e12; if (r) c.radius = r; return c; };
  // two features on the r=300 shell, two pool cells 60 apart near the centre
  const F1 = add({ x: 400, y: 400, z: 100 }, 600), F2 = add({ x: 400, y: 700, z: 400 }, 600);
  const P1 = add({ x: 400, y: 400, z: 370 }), P2 = add({ x: 400, y: 400, z: 430 });
  const a1 = F1.connect(P1, 0, 1.1), a2 = F2.connect(P2, 0, 1.1), rec = P1.connect(P2, 0, 0.4);
  const pulses = new Map();
  const prior = field.env.forNeuron.bind(field.env);
  field.env.forNeuron = (cell, frame) => { const env = prior(cell, frame);
    if (cell === F1 || cell === F2) { env.inputPulse = pulses.get(cell.id) === field.tick; env.inputExempt = true; env.inputClamped = true; }
    return env; };
  const spikes = []; field.onEvent = e => { if (e.type === 'spike') spikes.push([e.spike.neuronId, field.tick]); };
  const w0 = rec.weight;
  for (let trial = 0; trial < 40; trial++) {
    const t0 = field.tick + 1;
    pulses.set(F1.id, t0); pulses.set(F2.id, t0 + jitterTicks);          // F2 (→P2) onset delayed by jitter
    for (let i = 0; i < 100; i++) field.step();
  }
  const names = { [F1.id]: 'F1', [F2.id]: 'F2', [P1.id]: 'P1', [P2.id]: 'P2' };
  const first = spikes.slice(0, 4).map(([id, t]) => names[id] + '@' + t);
  return { jitterTicks, clock, afferentDelays: [a1.delay / .02, a2.delay / .02].map(x => x.toFixed(1)), recurrentDelay: (rec.delay / .02).toFixed(1),
    firstTrialSpikes: first, initialWeight:w0, finalWeight:rec.weight, recurrentWeight: w0.toFixed(3) + ' -> ' + rec.weight.toFixed(3) };
}
if(require.main===module){
  if(process.argv[2]){
    for(const clock of ['arrival','emission'])for(const jitterTicks of [0,2,6,10])console.log(JSON.stringify(run({jitterTicks,clock},process.argv[2])));
  }else{
    // node --test invokes this file without a root argument. Direct CLI use
    // accepts an explicit root, including '.', resolved against the caller cwd.
    const {test}=require('node:test'),assert=require('node:assert/strict');
    test('synchronous arrival leaves the isolated recurrent weight unchanged',()=>{
      const result=run({jitterTicks:0,clock:'arrival'});assert.equal(result.initialWeight,.4);assert.equal(result.finalWeight,result.initialWeight);
    });
    test('six-tick feature offset allows arrival-clock recurrent potentiation above 0.9',()=>{
      const result=run({jitterTicks:6,clock:'arrival'});assert.ok(result.finalWeight>.9,JSON.stringify(result));
    });
    test('synchronous emission clock potentiates the isolated recurrent edge',()=>{
      const result=run({jitterTicks:0,clock:'emission'});assert.ok(result.finalWeight>1.02,JSON.stringify(result));
    });
  }
}
module.exports={run};
