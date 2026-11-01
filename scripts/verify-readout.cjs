'use strict';
// Independent native replay and direct calculations; does not call the readout harness.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {LockedController,SpikingField,DevelopmentSession,compileController,encodeWord}=require('../src/index.cjs');
const study=path.resolve(process.argv[2]),id=process.argv[3],directory=path.join(study,'cases',id),ROOT=path.resolve(__dirname,'..');
const read=(...p)=>JSON.parse(fs.readFileSync(path.join(...p))),same=(a,b,label)=>assert.equal(JSON.stringify(a),JSON.stringify(b),label),near=(a,b,label)=>assert.ok(Math.abs(a-b)<1e-8,label+': '+a+' vs '+b);
const sorted=xs=>[...new Set(xs)].sort((a,b)=>a-b),intersection=(a,b)=>a.filter(x=>b.includes(x)),completion=(a,b)=>b.length?intersection(a,b).length/b.length:null,jac=(a,b)=>!a.length||!b.length?0:intersection(a,b).length/new Set([...a,...b]).size;
const cell=read(directory,'summary.json'),plan=read(study,'plan.json'),spec=plan.cells.find(c=>c.id===id),origin=read(study,'origins',cell.seed+'.json'),refs=origin.refs,pool=new Set(origin.pool),features=new Set(origin.features);
assert.ok(spec);same(cell.options,spec.options);assert.equal(origin.epoch,{1:70,2:60,3:70}[cell.seed]);assert.equal(origin.identity.byteIdentical,true);
const original=read(ROOT,plan.origin.source,'cases','baseline-'+cell.seed,'memory.json');same(origin.memory,original,'Original1g native export');same(origin.refs,original.cores);
const originalTrials=read(ROOT,plan.origin.source,'cases','baseline-'+cell.seed,'trials.json').primary;same(origin.formationTrials.A,originalTrials.A);same(origin.formationTrials.B,originalTrials.B);same(origin.formationSchedule,originalTrials.stimulusSchedule);
function register(field){Object.defineProperty(field,'endpointIds',{get:()=>origin.features});field.isInputCell=id=>features.has(id);}
const originalSession=DevelopmentSession.restore(origin.checkpoint,SpikingField);register(originalSession.field);assert.equal(Boolean(originalSession.field.circuitLock),false);
originalSession.field.lockCircuit('NeuroSphere Stage 1d formation probe');same(compileController(originalSession.field,{name:'NeuroSphere formation',io:originalSession.io.config}),original.artifact,'Reproduced unlocked snapshot exports exact original circuit');
const direct={};for(const cue of ['A','B','C']){const sources=new Set(encodeWord(origin.cues[cue]).map(bit=>origin.features[bit]));direct[cue]=sorted(origin.seedEdges.filter(e=>sources.has(e.sourceId)).map(e=>e.targetId));}same(direct,origin.directSets);
const oldWeights=original.artifact.edges.filter(e=>pool.has(e.sourceId)&&pool.has(e.targetId)).map(({id,sourceId,targetId,weight})=>({id,sourceId,targetId,weight}));
const baseline=read(directory,'formation-untrained/memory.json'),primaryMemory=read(directory,'primary/memory.json'),cache=new Map();let nativeResponses=0;
const bits=(cue,half=null)=>encodeWord(origin.cues[cue]).filter((_,i)=>half===null||i%2===half);
function native(memory,seconds,cue,half=null){
  const key=JSON.stringify(memory.artifact);if(!cache.has(key)){const idle={};for(const s of [0,60]){const c=new LockedController(memory.artifact);c.advance(s);idle[s]=c.checkpoint();}cache.set(key,{idle,probes:new Map()});}
  const cached=cache.get(key),probeKey=[seconds,cue,half].join('/');if(cached.probes.has(probeKey))return cached.probes.get(probeKey);
  const spikes=[],controller=LockedController.restore(cached.idle[seconds],spike=>spikes.push({neuronId:spike.neuronId,time:spike.time})),t0=controller.tick+1;
  for(const bit of bits(cue,half))controller.io.pulse('f'+bit,t0);controller.advance(1);const active=sorted(spikes.filter(s=>pool.has(s.neuronId)).map(s=>s.neuronId));
  const result={active,spikes,t0,endTime:controller.time,io:controller.io.decode(false)};cached.probes.set(probeKey,result);nativeResponses++;return result;
}
function margins(memory,response,output){
  const config=memory.artifact.config,node=memory.artifact.nodes.find(n=>n.id===output.id),edges=new Map(memory.artifact.edges.filter(e=>e.targetId===output.id).map(e=>[e.sourceId,e]));
  const pending=response.spikes.filter(s=>pool.has(s.neuronId)&&edges.has(s.neuronId)).map(s=>({at:s.time+edges.get(s.neuronId).delay,synapseId:edges.get(s.neuronId).id,weight:edges.get(s.neuronId).weight}));
  const arrivals=pending.filter(m=>m.at<=response.endTime+1e-9),raw=arrivals.reduce((s,m)=>s+m.weight,0);let potential=0,adaptation=0,refractory=0,integrated=0,peak=-Infinity,peakPotential=0,peakThreshold=null,first=null;const fired=[];
  for(let tick=response.t0;tick<response.t0+50;tick++){
    const time=tick*config.dt;potential*=Math.exp(-node.leakRate*config.dt);adaptation*=Math.exp(-config.dt/2.5);
    const due=arrivals.filter(m=>!m.used&&m.at<=time+1e-9);for(const m of due)m.used=true;due.sort((a,b)=>a.at-b.at||a.synapseId.localeCompare(b.synapseId));
    if(time>=refractory){for(const m of due){potential+=m.weight;integrated+=m.weight;}const threshold=node.threshold-.14*Math.exp(-node.age/config.maturation)+adaptation,margin=potential-threshold;
      if(margin>peak){peak=margin;peakPotential=potential;peakThreshold=threshold;}
      if(potential>=threshold){if(!first)first={potential,effectiveThreshold:threshold,integratedWeight:integrated};fired.push(time);potential=0;adaptation+=.08;refractory=time+config.refractory;}
    }
  }
  same(output.spikeTimes,fired,'Independent output membrane spike times');near(output.arrivingWeight,raw,'Arriving charge');near(output.inputMargin,raw-node.threshold,'Input margin');near(output.integratedWeight,integrated,'Integrated charge');
  near(output.peakMargin,peak,'Peak membrane margin');near(output.peakPotential,peakPotential,'Peak potential');near(output.peakEffectiveThreshold,peakThreshold,'Peak effective threshold');
  if(first){assert.ok(output.firstSpike);for(const k of Object.keys(first))near(output.firstSpike[k],first[k],'First spike '+k);}else assert.equal(output.firstSpike,null);
}
function validateMemory(memory){
  const artifact=memory.artifact;assert.equal(artifact.config.maxSynapses,10);assert.equal(artifact.config.weightFloor,0);assert.equal(artifact.config.maxWeight,1.65);
  for(const k of ['weightDecay','unusedDecay','healthLoss'])assert.equal(artifact.config[k],0);same(memory.cores,refs);assert.equal(artifact.nodes.length,694);
  for(const n of artifact.nodes.filter(n=>pool.has(n.id)))assert.equal(n.radius,60);
  for(const cue of ['A','B']){const o=memory.outputs[cue],n=artifact.nodes.find(n=>n.id===o.id);assert.equal(n.recordOutput,true);assert.equal(n.threshold,spec.options.thresholdFactor*refs[cue].length*1.65);assert.equal(o.threshold,n.threshold);same([n.x,n.y,n.z],[400,400,400]);assert.ok(!artifact.edges.some(e=>e.sourceId===o.id));}
  for(const n of artifact.nodes)assert.ok(artifact.edges.filter(e=>e.sourceId===n.id).length<=10);
}
function measured(memory,summary){
  validateMemory(memory);const observed=summary.observed;
  for(const s of [0,60])for(const key of ['probes','halfProbes'])for(const row of observed[key][s]){
    const response=native(memory,s,row.cue,row.half);same(row.active,response.active,'Native pool response');same(row.spikes,response.spikes.filter(spike=>pool.has(spike.neuronId)||Object.values(memory.outputs).some(o=>o.id===spike.neuronId)),'Native output/pool spike trace');same(row.io,response.io);
    for(const cue of ['A','B']){const output=row.outputs[cue],times=response.spikes.filter(spike=>spike.neuronId===memory.outputs[cue].id).map(spike=>spike.time);same(output.spikeTimes,times);assert.equal(output.fired,times.length>0);assert.equal(row.coreCellsFired[cue],intersection(response.active,refs[cue]).length);
      same(output.latencyTicks,times.map(t=>Math.round(t/.02)-response.t0));margins(memory,response,output);}
  }
  const only=(row,cue)=>row.outputs[cue].fired&&!row.outputs[cue==='A'?'B':'A'].fired;
  const gates={R1:[0,60].every(s=>['A','B'].every(c=>only(observed.probes[s].find(r=>r.cue===c),c))),R2:[0,60].every(s=>observed.halfProbes[s].every(row=>only(row,row.cue))),R3:[0,60].every(s=>{const c=observed.probes[s].find(r=>r.cue==='C');return !c.outputs.A.fired&&!c.outputs.B.fired;})};
  const actual=memory.artifact.edges.filter(e=>pool.has(e.sourceId)&&pool.has(e.targetId)).map(({id,sourceId,targetId,weight})=>({id,sourceId,targetId,weight})),equal=JSON.stringify(actual)===JSON.stringify(oldWeights);
  const components={poolWeightsExactlyUnchanged:equal,'2-specificity':jac(refs.A,refs.B)<=.2,'4-negative-cue':true,'8-retention':jac(native(memory,60,'A').active,refs.A)>=.8,'9-pattern-completion':true};
  for(const s of [0,60]){
    const c=native(memory,s,'C').active,scores={A:jac(c,refs.A),B:jac(c,refs.B)},reject=Math.max(scores.A,scores.B)<.5;
    components['4-negative-cue']&&=reject&&scores.A<=.25&&scores.B<=.25&&c.filter(id=>!direct.C.includes(id)).length<=.25*Math.min(refs.A.length,refs.B.length);
    for(const cue of ['A','B'])for(const half of [0,1]){const trained=completion(native(memory,s,cue,half).active,refs[cue]),untrained=completion(native(baseline,s,cue,half).active,refs[cue]);components['9-pattern-completion']&&=trained>=.8&&trained-untrained>=.25;}
  }
  gates.R4=Object.values(components).every(Boolean);same(summary.memoryPreservation,components);same(summary.gates,gates);return gates;
}
function rng(seed){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
function training(summary,trials,memory){
  const random=rng((origin.seed^0x94d049bb)>>>0);assert.equal(trials.rows.length,2*summary.epoch);let expectedTick=origin.tick+1;
  for(const [index,row] of trials.rows.entries()){
    assert.equal(row.epoch,1+Math.floor(index/2));assert.equal(row.cue,index%2?'B':'A');assert.equal(row.t0,expectedTick);assert.equal(row.captureTicks,65);
    same(row.onsets,bits(row.cue).map(bit=>{const draw=random(),offset=Math.floor(draw*16);return {bit,cellId:origin.features[bit],draw,offset,tick:expectedTick+offset};}));
    assert.equal(row.features.length,8);for(const onset of row.onsets)near(row.features.find(s=>s.neuronId===onset.cellId).time,onset.tick*.02,'Feature timing');
    const teacherCue=summary.condition==='swapped-teacher'?(row.cue==='A'?'B':'A'):row.cue;assert.equal(row.teacher.id,memory.outputs[teacherCue].id);assert.equal(row.teacher.tick,expectedTick+spec.options.teacherTick);
    const time=row.teacher.tick*.02,delivered=row.outputs.some(s=>s.neuronId===row.teacher.id&&Math.abs(s.time-time)<1e-9&&s.externalDrive);assert.equal(row.teacher.delivered,delivered);assert.equal(row.teacher.refractoryVeto,time<row.teacher.refractoryUntil);assert.equal(delivered,!row.teacher.refractoryVeto);
    same(row.teacher.naturalBefore,row.outputs.filter(s=>s.neuronId===row.teacher.id&&!s.driven&&s.time<time-1e-9));
    if(row.teacher.refractoryVeto)assert.ok(row.outputs.some(s=>s.neuronId===row.teacher.id&&s.time<time&&s.time+1.35>time));
    same(row.active,sorted(row.pool.map(s=>s.neuronId)));expectedTick+=565;
  }
  for(const cue of ['A','B'])assert.equal(summary.teacher.firstNaturalBeforeTeacher[cue],trials.rows.find(row=>row.teacher.id===memory.outputs[cue].id&&row.teacher.naturalBefore.length)?.epoch??null);
}
const conditions=new Map();
for(const condition of ['primary',...Object.keys(cell.controls),'continued-primary']){
  const location=condition==='primary'?path.join(directory,'primary'):condition==='continued-primary'?path.join(directory,'continued-primary'):path.join(directory,'controls',condition),summary=read(location,'summary.json'),memory=read(location,'memory.json'),trials=read(location,'trials.json');
  assert.equal(summary.epoch,condition==='continued-primary'?80:condition==='untrained-readout'?0:cell.stopping.epoch);
  if(condition!=='continued-primary')same(summary,condition==='primary'?cell.primary:cell.controls[condition]);measured(memory,summary);
  if(!condition.startsWith('prune-'))training(summary,trials,memory);
  const development=read(location,'development.json'),session=DevelopmentSession.restore(development.checkpoint,SpikingField);register(session.field);for(const id of [...origin.pool,...Object.values(memory.outputs).map(o=>o.id)])assert.equal(session.field.getNeuron(id).nextGrowthAt,1e12);
  assert.equal(session.field.config.maxSynapses,10);assert.equal(session.field.config.weightFloor,0);session.field.lockCircuit('NeuroSphere Stage 1d formation probe');same(compileController(session.field,{name:'NeuroSphere formation',io:session.io.config}),memory.artifact,'Native readout reload');
  conditions.set(condition,{summary,memory,trials});
}
const curve=read(directory,'primary/curve.json');same(curve.map(r=>r.epoch),Array.from({length:9},(_,i)=>i*10));
for(const row of curve)measured(read(directory,'primary/checkpoints',String(row.epoch).padStart(3,'0'),'memory.json'),row);
const qualifies=row=>row.epoch>=20&&['R1','R2','R3'].every(k=>row.gates[k]),first=curve.find(qualifies);assert.equal(cell.stopping.epoch,first?.epoch??80);assert.equal(cell.stopping.reached,!!first);
same(primaryMemory,read(directory,'primary/checkpoints',String(cell.stopping.epoch).padStart(3,'0'),'memory.json'));
for(const condition of ['prune-readout','prune-formed']){
  const data=conditions.get(condition),O=new Set(Object.values(primaryMemory.outputs).map(o=>o.id)),removed=primaryMemory.artifact.edges.filter(e=>pool.has(e.sourceId)&&(condition==='prune-readout'?O.has(e.targetId)&&e.weight>.1:pool.has(e.targetId))).map(e=>e.id);
  same(data.summary.ablation.removed,removed);same(data.memory.artifact.edges,primaryMemory.artifact.edges.filter(e=>!removed.includes(e.id)));same(data.memory.artifact.nodes,primaryMemory.artifact.nodes);
  const unchanged=[0,60].every(s=>['probes','halfProbes'].every(k=>JSON.stringify(data.summary.observed[k][s].map(r=>r.active))===JSON.stringify(cell.primary.observed[k][s].map(r=>r.active))));assert.equal(data.summary.ablation.poolResponsesUnchanged,unchanged);
}
const none=s=>[0,60].every(d=>['probes','halfProbes'].every(k=>s.observed[k][d].every(r=>!r.outputs.A.fired&&!r.outputs.B.fired))),controls=cell.controls;
const discrimination={readoutHebbianOff:!controls['readout-hebbian-off'].gates.R1&&none(controls['readout-hebbian-off']),pruneReadout:!controls['prune-readout'].gates.R1&&controls['prune-readout'].ablation.poolResponsesUnchanged,
  swappedTeacher:[0,60].every(d=>['A','B'].every(c=>{const row=controls['swapped-teacher'].observed.probes[d].find(r=>r.cue===c);return row.outputs[c==='A'?'B':'A'].fired&&!row.outputs[c].fired;})),
  pruneFormed:!controls['prune-formed'].gates.R2&&controls['prune-formed'].gates.R1,untrainedReadout:none(controls['untrained-readout'])};same(cell.discrimination,discrimination);
assert.equal(cell.pass,cell.stopping.reached&&Object.values(cell.primary.gates).every(Boolean)&&Object.values(discrimination).every(Boolean));
process.stdout.write(JSON.stringify({id,scientificPass:cell.pass,allEvidenceChecks:true,startingIdentity:true,replayedCircuits:cache.size,nativeProbeResponses:nativeResponses,stoppingEpoch:cell.stopping.epoch})+'\n');
