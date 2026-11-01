'use strict';
// Independent evidence audit: native replay plus direct gate/topology/ledger calculations.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {LockedController,DevelopmentSession,SpikingField,compileController,encodeWord}=require('../src/index.cjs');
const {loadVocabulary,normalize}=require('../src/vocabulary.cjs');
const study=path.resolve(process.argv[2]),id=process.argv[3],directory=path.join(study,'cases',id);
const read=(...names)=>JSON.parse(fs.readFileSync(path.join(...names))),same=(a,b,label)=>assert.equal(JSON.stringify(a),JSON.stringify(b),label);
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex'),sorted=x=>[...new Set(x)].sort((a,b)=>a-b);
const intersection=(a,b)=>a.filter(id=>b.includes(id)),completion=(a,b)=>b.length?intersection(a,b).length/b.length:null;
const jac=(a,b)=>!a.length||!b.length?0:intersection(a,b).length/new Set([...a,...b]).size;
const decode=(active,cores)=>{const scores={A:jac(active,cores.A),B:jac(active,cores.B)},best=Math.max(scores.A,scores.B);return {scores,label:best<.5?'reject':scores.A>=scores.B?'A':'B'};};
const quantile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);if(!a.length)return null;const x=(a.length-1)*p,i=Math.floor(x);return a[i]+(a[Math.ceil(x)]-a[i])*(x-i);};
const cell=read(directory,'summary.json'),plan=read(study,'plan.json'),spec=plan.cells.find(s=>s.id===id);
assert.ok(spec);same(cell.options,spec.options);const opts=cell.options,primaryMemory=read(directory,'primary','memory.json'),initial=read(directory,'initial','memory.json');
const vocabulary=loadVocabulary(),selected=[],seenWords=new Set(),usedBits=new Set();
for(const record of [...vocabulary.records].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)){
  const word=normalize(record.word);if(!word||seenWords.has(word))continue;seenWords.add(word);
  const code=encodeWord(word);if(code.some(bit=>usedBits.has(bit)))continue;
  selected.push({id:record.id,word,bits:code});code.forEach(bit=>usedBits.add(bit));if(selected.length===3)break;
}
assert.equal(selected.length,3);same(cell.primary.cueSelection.records,Object.fromEntries(['A','B','C'].map((cue,i)=>[cue,selected[i]])),'ID-ordered disjoint cues');
assert.equal(cell.primary.cueSelection.vocabularyHash,vocabulary.sourceHash);same(initial.cues,Object.fromEntries(['A','B','C'].map((cue,i)=>[cue,selected[i].word])));
const seedEdges=initial.artifact.edges,groups=initial.scaffold.groups,pool=initial.pool,threshold=Math.ceil(1.02/opts.w0),direct={},primed={};
assert.equal(threshold,2);assert.equal(groups.length,192);assert.equal(new Set(groups.flat()).size,192*opts.g);assert.equal(seedEdges.length,192*opts.g*8);
for(const cue of ['A','B','C']){
  const sources=new Set(encodeWord(initial.cues[cue]).flatMap(bit=>groups[bit])),counts=new Map();
  for(const e of seedEdges)if(sources.has(e.sourceId))counts.set(e.targetId,(counts.get(e.targetId)||0)+1);
  direct[cue]=sorted([...counts].filter(([,n])=>n>=2).map(([id])=>id));primed[cue]=sorted([...counts].filter(([,n])=>n===1).map(([id])=>id));
}
same(direct,cell.primary.directSets,'two-hit direct sets');same(primed,cell.primary.primedSets,'one-hit primed sets');
const cache=new Map();let probeCount=0,ledgerCount=0;
function native(memory){
  const key=hash(memory.artifact);if(cache.has(key))return cache.get(key);
  const a=memory.artifact;assert.equal(a.nodes.length,192*opts.g+500);assert.equal(a.config.maxWeight,opts.w0);assert.equal(a.config.initialWeight,.4);assert.equal(a.config.maxSynapses,opts.maxSynapses);assert.equal(a.config.threshold,1.02);assert.equal(a.config.leakRate,1.4);
  assert.equal(a.config.radius,60);assert.equal(a.config.pairingClock,'arrival');for(const k of ['weightDecay','unusedDecay','healthLoss'])assert.equal(a.config[k],0);
  assert.equal(a.config.competitionMargin,1);assert.equal(a.config.exploration,.1);assert.equal(a.config.inhibitionStrength,.5);assert.equal(a.config.inhibitionRadiusFactor,.6);
  same(a.io.inputs.map(c=>c.cells),groups);assert.ok(a.nodes.every(n=>n.threshold===1.02));assert.ok(a.edges.every(e=>e.weight<=opts.w0));
  for(const group of groups)for(const id of group){const n=a.nodes.find(n=>n.id===id);assert.equal(n.radius,600);assert.ok(Math.abs(Math.hypot(n.x-400,n.y-400,n.z-400)-300)<1e-8);}
  const states={};for(const s of [0,60]){const controller=new LockedController(a);controller.advance(s);states[s]=controller.checkpoint();}
  const found=new Map(),result={get(seconds,cue,bits){
    const code=[...bits].sort((a,b)=>a-b),key=seconds+'/'+cue+'/'+code.join(',');if(found.has(key))return found.get(key);
    const active=new Set(),set=new Set(pool),controller=LockedController.restore(states[seconds],spike=>{if(set.has(spike.neuronId))active.add(spike.neuronId);});
    for(const bit of code)controller.io.pulse('f'+bit,controller.tick+1);controller.advance(1);const values=sorted(active);found.set(key,values);probeCount++;return values;
  }};cache.set(key,result);return result;
}
function bits(cue,half=null){return [...encodeWord(initial.cues[cue])].sort((a,b)=>a-b).filter((_,i)=>half===null||i%2===half);}
function battery(memory,saved){const runtime=native(memory);for(const seconds of [0,60]){
  for(const row of saved.probes[seconds]){const active=runtime.get(seconds,row.cue,bits(row.cue));same(active,row.active,'full native probe');const d=decode(active,memory.cores);same(row.scores,d.scores);assert.equal(row.label,d.label);}
  for(const row of saved.halfProbes[seconds])same(runtime.get(seconds,row.cue,bits(row.cue,row.half)),row.active,'half native probe');
}}
function basin(memory,baseline,rows,cores){const trained=native(memory),untrained=native(baseline);for(const seconds of [0,60]){assert.equal(rows[seconds].length,24);for(const row of rows[seconds]){
  const indices=row.half===0?[0,2,4,6,1,3,5,7]:[1,3,5,7,0,2,4,6],all=bits(row.cue),expected=indices.slice(0,row.count).map(i=>all[i]);same(row.bits,expected);
  const active=trained.get(seconds,row.cue,expected),raw=untrained.get(seconds,row.cue,expected);same(row.active,active,'basin trained response');same(row.untrainedActive,raw,'basin untrained response');
  assert.equal(row.trained,completion(active,cores[row.cue]));assert.equal(row.untrained,completion(raw,cores[row.cue]));
}}}
function extract(trials){const window=trials.slice(-10),counts=new Map();for(const ids of window)for(const id of new Set(ids))counts.set(id,(counts.get(id)||0)+1);return sorted([...counts].filter(([,n])=>n>=Math.ceil(.8*window.length)).map(([id])=>id));}
function stable(trials){const rows=trials.slice(-10);let sum=0,n=0;for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){sum+=jac(rows[i],rows[j]);n++;}return rows.length===10&&sum/n>=.7;}
function gates(memory,baseline,cores,responses){
  const runtime=native(memory),raw=native(baseline),edges=memory.artifact.edges.filter(e=>pool.includes(e.sourceId)&&pool.includes(e.targetId)),density=edges.length/(500*499),smaller=Math.min(cores.A.length,cores.B.length);
  const own=cue=>edges.filter(e=>cores[cue].includes(e.sourceId)&&cores[cue].includes(e.targetId)),median={A:quantile(own('A').map(e=>e.weight),.5),B:quantile(own('B').map(e=>e.weight),.5)};
  const result={'1-stability':stable(responses.A)&&stable(responses.B),'2-specificity':jac(cores.A,cores.B)<=.2,'3-size':['A','B'].every(cue=>cores[cue].length>=5&&cores[cue].length<=125),
    '4-negative-cue':true,'7-recurrent-structure':['A','B'].every(cue=>{const n=cores[cue].length,count=own(cue).length;return n>1&&count>=n&&count/(n*(n-1))>=3*density;}),
    '8-retention':jac(runtime.get(60,'A',bits('A')),cores.A)>=.8,'9-pattern-completion':true,'10-potentiation':['A','B'].every(cue=>median[cue]!==null&&median[cue]>=.6)};
  for(const s of [0,60]){
    const c=runtime.get(s,'C',bits('C')),d=decode(c,cores);result['4-negative-cue']&&=d.label==='reject'&&d.scores.A<=.25&&d.scores.B<=.25&&c.filter(id=>!direct.C.includes(id)).length<=.25*smaller;
    for(const cue of ['A','B'])for(const half of [0,1]){const trained=completion(runtime.get(s,cue,bits(cue,half)),cores[cue]),untrained=completion(raw.get(s,cue,bits(cue,half)),cores[cue]);result['9-pattern-completion']&&=trained!==null&&untrained!==null&&trained>=.8&&trained-untrained>=.25;}
  }return {result,median};
}
function random(seed){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
function ledger(trials,memory,summary){
  const rng=random((opts.seed^0x27d4eb2f)>>>0),bySource=new Map();for(const e of trials.seedEdges){if(!bySource.has(e.sourceId))bySource.set(e.sourceId,[]);bySource.get(e.sourceId).push(e);}
  let tick=1;const predicted=[];
  for(const [index,row] of trials.rows.entries()){
    assert.equal(row.epoch,Math.floor(index/2)+1);assert.equal(row.cue,index%2?'B':'A');assert.equal(row.t0,tick);assert.equal(row.captureTicks,58);
    const expected=bits(row.cue).map(bit=>{const draw=rng(),offset=Math.floor(draw*9);return {bit,cellIds:groups[bit],draw,offset,tick:tick+offset};});same(row.onsets,expected,'recorded per-bit draws');
    same(row.active,sorted(row.spikes.map(s=>s.neuronId)));same(row.active,trials.responses[row.cue][row.epoch-1]);
    same(row.featureSpikes.map(s=>s.neuronId).sort((a,b)=>a-b),expected.flatMap(o=>o.cellIds).sort((a,b)=>a-b));
    const hits=new Map();for(const onset of expected)for(const id of onset.cellIds){assert.ok(Math.abs(row.featureSpikes.find(s=>s.neuronId===id).time-onset.tick*.02)<1e-8);
      for(const e of bySource.get(id)||[]){if(!hits.has(e.targetId))hits.set(e.targetId,[]);hits.get(e.targetId).push({time:offsetTime(onset,tick)+e.delay,weight:e.weight});}}
    const arrivals=new Map();for(const [id,entries] of hits){entries.sort((a,b)=>a.time-b.time);let last=0,potential=0;for(const hit of entries){potential=potential*Math.exp(-1.4*(hit.time-last))+hit.weight;last=hit.time;if(potential>=1.02){arrivals.set(id,hit.time);break;}}}
    predicted.push({cue:row.cue,t0:tick*.02,arrivals});tick+=558;
  }
  const live=new Map(memory.artifact.edges.map(e=>[e.id,e])),raw=trials.weightAudit.lifecycles;
  for(const edge of trials.pairingAudit){
    const original=raw.find(e=>e.id===edge.id);assert.ok(original);assert.ok(Math.abs(edge.finalWeight-edge.initialWeight-edge.potentiationGain+edge.competitionLoss)<1e-8);
    if(edge.surviving){assert.equal(edge.finalWeight,live.get(edge.id).weight);ledgerCount++;}else assert.ok(!live.has(edge.id));
    let qualifying=0,modelled=0,unmodelled=0;for(const trial of predicted){const pre=trial.arrivals.get(edge.sourceId),post=trial.arrivals.get(edge.targetId);
      if(trial.t0+(pre??0)<=edge.birthTime+1e-9)continue;if(edge.deathTime!==null&&trial.t0+(post??0)>edge.deathTime+1e-9)continue;
      if(pre===undefined||post===undefined){unmodelled++;continue;}modelled++;const lag=post-pre-edge.delay;if(lag>=-1e-9&&lag<=.32+1e-9)qualifying++;
    }
    assert.equal(edge.predicted.qualifying,qualifying);assert.equal(edge.predicted.modelledTrials,modelled);assert.equal(edge.predicted.unmodelledTrials,unmodelled);
  }
  for(const key of ['potentiationEvents','potentiationGain','competitionEvents','competitionLoss']){
    const total=raw.reduce((sum,e)=>sum+e[key],0),epochs=trials.weightAudit.epochs.reduce((sum,e)=>sum+e[key],0);assert.ok(Math.abs(total-epochs)<1e-8);assert.ok(Math.abs(total-summary.structuralAudit.totals[key])<1e-8);
  }
  assert.equal(raw.length,summary.structuralAudit.totals.formed);assert.equal(raw.filter(e=>!e.surviving).length,summary.structuralAudit.totals.pruned);
  if(summary.condition==='growth-off')assert.equal(raw.length,0);if(summary.condition==='hebbian-off')assert.equal(summary.structuralAudit.totals.potentiationEvents,0);
  if(summary.condition==='continued-hebbian-off')assert.ok(trials.weightAudit.epochs.filter(e=>e.epoch>cell.stopping.epoch).every(e=>e.potentiationEvents===0));
}
function offsetTime(onset,t0){return (onset.tick-t0)*.02;}
const conditionData=new Map();
for(const condition of ['primary',...Object.keys(cell.controls)]){
  const location=condition==='primary'?path.join(directory,'primary'):path.join(directory,'controls',condition),summary=read(location,'summary.json'),memory=read(location,'memory.json'),trials=read(location,'trials.json');
  const baseline=fs.existsSync(path.join(location,'initial-memory.json'))?read(location,'initial-memory.json'):initial;
  same(summary,condition==='primary'?cell.primary:cell.controls[condition],'persisted summary');battery(memory,summary);
  const calculated=gates(memory,baseline,memory.cores,trials.responses);for(const [key,pass] of Object.entries(calculated.result))assert.equal(summary.criteria[key].pass,pass,condition+'/'+key);
  for(const s of [0,60])for(const row of summary.patternCompletion.rows[s]){
    const reference=row.cue==='C'?direct.C:memory.cores[row.cue],actual=completion(native(memory).get(s,row.cue,bits(row.cue,row.half)),reference),raw=completion(native(baseline).get(s,row.cue,bits(row.cue,row.half)),reference);
    assert.equal(row.trained,actual);assert.equal(row.untrained,raw);assert.equal(row.gain,actual===null||raw===null?null:actual-raw);
  }
  if(summary.basin)basin(memory,baseline,summary.basin,memory.cores);
  if(condition!=='prune-formed'){
    same(memory.cores,{A:extract(trials.responses.A),B:extract(trials.responses.B)},'contemporary core extraction');ledger(trials,memory,summary);
    same(summary.directSets,direct);same(summary.primedSets,primed);
  }
  if(condition.startsWith('continued-')){
    assert.equal(summary.epoch,120);same(summary.gate11.frozenCores,primaryMemory.cores);const frozen=gates(memory,baseline,primaryMemory.cores,trials.responses);
    const components=Object.fromEntries(['2-specificity','4-negative-cue','8-retention','9-pattern-completion'].map(key=>[key,frozen.result[key]]));components.epoch120=true;
    components.saturation=['A','B'].every(cue=>frozen.median[cue]!==null&&frozen.median[cue]>=.65);components.drift=['A','B'].every(cue=>jac(primaryMemory.cores[cue],memory.cores[cue])>=.8);
    same(components,summary.gate11.components,'independent frozen-core gate 11');assert.equal(summary.gate11.pass,Object.values(components).every(Boolean));
    for(const cue of ['A','B']){assert.equal(summary.gate11.drift[cue],jac(primaryMemory.cores[cue],memory.cores[cue]));assert.equal(summary.gate11.saturation[cue],frozen.median[cue]);}
    for(const row of summary.gate11.frozenMetrics.negative){const active=native(memory).get(row.idleSeconds,'C',bits('C')),spill=active.filter(id=>!direct.C.includes(id)),d=decode(active,primaryMemory.cores);
      same(row.outsideDirectSet,spill);assert.equal(row.readback,d.label);assert.equal(row.A.jaccard,d.scores.A);assert.equal(row.B.jaccard,d.scores.B);}
    basin(memory,baseline,summary.frozenBasin,primaryMemory.cores);
  }
  conditionData.set(condition,{summary,memory,trials,location});
}
const curve=read(directory,'primary','curve.json');same(curve.map(r=>r.epoch),Array.from({length:12},(_,i)=>(i+1)*10));
function checkCurve(row,memory){battery(memory,row.battery);
  for(const s of [0,60])for(const half of row.halfCompletions[s])assert.equal(half.completion,completion(native(memory).get(s,half.cue,bits(half.cue,half.half)),memory.cores[half.cue]));
  for(const s of [0,60])for(const half of row.frozen.halfCompletions[s])assert.equal(half.completion,completion(native(memory).get(s,half.cue,bits(half.cue,half.half)),primaryMemory.cores[half.cue]));
  for(const s of [0,60]){const active=native(memory).get(s,'C',bits('C')),count=active.filter(id=>!direct.C.includes(id)).length;assert.equal(row.negative[s].count,count);assert.equal(row.frozen.negative[s].count,count);same(row.frozen.negative[s].jaccards,decode(active,primaryMemory.cores).scores);}
  const edges=memory.artifact.edges.filter(e=>pool.includes(e.sourceId)&&pool.includes(e.targetId));for(const cue of ['A','B']){const own=edges.filter(e=>primaryMemory.cores[cue].includes(e.sourceId)&&primaryMemory.cores[cue].includes(e.targetId));assert.equal(row.frozen.medianWeights[cue],quantile(own.map(e=>e.weight),.5));assert.equal(row.frozen.drift[cue],jac(primaryMemory.cores[cue],row.cores[cue]));}
}
for(const row of curve)checkCurve(row,read(directory,'primary','checkpoints',String(row.epoch).padStart(3,'0'),'memory.json'));
const offLocation=conditionData.get('continued-hebbian-off').location;
for(const row of read(offLocation,'curve.json'))checkCurve(row,read(offLocation,'checkpoints',String(row.epoch).padStart(3,'0'),'memory.json'));
const qualifies=row=>row.epoch>=30&&[0,60].every(s=>row.halfCompletions[s].every(h=>h.completion!==null&&h.completion>=.8)),first=curve.find(qualifies);
assert.equal(cell.stopping.epoch,first?.epoch??120);assert.equal(cell.stopping.reached,!!first);assert.equal(cell.stopping.cConsulted,false);assert.equal(cell.stopping.otherGatesConsulted,false);
same(primaryMemory,read(directory,'primary','checkpoints',String(cell.stopping.epoch).padStart(3,'0'),'memory.json'));
same(conditionData.get('continued-plastic').memory,read(directory,'primary','checkpoints','120','memory.json'));
const before=primaryMemory.artifact,pruned=conditionData.get('prune-formed'),removed=before.edges.filter(e=>pool.includes(e.sourceId)&&pool.includes(e.targetId)).map(e=>e.id);
same(pruned.summary.ablation.removed,removed);same(pruned.memory.artifact.edges,before.edges.filter(e=>!removed.includes(e.id)));same(pruned.memory.artifact.nodes,before.nodes);
const development=read(directory,'primary','development.json'),session=DevelopmentSession.restore(development.checkpoint,SpikingField),field=session.field;
assert.equal(Boolean(field.circuitLock),false);const ids=groups.flat(),inputSet=new Set(ids);Object.defineProperty(field,'endpointIds',{get:()=>ids});field.isInputCell=id=>inputSet.has(id);
for(const id of ids)assert.equal(field.getNeuron(id).nextGrowthAt,1e12);field.lockCircuit('NeuroSphere Stage 1d formation probe');same(compileController(field,{name:'NeuroSphere formation',io:session.io.config}),before,'native restored stopping artifact');
const discrimination={growthOff:['9-pattern-completion','10-potentiation'].every(k=>!cell.controls['growth-off'].criteria[k].pass),hebbianOff:['9-pattern-completion','10-potentiation'].every(k=>!cell.controls['hebbian-off'].criteria[k].pass),pruneFormed:true};
for(const s of [0,60])for(const cue of ['A','B'])for(const half of [0,1]){const p=completion(native(primaryMemory).get(s,cue,bits(cue,half)),primaryMemory.cores[cue]),q=completion(native(pruned.memory).get(s,cue,bits(cue,half)),primaryMemory.cores[cue]);discrimination.pruneFormed&&=q!==null&&q<.6&&p>q;}
same(discrimination,cell.discrimination);assert.equal(cell.primary.criteria['11-continued-stability'].pass,cell.controls['continued-plastic'].gate11.pass);
assert.equal(cell.pass,cell.stopping.reached&&Object.values(cell.primary.criteria).every(c=>!c.gated||c.pass)&&Object.values(discrimination).every(Boolean));
process.stdout.write(JSON.stringify({id,scientificPass:cell.pass,allEvidenceChecks:true,replayedCircuits:cache.size,nativeProbeResponses:probeCount,liveLedgerWeightsChecked:ledgerCount,stoppingEpoch:cell.stopping.epoch})+'\n');
