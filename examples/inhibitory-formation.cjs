'use strict';
const assert=require('node:assert/strict');
const inhibitionAudit=require('./inhibitory-audit.cjs');
const f=require('./formation.cjs'),auditTools=require('./formation-v2-audit.cjs'),baseAudit=require('./formation-audit.cjs');
const {SpikingField,DevelopmentSession,LockedController,encodeWord}=require('../src/index.cjs');
const {jaccard}=require('../src/neuron/assembly-task.js');
const BITS=192,DELAYS=[0,60],COUNTS=[2,3,4,5,6,8],CONTROLS=['growth-off','hebbian-off','inhibition-off','shuffled','untrained','prune-formed'];
const DEFAULTS=Object.freeze({seed:1,fraction:.2,scaffold:'v2',epochs:120});
const copy=x=>structuredClone(x),sorted=x=>[...new Set(x)].sort((a,b)=>a-b);
// Share only native pre-stimulus silence; every actual cue still restores its own controller.
const probeCache=new WeakMap();
function probeStates(memory){
  if(!probeCache.has(memory)){
    const states=Object.fromEntries(DELAYS.map(seconds=>{const idle=new LockedController(memory.artifact);idle.advance(seconds);return [seconds,idle.checkpoint()];}));
    probeCache.set(memory,{states});
  }return probeCache.get(memory);
}
function probeBattery(memory){
  const cached=probeStates(memory);if(!cached.battery)cached.battery={
    probes:Object.fromEntries(DELAYS.map(s=>[s,['A','B','C'].map(cue=>f.probeMemory(memory,cue,s,null,cached.states[s]))])),
    halfProbes:Object.fromEntries(DELAYS.map(s=>[s,['A','B','C'].flatMap(cue=>[0,1].map(half=>f.probeMemory(memory,cue,s,half,cached.states[s])))]))};
  return cached.battery;
}
function options(values={}){
  const raw={...DEFAULTS,...values},v1=raw.scaffold==='v1';
  for(const key of Object.keys(raw))if(!['seed','fraction','scaffold','epochs','pool','g','w0','maxWeight','maxSynapses','k','jitter','gap','auditEnabled'].includes(key))throw new Error('Unknown inhibitory setting: '+key);
  if(!Number.isSafeInteger(raw.seed)||raw.seed<0||raw.seed>0xffffffff||![.2,.3].includes(raw.fraction)||!['v1','v2'].includes(raw.scaffold)||!Number.isInteger(raw.epochs)||raw.epochs<1||raw.epochs>120)throw new Error('Undeclared inhibitory setting.');
  const fixed={g:v1?1:4,w0:v1?1.1:.7,maxWeight:v1?1.65:.7,maxSynapses:v1?8:10,k:8,jitter:v1?15:8,gap:10};
  for(const [key,value] of Object.entries(fixed))if(raw[key]!==undefined&&raw[key]!==value)throw new Error('Undeclared scaffold override: '+key);
  const result={...raw,...fixed,pool:raw.pool??Math.round(500/(1-raw.fraction))};
  if(!Number.isInteger(result.pool)||result.pool<50||result.pool+BITS*result.g>2000)throw new Error('Invalid fixture pool.');
  return result;
}
function registerInputs(field,ids){const set=new Set(ids);Object.defineProperty(field,'endpointIds',{get:()=>[...ids]});field.isInputCell=id=>set.has(id);}
function radicalInverse(index,base){let value=0,place=1/base;while(index){value+=(index%base)*place;index=Math.floor(index/base);place/=base;}return value;}
function ballPoint(u,v,w,radius){const z=2*v-1,ring=Math.sqrt(1-z*z),angle=2*Math.PI*w,r=radius*Math.cbrt(u);return {x:400+r*ring*Math.cos(angle),y:400+r*ring*Math.sin(angle),z:400+r*z};}
function topology(groups,seedEdges,cues,threshold,w0){
  const hitThreshold=Math.ceil(threshold/w0),directSets={},primedSets={},directHits={};
  for(const cue of ['A','B','C']){
    const sources=new Set(encodeWord(cues[cue]).flatMap(bit=>groups[bit])),hits=new Map();
    for(const e of seedEdges)if(sources.has(e.sourceId))hits.set(e.targetId,(hits.get(e.targetId)||0)+1);
    directHits[cue]=[...hits].sort((a,b)=>a[0]-b[0]).map(([id,count])=>({id,hits:count}));
    directSets[cue]=directHits[cue].filter(e=>e.hits>=hitThreshold).map(e=>e.id);
    primedSets[cue]=directHits[cue].filter(e=>e.hits===1).map(e=>e.id);
  }
  return {hitThreshold,directSets,primedSets,directHits};
}
function attachRun(run,{prior=null}={}){
  const {field,session,pool,opts}=run,poolSet=new Set(pool),featureSet=new Set(run.features);
  const audit=prior?auditTools.resumeAudit(field,new Set(run.physicalPool),prior.audit,prior.epoch):baseAudit.createWeightAudit(field,new Set(run.physicalPool));
  if(!prior)for(const id of run.physicalPool)audit.attach(field.getNeuron(id));
  run.inhibition=inhibitionAudit.createObserver(run,{enabled:opts.auditEnabled!==false});
  const rng=f.random(run.streams.jitter);for(let n=0;n<(prior?.rows.length||0)*8;n++)rng();
  run.rows=copy(prior?.rows||[]);run.trials=copy(prior?.trials||{A:[],B:[]});run.weightAudit=audit;
  const previous=field.onEvent;let capture=null;
  field.onEvent=event=>{
    previous(event);audit.observe(event);run.inhibition.observe(event);
    if(capture&&event.type==='spike'){
      const spike={neuronId:event.spike.neuronId,time:event.spike.time};
      if(poolSet.has(spike.neuronId))capture.spikes.push(spike);
      else if(featureSet.has(spike.neuronId))capture.featureSpikes.push(spike);
    }
  };
  const configBytes=f.json(field.config);
  run.trial=(cue,epoch)=>{
    assert.ok(cue==='A'||cue==='B');audit.setEpoch(epoch);
    const t0=field.tick+1,captureTicks=50+opts.jitter;
    const onsets=f.cueBits(cue,null,run.cues).map(bit=>{
      const draw=rng(),offset=Math.floor(draw*(opts.jitter+1)),tick=t0+offset;
      session.io.pulse('f'+bit,tick);return {bit,cellIds:[...run.groups[bit]],draw,offset,tick};
    });
    capture={spikes:[],featureSpikes:[]};run.inhibition.begin(cue);for(let n=0;n<captureTicks;n++)session.step();
    const row={epoch,cue,t0,captureTicks,onsets,active:sorted(capture.spikes.map(s=>s.neuronId)),...capture,inhibition:run.inhibition.end()};capture=null;
    const expected=onsets.flatMap(o=>o.cellIds).sort((a,b)=>a-b),actual=row.featureSpikes.map(s=>s.neuronId).sort((a,b)=>a-b);
    assert.deepEqual(actual,expected,'Each bit port must pulse every feature cell exactly once.');
    for(const onset of onsets)for(const id of onset.cellIds)assert.ok(Math.abs(row.featureSpikes.find(s=>s.neuronId===id).time-onset.tick*field.config.dt)<1e-8);
    for(let n=0;n<Math.round(opts.gap/field.config.dt);n++)session.step();
    run.rows.push(row);run.trials[cue].push(row.active);assert.equal(f.json(field.config),configBytes,'Temporary config mutation is forbidden.');return row;
  };
  run.epoch=epoch=>{run.trial('A',epoch);run.trial('B',epoch);audit.endEpoch(epoch);};
  return run;
}
function setup(values={},condition='primary'){
  const opts=options(values);if(condition==='inhibition-off')throw new Error('Inhibition-off is the saved 500-E v2 primary reference, not a second inhibitory run.');
  if(condition!=='primary'&&!CONTROLS.includes(condition))throw new Error('Invalid inhibitory condition.');
  const config={dimensions:3,extent:{x:800,y:800,z:800},maxCells:2000,radius:60,maxSynapses:opts.maxSynapses,maxWeight:opts.maxWeight,initialWeight:.4,inhibitoryFraction:opts.fraction,
    pairingClock:'arrival',weightDecay:0,unusedDecay:0,healthLoss:0,growthPeriod:1.8,competitionMargin:1,exploration:.1,inhibitionStrength:.5,inhibitionRadiusFactor:.6};
  const features={inhibitoryPopulation:true,hebbian:condition!=='hebbian-off',lateralInhibition:false,activityScaledInhibition:false,gradient:false,reward:false,consolidation:false,homeostasis:false};
  const field=new SpikingField({empty:true,seed:opts.seed,config,features});
  const streams={placement:(opts.seed^0x41c64e6d)>>>0,projection:(opts.seed^0x9e3779b9)>>>0,shuffle:(opts.seed^0x85ebca6b)>>>0,jitter:(opts.seed^0x27d4eb2f)>>>0};
  registerInputs(field,Array.from({length:BITS*opts.g},(_,i)=>i+1));
  const placement=f.random(streams.placement),rotation=placement(),shifts=[placement(),placement(),placement()];
  const featureCells=Array.from({length:BITS*opts.g},(_,i)=>{
    const cell=field.addNeuron(ballPoint(1,(i+.5)/(BITS*opts.g),(i/((1+Math.sqrt(5))/2)+rotation)%1,300));cell.radius=600;cell.nextGrowthAt=1e12;return cell;
  });
  const groups=Array.from({length:BITS},(_,bit)=>featureCells.slice(bit*opts.g,(bit+1)*opts.g).map(c=>c.id));
  const poolCells=Array.from({length:opts.pool},(_,i)=>{
    const point=[2,3,5].map((base,axis)=>(radicalInverse(i+1,base)+shifts[axis])%1);
    const cell=field.addNeuron({...ballPoint(...point,120),recordOutput:false,secretionRate:0});if(condition==='growth-off')cell.nextGrowthAt=1e12;return cell;
  });
  const projection=f.random(streams.projection),seedEdges=[];
  for(const source of featureCells)for(const target of f.sample(poolCells,opts.k,projection)){
    const edge=source.connect(target,field.time,opts.w0);assert.ok(edge,'Native seed connection refused.');
    seedEdges.push({id:edge.id,sourceId:source.id,targetId:target.id,weight:edge.weight,delay:edge.delay});
  }
  if(condition==='shuffled'){
    const points=f.sample(poolCells.map(({x,y,z})=>({x,y,z})),poolCells.length,f.random(streams.shuffle));poolCells.forEach((c,i)=>Object.assign(c,points[i]));
  }
  const inputIds=featureCells.map(c=>c.id);
  const session=new DevelopmentSession(field,{}, {inputs:groups.map((cells,bit)=>({name:'f'+bit,cells})),outputs:[]});
  const cueSelection=f.selectCues(),cues=cueSelection.words;
  const excitatory=poolCells.filter(c=>!c.inhibitory),inhibitory=poolCells.filter(c=>c.inhibitory),top=topology(groups,seedEdges.filter(e=>excitatory.some(c=>c.id===e.targetId)),cues,field.config.threshold,opts.w0);
  assert.ok(featureCells.every(c=>!c.inhibitory),'Feature endpoints must stay excitatory.');
  return attachRun({opts,condition,field,session,features:inputIds,groups,pool:excitatory.map(c=>c.id),physicalPool:poolCells.map(c=>c.id),inhibitoryPool:inhibitory.map(c=>c.id),positions:new Map(poolCells.map(({id,x,y,z})=>[id,{x,y,z}])),
    cueSelection,cues,streams,seedEdges,...top});
}
function exportMemory(run,cores){return {...f.exportMemory(run,cores),population:{excitatory:[...run.pool],inhibitory:[...run.inhibitoryPool],physical:[...run.physicalPool]},scaffold:{stage:'inhibitory-diagnostic',g:run.opts.g,groups:copy(run.groups),w0:run.opts.w0,hitThreshold:run.hitThreshold}};}
function liveEdges(run){const pool=new Set(run.pool);return run.field.links.filter(e=>e.active&&e.target.alive&&pool.has(e.sourceId)&&pool.has(e.targetId)).map(({id,sourceId,targetId,weight,delay})=>({id,sourceId,targetId,weight,delay}));}
function restoreStop(primary){
  const saved=primary.development,session=DevelopmentSession.restore(saved.checkpoint,SpikingField),field=session.field;
  const run={...copy(saved.metadata),field,session,positions:new Map(saved.metadata.positions),condition:'continued-hebbian-off'};registerInputs(field,run.features);
  assert.equal(f.json(exportMemory(run,primary.memory.cores)),f.json(primary.memory),'Stopping checkpoint must restore byte-identically.');
  return attachRun(run,{prior:{audit:primary.trials.weightAudit,epoch:primary.summary.epoch,rows:primary.trials.rows,trials:primary.trials.responses}});
}
function subsetBits(cue,count,half,cues){
  if(!COUNTS.includes(count)||![0,1].includes(half))throw new Error('Undeclared basin probe.');
  const bits=f.cueBits(cue,null,cues),indices=half===0?[0,2,4,6,1,3,5,7]:[1,3,5,7,0,2,4,6];
  return indices.slice(0,count).map(i=>bits[i]);
}
function basinProbes(memory){
  const cached=probeStates(memory);if(cached.basin)return cached.basin;
  const result={};for(const seconds of DELAYS){
    const checkpoint=cached.states[seconds];
    result[seconds]=['A','B'].flatMap(cue=>COUNTS.flatMap(count=>[0,1].map(half=>{
      const bits=subsetBits(cue,count,half,memory.cues);
      if(cached.battery&&(count===4||count===8)){
        const prior=count===4?cached.battery.halfProbes[seconds].find(p=>p.cue===cue&&p.half===half):cached.battery.probes[seconds].find(p=>p.cue===cue);
        return {cue,count,half,bits,active:[...prior.active]};
      }
      const active=new Set(),pool=new Set(memory.pool),controller=LockedController.restore(checkpoint,s=>{if(pool.has(s.neuronId))active.add(s.neuronId);});
      for(const bit of bits)controller.io.pulse('f'+bit,controller.tick+1);controller.advance(1);
      return {cue,count,half,bits,active:sorted(active)};
    })));
  }cached.basin=result;return result;
}
function basinReport(trained,untrained,cores){return Object.fromEntries(DELAYS.map(seconds=>[seconds,trained[seconds].map(row=>{
  const baseline=untrained[seconds].find(r=>r.cue===row.cue&&r.count===row.count&&r.half===row.half),reference=cores[row.cue];
  return {...row,referenceSize:reference.length,trained:f.completion(row.active,reference),untrained:f.completion(baseline.active,reference),untrainedActive:baseline.active};
})]));}
function weightSummary(cores,edges){
  const initial=f.potentiation(cores,edges,.4);
  function bounded(distribution,selected){return {...distribution,capThreshold:.69,capCount:selected.filter(e=>e.weight>=.69).length,capFraction:selected.length?selected.filter(e=>e.weight>=.69).length/selected.length:0};}
  for(const cue of ['A','B']){
    const core=new Set(cores[cue]),selected=edges.filter(e=>core.has(e.sourceId)&&core.has(e.targetId));
    initial.cores[cue].within=bounded(initial.cores[cue].within,selected);
  }
  initial.poolWide=bounded(initial.poolWide,edges);initial.capFractionGated=false;return initial;
}
function metrics(run,memory,battery,baseline,{cores=memory.cores}={}){
  const probes=Object.fromEntries(DELAYS.map(s=>[s,battery.probes[s].map(p=>({...p,...f.decode(p.active,cores)}))]));
  const result=f.metrics({trials:run.trials,cores,pool:run.pool,positions:run.positions,growthEdges:liveEdges(run),stats:run.field.stats,
    probes,seed:run.opts.seed,directSets:run.directSets,halfProbes:battery.halfProbes,untrainedHalfProbes:baseline.halfProbes,initialWeight:.4});
  result.potentiation=weightSummary(cores,liveEdges(run));
  result.criteria['10-potentiation'].rule='Each core: median surviving within-core formed weight >= 0.6 (initialWeight + 0.2). Cap fraction >=0.69 is reported only.';
  for(const cue of ['A','B']){
    const r=result.recruitment[cue],other=cue==='A'?'B':'A';
    r.primedRecruits={cells:r.cells.filter(id=>run.primedSets[cue].includes(id))};r.primedRecruits.count=r.primedRecruits.cells.length;
    r.trulyNeutral={cells:r.cells.filter(id=>!run.directSets[other].includes(id)&&!run.primedSets.A.includes(id)&&!run.primedSets.B.includes(id))};r.trulyNeutral.count=r.trulyNeutral.cells.length;
    r.trulyNeutral.fraction=cores[cue].length?r.trulyNeutral.count/cores[cue].length:null;
    r.neutralSplit={ownCuePrimed:r.neutral.cells.filter(id=>run.primedSets[cue].includes(id)),
      otherCuePrimedOnly:r.neutral.cells.filter(id=>!run.primedSets[cue].includes(id)&&run.primedSets[other].includes(id)),trulyNeutral:r.trulyNeutral.cells};
  }
  result.criteria['6-recruitment']={gated:false,status:'REPORTED',pass:null,rule:'Report other-cue direct, own-cue primed recruits and cells outside both cues\' direct and primed sets; no recruitment gate.'};
  return result;
}
function stoppingCriterion(epoch,halves){return Number.isSafeInteger(epoch)&&epoch>=30&&epoch<=120&&epoch%10===0&&DELAYS.every(s=>{
  const rows=halves?.[s];return Array.isArray(rows)&&rows.length===4&&['A','B'].every(cue=>[0,1].every(half=>{const found=rows.filter(r=>r.cue===cue&&r.half===half);return found.length===1&&Number.isFinite(found[0].completion)&&found[0].completion>=.8&&found[0].completion<=1;}));
});}
function checkpoint(run,epoch){
  const cores={A:f.extractCore(run.trials.A),B:f.extractCore(run.trials.B)},memory=exportMemory(run,cores),battery=probeBattery(memory),edges=liveEdges(run);
  const smaller=Math.min(cores.A.length,cores.B.length),weights=weightSummary(cores,edges);
  const halfCompletions=Object.fromEntries(DELAYS.map(s=>[s,battery.halfProbes[s].filter(r=>r.cue!=='C').map(r=>({cue:r.cue,half:r.half,completion:f.completion(r.active,cores[r.cue])}))]));
  const negative=Object.fromEntries(DELAYS.map(s=>{const row=battery.probes[s].find(r=>r.cue==='C'),spill=row.active.filter(id=>!run.directSets.C.includes(id));
    return [s,{count:spill.length,fraction:smaller?spill.length/smaller:null,jaccards:row.scores,readback:row.label,active:row.active}];}));
  const row={epoch,edgesByType:inhibitionAudit.edgeReport(run,run.weightAudit.finish()),cores,coreSizes:{A:cores.A.length,B:cores.B.length},halfCompletions,negative,
    medianWeights:Object.fromEntries(['A','B'].map(cue=>[cue,weights.cores[cue].within.quantiles.median])),capFractions:Object.fromEntries(['A','B'].map(cue=>[cue,weights.cores[cue].within.capFraction])),
    reached:stoppingCriterion(epoch,halfCompletions),battery};
  return {row,memory};
}
function frozenCurve(row,memory,cores,directSets){
  const pool=new Set(memory.pool),edges=memory.artifact.edges.filter(e=>pool.has(e.sourceId)&&pool.has(e.targetId)),weights=weightSummary(cores,edges),smaller=Math.min(cores.A.length,cores.B.length);
  return {reference:'Frozen stopping cores; retrospective reporting, never consulted by the stopping rule.',
    halfCompletions:Object.fromEntries(DELAYS.map(s=>[s,row.battery.halfProbes[s].filter(r=>r.cue!=='C').map(r=>({cue:r.cue,half:r.half,completion:f.completion(r.active,cores[r.cue])}))])),
    negative:Object.fromEntries(DELAYS.map(s=>{const c=row.battery.probes[s].find(r=>r.cue==='C'),count=c.active.filter(id=>!directSets.C.includes(id)).length,d=f.decode(c.active,cores);
      return [s,{count,fraction:smaller?count/smaller:null,jaccards:d.scores,readback:d.label}];})),
    medianWeights:Object.fromEntries(['A','B'].map(cue=>[cue,weights.cores[cue].within.quantiles.median])),
    drift:Object.fromEntries(['A','B'].map(cue=>[cue,jaccard(cores[cue],row.cores[cue])]))};
}
function save(run,cp,baseline,untrainedMemory,{withDevelopment=false,untrainedBasin=null}={}){
  const cores=cp.memory.cores,rawAudit=run.weightAudit.finish(),audit=auditTools.summarize(rawAudit,{cores,pool:run.physicalPool,rows:run.rows,seedEdges:run.seedEdges,config:run.field.config,jitter:run.opts.jitter});
  const result=metrics(run,cp.memory,cp.row.battery,baseline),seedIds=new Set(run.seedEdges.map(e=>e.id));
  const afferents=run.field.links.filter(e=>e.active&&seedIds.has(e.id));assert.equal(afferents.length,run.seedEdges.length,'Afferents must survive with decay off and no feature growth.');
  if(run.opts.scaffold==='v2')assert.ok(afferents.every(e=>e.weight===run.opts.w0),'Capped afferents must keep w0.');
  assert.ok(run.field.links.filter(e=>e.active).every(e=>e.weight<=run.opts.maxWeight),'Native maxWeight exceeded.');
  const trainedBasin=basinProbes(cp.memory),baselineBasin=untrainedBasin||basinProbes(untrainedMemory);
  const summary={stage:'inhibitory-diagnostic',condition:run.condition,seed:run.opts.seed,options:copy(run.opts),epoch:cp.row.epoch,cores:copy(cores),
    directSets:copy(run.directSets),primedSets:copy(run.primedSets),directHits:copy(run.directHits),hitThreshold:run.hitThreshold,
    cueSelection:copy(run.cueSelection),firstTrial:Object.fromEntries(['A','B'].map(cue=>[cue,{active:run.trials[cue][0]?.length??null,fraction:run.trials[cue].length?run.trials[cue][0].length/run.pool.length:null}])),
    effective:{config:copy(run.field.config),features:copy(run.field.features),featureHistory:copy(run.field.featureHistory),featureCount:run.features.length,inputPorts:BITS,
      groupSize:run.opts.g,featureRadius:600,featureGrowth:false,poolGrowth:run.condition!=='growth-off',rngStreams:run.streams,seedEdgeCount:run.seedEdges.length,
      survivingAfferents:afferents.length,changedAfferents:afferents.filter(e=>e.weight!==run.opts.w0).length,captureTicks:50+run.opts.jitter,jitterPerBit:true,configUnchanged:true},
    population:{excitatory:[...run.pool],inhibitory:[...run.inhibitoryPool],physical:[...run.physicalPool]},edgesByType:cp.row.edgesByType,
    ...result,probes:cp.row.battery.probes,halfProbes:cp.row.battery.halfProbes,untrainedHalfProbes:baseline.halfProbes,
    structuralAudit:{...audit,edges:undefined},basin:basinReport(trainedBasin,baselineBasin,cores)};
  const saved={summary,memory:cp.memory,trials:{responses:copy(run.trials),rows:copy(run.rows),seedEdges:copy(run.seedEdges),growthEdges:liveEdges(run),weightAudit:rawAudit,pairingAudit:audit.edges},
    untrainedMemory,untrainedBasin:baselineBasin};
  if(withDevelopment){const {field,session,weightAudit,inhibition,trial,epoch,rows,trials,positions,...metadata}=run;
    saved.development={checkpoint:session.checkpoint(),metadata:{...copy(metadata),positions:[...positions]}};
  }return saved;
}
function continuedAssessment(run,cp,primary,baseline){
  const frozen=primary.memory.cores,measure=metrics(run,cp.memory,cp.row.battery,baseline,{cores:frozen});
  const drift=Object.fromEntries(['A','B'].map(cue=>[cue,jaccard(frozen[cue],cp.memory.cores[cue])]));
  const saturation=Object.fromEntries(['A','B'].map(cue=>[cue,measure.potentiation.cores[cue].within.quantiles.median]));
  const components=Object.fromEntries(['2-specificity','4-negative-cue','8-retention','9-pattern-completion'].map(key=>[key,measure.criteria[key].pass]));
  components.epoch120=cp.row.epoch===120;
  components.saturation=['A','B'].every(cue=>Number.isFinite(saturation[cue])&&saturation[cue]>=.65);components.drift=['A','B'].every(cue=>drift[cue]>=.8);
  return {reference:'Frozen stopping cores for every gate-11 metric; contemporaneous cores reported separately.',frozenCores:copy(frozen),contemporaneousCores:copy(cp.memory.cores),
    stopEpoch:primary.summary.epoch,epoch:cp.row.epoch,postStopEpochs:cp.row.epoch-primary.summary.epoch,drift,saturation,components,pass:Object.values(components).every(Boolean),frozenMetrics:measure};
}
function runCondition(values={},condition='primary',{matchedEpoch=null,primary=null,checkpoints=true,onCheckpoint=null}={}){
  const opts=options(values),continuing=condition==='continued-hebbian-off';
  const run=continuing?restoreStop(primary):setup(opts,condition),untrainedMemory=continuing?primary.untrainedMemory:exportMemory(run,{A:[],B:[]});
  const baseline=probeBattery(untrainedMemory),untrainedBasin=continuing?primary.untrainedBasin:basinProbes(untrainedMemory);
  if(continuing)run.field.setFeatures({hebbian:false});
  const curve=[],memories=[];let stopped=null,last=null;
  const start=continuing?primary.summary.epoch:0,total=condition==='untrained'?0:condition==='primary'||continuing?opts.epochs:matchedEpoch;
  if(!Number.isSafeInteger(total)||total<start||total>opts.epochs)throw new Error('Invalid matched control duration.');
  for(let epoch=start+1;epoch<=total;epoch++){
    run.epoch(epoch);
    if(epoch%10===0&&checkpoints&&(condition==='primary'||continuing)){
      const cp=checkpoint(run,epoch);curve.push(cp.row);memories.push({epoch,memory:cp.memory});last=cp;
      if(onCheckpoint)onCheckpoint(cp);
      if(condition==='primary'&&!stopped&&(cp.row.reached||epoch===total)){
        stopped=save(run,cp,baseline,untrainedMemory,{withDevelopment:true,untrainedBasin});
        stopped.summary.stopping={epoch,reached:cp.row.reached,minimum:30,maximum:120,checkpointEvery:10,threshold:.8,cConsulted:false,otherGatesConsulted:false};
      }
    }
  }
  const finalCp=last?.row.epoch===total?last:checkpoint(run,total);
  if(condition==='primary'){
    if(!stopped){stopped=save(run,finalCp,baseline,untrainedMemory,{withDevelopment:true,untrainedBasin});stopped.summary.stopping={epoch:total,reached:false,minimum:30,maximum:120,checkpointEvery:10,threshold:.8,cConsulted:false,otherGatesConsulted:false};}
    const continued=total===stopped.summary.epoch?copy({summary:stopped.summary,memory:stopped.memory,trials:stopped.trials}):save(run,finalCp,baseline,untrainedMemory,{untrainedBasin});continued.summary.condition='continued-plastic';
    continued.summary.gate11=continuedAssessment(run,finalCp,stopped,baseline);
    continued.summary.frozenBasin=basinReport(continued.summary.basin,untrainedBasin,stopped.memory.cores);
    stopped.summary.criteria['11-continued-stability']={gated:true,pass:continued.summary.gate11.pass,status:continued.summary.gate11.pass?'PASS':'FAIL',rule:'At 120, gates 2/4/8/9 on frozen stopping cores; both within-core medians >=0.65; each frozen/contemporaneous core Jaccard >=0.8.'};
    stopped.summary.pass=Object.values(stopped.summary.criteria).every(c=>!c.gated||c.pass);
    for(const row of curve)row.frozen=frozenCurve(row,memories.find(cp=>cp.epoch===row.epoch).memory,stopped.memory.cores,run.directSets);
    return {...stopped,continued,curve,checkpointMemories:memories};
  }
  const result=save(run,finalCp,baseline,untrainedMemory,{untrainedBasin});
  if(continuing){result.summary.gate11=continuedAssessment(run,finalCp,primary,baseline);result.summary.frozenBasin=basinReport(result.summary.basin,untrainedBasin,primary.memory.cores);
    for(const row of curve)row.frozen=frozenCurve(row,memories.find(cp=>cp.epoch===row.epoch).memory,primary.memory.cores,run.directSets);
    result.curve=curve;result.checkpointMemories=memories;}
  return result;
}
function pruneFormed(primary){
  const run=restoreStop(primary);run.condition='prune-formed';const pool=new Set(run.physicalPool),before=run.field.links.filter(e=>e.active).map(e=>e.toJSON()),removed=[];
  for(const e of run.field.links.filter(e=>e.active&&pool.has(e.sourceId)&&pool.has(e.targetId))){removed.push(e.id);e.prune();run.field.getNeuron(e.sourceId).synapses=run.field.getNeuron(e.sourceId).synapses.filter(s=>s!==e);}
  assert.equal(f.json(run.field.links.filter(e=>e.active).map(e=>e.toJSON())),f.json(before.filter(e=>!removed.includes(e.id))),'Pruning changed an afferent or unrelated edge.');
  const memory=exportMemory(run,primary.memory.cores),battery=probeBattery(memory),baseline=probeBattery(primary.untrainedMemory),result=metrics(run,memory,battery,baseline);
  const completionDrop=Object.fromEntries(DELAYS.map(s=>[s,result.patternCompletion.rows[s].filter(r=>r.cue!=='C').map(row=>{
    const old=primary.summary.patternCompletion.rows[s].find(r=>r.cue===row.cue&&r.half===row.half);return {cue:row.cue,half:row.half,before:old.trained,after:row.trained};
  })]));
  return {summary:{stage:'inhibitory-diagnostic',condition:'prune-formed',epoch:primary.summary.epoch,...result,probes:battery.probes,halfProbes:battery.halfProbes,
    ablation:{removed,completionDrop,otherEdgesUnchanged:true}},memory,trials:{responses:primary.trials.responses,removed}};
}
function decision(primary,controls){
  const p=primary.summary,failures=Object.entries(p.criteria).filter(([,c])=>c.gated&&!c.pass).map(([key])=>key);
  if(!p.stopping.reached)failures.push('Stopping criterion not reached by 120.');
  for(const name of ['growth-off','hebbian-off','shuffled','prune-formed'])assert.equal(controls[name].summary.epoch,p.epoch,'Unmatched '+name);
  const discrimination={growthOff:['9-pattern-completion','10-potentiation'].every(k=>!controls['growth-off'].summary.criteria[k].pass),
    hebbianOff:['9-pattern-completion','10-potentiation'].every(k=>!controls['hebbian-off'].summary.criteria[k].pass),
    pruneFormed:DELAYS.every(s=>controls['prune-formed'].summary.ablation.completionDrop[s].every(r=>r.after!==null&&r.after<.6&&r.before>r.after))};
  for(const [key,pass] of Object.entries(discrimination))if(!pass)failures.push(key+' discrimination');
  return {discrimination,failedCriteria:failures,pass:failures.length===0};
}
function runSuite(values={},progress=()=>{},{reference=null}={}){
  progress('primary');const primary=runCondition(values),controls={};
  for(const name of CONTROLS.filter(n=>n!=='prune-formed'&&n!=='inhibition-off')){progress(name);controls[name]=runCondition(values,name,{matchedEpoch:primary.summary.epoch});}
  progress('inhibition-off reference');controls['inhibition-off']=reference||require('./formation-v2.cjs').runCondition({seed:values.seed??1});
  progress('prune-formed');controls['prune-formed']=pruneFormed(primary);
  controls['continued-plastic']=primary.continued;
  progress('continued-hebbian-off');controls['continued-hebbian-off']=runCondition(values,'continued-hebbian-off',{primary});
  const result=decision(primary,controls);
  return {summary:{schema:'neurosphere-inhibitory-diagnostic-cell/v1',stage:'inhibitory-diagnostic',options:options(values),stopping:primary.summary.stopping,
    primary:primary.summary,controls:Object.fromEntries(Object.entries(controls).map(([name,r])=>[name,r.summary])),trainingCurve:primary.curve,...result},primary,controls};
}
module.exports={BITS,DELAYS,COUNTS,CONTROLS,DEFAULTS,options,topology,setup,exportMemory,liveEdges,restoreStop,subsetBits,probeBattery,basinProbes,basinReport,
  metrics,stoppingCriterion,checkpoint,save,continuedAssessment,runCondition,pruneFormed,decision,runSuite};
if(require.main===module)require('./inhibitory-study.cjs').main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=2;});
