'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const h=require('../examples/inhibitory-formation.cjs'),f=require('../examples/formation.cjs'),study=require('../examples/inhibitory-study.cjs');
const {SpikingField,DevelopmentSession,core:{Synapse}}=require('../src/index.cjs');
test('population assignment excludes every feature before creation, with unchanged per-cell seeded engine types',()=>{
  for(const fraction of [.2,.3]){
    const r=h.setup({fraction});assert.equal(r.physicalPool.length,Math.round(500/(1-fraction)));assert.equal(r.features.length,768);
    assert.ok(r.features.every(id=>!r.field.getNeuron(id).inhibitory));assert.equal(r.field.features.lateralInhibition,false);assert.equal(r.pool.length+r.inhibitoryPool.length,r.physicalPool.length);
    const E=new Set(r.pool);for(const cue of ['A','B','C']){assert.ok(r.directSets[cue].every(id=>E.has(id)));assert.ok(r.primedSets[cue].every(id=>E.has(id)));}
    const duplicate=h.setup({fraction});assert.deepEqual(duplicate.pool,r.pool);assert.deepEqual(duplicate.inhibitoryPool,r.inhibitoryPool);assert.deepEqual(duplicate.seedEdges,r.seedEdges);
    const memory=h.exportMemory(r,{A:[],B:[]});assert.equal(memory.pool.length,r.pool.length);assert.equal(memory.artifact.nodes.length,r.physicalPool.length+768);
  }
});
test('v1 comparison preserves Stage 1g scaffold parameters and reports one-hit direct cells',()=>{
  const r=h.setup({scaffold:'v1',pool:50,epochs:2});assert.equal(r.features.length,192);assert.equal(r.hitThreshold,1);assert.equal(r.opts.jitter,15);assert.equal(r.field.config.maxSynapses,8);assert.equal(r.field.config.maxWeight,1.65);
  assert.ok(r.seedEdges.every(e=>e.weight===1.1));assert.ok(r.primedSets.A.every(id=>r.directSets.A.includes(id)));
});
test('inhibition observers are passive and grouped ports pulse all copies',()=>{
  const observed=h.setup({pool:50,epochs:2}),plain=h.setup({pool:50,epochs:2,auditEnabled:false});
  for(let epoch=1;epoch<=2;epoch++){observed.epoch(epoch);plain.epoch(epoch);}
  assert.equal(f.json(observed.field.snapshot()),f.json(plain.field.snapshot()));
  for(const row of observed.rows){assert.equal(row.featureSpikes.length,32);assert.ok(row.active.every(id=>observed.pool.includes(id)));assert.ok(row.inhibition.inhibitoryCellsFiring.every(id=>observed.inhibitoryPool.includes(id)));
    assert.equal(row.inhibition.meanInhibitoryCharge,row.inhibition.cells.reduce((s,c)=>s+c.inhibitoryCharge,0)/observed.pool.length);
    for(const p of row.inhibition.effectiveThresholdProxy)assert.ok(Math.abs(p.net-(p.excitation-p.inhibition))<1e-10);
  }
});
test('native inhibition signs and observers distinguish integration from refractory discard',()=>{
  const audit=require('../examples/inhibitory-audit.cjs'),field=new SpikingField({empty:true,config:{radius:600,weightDecay:0,unusedDecay:0,healthLoss:0},features:{inhibitoryPopulation:true,hebbian:false}});
  const a=field.addNeuron({x:100,y:100}),b=field.addNeuron({x:120,y:100});a.nextGrowthAt=b.nextGrowthAt=1e12;
  const run={field,pool:[b.id],physicalPool:[b.id],inhibitoryPool:[a.id],seedEdges:[{id:'afferent'}],primedSets:{A:[b.id]}},observer=audit.createObserver(run);
  observer.begin('A');b.inbox.push({at:0,weight:-.4,synapticInhibition:true,synapseId:'inhibitory',spikeId:'i/p1'},{at:.01,weight:.7,synapseId:'afferent',spikeId:'f/p1'});
  b.step(.02,{time:.02,features:field.features,observe:()=>{},chemical:()=>0,sense:()=>[]});
  const row=observer.end();assert.equal(row.meanInhibitoryCharge,.4);assert.deepEqual(row.primed.integratedBeforeAfferent,[b.id]);
  observer.begin('A');b.refractoryUntil=1;b.inbox.push({at:.03,weight:-.4,synapticInhibition:true,synapseId:'inhibitory',spikeId:'i/p2'});
  b.step(.02,{time:.04,features:field.features,observe:()=>{},chemical:()=>0,sense:()=>[]});const discarded=observer.end();assert.equal(discarded.meanInhibitoryCharge,0);assert.equal(discarded.cells[0].discardedInhibition,.4);
});
test('deterministic summary, native restoration, physical pruning and E-only gate metrics',()=>{
  const one=h.runCondition({pool:50,epochs:2}),two=h.runCondition({pool:50,epochs:2});assert.equal(f.json(one.summary),f.json(two.summary));assert.equal(f.json(one.memory),f.json(two.memory));
  const restored=h.restoreStop(one),full=h.setup({pool:50,epochs:3});for(let e=1;e<=3;e++)full.epoch(e);restored.epoch(3);
  // Native reload annotates its historical endpoint-placement metric. Verify
  // every neuron/terminal state and the actual native compiled circuit instead.
  assert.deepEqual(restored.field.snapshot().neurons,full.field.snapshot().neurons);
  assert.equal(restored.field.rng.state,full.field.rng.state);assert.equal(restored.field.tick,full.field.tick);
  const cores={A:f.extractCore(full.trials.A),B:f.extractCore(full.trials.B)};
  assert.equal(f.json(h.exportMemory(restored,cores)),f.json(h.exportMemory(full,cores)));assert.equal(f.json(restored.rows),f.json(full.rows));
  const E=new Set(one.summary.population.excitatory);assert.ok(Object.values(one.memory.cores).flat().every(id=>E.has(id)));assert.ok(one.trials.growthEdges.every(e=>E.has(e.sourceId)&&E.has(e.targetId)));
  const pruned=h.pruneFormed(one),physical=new Set(one.summary.population.physical);assert.ok(pruned.summary.ablation.removed.length>0);assert.ok(!pruned.memory.artifact.edges.some(e=>physical.has(e.sourceId)&&physical.has(e.targetId)));
  assert.ok(pruned.memory.artifact.edges.every(e=>one.trials.seedEdges.some(s=>s.id===e.id)));
});
test('confirmation only advances a seed1 cell passing every gate including11',()=>{
  const d=study.declaration();assert.equal(d.cells.length,3);assert.deepEqual(d.cells.map(c=>c.options.pool),[625,714,625]);
  const cell={...d.cells[0],summary:{stopping:{reached:true},primary:{criteria:{'11':{gated:true,pass:false}}},pass:false}};
  assert.equal(study.eligible(cell.summary),false);assert.equal(study.decide([cell]).pass,false);assert.deepEqual(study.decide([cell]).eligibleSeed1,[]);
  cell.summary.primary.criteria['11'].pass=true;cell.summary.pass=true;assert.equal(study.decide([cell]).pass,false);
  assert.equal(study.decide([cell,...[2,3].map(seed=>({...structuredClone(cell),options:{...cell.options,seed}}))]).pass,true);
});
