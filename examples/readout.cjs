'use strict';
const assert=require('node:assert/strict'),f=require('./formation.cjs'),association=require('./association.cjs'),v2=require('./formation-v2.cjs');
const {SpikingField,DevelopmentSession,SpikeIO,LockedController,loadVocabulary,encodeWord,core:{Synapse}}=require('../src/index.cjs');
const {distribution}=require('./formation-audit.cjs');
const DELAYS=[0,60],CONTROLS=['readout-hebbian-off','prune-readout','swapped-teacher','prune-formed','untrained-readout'];
const copy=x=>structuredClone(x),sorted=xs=>[...new Set(xs)].sort((a,b)=>a-b);
function options(values={}){
  const result={teacherTick:24,thresholdFactor:.4,epochs:80,...values};
  if(Object.keys(result).some(k=>!['teacherTick','thresholdFactor','epochs'].includes(k))||![16,24,32].includes(result.teacherTick)||![.25,.4].includes(result.thresholdFactor)||!Number.isInteger(result.epochs)||result.epochs<1||result.epochs>80)throw new Error('Undeclared readout setting.');
  return result;
}
function weights(field,ids){const set=new Set(ids);return field.links.filter(e=>e.active&&set.has(e.sourceId)&&set.has(e.targetId)).map(e=>({id:e.id,sourceId:e.sourceId,targetId:e.targetId,weight:e.weight}));}
function scope(run){
  const prior=run.field.env.forNeuron.bind(run.field.env),outputIds=new Set(Object.values(run.outputs).map(o=>o.id));
  run.teacher=null;
  run.field.env.forNeuron=(cell,frame)=>{
    const env=prior(cell,frame);env.features={...env.features,hebbian:run.condition!=='readout-hebbian-off'&&outputIds.has(cell.id)};
    if(run.teacher&&run.field.tick===run.teacher.tick&&cell.id===run.teacher.id){
      env.forcedSpike=true;run.teacher.refractoryUntil=cell.refractoryUntil;run.teacher.refractoryVeto=env.time<cell.refractoryUntil;
    }
    return env;
  };
  return run;
}
function setup(origin,values={},condition='primary'){
  if(!['primary',...CONTROLS].includes(condition))throw new Error('Unknown readout condition.');
  const run=association.restore(origin),opts=options(values),{field,session}=run;
  const originalWeights=weights(field,run.pool),allExisting=field.links.filter(e=>e.active).map(e=>({id:e.id,weight:e.weight}));
  const before=copy(field.config);field.config.maxSynapses=10;field.config.weightFloor=0;
  for(const id of run.pool)field.getNeuron(id).nextGrowthAt=1e12;
  const outputs=Object.fromEntries(['A','B'].map(cue=>{
    const cell=field.addNeuron({x:400,y:400,z:400,recordOutput:true});cell.nextGrowthAt=1e12;
    cell.threshold=opts.thresholdFactor*origin.refs[cue].length*field.config.maxWeight;
    return [cue,{id:cell.id,name:'O_'+cue,conceptId:origin.cueSelection.records[cue].id,threshold:cell.threshold}];
  }));
  for(const id of run.pool){const source=field.getNeuron(id);assert.ok(source.synapses.length+2<=10,'Readout needs two reserved terminal slots.');
    for(const cue of ['A','B']){
      const edge=new Synapse(source.id+'/s'+source.nextSynapseId++,source,field.getNeuron(outputs[cue].id),field.config,field.time,.02);
      source.synapses.push(edge);
    }
  }
  session.io=new SpikeIO({inputs:session.io.config.inputs,outputs:['A','B'].map(cue=>({name:outputs[cue].name,cells:[outputs[cue].id],mode:'count'}))},field.neurons,field.config.dt);
  session.io.tick=field.tick;
  const phase={tick:field.tick,time:field.time,configBefore:before,configAfter:copy(field.config),maxSynapses:10,weightFloor:0,
    poolGrowthAt:1e12,poolGrowthIds:[...run.pool],outputGrowthAt:1e12,plasticityScope:Object.values(outputs).map(o=>o.id),readoutHebbian:condition!=='readout-hebbian-off',nativeFeatures:copy(field.features),
    wiring:'Dense ordinary native Synapse projections at0.02; preserved pool radius60 and native geometric delays; no fixed flags.',
    teacher:'Native env.forcedSpike only; natural output activity retained, refractoriness respected, no output clamp.',
    inputAdapter:'Existing feature ports retained; add O_A/O_B output channels, start readout IO counters at the phase boundary.'};
  Object.assign(run,{readoutOptions:opts,condition,outputs,phase,originalWeights,allExisting,rows:[],originSeed:origin.seed});
  scope(run);assert.equal(f.json(weights(field,run.pool)),f.json(originalWeights));
  assert.ok(run.pool.every(id=>field.getNeuron(id).radius===origin.memory.artifact.nodes.find(n=>n.id===id).radius));
  // Native reload must describe exactly the actual ordinary projections.
  const restored=SpikingField.fromSnapshot(field.snapshot());
  assert.deepEqual(restored.links.map(e=>[e.id,e.weight,e.delay]),field.links.map(e=>[e.id,e.weight,e.delay]));
  return run;
}
function assertPreserved(run){
  assert.equal(f.json(weights(run.field,run.pool)),f.json(run.originalWeights),'R4: a pool->pool weight or edge changed.');
  const current=new Map(run.field.links.filter(e=>e.active).map(e=>[e.id,e.weight]));
  for(const e of run.allExisting)assert.equal(current.get(e.id),e.weight,'Non-readout edge changed: '+e.id);
  assert.equal(f.json(run.field.config),f.json(run.phase.configAfter),'Temporary config mutation is forbidden.');
  for(const id of run.pool)assert.equal(run.field.getNeuron(id).nextGrowthAt,1e12);
  for(const output of Object.values(run.outputs)){const cell=run.field.getNeuron(output.id);assert.equal(cell.threshold,output.threshold);assert.equal(cell.nextGrowthAt,1e12);assert.equal(cell.recordOutput,true);assert.equal(cell.synapses.length,0);}
}
function memoryOf(run,origin,epoch){
  const native=f.exportMemory(run,origin.refs);
  return {...native,schema:'neurosphere-readout/v1',seed:origin.seed,formationEpoch:origin.epoch,readoutEpoch:epoch,referenceIdentity:origin.identity,
    outputs:copy(run.outputs),phase:copy(run.phase),readoutOptions:copy(run.readoutOptions),codebook:'Host vocabulary.get(conceptId).word lookup for the firing output cell; not generated language.'};
}
function attachTraining(run,origin){
  const phaseSeed=(origin.seed^0x94d049bb)>>>0,rng=f.random(phaseSeed),pool=new Set(run.pool),outputIds=new Set(Object.values(run.outputs).map(o=>o.id));
  const prior=run.field.onEvent;let capture=null;
  run.field.onEvent=event=>{prior(event);if(capture&&event.type==='spike'){
    const spike={neuronId:event.spike.neuronId,time:event.spike.time,driven:event.spike.driven,externalDrive:!!event.spike.externalDrive};
    if(pool.has(spike.neuronId))capture.pool.push(spike);else if(outputIds.has(spike.neuronId))capture.outputs.push(spike);else capture.features.push(spike);
  }};
  run.phase.jitterStream=phaseSeed;run.phase.jitter='Dedicated seeded stream, one U{0..15} draw per cue bit; shared across matched controls.';
  run.trial=(cue,epoch)=>{
    const {field,session}=run,t0=field.tick+1,captureTicks=65,teacherCue=run.condition==='swapped-teacher'?(cue==='A'?'B':'A'):cue;
    const onsets=f.cueBits(cue,null,run.cues).map(bit=>{const draw=rng(),offset=Math.floor(draw*16),tick=t0+offset;session.io.pulse('f'+bit,tick);return {bit,cellId:run.features[bit],draw,offset,tick};});
    run.teacher={id:run.outputs[teacherCue].id,cue:teacherCue,tick:t0+run.readoutOptions.teacherTick,refractoryUntil:null,refractoryVeto:null};
    capture={pool:[],outputs:[],features:[]};for(let n=0;n<captureTicks;n++)session.step();
    const teacher={...run.teacher,delivered:capture.outputs.some(s=>s.neuronId===run.teacher.id&&Math.abs(s.time-run.teacher.tick*field.config.dt)<1e-9&&s.externalDrive),
      naturalBefore:capture.outputs.filter(s=>s.neuronId===run.teacher.id&&!s.driven&&s.time<run.teacher.tick*field.config.dt-1e-9)};
    assert.notEqual(teacher.refractoryVeto,null,'Teacher tick was not visited.');assert.equal(teacher.delivered,!teacher.refractoryVeto,'Native teacher request must either deliver or be refractory-vetoed.');
    const row={epoch,cue,t0,captureTicks,onsets,teacher,active:sorted(capture.pool.map(s=>s.neuronId)),...capture};capture=null;run.teacher=null;
    assert.deepEqual(sorted(row.features.map(s=>s.neuronId)),sorted(onsets.map(o=>o.cellId)));assert.equal(row.features.length,8);
    for(const onset of onsets)assert.ok(Math.abs(row.features.find(s=>s.neuronId===onset.cellId).time-onset.tick*field.config.dt)<1e-8);
    for(let n=0;n<500;n++)session.step();run.rows.push(row);assertPreserved(run);return row;
  };
  run.epoch=n=>{run.trial('A',n);run.trial('B',n);};return run;
}
const cache=new WeakMap();
function idleStates(memory){if(!cache.has(memory)){const states={};for(const s of DELAYS){const c=new LockedController(memory.artifact);c.advance(s);states[s]=c.checkpoint();}cache.set(memory,states);}return cache.get(memory);}
function probe(memory,cue,seconds=0,half=null,{bits=null,observe=true}={}){
  const code=bits||f.cueBits(cue,half,memory.cues),pool=new Set(memory.pool),spikes=[],outputIds=new Set(Object.values(memory.outputs).map(o=>o.id));
  const controller=LockedController.restore(idleStates(memory)[seconds],spike=>{if(pool.has(spike.neuronId)||outputIds.has(spike.neuronId))spikes.push({neuronId:spike.neuronId,time:spike.time});});
  const t0=controller.tick+1,measure=Object.fromEntries(['A','B'].map(c=>[c,{arrivingWeight:0,integratedWeight:0,peakPotential:0,peakEffectiveThreshold:null,peakMargin:-Infinity,firstSpike:null}]));
  if(observe)for(const c of ['A','B']){
    const cell=controller.getNeuron(memory.outputs[c].id),native=cell.step,nativeFire=cell.fire,m=measure[c];
    Object.defineProperty(cell,'step',{value:function(dt,env){
      const due=this.inbox.filter(msg=>msg.at<=env.time+1e-9);m.arrivingWeight+=due.reduce((s,msg)=>s+msg.weight,0);
      if(env.time>=this.refractoryUntil){m.integratedWeight+=due.reduce((s,msg)=>s+msg.weight,0);const preview=this.previewThreshold(dt,env.time),margin=preview.potential-preview.threshold;
        if(margin>m.peakMargin){m.peakMargin=margin;m.peakPotential=preview.potential;m.peakEffectiveThreshold=preview.threshold;}}
      return native.call(this,dt,env);
    }});
    Object.defineProperty(cell,'fire',{value:function(...args){if(!m.firstSpike)m.firstSpike={potential:this.potential,effectiveThreshold:this.firingThreshold,integratedWeight:m.integratedWeight};return nativeFire.apply(this,args);}});
  }
  for(const bit of code)controller.io.pulse('f'+bit,t0);controller.advance(1);
  const active=sorted(spikes.filter(s=>pool.has(s.neuronId)).map(s=>s.neuronId)),outputs=Object.fromEntries(['A','B'].map(c=>{
    const o=memory.outputs[c],times=spikes.filter(s=>s.neuronId===o.id).map(s=>s.time),m=measure[c];
    return [c,{...o,spikeTimes:times,spikeTicks:times.map(t=>Math.round(t/controller.config.dt)),latencyTicks:times.map(t=>Math.round(t/controller.config.dt)-t0),
      fired:times.length>0,...(observe?{...m,inputMargin:m.arrivingWeight-o.threshold}:{} )}];
  }));
  return {cue,half,bits:code,idleSeconds:seconds,t0,active,spikes,outputs,io:controller.io.decode(false),...f.decode(active,memory.cores),
    coreCellsFired:Object.fromEntries(['A','B'].map(c=>[c,active.filter(id=>memory.cores[c].includes(id)).length]))};
}
function battery(memory){return {probes:Object.fromEntries(DELAYS.map(s=>[s,['A','B','C'].map(c=>probe(memory,c,s))])),
  halfProbes:Object.fromEntries(DELAYS.map(s=>[s,['A','B'].flatMap(c=>[0,1].map(h=>probe(memory,c,s,h)))]))};}
function readoutGates(observed){
  const only=(r,c)=>r.outputs[c].fired&&!r.outputs[c==='A'?'B':'A'].fired;
  return {R1:DELAYS.every(s=>['A','B'].every(c=>only(observed.probes[s].find(r=>r.cue===c),c))),
    R2:DELAYS.every(s=>observed.halfProbes[s].length===4&&['A','B'].every(c=>[0,1].every(h=>only(observed.halfProbes[s].find(r=>r.cue===c&&r.half===h),c)))),
    R3:DELAYS.every(s=>{const r=observed.probes[s].find(r=>r.cue==='C');return !r.outputs.A.fired&&!r.outputs.B.fired;})};
}
function stoppingCriterion(epoch,gates){return Number.isInteger(epoch)&&epoch>=20&&epoch<=80&&epoch%10===0&&['R1','R2','R3'].every(k=>gates[k]===true);}
function weightReport(memory){const pool=new Set(memory.pool),edges=memory.artifact.edges.filter(e=>pool.has(e.sourceId)),A=new Set(memory.cores.A),B=new Set(memory.cores.B);
  return Object.fromEntries(['A','B'].map(cue=>{
    const own=memory.cores[cue],other=memory.cores[cue==='A'?'B':'A'],selected=edges.filter(e=>e.targetId===memory.outputs[cue].id),mean=ids=>{const e=selected.filter(e=>ids.includes(e.sourceId));return e.length?e.reduce((s,v)=>s+v.weight,0)/e.length:0;};
    return [cue,{all:distribution(selected.map(e=>e.weight)),refA:distribution(selected.filter(e=>A.has(e.sourceId)).map(e=>e.weight)),refB:distribution(selected.filter(e=>B.has(e.sourceId)).map(e=>e.weight)),
      other:distribution(selected.filter(e=>!A.has(e.sourceId)&&!B.has(e.sourceId)).map(e=>e.weight)),overlapCount:selected.filter(e=>A.has(e.sourceId)&&B.has(e.sourceId)).length,
      selectivity:(mean(own)-mean(other))/memory.artifact.config.maxWeight}];
  }));
}
function initialFormation(origin){const run=f.setup(origin.opts),memory=f.exportMemory(run,{A:[],B:[]});return {memory,battery:v2.probeBattery(memory)};}
function assess(run,origin,epoch,baseline){
  const memory=memoryOf(run,origin,epoch),observed=battery(memory),gates=readoutGates(observed),preserved=f.json(weights(run.field,run.pool))===f.json(run.originalWeights);
  const formation=f.metrics({trials:origin.formationTrials,cores:origin.refs,pool:run.pool,positions:run.positions,growthEdges:association.liveEdges(run),stats:run.field.stats,
    probes:observed.probes,seed:origin.seed,directSets:origin.directSets,halfProbes:observed.halfProbes,untrainedHalfProbes:baseline.battery.halfProbes,initialWeight:.4});
  const components={poolWeightsExactlyUnchanged:preserved,...Object.fromEntries(['2-specificity','4-negative-cue','8-retention','9-pattern-completion'].map(k=>[k,formation.criteria[k].pass]))};
  gates.R4=Object.values(components).every(Boolean);
  return {epoch,memory,row:{epoch,gates,reached:stoppingCriterion(epoch,gates),observed,formation,weights:weightReport(memory),memoryPreservation:components}};
}
function teacherReport(rows,outputs){return {epochs:sorted(rows.map(r=>r.epoch)).map(epoch=>({epoch,...Object.fromEntries(['A','B'].map(c=>{
  const r=rows.find(r=>r.epoch===epoch&&r.teacher.id===outputs[c].id);return [c,{delivered:r.teacher.delivered,refractoryVeto:r.teacher.refractoryVeto,naturalBefore:r.teacher.naturalBefore.length>0}];}))})),
  firstNaturalBeforeTeacher:Object.fromEntries(['A','B'].map(c=>[c,rows.find(r=>r.teacher.id===outputs[c].id&&r.teacher.naturalBefore.length)?.epoch??null]))};}
function save(run,origin,cp,stopping=null){return {summary:{schema:'neurosphere-readout-condition/v1',condition:run.condition,seed:origin.seed,options:copy(run.readoutOptions),epoch:cp.epoch,
  formationEpoch:origin.epoch,referenceIdentity:copy(origin.identity),refs:copy(origin.refs),effective:copy(run.phase),stopping,...cp.row,
  teacher:teacherReport(run.rows,run.outputs),pass:Object.values(cp.row.gates).every(Boolean)},memory:cp.memory,trials:{rows:copy(run.rows)},
  development:{checkpoint:run.session.checkpoint(),outputs:copy(run.outputs),phase:copy(run.phase),originalWeights:copy(run.originalWeights),allExisting:copy(run.allExisting)}};}
function runCondition(origin,values={},condition='primary',{matchedEpoch=null,baseline=null,onCheckpoint=null}={}){
  const opts=options(values),run=attachTraining(setup(origin,opts,condition),origin),initial=baseline||initialFormation(origin),curve=[],checkpointMemories=[];
  if(!['primary','readout-hebbian-off','swapped-teacher','untrained-readout'].includes(condition))throw new Error('Pruning controls must restore the exact primary stop.');
  const total=condition==='untrained-readout'?0:condition==='primary'?opts.epochs:matchedEpoch;
  if(!Number.isInteger(total)||total<0||total>opts.epochs)throw new Error('Invalid readout duration.');
  let stopped=null,final=null;
  const checkpoint=epoch=>{const cp=assess(run,origin,epoch,initial);curve.push(cp.row);checkpointMemories.push({epoch,memory:cp.memory});if(onCheckpoint)onCheckpoint(cp);return cp;};
  const zero=checkpoint(0);
  for(let epoch=1;epoch<=total;epoch++){
    run.epoch(epoch);if(epoch%10===0){const cp=checkpoint(epoch);final=cp;
      if(condition==='primary'&&!stopped&&(cp.row.reached||epoch===total))stopped=save(run,origin,cp,{epoch,reached:cp.row.reached,minimum:20,maximum:80,every:10,reads:['R1','R2','R3']});}
  }
  final=total===0?zero:final?.epoch===total?final:checkpoint(total);
  if(condition==='primary'){
    if(!stopped)stopped=save(run,origin,final,{epoch:total,reached:false,minimum:20,maximum:80,every:10,reads:['R1','R2','R3']});
    return {...stopped,curve,checkpointMemories,continued:save(run,origin,final),initial:{summary:zero.row,memory:zero.memory},initialFormationMemory:initial.memory};
  }return {...save(run,origin,final),curve,checkpointMemories};
}
function restoreStopped(origin,primary){
  const d=primary.development,session=DevelopmentSession.restore(d.checkpoint,SpikingField),field=session.field,ids=[...origin.features],set=new Set(ids);
  Object.defineProperty(field,'endpointIds',{get:()=>ids});field.isInputCell=id=>set.has(id);
  const run={field,session,condition:primary.summary.condition,readoutOptions:copy(primary.summary.options),outputs:copy(d.outputs),phase:copy(d.phase),originalWeights:copy(d.originalWeights),allExisting:copy(d.allExisting),
    features:ids,pool:[...origin.pool],opts:copy(origin.opts),cues:copy(origin.cues),cueSelection:copy(origin.cueSelection),refs:copy(origin.refs),directSets:copy(origin.directSets),rows:copy(primary.trials.rows),
    positions:new Map(field.neurons.filter(n=>origin.pool.includes(n.id)).map(n=>[n.id,{x:n.x,y:n.y,z:n.z}]))};
  scope(run);assert.equal(f.json(memoryOf(run,origin,primary.summary.epoch)),f.json(primary.memory),'Readout native stopping checkpoint differs.');return run;
}
function pruneCondition(origin,primary,condition,baseline){
  assert.ok(['prune-readout','prune-formed'].includes(condition));const run=restoreStopped(origin,primary),pool=new Set(run.pool),O=new Set(Object.values(run.outputs).map(o=>o.id));run.condition=condition;
  const before=run.field.links.filter(e=>e.active).map(e=>e.toJSON()),removed=[];
  for(const e of run.field.links.filter(e=>e.active&&pool.has(e.sourceId)&&(condition==='prune-readout'?O.has(e.targetId)&&e.weight>.1:pool.has(e.targetId)))){
    removed.push(e.id);e.prune();const source=run.field.getNeuron(e.sourceId);source.synapses=source.synapses.filter(s=>s!==e);
  }
  assert.equal(f.json(run.field.links.filter(e=>e.active).map(e=>e.toJSON())),f.json(before.filter(e=>!removed.includes(e.id))));
  const cp=assess(run,origin,primary.summary.epoch,baseline),result=save(run,origin,cp);
  const poolResponsesUnchanged=DELAYS.every(s=>['probes','halfProbes'].every(key=>f.json(cp.row.observed[key][s].map(r=>r.active))===f.json(primary.summary.observed[key][s].map(r=>r.active))));
  result.summary.ablation={removed,otherEdgesUnchanged:true,poolResponsesUnchanged};return result;
}
function decide(primary,controls){
  for(const name of CONTROLS){assert.ok(controls[name],'Missing readout control: '+name);assert.equal(controls[name].epoch,name==='untrained-readout'?0:primary.epoch,'Unmatched readout control duration: '+name);}
  const noOutputs=s=>DELAYS.every(d=>['probes','halfProbes'].every(k=>s.observed[k][d].every(r=>!r.outputs.A.fired&&!r.outputs.B.fired)));
  const discrimination={readoutHebbianOff:!controls['readout-hebbian-off'].gates.R1&&noOutputs(controls['readout-hebbian-off']),
    pruneReadout:!controls['prune-readout'].gates.R1&&controls['prune-readout'].ablation.poolResponsesUnchanged,
    swappedTeacher:DELAYS.every(d=>['A','B'].every(c=>{const r=controls['swapped-teacher'].observed.probes[d].find(r=>r.cue===c),other=c==='A'?'B':'A';return r.outputs[other].fired&&!r.outputs[c].fired;})),
    pruneFormed:!controls['prune-formed'].gates.R2&&controls['prune-formed'].gates.R1,untrainedReadout:noOutputs(controls['untrained-readout'])};
  const failures=Object.entries(primary.gates).filter(([,v])=>!v).map(([k])=>k);if(!primary.stopping.reached)failures.push('Stopping criterion not reached by80.');
  for(const [k,v] of Object.entries(discrimination))if(!v)failures.push(k+' discrimination');return {discrimination,failedCriteria:failures,pass:failures.length===0};
}
function decoded(memory,word,seconds=0){const vocabulary=loadVocabulary(),observed=probe(memory,'input',seconds,null,{bits:encodeWord(word)}),fired=['A','B'].filter(c=>observed.outputs[c].fired);
  return {input:word,interpretation:memory.codebook,status:fired.length===1?'decoded':fired.length?'ambiguous':'silent',
    outputs:fired.map(c=>({conceptId:memory.outputs[c].conceptId,word:vocabulary.get(memory.outputs[c].conceptId).word,outputCell:memory.outputs[c].name,
      spikeTime:observed.outputs[c].spikeTimes[0],latencyTicks:observed.outputs[c].latencyTicks[0],margin:observed.outputs[c].inputMargin,peakMembraneMargin:observed.outputs[c].peakMargin,coreCellsFired:observed.coreCellsFired[c]})),
    coreCellsFired:observed.coreCellsFired,outputMeasurements:observed.outputs};}
module.exports={DELAYS,CONTROLS,options,weights,scope,setup,assertPreserved,memoryOf,attachTraining,probe,battery,readoutGates,stoppingCriterion,weightReport,initialFormation,assess,teacherReport,save,runCondition,restoreStopped,pruneCondition,decide,decoded};
if(require.main===module)require('./readout-study.cjs').main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=2;});
