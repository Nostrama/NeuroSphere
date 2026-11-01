'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const r=require('../examples/readout.cjs'),a=require('../examples/association.cjs'),f=require('../examples/formation.cjs');
const {SpikingField,core:{Synapse},loadVocabulary}=require('../src/index.cjs');
let savedOrigin=null;
function origin(){if(!savedOrigin){
  const run=f.setup({seed:1,pool:150}),trials={A:[],B:[]};for(let epoch=1;epoch<=2;epoch++){for(const cue of ['A','B'])trials[cue].push(run.trial(cue));run.weightAudit.endEpoch(epoch);}
  const cores={A:f.extractCore(trials.A),B:f.extractCore(trials.B)},expected={memory:f.exportMemory(run,cores),trials:{...trials,growthEdges:a.liveEdges(run).map(({delay,...e})=>e),stimulusSchedule:run.stimulusSchedule}};
  savedOrigin=a.reproduce(1,{values:{pool:150},epochs:2,expected}).origin;
}return savedOrigin;}
test('readout apparatus preserves native memories, adds dense ordinary0.02 projections, and round-trips permanent settings',()=>{
  const o=origin(),run=r.setup(o),pool=new Set(run.pool),ids=new Set(Object.values(run.outputs).map(v=>v.id));
  assert.equal(run.field.config.maxSynapses,10);assert.equal(run.field.config.weightFloor,0);
  assert.equal(run.field.links.filter(e=>pool.has(e.sourceId)&&ids.has(e.targetId)).length,2*run.pool.length);
  for(const e of run.field.links.filter(e=>ids.has(e.targetId))){assert.equal(e.weight,.02);assert.equal(e.fixed,undefined);const source=run.field.getNeuron(e.sourceId),target=e.target;
    assert.equal(e.delay,.04+Math.hypot(source.x-target.x,source.y-target.y,source.z-target.z)/1800);}
  for(const id of run.pool){const n=run.field.getNeuron(id);assert.equal(n.radius,60);assert.equal(n.nextGrowthAt,1e12);assert.ok(n.synapses.length<=10);}
  for(const cue of ['A','B']){const n=run.field.getNeuron(run.outputs[cue].id);assert.equal(n.recordOutput,true);assert.equal(n.threshold,.4*o.refs[cue].length*1.65);assert.equal(n.synapses.length,0);}
  const restored=SpikingField.fromSnapshot(run.field.snapshot());assert.equal(restored.config.weightFloor,0);assert.equal(restored.config.maxSynapses,10);assert.deepEqual(restored.neurons.map(n=>n.nextGrowthAt),run.field.neurons.map(n=>n.nextGrowthAt));
  r.assertPreserved(run);
});
test('engine fixScaffold incompatibility is real: native floor raises0.02 and fixed prune refuses',()=>{
  const run=r.setup(origin()),output=run.outputs.A.id,edge=run.field.links.find(e=>e.targetId===output),source=run.field.getNeuron(edge.sourceId);
  edge.fixScaffold(source);assert.equal(edge.weight,.3);edge.prune();assert.equal(edge.active,true);assert.throws(()=>SpikingField.fromSnapshot(run.field.snapshot()),/Invalid fixed scaffold/);
});
test('readout scopes Hebbian postsynaptically, retains pool radius and uses no output clamp',()=>{
  const run=r.setup(origin()),frame=[];for(const n of run.field.neurons){const env=run.field.env.forNeuron(n,frame);assert.equal(env.features.hebbian,Object.values(run.outputs).some(o=>o.id===n.id));if(n.recordOutput)assert.notEqual(env.inputClamped,true);}
  const off=r.setup(origin(),{},'readout-hebbian-off');for(const n of off.field.neurons)assert.equal(off.field.env.forNeuron(n,[]).features.hebbian,false);
});
test('teacher schedule is deterministic; native refractory veto and early natural spikes are recorded',()=>{
  const o=origin(),first=r.attachTraining(r.setup(o),o),second=r.attachTraining(r.setup(o),o);first.epoch(1);second.epoch(1);
  assert.equal(f.json(first.rows),f.json(second.rows));assert.equal(f.json(first.field.snapshot()),f.json(second.field.snapshot()));
  for(const row of first.rows){assert.equal(row.teacher.tick,row.t0+24);assert.equal(row.teacher.delivered,!row.teacher.refractoryVeto);assert.equal(row.onsets.length,8);assert.ok(row.onsets.every(x=>x.offset>=0&&x.offset<=15));}
  const native=r.attachTraining(r.setup(o),o),target=native.field.getNeuron(native.outputs.A.id);target.refractoryUntil=native.field.time+1;
  const row=native.trial('A',1);assert.equal(row.teacher.delivered,false);assert.equal(row.teacher.refractoryVeto,true);
  r.assertPreserved(first);assert.ok(first.field.links.some(e=>e.targetId===first.outputs.A.id&&e.weight>.02));
});
test('readout probes have no teacher and passive margin observers preserve native responses',()=>{
  const o=origin(),run=r.attachTraining(r.setup(o),o);run.epoch(1);const memory=r.memoryOf(run,o,1);
  for(const cue of ['A','B','C']){
    const observed=r.probe(memory,cue),plain=r.probe(memory,cue,0,null,{observe:false});assert.deepEqual(observed.spikes,plain.spikes);assert.deepEqual(observed.active,plain.active);assert.deepEqual(observed.io,plain.io);
    for(const c of ['A','B']){assert.equal(observed.outputs[c].inputMargin,observed.outputs[c].arrivingWeight-observed.outputs[c].threshold);assert.ok(Number.isFinite(observed.outputs[c].peakMargin));}
  }
});
test('stopping reads only R1-R3 at checkpoints20..80, and all control outcomes are required',()=>{
  const gates={R1:true,R2:true,R3:true,R4:false};assert.equal(r.stoppingCriterion(20,gates),true);for(const epoch of [0,10,21,90])assert.equal(r.stoppingCriterion(epoch,gates),false);
  for(const key of ['R1','R2','R3'])assert.equal(r.stoppingCriterion(40,{...gates,[key]:false}),false);
});
test('snapshot restoration and readout/formed ablations remove only declared edges',()=>{
  const o=origin(),primary=r.runCondition(o,{epochs:2}),baseline=r.initialFormation(o),restored=r.restoreStopped(o,primary);
  const repeated=r.runCondition(o,{epochs:2});assert.equal(f.json(primary.summary),f.json(repeated.summary));assert.equal(f.json(primary.memory),f.json(repeated.memory));
  assert.equal(f.json(r.memoryOf(restored,o,2)),f.json(primary.memory));
  for(const condition of ['prune-readout','prune-formed']){
    const cut=r.pruneCondition(o,primary,condition,baseline),removed=new Set(cut.summary.ablation.removed);
    assert.deepEqual(cut.memory.artifact.edges,primary.memory.artifact.edges.filter(e=>!removed.has(e.id)));assert.deepEqual(cut.memory.artifact.nodes,primary.memory.artifact.nodes);
    if(condition==='prune-readout')assert.equal(cut.summary.ablation.poolResponsesUnchanged,true);
  }
});
test('prune-readout uses a strict0.1 threshold on ordinary native edges',()=>{
  const o=origin(),run=r.setup(o),target=run.outputs.A.id,edges=run.field.links.filter(e=>e.targetId===target);edges[0].weight=.100001;edges[1].weight=.1;
  const baseline=r.initialFormation(o),cp=r.assess(run,o,0,baseline),saved=r.save(run,o,cp),cut=r.pruneCondition(o,saved,'prune-readout',baseline);
  assert.deepEqual(cut.summary.ablation.removed,[edges[0].id]);assert.equal(cut.memory.artifact.edges.find(e=>e.id===edges[1].id).weight,.1);assert.equal(cut.summary.ablation.poolResponsesUnchanged,true);
});
test('every declared baseline and all five discrimination outcomes are required; diagnostics cannot replace them',()=>{
  const study=require('../examples/readout-study.cjs'),plan=study.declaration();assert.equal(plan.cells.length,8);assert.equal(plan.cells.filter(c=>c.seed===1).length,6);
  const cells=plan.cells.map(c=>({...c,summary:{pass:c.role==='baseline',failedCriteria:['fixture failure']}}));assert.equal(study.decide(cells).pass,true);cells[1].summary.pass=false;assert.equal(study.decide(cells).pass,false);
  const row=(cue,fired)=>({cue,outputs:{A:{fired:fired==='A'},B:{fired:fired==='B'}}}),observed=mode=>({probes:Object.fromEntries([0,60].map(s=>[s,['A','B','C'].map(c=>row(c,mode==='swap'&&c!=='C'?(c==='A'?'B':'A'):null))])),halfProbes:{0:[],60:[]}});
  const controls={'readout-hebbian-off':{gates:{R1:false},observed:observed('none')},'prune-readout':{gates:{R1:false},ablation:{poolResponsesUnchanged:true}},'swapped-teacher':{observed:observed('swap')},
    'prune-formed':{gates:{R1:true,R2:false}},'untrained-readout':{observed:observed('none')}};
  const primary={epoch:40,gates:{R1:true,R2:true,R3:true,R4:true},stopping:{reached:true}};for(const [name,control] of Object.entries(controls))control.epoch=name==='untrained-readout'?0:40;
  assert.equal(r.decide(primary,controls).pass,true);
  controls['prune-formed'].gates.R1=false;assert.equal(r.decide(primary,controls).pass,false);
  controls['readout-hebbian-off'].epoch=80;assert.throws(()=>r.decide(primary,controls),/Unmatched/);
});
test('decoded words come from output concept IDs through the vocabulary codebook, not input text copying',()=>{
  const o=origin(),run=r.setup(o),memory=r.memoryOf(run,o,0);const result=r.decoded(memory,'aardvark');assert.match(result.interpretation,/codebook|vocabulary/);assert.equal(result.status,'silent');
  const forced=structuredClone(memory),output=forced.artifact.nodes.find(n=>n.id===forced.outputs.B.id);output.threshold=.01;forced.outputs.B.threshold=.01;
  const decoded=r.decoded(forced,'aardvark');assert.equal(decoded.status,'decoded');assert.equal(decoded.outputs[0].word,loadVocabulary().get(forced.outputs.B.conceptId).word);assert.notEqual(decoded.outputs[0].word,'aardvark');
});
