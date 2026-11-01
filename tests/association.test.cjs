'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const f=require('../examples/formation.cjs'),a=require('../examples/association.cjs'),study=require('../examples/association-study.cjs'),audit=require('../examples/association-audit.cjs');
const values={pool:150,epochs:2,gap:.5};
let fixture;
function origin(){
  if(!fixture){const evidence=f.runCondition(values,'primary',{checkpoints:false});fixture=a.reproduce(1,{values,epochs:2,expected:{memory:evidence.memory,trials:evidence.trials}}).origin;}
  return structuredClone(fixture);
}
test('association reproduces an unlocked Stage 1 state byte-for-byte and rejects changed evidence',()=>{
  const o=origin();assert.equal(o.identity.byteIdentical,true);assert.equal(Boolean(o.checkpoint.snapshot.circuitLock),false);
  const run=a.restore(o);assert.equal(f.json(f.exportMemory(run,o.refs)),f.json(o.memory));
  const bad=structuredClone(o);bad.memory.artifact.edges[0].weight+=.01;assert.throws(()=>a.restore(bad),/differs/);
});
test('paired schedule preserves order for delta 12, jitter 5 and records every seeded draw',()=>{
  const run=a.restore(origin()),rng=f.random(123);
  for(let i=1;i<=40;i++){const row=a.schedulePair(run,i,12,5,rng),A=row.onsets.filter(x=>x.cue==='A'),B=row.onsets.filter(x=>x.cue==='B');
    assert.equal(A.length,8);assert.equal(B.length,8);assert.ok(Math.max(...A.map(x=>x.tick))<Math.min(...B.map(x=>x.tick)));
    for(const x of row.onsets)assert.equal(x.offset,(x.cue==='A'?0:12)+Math.floor(x.draw*6));assert.equal(row.captureTicks,67);
  }
});
test('cross-core membership includes shared cells, and pruning removes the union exactly once',()=>{
  const refs={A:[1,2],B:[2,3]},edges=[{id:'a',sourceId:1,targetId:2},{id:'b',sourceId:2,targetId:3},{id:'c',sourceId:3,targetId:1},{id:'d',sourceId:4,targetId:5}];
  assert.deepEqual(a.classify(edges,refs).forward.map(e=>e.id),['a','b']);assert.deepEqual(a.classify(edges,refs).reverse.map(e=>e.id),['c']);
  const run=a.restore(origin()),before=run.field.snapshot(),cross=a.classify(a.liveEdges(run),fixture.refs).union,removed=a.pruneCross(run,fixture.refs);
  assert.deepEqual([...removed].sort(),cross.map(e=>e.id).sort());const after=run.field.snapshot();
  // Strict native export after pruning validates all remaining live edges. Afferents stay byte-identical.
  assert.equal(f.json(after.neurons.filter(n=>fixture.features.includes(n.id))),f.json(before.neurons.filter(n=>fixture.features.includes(n.id))));
  assert.doesNotThrow(()=>f.exportMemory(run,fixture.refs));
});
test('association stop predicate uses only forward recruitment at both delays',()=>{
  const probe={forward:{0:.5,60:.6},C:{spillover:100}};
  assert.equal(a.stoppingCriterion(5,probe.forward),true);probe.C={spillover:0};assert.equal(a.stoppingCriterion(5,probe.forward),true);
  for(const epoch of [0,4,6,45])assert.equal(a.stoppingCriterion(epoch,probe.forward),false);
  assert.equal(a.stoppingCriterion(5,{0:.9,60:.49}),false);assert.equal(a.stoppingCriterion(5,{0:NaN,60:1}),false);
});
test('paired audit combines both afferent schedules and distinguishes arrival direction',()=>{
  const rows=[{epoch:1,cue:'A→B',t0:1,onsets:[{cellId:1,tick:1},{cellId:2,tick:13}]}];
  const schedules=audit.schedulesFor(rows,[{sourceId:1,targetId:3,delay:.14},{sourceId:2,targetId:4,delay:.14}],.02);
  const predict=require('../examples/formation-audit.cjs').predictedPairings;
  assert.equal(predict({sourceId:3,targetId:4,delay:.06,birthTime:0},schedules).qualifying,1);
  assert.equal(predict({sourceId:4,targetId:3,delay:.06,birthTime:0},schedules).qualifying,0);
});
test('same association seed gives byte-identical summary; native observers do not mutate config',()=>{
  const o=origin(),first=a.runCondition(o,{maximum:5}),second=a.runCondition(o,{maximum:5});
  assert.equal(f.json(first.summary),f.json(second.summary));assert.equal(f.json(first.memory),f.json(second.memory));
  assert.equal(first.summary.effective.configUnchanged,true);
  assert.ok(first.summary.structuralAudit.totals.maxAbsUnobservedWeightChange<1e-10);
  const pruned=a.pruneCondition(o,first);assert.equal(pruned.summary.unchangedOtherEdges,true);
});
test('declared study contains the fixed primary seeds and six diagnostic cells, with reported cells nongating',()=>{
  const plan=study.declaration();assert.equal(plan.cells.length,8);
  assert.deepEqual(plan.cells.filter(c=>c.role==='baseline').map(c=>c.seed),[1,2,3]);
  assert.equal(plan.cells.filter(c=>c.seed===1).length,6);
  const rows=plan.cells.map(c=>({...c,summary:{pass:c.role==='baseline',failedCriteria:['reported failure']}}));
  assert.equal(study.decide(rows).pass,true);rows[1].summary.pass=false;assert.equal(study.decide(rows).pass,false);
});
test('native restored unpaired continuation exactly reproduces uninterrupted Stage 1 training',()=>{
  const o=origin(),continuation=a.runCondition(o,{condition:'unpaired-continuation',matchedEpoch:5,maximum:5});
  const uninterrupted=f.setup(values);
  for(let epoch=1;epoch<=7;epoch++){uninterrupted.trial('A');uninterrupted.trial('B');uninterrupted.weightAudit.endEpoch(epoch);}
  const expected=f.exportMemory(uninterrupted,o.refs);
  assert.equal(f.json(continuation.memory.artifact),f.json(expected.artifact));
  assert.equal(f.json(continuation.trials.rows.map(r=>({t0:r.t0,onsets:r.onsets.map(({cue,...o})=>o)}))),
    f.json(Array.from({length:5},(_,i)=>['A','B'].map(cue=>{const r=uninterrupted.stimulusSchedule[cue][i+2];return {t0:r.t0,onsets:r.onsets};})).flat()));
});
test('relative containment and all matched controls gate both delays; absolute cap stays observational',()=>{
  const halves=['A','B'].flatMap(cue=>[0,1].map(half=>({cue,half,completion:.9})));
  const metric=(forward,reverse,spill)=>({delays:Object.fromEntries([0,60].map(s=>[s,{forward,reverse,selfFull:{A:1,B:1},halves:structuredClone(halves),c:{fraction:spill,readback:'reject',jaccards:{A:.2,B:.2},absoluteCapPass:spill<=.25}}]))});
  const primary={summary:{epoch:10,stopping:{reached:true},metrics:metric(.6,.1,.4)}};
  const controls=Object.fromEntries([['untrained',.1,.1,.1],['unpaired-continuation',.1,.1,.35],['hebbian-off-association',.2,.1,.3],['prune-cross',.2,.1,.3]].map(([name,forward,reverse,spill])=>[name,{summary:{epoch:name==='untrained'?0:10,metrics:metric(forward,reverse,spill)}}]));
  assert.equal(a.evaluate(primary,controls).pass,true);
  controls['unpaired-continuation'].summary.metrics.delays[60].c.fraction=.1;
  assert.equal(a.evaluate(primary,controls).criteria.relativeContainment,false);
  controls['unpaired-continuation'].summary.epoch=5;assert.throws(()=>a.evaluate(primary,controls),/Unmatched control/);
});
