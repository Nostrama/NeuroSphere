'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const v=require('../examples/formation-v2.cjs'),f=require('../examples/formation.cjs'),study=require('../examples/formation-v2-study.cjs'),audit=require('../examples/formation-v2-audit.cjs');
const {SpikingField,DevelopmentSession,LockedController,compileController}=require('../src/index.cjs');
const fixture={pool:80,epochs:2};let cached;
function primary(){cached??=v.runCondition(fixture);return cached;}
test('v2 uses 768 distinct shell cells, 192 native grouped ports and 6144 capped afferents',()=>{
  const r=v.setup();assert.equal(r.features.length,768);assert.equal(r.field.neurons.length,1268);assert.equal(r.session.io.config.inputs.length,192);assert.equal(r.seedEdges.length,6144);
  const positions=new Set();for(const id of r.features){const n=r.field.getNeuron(id);positions.add([n.x,n.y,n.z].join(','));assert.ok(Math.abs(Math.hypot(n.x-400,n.y-400,n.z-400)-300)<1e-8);assert.equal(n.radius,600);assert.equal(n.nextGrowthAt,1e12);assert.equal(n.synapses.length,8);assert.equal(n.threshold,1.02);}
  assert.equal(positions.size,768);assert.equal(r.field.config.radius,60);assert.equal(r.field.config.maxSynapses,10);assert.equal(r.field.config.initialWeight,.4);assert.equal(r.field.config.maxWeight,.7);
  assert.ok(r.seedEdges.every(e=>e.weight===.7));const before=f.json(r.field.config),counts=r.groups[17].map(id=>r.field.getNeuron(id).spikeCount);
  r.session.io.pulse('f17',1);r.session.step();assert.deepEqual(r.groups[17].map(id=>r.field.getNeuron(id).spikeCount),counts.map(n=>n+1));assert.equal(f.json(r.field.config),before);
  const memory=v.exportMemory(r,{A:[],B:[]});assert.equal(memory.artifact.io.inputs[17].cells.length,4);
  const emitted=[],controller=new LockedController(memory.artifact,s=>emitted.push(s.neuronId));controller.io.pulse('f17',1);controller.advance(.04);
  assert.deepEqual(emitted.filter(id=>r.features.includes(id)).sort((a,b)=>a-b),[...r.groups[17]].sort((a,b)=>a-b));
});
test('direct and primed sets count all group members and keep one-hit cells separate',()=>{
  const groups=Array.from({length:192},(_,i)=>[i*4,i*4+1,i*4+2,i*4+3]),cues=f.CUES,bit=f.cueBits('A')[0],ids=groups[bit];
  const edges=[{sourceId:ids[0],targetId:1000},{sourceId:ids[0],targetId:1001},{sourceId:ids[1],targetId:1001},{sourceId:ids[2],targetId:1002},{sourceId:ids[3],targetId:1002}];
  for(const weight of [.6,.7]){const t=v.topology(groups,edges,cues,1.02,weight);assert.equal(t.hitThreshold,2);assert.deepEqual(t.directSets.A,[1001,1002]);assert.deepEqual(t.primedSets.A,[1000]);assert.deepEqual(t.directSets.B,[]);}
});
test('a single bounded native edge does not fire a pool cell',()=>{
  const field=new SpikingField({empty:true,seed:1,config:{radius:600,maxWeight:.7,weightDecay:0,unusedDecay:0,healthLoss:0},features:{hebbian:true,lateralInhibition:false,gradient:false}});
  const source=field.addNeuron({x:100,y:100}),target=field.addNeuron({x:120,y:100});source.nextGrowthAt=target.nextGrowthAt=1e12;source.connect(target,0,.7);
  const session=new DevelopmentSession(field,{}, {inputs:[{name:'input',cells:[source.id]}],outputs:[]});field.lockCircuit('bounded edge test');
  const fired=[],controller=new LockedController(compileController(field,{io:session.io.config}),s=>fired.push(s.neuronId));controller.io.pulse('input',1);controller.advance(1);
  assert.ok(fired.includes(source.id));assert.ok(!fired.includes(target.id));
});
test('one jitter draw per bit drives every copy at the same scheduled tick',()=>{
  const r=v.setup(fixture);r.epoch(1);const rng=f.random(r.streams.jitter);
  for(const row of r.rows){assert.equal(row.onsets.length,8);assert.equal(row.featureSpikes.length,32);assert.equal(row.captureTicks,58);
    for(const onset of row.onsets){assert.equal(onset.draw,rng());assert.equal(onset.offset,Math.floor(onset.draw*9));assert.equal(onset.cellIds.length,4);assert.equal(new Set(onset.cellIds.map(id=>row.featureSpikes.find(s=>s.neuronId===id).time)).size,1);}}
});
test('v2 stopping consults only the four contemporaneous half completions at both delays',()=>{
  const rows=()=>['A','B'].flatMap(cue=>[0,1].map(half=>({cue,half,completion:.8}))),halves={0:rows(),60:rows()};
  assert.equal(v.stoppingCriterion(30,halves),true);assert.equal(v.stoppingCriterion(120,halves),true);for(const n of [10,20,31,130])assert.equal(v.stoppingCriterion(n,halves),false);
  const cp={halfCompletions:halves,C:{spillover:0}};cp.C.spillover=1000;assert.equal(v.stoppingCriterion(30,cp.halfCompletions),true);halves[60][3].completion=.79;assert.equal(v.stoppingCriterion(30,halves),false);
});
test('fixed basin prefixes are nested and the four-bit subsets are exactly the old halves',()=>{
  for(const cue of ['A','B'])for(const half of [0,1]){let previous=[];for(const n of v.COUNTS){const bits=v.subsetBits(cue,n,half,f.CUES);assert.equal(bits.length,n);assert.ok(previous.every(b=>bits.includes(b)));previous=bits;}
    assert.deepEqual(v.subsetBits(cue,4,half,f.CUES),f.cueBits(cue,half));}
});
test('two-hit audit prediction integrates afferents rather than treating a lone arrival as a spike',()=>{
  const rows=[{epoch:1,cue:'A',t0:1,onsets:[{tick:1,cellIds:[1,2]}]}],config={dt:.02,leakRate:1.4,threshold:1.02};
  const edges=[{sourceId:1,targetId:3,weight:.7,delay:.1},{sourceId:1,targetId:4,weight:.7,delay:.1},{sourceId:2,targetId:4,weight:.7,delay:.2}];
  const schedule=audit.afferentPredictions(rows,edges,config)[0];assert.equal(schedule.arrivals.has(3),false);assert.equal(schedule.arrivals.get(4),.2);
});
test('same v2 seed reproduces summary and native memory bytes with all weights bounded',()=>{
  const first=primary(),second=v.runCondition(fixture);assert.equal(f.json(first.summary),f.json(second.summary));assert.equal(f.json(first.memory),f.json(second.memory));
  assert.ok(first.memory.artifact.edges.every(e=>e.weight<=.7));assert.ok(first.summary.structuralAudit.totals.maxAbsUnobservedWeightChange<1e-10);
});
test('shared pre-stimulus states reproduce the original independent native battery exactly',()=>{
  const p=primary(),native=f.probeBattery(p.memory),cached=v.probeBattery(p.memory);assert.equal(f.json(cached),f.json(native));
  const basin=v.basinProbes(p.memory);for(const s of [0,60])for(const row of basin[s].filter(r=>r.count===4||r.count===8)){
    const reference=row.count===4?native.halfProbes[s].find(r=>r.cue===row.cue&&r.half===row.half):native.probes[s].find(r=>r.cue===row.cue);assert.deepEqual(row.active,reference.active);
  }
});
test('restored grouped formation and resumed audit match uninterrupted training',()=>{
  const p=primary(),restored=v.restoreStop(p),full=v.setup({...fixture,epochs:4});for(let i=1;i<=4;i++)full.epoch(i);for(let i=3;i<=4;i++)restored.epoch(i);
  const cores={A:f.extractCore(full.trials.A),B:f.extractCore(full.trials.B)};assert.equal(f.json(v.exportMemory(restored,cores)),f.json(v.exportMemory(full,cores)));
  assert.equal(f.json(restored.rows),f.json(full.rows));const a=restored.weightAudit.finish(),b=full.weightAudit.finish();
  assert.equal(a.lifecycles.length,b.lifecycles.length);for(const row of a.lifecycles){const old=b.lifecycles.find(e=>e.id===row.id);for(const key of ['birthEpoch','birthTick','deathEpoch','finalWeight','potentiationEvents','competitionEvents'])assert.equal(row[key],old[key]);}
  for(const key of ['formed','pruned','potentiationEvents','competitionEvents'])assert.equal(a.epochs.reduce((n,e)=>n+e[key],0),b.epochs.reduce((n,e)=>n+e[key],0));
});
test('continued Hebbian-off records its phase change and gates 11 against frozen cores plus drift',()=>{
  const p=primary(),continued=v.runCondition({...fixture,epochs:4},'continued-hebbian-off',{primary:p});
  assert.equal(continued.summary.effective.features.hebbian,false);assert.ok(continued.summary.effective.featureHistory.length>p.summary.effective.featureHistory.length);
  assert.ok(continued.trials.weightAudit.epochs.filter(e=>e.epoch>2).every(e=>e.potentiationEvents===0));
  const r=v.restoreStop(p),cp=v.checkpoint(r,120);cp.memory.cores={A:[],B:[]};const result=v.continuedAssessment(r,cp,p,f.probeBattery(p.untrainedMemory));
  assert.deepEqual(result.frozenCores,p.memory.cores);assert.equal(result.frozenMetrics.coreSizes.A,p.memory.cores.A.length);assert.equal(result.components.drift,false);
});
test('native prune-formed preserves afferents and exactly removes stopping pool edges',()=>{
  const p=primary(),pruned=v.pruneFormed(p),ids=new Set(pruned.summary.ablation.removed);assert.ok(ids.size>0);
  assert.deepEqual(pruned.memory.artifact.edges,p.memory.artifact.edges.filter(e=>!ids.has(e.id)));assert.deepEqual(pruned.memory.artifact.nodes,p.memory.artifact.nodes);
  assert.equal(pruned.summary.epoch,2);
});
test('v2 declaration fixes seven cells and diagnostics never replace the three primary seeds',()=>{
  const d=study.declaration();assert.equal(d.cells.length,7);assert.equal(d.cells.filter(c=>c.options.seed===1).length,5);assert.equal(d.gates.continued.median,.65);assert.match(d.gates.continued.reference,/Frozen/);
  const cells=d.cells.map(c=>({...c,summary:{pass:c.role==='baseline',failedCriteria:['diagnostic']}}));assert.equal(study.decide(cells).pass,true);cells[1].summary.pass=false;assert.equal(study.decide(cells).pass,false);
});
