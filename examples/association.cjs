'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const f=require('./formation.cjs'),auditTools=require('./association-audit.cjs');
const {SpikingField,DevelopmentSession}=require('../src/index.cjs');
const {jaccard}=require('../src/neuron/assembly-task.js');
const ROOT=path.resolve(__dirname,'..'),EVIDENCE='outputs/formation/2026-10-31T23-05-24-523Z-stage1g';
const STOP=Object.freeze({1:70,2:60,3:70}),DELAYS=Object.freeze([0,60]);
const copy=x=>structuredClone(x),sorted=x=>[...new Set(x)].sort((a,b)=>a-b),hash=x=>createHash('sha256').update(f.json(x)).digest('hex');
function classify(edges,refs){
  const a=new Set(refs.A),b=new Set(refs.B);
  const forward=edges.filter(e=>a.has(e.sourceId)&&b.has(e.targetId)),reverse=edges.filter(e=>b.has(e.sourceId)&&a.has(e.targetId));
  const ids=new Set([...forward,...reverse].map(e=>e.id));
  return {forward,reverse,union:edges.filter(e=>ids.has(e.id)),bothDirections:forward.filter(e=>reverse.some(r=>r.id===e.id)).length};
}
function liveEdges(run){return run.field.links.filter(e=>e.active&&e.target.alive&&run.pool.includes(e.sourceId)&&run.pool.includes(e.targetId)).map(({id,sourceId,targetId,weight,delay})=>({id,sourceId,targetId,weight,delay}));}
function freezeRefs(refs){return Object.freeze({A:Object.freeze([...refs.A]),B:Object.freeze([...refs.B])});}
function assertStartingState(run,trials,expected){
  const refs={A:f.extractCore(trials.A),B:f.extractCore(trials.B)},memory=f.exportMemory(run,refs);
  assert.equal(Boolean(run.field.circuitLock),false,'Formation must remain unlocked.');
  assert.equal(f.json(refs),f.json(expected.memory.cores),'Stage 1 reference cores differ.');
  assert.equal(f.json(memory),f.json(expected.memory),'Stage 1 locked native export is not byte-identical.');
  const edges=liveEdges(run).map(({delay,...edge})=>edge);
  assert.equal(f.json(edges),f.json(expected.trials.growthEdges),'Stage 1 formed edges/weights differ.');
  for(const key of ['A','B'])assert.equal(f.json(trials[key]),f.json(expected.trials[key]),'Stage 1 trial responses differ.');
  assert.equal(f.json(run.stimulusSchedule),f.json(expected.trials.stimulusSchedule),'Stage 1 jitter draws differ.');
  return {refs:freezeRefs(refs),identity:{byteIdentical:true,coresSHA256:hash(refs),formedEdgesSHA256:hash(edges),memorySHA256:hash(memory),
    scope:'Exact UTF-8 serialization of cores, ordered formed edges and weights, full locked native export, A/B responses and jitter schedule; training field remains unlocked.'},memory};
}
function reproduce(seed,{root=ROOT,values={},epochs=STOP[seed],expected=null}={}){
  if(!Number.isSafeInteger(epochs)||epochs<1)throw new Error('Invalid formation stopping epoch.');
  if(!expected){const dir=path.join(root,EVIDENCE,'cases','baseline-'+seed);
    const summary=JSON.parse(fs.readFileSync(path.join(dir,'summary.json')));
    assert.equal(summary.stopping.epoch,epochs);assert.equal(summary.pass,true);
    expected={memory:JSON.parse(fs.readFileSync(path.join(dir,'memory.json'))),trials:JSON.parse(fs.readFileSync(path.join(dir,'trials.json'))).primary};
  }
  const run=f.setup({...values,seed}),trials={A:[],B:[]};
  for(let epoch=1;epoch<=epochs;epoch++){for(const cue of ['A','B'])trials[cue].push(run.trial(cue));run.weightAudit.endEpoch(epoch);}
  const verified=assertStartingState(run,trials,expected);
  const origin={schema:'neurosphere-association-origin/v1',seed,epoch:epochs,refs:verified.refs,identity:verified.identity,memory:verified.memory,
    checkpoint:run.session.checkpoint(),audit:run.weightAudit.finish(),time:run.field.time,tick:run.field.tick,
    opts:run.opts,cues:run.cues,cueSelection:run.cueSelection,features:run.features,pool:run.pool,seedEdges:run.seedEdges,directSets:run.directSets,
    formationTrials:trials,formationSchedule:run.stimulusSchedule,streams:run.streams};
  return {origin,run};
}
function registerInputs(field,ids){const set=new Set(ids);Object.defineProperty(field,'endpointIds',{get:()=>[...ids]});field.isInputCell=id=>set.has(id);}
function restore(origin){
  const session=DevelopmentSession.restore(origin.checkpoint,SpikingField),field=session.field;
  registerInputs(field,origin.features);
  const run={field,session,opts:copy(origin.opts),cues:copy(origin.cues),cueSelection:copy(origin.cueSelection),pool:[...origin.pool],features:[...origin.features],
    seedEdges:copy(origin.seedEdges),directSets:copy(origin.directSets),refs:freezeRefs(origin.refs),positions:new Map(field.neurons.filter(n=>origin.pool.includes(n.id)).map(n=>[n.id,{x:n.x,y:n.y,z:n.z}]))};
  assert.equal(f.json(f.exportMemory(run,run.refs)),f.json(origin.memory),'Native restored starting circuit differs.');
  assert.equal(Boolean(field.circuitLock),false);
  return run;
}
function schedulePair(run,epoch,delta,jitter,rng,reverse=false){
  const t0=run.field.tick+1,leading=reverse?'B':'A',following=reverse?'A':'B';
  const onsets=[leading,following].flatMap((cue,i)=>f.cueBits(cue,null,run.cues).map(bit=>{
    const draw=rng(),offset=i*delta+Math.floor(draw*(jitter+1));
    return {cue,bit,cellId:run.features[bit],draw,offset,tick:t0+offset};
  }));
  return {epoch,cue:reverse?'B→A':'A→B',t0,captureTicks:50+delta+jitter,onsets};
}
function stoppingCriterion(epoch,forward){return Number.isSafeInteger(epoch)&&epoch>=5&&epoch<=40&&epoch%5===0&&
  DELAYS.every(s=>Number.isFinite(forward?.[s])&&forward[s]>=.5&&forward[s]<=1);}
function memoryOf(run,origin,epoch){
  const native=f.exportMemory(run,origin.refs),edges=liveEdges(run),cross=classify(edges,origin.refs);
  return {schema:'neurosphere-association/v1',seed:origin.seed,formationEpoch:origin.epoch,associationEpoch:epoch,refs:copy(origin.refs),
    cues:copy(run.cues),cueSelection:copy(run.cueSelection),pool:[...run.pool],features:[...run.features],volume:native.volume,
    crossCoreEdges:{forward:cross.forward,reverse:cross.reverse,union:cross.union,bothDirections:cross.bothDirections},artifact:native.artifact};
}
function formationView(memory){return {schema:'neurosphere-formation/v2',cues:memory.cues,cores:memory.refs,pool:memory.pool,artifact:memory.artifact};}
function measure(memory,directSets){
  const {probes,halfProbes}=f.probeBattery(formationView(memory)),refs=memory.refs,smaller=Math.min(refs.A.length,refs.B.length);
  if(!smaller)throw new Error('Reference cores must be nonempty.');
  const delays=Object.fromEntries(DELAYS.map(s=>{
    const p=Object.fromEntries(probes[s].map(row=>[row.cue,row])),halves=halfProbes[s].filter(r=>r.cue!=='C').map(row=>({...row,completion:f.completion(row.active,refs[row.cue])}));
    const spillover=p.C.active.filter(id=>!directSets.C.includes(id));
    const neutral=Object.fromEntries(['A','B'].map(cue=>[cue,p[cue].active.filter(id=>!directSets.A.includes(id)&&!directSets.B.includes(id))]));
    return [s,{forward:f.completion(p.A.active,refs.B),reverse:f.completion(p.B.active,refs.A),
      selfFull:{A:f.completion(p.A.active,refs.A),B:f.completion(p.B.active,refs.B)},halves,
      minHalf:Math.min(...halves.map(h=>h.completion)),c:{spillover,count:spillover.length,fraction:spillover.length/smaller,
        jaccards:p.C.scores,readback:p.C.label,absoluteCapPass:spillover.length/smaller<=.25},
      readback:Object.fromEntries(['A','B','C'].map(cue=>[cue,{label:p[cue].label,topTwo:Object.entries(p[cue].scores).map(([label,jaccard])=>({label,jaccard})).sort((a,b)=>b.jaccard-a.jaccard)}])),neutral,probes:p}];
  }));
  return {delays,forward:Object.fromEntries(DELAYS.map(s=>[s,delays[s].forward]))};
}
function pruneCross(run,refs){
  const before=liveEdges(run),ids=new Set(classify(before,refs).union.map(e=>e.id)),removed=[];
  for(const edge of run.field.links.filter(e=>e.active&&ids.has(e.id))){removed.push(edge.id);edge.prune();const source=run.field.getNeuron(edge.sourceId);source.synapses=source.synapses.filter(e=>e!==edge);}
  assert.equal(f.json(liveEdges(run)),f.json(before.filter(e=>!ids.has(e.id))),'Pruning changed unrelated pool edges.');
  return removed;
}
function describeCross(memory){return Object.fromEntries(['forward','reverse'].map(key=>[key,{...f.weightDistribution(memory.crossCoreEdges[key]),ids:memory.crossCoreEdges[key].map(e=>e.id)}]));}
function observations(run,origin,trials,memory){
  const cores=trials.length?{A:f.extractCore(trials.filter(t=>t.cue!=='B').map(t=>t.active)),B:f.extractCore(trials.filter(t=>t.cue!=='A').map(t=>t.active))}:copy(origin.refs);
  const union=sorted([...cores.A,...cores.B]),edges=liveEdges(run);
  return {contemporaneousCores:cores,contemporaneousJaccard:jaccard(cores.A,cores.B),
    coreDefinition:'Last ten responses with >=80% presence. Paired whole-trial responses are attributed to both co-presented cues; these observations never define a reference or a gate.',
    unionCompactness:f.compactness(union,run.pool,run.positions,(origin.seed^0x6a09e667)>>>0),
    within:Object.fromEntries(['A','B'].map(cue=>[cue,f.weightDistribution(edges.filter(e=>origin.refs[cue].includes(e.sourceId)&&origin.refs[cue].includes(e.targetId)))])),cross:describeCross(memory)};
}
function runCondition(origin,{condition='primary',delta=12,jitter=5,matchedEpoch=null,maximum=40,checkpointEvery=5}={}){
  if(!['primary','unpaired-continuation','hebbian-off-association','reverse-order','growth-off-association','untrained'].includes(condition))throw new Error('Unknown association condition.');
  if(![6,12,24].includes(delta)||![5,15].includes(jitter))throw new Error('Undeclared diagnostic setting.');
  if(!Number.isSafeInteger(maximum)||maximum<5||maximum>40||maximum%5||checkpointEvery!==5)throw new Error('Invalid association ceiling.');
  if(condition!=='primary'&&condition!=='untrained'&&(!Number.isSafeInteger(matchedEpoch)||matchedEpoch<5||matchedEpoch>maximum||matchedEpoch%5))throw new Error('Control requires matched primary exposure.');
  const run=restore(origin),{field,session}=run,pool=new Set(run.pool),audit=auditTools.createAudit(field,pool,origin),trials=[],checkpoints=[];
  const configBefore=f.json(field.config),featureEvents=[];
  if(condition==='hebbian-off-association'){field.setFeatures({hebbian:false});featureEvents.push(copy(field.featureHistory.at(-1)));}
  if(condition==='growth-off-association')for(const id of run.pool)field.getNeuron(id).nextGrowthAt=1e12;
  const phaseSeed=(origin.seed^0xd1b54a35)>>>0,rng=f.random(phaseSeed),unpairedRng=f.random(origin.streams.jitter);
  for(let n=0;n<origin.epoch*16;n++)unpairedRng();
  let active=null,spikes=null;const prior=field.onEvent;
  field.onEvent=event=>{prior(event);audit.observe(event);if(active&&event.type==='spike'&&pool.has(event.spike.neuronId)){active.add(event.spike.neuronId);spikes.push(copy(event.spike));}};
  function executeTrial(schedule){
    active=new Set();spikes=[];for(const onset of schedule.onsets)session.io.pulse('f'+onset.bit,onset.tick);
    for(let n=0;n<schedule.captureTicks;n++)session.step();
    const row={...schedule,active:sorted(active),spikes};active=null;spikes=null;
    for(let n=0;n<Math.round(run.opts.gap/field.config.dt);n++)session.step();
    trials.push(row);
  }
  function assess(epoch){
    assert.equal(f.json(field.config),configBefore,'Configuration was mutated.');
    const memory=memoryOf(run,origin,epoch),metrics=measure(memory,origin.directSets);
    const observation=observations(run,origin,trials,memory);
    return {epoch,memory,metrics,observations:observation};
  }
  function save(checkpoint,stopping){
    const weightAudit=audit.finish(),structuralAudit=auditTools.summarize(weightAudit,origin,trials,field.config,classify);
    return {summary:{schema:'neurosphere-association-report/v1',condition,seed:origin.seed,delta,jitter,epoch:checkpoint.epoch,
      referenceIdentity:origin.identity,refs:copy(origin.refs),formationEpoch:origin.epoch,stopping,metrics:checkpoint.metrics,observations:checkpoint.observations,
      structuralAudit:{...structuralAudit,edges:undefined},effective:{config:copy(field.config),features:copy(field.features),featureEvents,phaseSeed,
        unpairedJitter:15,unpairedRngDrawsSkipped:origin.epoch*16,configUnchanged:true},crossBefore:describeCross(memoryOf(restore(origin),origin,0))},
      memory:checkpoint.memory,trials:{rows:copy(trials),weightAudit:structuralAudit,refs:copy(origin.refs),directSets:copy(origin.directSets),seedEdges:copy(origin.seedEdges)},
      unlockedCheckpoint:session.checkpoint()};
  }
  const baseline=assess(0);checkpoints.push(baseline);
  if(condition==='untrained')return {...save(baseline,null),checkpoints};
  let stopped=null;
  const total=condition==='primary'||condition==='unpaired-continuation'?maximum:matchedEpoch;
  for(let epoch=1;epoch<=total;epoch++){
    audit.setEpoch(epoch);
    if(condition==='unpaired-continuation')for(const cue of ['A','B']){
      const t0=field.tick+1,onsets=f.cueBits(cue,null,run.cues).map(bit=>{const draw=unpairedRng(),offset=Math.floor(draw*16);return {cue,bit,cellId:run.features[bit],draw,offset,tick:t0+offset};});
      executeTrial({epoch,cue,t0,captureTicks:65,onsets});
    }else executeTrial(schedulePair(run,epoch,delta,jitter,rng,condition==='reverse-order'));
    audit.endEpoch();
    if(epoch%checkpointEvery===0){
      const cp=assess(epoch);checkpoints.push(cp);
      const reached=condition==='primary'&&stoppingCriterion(epoch,cp.metrics.forward);
      if(!stopped&&(condition==='primary'?(reached||epoch===maximum):epoch===matchedEpoch)){
        const stop=condition==='primary'?{epoch,reached,minimum:5,maximum,checkpointEvery,threshold:.5,consulted:'A-alone recruitment of refB at 0 and 60 seconds only',cConsulted:false,otherGatesConsulted:false}:null;
        stopped=save(cp,stop);
      }
    }
  }
  assert.ok(stopped,'No stopping snapshot.');
  stopped.checkpoints=checkpoints;stopped.continuation={epoch:total,memory:checkpoints.at(-1).memory,rows:copy(trials),weightAudit:auditTools.summarize(audit.finish(),origin,trials,field.config,classify)};
  return stopped;
}
function pruneCondition(origin,primary){
  const session=DevelopmentSession.restore(primary.unlockedCheckpoint,SpikingField),field=session.field;registerInputs(field,origin.features);
  const run={field,session,pool:origin.pool,features:origin.features,opts:origin.opts,cues:origin.cues,cueSelection:origin.cueSelection};
  assert.equal(f.json(memoryOf(run,origin,primary.summary.epoch)),f.json(primary.memory));
  const beforeEdges=field.links.filter(e=>e.active).map(e=>e.toJSON?e.toJSON():{id:e.id,sourceId:e.sourceId,targetId:e.targetId,weight:e.weight,delay:e.delay});
  const removed=pruneCross(run,origin.refs),memory=memoryOf(run,origin,primary.summary.epoch),metrics=measure(memory,origin.directSets);
  const remaining=field.links.filter(e=>e.active).map(e=>e.toJSON?e.toJSON():{id:e.id,sourceId:e.sourceId,targetId:e.targetId,weight:e.weight,delay:e.delay});
  assert.equal(f.json(remaining),f.json(beforeEdges.filter(e=>!removed.includes(e.id))),'Pruning altered an unrelated edge or afferent.');
  return {summary:{condition:'prune-cross',seed:origin.seed,epoch:primary.summary.epoch,metrics,removedEdges:removed,crossBefore:describeCross(primary.memory),crossAfter:describeCross(memory),unchangedOtherEdges:true},memory};
}
function evaluate(primary,controls){
  const p=primary.summary,baseline=controls.untrained.summary.metrics,unpaired=controls['unpaired-continuation'].summary.metrics,
    hebbian=controls['hebbian-off-association'].summary.metrics,pruned=controls['prune-cross'].summary.metrics;
  for(const name of ['unpaired-continuation','hebbian-off-association','prune-cross'])assert.equal(controls[name].summary.epoch,p.epoch,'Unmatched control.');
  const criteria={stopping:p.stopping?.reached===true,forward:true,reverse:true,selfIntegrity:true,cReadback:true,cJaccard:true,relativeContainment:true,
    unpairedControl:true,hebbianControl:true,pruneRecruitment:true,pruneIntegrity:true};
  const perDelay={};
  for(const s of DELAYS){
    const row=p.metrics.delays[s],base=baseline.delays[s],u=unpaired.delays[s],h=hebbian.delays[s],q=pruned.delays[s];
    criteria.forward&&=row.forward>=.5;criteria.reverse&&=row.reverse<=base.reverse+.15;
    criteria.selfIntegrity&&=row.halves.every(r=>r.completion>=.8)&&row.selfFull.A>=.9&&row.selfFull.B>=.9;
    criteria.cReadback&&=row.c.readback==='reject';criteria.cJaccard&&=row.c.jaccards.A<=.25&&row.c.jaccards.B<=.25;
    criteria.relativeContainment&&=row.c.fraction<=u.c.fraction+.1;
    criteria.unpairedControl&&=u.forward<=base.forward+.15;criteria.hebbianControl&&=h.forward<=base.forward+.15;
    criteria.pruneRecruitment&&=q.forward<.3&&q.forward<row.forward;
    criteria.pruneIntegrity&&=q.halves.every(r=>Math.abs(r.completion-row.halves.find(v=>v.cue===r.cue&&v.half===r.half).completion)<=.05);
    perDelay[s]={cSpilloverDifference:row.c.fraction-u.c.fraction,reverseMaximum:base.reverse+.15,controlForwardMaximum:base.forward+.15,
      prunedForward:q.forward,halfCompletionChanges:q.halves.map(r=>({cue:r.cue,half:r.half,change:r.completion-row.halves.find(v=>v.cue===r.cue&&v.half===r.half).completion}))};
  }
  return {criteria,perDelay,pass:Object.values(criteria).every(Boolean),failedCriteria:Object.keys(criteria).filter(k=>!criteria[k])};
}
function assemble(origin,primary,controls){
  const first=primary.checkpoints.find(cp=>stoppingCriterion(cp.epoch,cp.metrics.forward)),expected=first?.epoch??40;
  assert.equal(primary.summary.epoch,expected);assert.equal(primary.summary.stopping.reached,!!first);
  assert.equal(f.json(primary.memory),f.json(primary.checkpoints.find(cp=>cp.epoch===expected).memory));
  const decision=evaluate(primary,controls);
  const reported={};if(controls['reverse-order'])reported.reverseOrder=DELAYS.every(s=>{const m=controls['reverse-order'].summary.metrics.delays[s];return m.reverse>=.5&&m.forward<=controls.untrained.summary.metrics.delays[s].forward+.15;});
  return {summary:{schema:'neurosphere-association-suite/v1',stage:'2',seed:origin.seed,delta:primary.summary.delta,jitter:primary.summary.jitter,
    refs:copy(origin.refs),referenceIdentity:origin.identity,cues:origin.cues,cueSelection:origin.cueSelection,stopping:primary.summary.stopping,
    primary:primary.summary,controls:Object.fromEntries(Object.entries(controls).map(([key,v])=>[key,v.summary])),reported,...decision},
    memory:primary.memory,trials:{primary:primary.trials,...Object.fromEntries(Object.entries(controls).filter(([,v])=>v.trials).map(([k,v])=>[k,v.trials]))},
    controls:Object.fromEntries(Object.entries(controls).map(([key,v])=>[key,v.memory])),
    checkpoints:{primary:primary.checkpoints,unpaired:controls['unpaired-continuation'].checkpoints,
      ...Object.fromEntries(Object.entries(controls).filter(([k,v])=>k!=='unpaired-continuation'&&v.checkpoints).map(([k,v])=>[k,v.checkpoints]))},
    continuation:{primary:primary.continuation,unpaired:controls['unpaired-continuation'].continuation}};
}
function runSuite(origin,spec,progress=()=>{}){
  const controls={};progress('primary');const primary=runCondition(origin,spec);
  for(const condition of ['untrained','unpaired-continuation','hebbian-off-association',...(origin.seed===1?['reverse-order','growth-off-association']:[])]){
    progress(condition);controls[condition]=runCondition(origin,{...spec,condition,matchedEpoch:primary.summary.epoch});
  }
  controls['prune-cross']=pruneCondition(origin,primary);return assemble(origin,primary,controls);
}
module.exports={ROOT,EVIDENCE,STOP,DELAYS,hash,classify,liveEdges,assertStartingState,reproduce,restore,schedulePair,stoppingCriterion,memoryOf,formationView,measure,pruneCross,describeCross,runCondition,pruneCondition,evaluate,assemble,runSuite};
if(require.main===module)require('./association-study.cjs').main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=2;});
