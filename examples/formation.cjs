'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { SpikingField, DevelopmentSession, LockedController, compileController } = require('../src/index.cjs');
const { encodeWord, WORD_CODE, loadVocabulary, normalize } = require('../src/vocabulary.cjs');
const { DEFAULTS: NEURON_DEFAULTS } = require('../src/neuron/neuron.js');
const { jaccard } = require('../src/neuron/assembly-task.js');
const { LAYOUT } = require('../src/domain-layout.cjs');
const { createWeightAudit, summarizeAudit } = require('./formation-audit.cjs');

const LEGACY_CUES = Object.freeze({ A:'aardvark', B:'banana', C:'cabbage' });
const LABELS = Object.freeze(['A','B','C']);
function selectCues(mode='disjoint',vocabulary=loadVocabulary()) {
  if(!['disjoint','shared'].includes(mode))throw new Error('Cues must be disjoint or shared.');
  const records=[],seen=new Set(),used=new Set();
  if(mode==='disjoint')for(const record of [...vocabulary.records].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)){
    const word=normalize(record.word);if(!word||seen.has(word))continue;seen.add(word);
    const bits=encodeWord(word);if(bits.some(bit=>used.has(bit)))continue;
    records.push({id:record.id,word,bits});for(const bit of bits)used.add(bit);
    if(records.length===3)break;
  }
  else for(const word of Object.values(LEGACY_CUES))records.push({id:null,word,bits:encodeWord(word)});
  if(records.length!==3)throw new Error('Vocabulary does not contain three disjoint word codes.');
  return {mode,vocabularyHash:vocabulary.sourceHash,
    rule:mode==='disjoint'?'Greedy first three distinct normalized words in ascending ID order with pairwise-disjoint codes.':'Historical aardvark/banana pair; cabbage remains the negative cue.',
    records:Object.fromEntries(LABELS.map((cue,i)=>[cue,records[i]])),
    words:Object.fromEntries(LABELS.map((cue,i)=>[cue,records[i].word])),bits:Object.fromEntries(LABELS.map((cue,i)=>[cue,records[i].bits]))};
}
const VOCABULARY=loadVocabulary();
const CUE_SETS={disjoint:selectCues('disjoint',VOCABULARY),shared:selectCues('shared',VOCABULARY)};
const CUES=Object.freeze({...CUE_SETS.disjoint.words});
const DECAY_CONFIG=Object.freeze({off:Object.freeze({weightDecay:0,unusedDecay:0,healthLoss:0}),
  default:Object.freeze(Object.fromEntries(['weightDecay','unusedDecay','healthLoss'].map(key=>[key,NEURON_DEFAULTS[key]])))});
const CONTROLS = Object.freeze(['growth-off','hebbian-off','inhibition-off','shuffled','untrained','prune-formed']);
const DEFAULTS = Object.freeze({ pool:500, poolRadius:120, radius:60, featureRadius:600, k:8, w0:1.1, initialWeight:.4, maxSynapses:8,
  growthPeriod:1.8, inhibitionStrength:.5, inhibitionRadiusFactor:.6, epochs:80, seed:1, gap:10, secretion:0, jitter:15, competitionMargin:1, exploration:.1,
  pairingClock:'arrival', decay:'off', cues:'disjoint', featureGrowth:false, homeostasis:false, activityScaledInhibition:false });
const BOUNDS = Object.freeze({ pool:[150,1200,true], poolRadius:[80,250], radius:[30,150], featureRadius:[420,800], k:[4,10,true], w0:[.6,1.4], initialWeight:[.2,.8],
  maxSynapses:[3,10,true], growthPeriod:[.5,5], inhibitionStrength:[0,2], inhibitionRadiusFactor:[.2,1], epochs:[0,200,true], seed:[0,0xffffffff,true], gap:[0,60], secretion:[0,100], jitter:[0,100,true],
  competitionMargin:[0,10], exploration:[0,10], hebbianRate:[0,1], stdpWindow:[.001,10], maxWeight:[.001,10], weightDecay:[0,1], unusedDecay:[0,1], healthLoss:[0,1], weightFloor:[0,1], threshold:[.001,10], leakRate:[0,100], refractory:[0,10] });
const copy = value => structuredClone(value);
const sorted = ids => [...new Set(ids)].sort((a,b)=>a-b);
function random(seed) {
  let state=seed>>>0;
  return ()=>{ state=(Math.imul(state,1664525)+1013904223)>>>0; return state/4294967296; };
}
function sample(values, count, rng) {
  const result=[...values];
  for(let i=0;i<count;i++){const j=i+Math.floor(rng()*(result.length-i));[result[i],result[j]]=[result[j],result[i]];}
  return result.slice(0,count);
}
function options(values={}) {
  const result={...DEFAULTS,...values};
  for(const [name,value] of Object.entries(result)){
    if(name==='decay'){if(!['off','default'].includes(value))throw new Error('--decay must be off or default.');continue;}
    if(name==='cues'){if(!['disjoint','shared'].includes(value))throw new Error('--cues must be disjoint or shared.');continue;}
    if(name==='pairingClock'){if(!['arrival','emission'].includes(value))throw new Error('--pairingClock must be arrival or emission.');continue;}
    if(['featureGrowth','homeostasis','activityScaledInhibition'].includes(name)){if(typeof value!=='boolean')throw new Error(name+' must be boolean.');continue;}
    const bounds=BOUNDS[name];
    if(!bounds||!Number.isFinite(value)||value<bounds[0]||value>bounds[1]||bounds[2]&&!Number.isSafeInteger(value))throw new Error('Invalid --'+name+'.');
  }
  if(result.k>result.pool||result.pool+WORD_CODE.features>2000)throw new Error('Population or projection count exceeds capacity.');
  if(result.k>result.maxSynapses)throw new Error('--k must not exceed --maxSynapses.');
  if(result.featureRadius<300+result.poolRadius)throw new Error('--featureRadius must cover the shell-to-pool distance (300 + poolRadius).');
  if(Math.abs(result.gap/.02-Math.round(result.gap/.02))>1e-8)throw new Error('--gap must be a multiple of the native 0.02-second tick.');
  return result;
}
function parseArgs(argv) {
  const values={},seeds=[];let sweep=false,diagnostic=false,study=false,output=null,help=false;
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];if(!flag.startsWith('--'))throw new Error('Expected a --flag, received '+flag+'.');
    const name=flag.slice(2);
    if(name==='help'){help=true;continue;}
    if(name==='sweep'){sweep=true;continue;}
    if(name==='diagnostic'){diagnostic=true;continue;}
    if(name==='study'){study=true;continue;}
    if(name==='pruneFormed')continue; // Historical flag: pruning is now the required control.
    if(name==='decay'||name==='cues'||name==='pairingClock'){values[name]=argv[++i];continue;}
    if(['featureGrowth','homeostasis','activityScaledInhibition'].includes(name)){values[name]=true;continue;}
    if(name==='output'){output=argv[++i];if(!output||output.startsWith('--'))throw new Error('--output needs a directory.');continue;}
    if(name==='seed'){
      const start=seeds.length;
      while(i+1<argv.length&&!argv[i+1].startsWith('--'))seeds.push(Number(argv[++i]));
      if(seeds.length===start)throw new Error('--seed needs one or more integers.');continue;
    }
    if(!Object.hasOwn(BOUNDS,name)||argv[i+1]===undefined||argv[i+1].startsWith('--'))throw new Error('Unknown flag or missing value: '+flag+'.');
    values[name]=Number(argv[++i]);
  }
  if(!seeds.length)seeds.push(DEFAULTS.seed);
  if(new Set(seeds).size!==seeds.length)throw new Error('Supply distinct seeds.');
  for(const seed of seeds)options({...values,seed});
  if(diagnostic&&(sweep||seeds.length!==1||seeds[0]!==1))throw new Error('--diagnostic requires seed 1 only and cannot be combined with --sweep.');
  if(study&&(sweep||diagnostic||Object.keys(values).length||argv.includes('--seed')))throw new Error('--study uses the predeclared protocol; only --output may be supplied.');
  return {options:options({...values,seed:seeds[0]}),seeds,sweep,diagnostic,study,output,help};
}
function extractCore(trials) {
  const window=trials.slice(-10),counts=new Map();
  for(const trial of window)for(const id of new Set(trial))counts.set(id,(counts.get(id)??0)+1);
  return sorted([...counts].filter(([,count])=>count>=Math.ceil(.8*window.length)).map(([id])=>id));
}
function stability(trials) {
  const window=trials.slice(-10);let sum=0,pairs=0;
  for(let i=0;i<window.length;i++)for(let j=i+1;j<window.length;j++){sum+=jaccard(window[i],window[j]);pairs++;}
  const mean=pairs?sum/pairs:null;
  return {trials:window.length,pairs,mean,strict:window.length===10&&mean>=.8,soft:window.length===10&&mean>=.7};
}
function meanDistance(ids, positions) {
  if(ids.length<2)return null;let total=0,pairs=0;
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
    const a=positions.get(ids[i]),b=positions.get(ids[j]);total+=Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);pairs++;
  }
  return total/pairs;
}
function compactness(core,pool,positions,seed) {
  if(core.length<2)return {size:core.length,observedMean:null,randomMean:null,ratio:null,randomSubsets:200,valid:false};
  const rng=random(seed),observedMean=meanDistance(core,positions);let sum=0;
  for(let i=0;i<200;i++)sum+=meanDistance(sample(pool,core.length,rng),positions);
  const randomMean=sum/200,ratio=randomMean>0?observedMean/randomMean:null;
  return {size:core.length,observedMean,randomMean,ratio,randomSubsets:200,valid:ratio!==null};
}
function recurrent(core,edges) {
  const ids=new Set(core);let within=0,between=0;
  for(const edge of edges){const a=ids.has(edge.sourceId),b=ids.has(edge.targetId);if(a&&b)within++;else if(a!==b)between++;}
  return {within,between,withinBetweenRatio:between?within/between:null,noBetweenEdges:between===0};
}
function weightDistribution(edges,initialWeight=.4) {
  const weights=edges.map(edge=>edge.weight).sort((a,b)=>a-b);
  if(weights.some(weight=>!Number.isFinite(weight)))throw new Error('Formed weights must be finite.');
  const quantile=p=>{
    if(!weights.length)return null;
    const position=(weights.length-1)*p,lo=Math.floor(position),hi=Math.ceil(position);
    return weights[lo]+(weights[hi]-weights[lo])*(position-lo);
  };
  const atOrAboveThreshold=weights.filter(weight=>weight>=1.02).length;
  return {count:weights.length,quantiles:{min:quantile(0),p25:quantile(.25),median:quantile(.5),p75:quantile(.75),max:quantile(1)},
    threshold:1.02,atOrAboveThreshold,fractionAtOrAboveThreshold:weights.length?atOrAboveThreshold/weights.length:0,
    ignitionFraction:weights.length?atOrAboveThreshold/weights.length:0,ignitionHealthy:weights.length>0&&atOrAboveThreshold/weights.length<.1,
    atInitialWeight:weights.filter(weight=>weight===initialWeight).length,belowInitialWeight:weights.filter(weight=>weight<initialWeight).length,
    aboveInitialWeight:weights.filter(weight=>weight>initialWeight).length};
}
function potentiation(cores,edges,initialWeight=.4) {
  const a=new Set(cores.A),b=new Set(cores.B),minimum=.6;
  const perCore=Object.fromEntries(['A','B'].map(cue=>{
    const core=new Set(cores[cue]);
    const within=weightDistribution(edges.filter(edge=>core.has(edge.sourceId)&&core.has(edge.targetId)),initialWeight);
    const boundary=weightDistribution(edges.filter(edge=>core.has(edge.sourceId)!==core.has(edge.targetId)),initialWeight);
    return [cue,{within,boundary,pass:within.count>0&&within.quantiles.median>=minimum}];
  }));
  const between=edges.filter(edge=>a.has(edge.sourceId)&&!b.has(edge.sourceId)&&b.has(edge.targetId)&&!a.has(edge.targetId)||
    b.has(edge.sourceId)&&!a.has(edge.sourceId)&&a.has(edge.targetId)&&!b.has(edge.targetId));
  return {initialWeight,medianMinimum:minimum,ignitionHealthyBelow:.1,ignitionGated:false,quantileMethod:'Linear interpolation at (n-1)*p; empty quantiles are null.',
    definitions:{within:'Both endpoints in the named core.',boundary:'Exactly one endpoint in the named core; same boundary as criterion 7.',
      betweenCores:'Edges between A-only and B-only members, in either direction; shared-core members excluded.',poolWide:'All surviving growth-formed pool-to-pool edges.'},
    cores:perCore,betweenCores:weightDistribution(between,initialWeight),poolWide:weightDistribution(edges,initialWeight),pass:perCore.A.pass&&perCore.B.pass};
}
function decode(active,cores) {
  const scores={A:jaccard(active,cores.A),B:jaccard(active,cores.B)},best=Math.max(scores.A,scores.B);
  // Deterministic argmax: an above-threshold tie uses the first label, A.
  return {scores,label:best<.5?'reject':scores.A>=scores.B?'A':'B'};
}

function cueBits(cue,half=null,cues=CUES) {
  const bits=[...encodeWord(cues[cue])].sort((a,b)=>a-b);
  if(half===null)return bits;
  if(half!==0&&half!==1)throw new Error('Half must be 0 (even indices) or 1 (odd indices).');
  return bits.filter((_,index)=>index%2===half);
}
function probeMemory(memory, cue, idleSeconds=0,half=null,checkpoint=null) {
  if(!['neurosphere-formation/v1','neurosphere-formation/v2'].includes(memory?.schema)||!LABELS.includes(cue)||![0,60].includes(idleSeconds))throw new Error('Invalid formation probe.');
  const cues=memory.schema==='neurosphere-formation/v1'?LEGACY_CUES:memory.cues;
  if(!cues||!LABELS.every(key=>typeof cues[key]==='string'))throw new Error('Formation memory is missing its cue words.');
  const pool=new Set(memory.pool),fired=new Set();
  const observe=spike=>{if(pool.has(spike.neuronId))fired.add(spike.neuronId);};
  const controller=checkpoint?LockedController.restore(checkpoint,observe):new LockedController(memory.artifact,observe);
  if(!checkpoint)controller.advance(idleSeconds);
  else if(controller.time!==idleSeconds)throw new Error('Probe checkpoint has the wrong idle duration.');
  fired.clear();const bits=cueBits(cue,half,cues);
  for(const bit of bits)controller.io.pulse('f'+bit,controller.tick+1);
  controller.advance(1);
  const active=sorted(fired);
  return {cue,idleSeconds,...(half===null?{}:{half,bits}),active,...decode(active,memory.cores)};
}
function probeBattery(memory) {
  const probes={},halfProbes={};
  for(const seconds of [0,60]){
    // Native checkpoint/restore shares only pre-stimulus silence. Every probe
    // gets an independent validated controller, with no preceding cue history.
    const idle=new LockedController(memory.artifact);idle.advance(seconds);
    const checkpoint=idle.checkpoint();
    probes[seconds]=Object.keys(CUES).map(cue=>probeMemory(memory,cue,seconds,null,checkpoint));
    halfProbes[seconds]=Object.keys(CUES).flatMap(cue=>[0,1].map(half=>probeMemory(memory,cue,seconds,half,checkpoint)));
  }
  return {probes,halfProbes};
}
function probeAll(memory){return probeBattery(memory).probes;}
function completion(active,reference){return reference.length?active.filter(id=>reference.includes(id)).length/reference.length:null;}
function patternCompletion(cores,directSets,halfProbes,untrainedHalfProbes) {
  const references={A:cores.A,B:cores.B,C:directSets.C};
  const rows=Object.fromEntries([0,60].map(seconds=>[seconds,halfProbes[seconds].map(probe=>{
    const baseline=untrainedHalfProbes[seconds].find(item=>item.cue===probe.cue&&item.half===probe.half),reference=references[probe.cue];
    const trained=completion(probe.active,reference),untrained=completion(baseline.active,reference);
    return {cue:probe.cue,half:probe.half,bits:probe.bits,reference:probe.cue==='C'?'initial directSet(C)':'trained core '+probe.cue,
      referenceSize:reference.length,trained,untrained,gain:trained===null||untrained===null?null:trained-untrained,
      crossCompletion:probe.cue==='C'?Object.fromEntries(['A','B'].map(cue=>[cue,{trained:completion(probe.active,cores[cue]),untrained:completion(baseline.active,cores[cue])}])):null};
  })]));
  const tested=[...rows[0],...rows[60]].filter(row=>row.cue!=='C');
  return {references,rows,pass:tested.every(row=>row.trained!==null&&row.trained>=.8&&row.gain>=.25),
    soft:tested.every(row=>row.trained!==null&&row.trained>=.7&&row.gain>=.25),softRule:'Both halves at both delays: completion >= 0.7, with the same >= 0.25 gain requirement.'};
}
function recruitmentBreakdown(cores,directSets) {
  const result=Object.fromEntries(['A','B'].map(cue=>{
    const other=cue==='A'?'B':'A',cells=cores[cue].filter(id=>!directSets[cue].includes(id));
    const otherCueDirect=cells.filter(id=>directSets[other].includes(id)),neutral=cells.filter(id=>!directSets[other].includes(id));
    return [cue,{recruited:cells.length,cells,fraction:cores[cue].length?cells.length/cores[cue].length:0,
      otherCueDirect:{count:otherCueDirect.length,cells:otherCueDirect},neutral:{count:neutral.length,cells:neutral,fraction:cores[cue].length?neutral.length/cores[cue].length:0}}];
  }));
  const sharedRecruits=result.A.cells.filter(id=>result.B.cells.includes(id));
  const coreAInDirectB=cores.A.filter(id=>directSets.B.includes(id)),coreBInDirectA=cores.B.filter(id=>directSets.A.includes(id));
  return {...result,overlap:{sharedRecruits:{count:sharedRecruits.length,cells:sharedRecruits},
    coreAInDirectB:{count:coreAInDirectB.length,cells:coreAInDirectB},coreBInDirectA:{count:coreBInDirectA.length,cells:coreBInDirectA},
    sharedCores:cores.A.filter(id=>cores.B.includes(id)).length}};
}
function confusion(probes) {
  const labels=['A','B','reject'];
  return {rows:['A','B','C'],columns:labels,counts:probes.map(probe=>labels.map(label=>Number(probe.label===label)))};
}
function metrics({trials,cores,pool,positions,growthEdges,stats,probes,seed,directSets,halfProbes,untrainedHalfProbes,initialWeight=.4}) {
  const stable={A:stability(trials.A),B:stability(trials.B)};
  const specificity=jaccard(cores.A,cores.B);
  const spatial={A:compactness(cores.A,pool,positions,(seed^0x9cd031)>>>0),B:compactness(cores.B,pool,positions,(seed^0x9cd032)>>>0)};
  const density=growthEdges.length/(pool.length*(pool.length-1));
  const structure={A:recurrent(cores.A,growthEdges),B:recurrent(cores.B,growthEdges),liveGrowthPoolEdges:growthEdges.length,poolDensity:density,formed:stats.formed,pruned:stats.pruned};
  for(const cue of ['A','B']){const row=structure[cue],size=cores[cue].length;row.density=size>1?row.within/(size*(size-1)):0;row.densityRelativeToPool=density?row.density/density:null;row.pass=size>1&&row.within>=size&&row.density>=3*density;}
  const recruitment=recruitmentBreakdown(cores,directSets);
  const pattern=patternCompletion(cores,directSets,halfProbes,untrainedHalfProbes);
  const weights=potentiation(cores,growthEdges,initialWeight);
  const spilloverLimit=.25*Math.min(cores.A.length,cores.B.length);
  const negative=[0,60].map(seconds=>{
    const probe=probes[seconds].find(p=>p.cue==='C');
    return {idleSeconds:seconds,cells:probe.active.length,readback:decode(probe.active,cores).label,outsideDirectSet:probe.active.filter(id=>!directSets.C.includes(id)),spilloverLimit,
      spilloverFractionOfSmallerCore:Math.min(cores.A.length,cores.B.length)?probe.active.filter(id=>!directSets.C.includes(id)).length/Math.min(cores.A.length,cores.B.length):null,
      ...Object.fromEntries(['A','B'].map(cue=>[cue,{jaccard:jaccard(probe.active,cores[cue]),overlap:probe.active.filter(id=>cores[cue].includes(id)).length}]))};
  });
  const retention=Object.fromEntries(['A','B'].map(cue=>[cue,{at0:jaccard(probes[0].find(p=>p.cue===cue).active,cores[cue]),at60:jaccard(probes[60].find(p=>p.cue===cue).active,cores[cue])}]));
  const criteria={
    '1-stability':{pass:stable.A.soft&&stable.B.soft,rule:'Both last-ten-trial mean pairwise Jaccards >= 0.7; strict >= 0.8 reported separately.'},
    '2-specificity':{pass:specificity<=.2,rule:'Inter-core Jaccard <= 0.2; size is evaluated separately.'},
    '3-size':{pass:['A','B'].every(cue=>cores[cue].length>=5&&cores[cue].length<=.25*pool.length),rule:'Each core contains 5 to 0.25*P cells.'},
    '4-negative-cue':{pass:negative.every(row=>row.readback==='reject'&&row.outsideDirectSet.length<=spilloverLimit&&['A','B'].every(cue=>row[cue].jaccard<=.25)),rule:'At both idle durations: nearest-core readback rejects C (< 0.5), C-to-each-core Jaccard <= 0.25, and spillover outside directSet(C) <= 25% of the smaller core.'},
    '5-compactness':{pass:['A','B'].every(cue=>spatial[cue].valid&&spatial[cue].ratio<.8),gated:false,rule:'Observation: each core distance / matched random-subset distance < 0.8; not a Stage 1f gate.'},
    '6-recruitment':{pass:recruitment.A.neutral.fraction>=.3&&recruitment.B.neutral.fraction>=.3,gated:false,rule:'Observation: at least 30% of each core is outside both trained cues\' initial direct sets; not a Stage 1f gate.'},
    '7-recurrent-structure':{pass:structure.A.pass&&structure.B.pass,rule:'Each core has >= its size surviving growth-formed internal edges, and internal directed density >= 3 times the pool-wide directed density.'},
    '8-retention':{pass:retention.A.at60>=.8,rule:'Locked A probe after 60 seconds has Jaccard >= 0.8 with core A; B also reported.'},
    '9-pattern-completion':{pass:pattern.pass,rule:'For A and B, both fixed halves at both delays: completion >= 0.8 and improvement over the untrained circuit on the same core >= 0.25.'},
    '10-potentiation':{pass:weights.pass,rule:'Each core: median surviving within-core formed weight >= 0.6. Ignition fraction is reported, not gated.'}
  };
  for(const criterion of Object.values(criteria)){criterion.gated??=true;criterion.status=criterion.pass?'PASS':'FAIL';}
  const directAgreement={trials:Object.fromEntries(['A','B'].map(cue=>[cue,trials[cue].map(active=>jaccard(active,directSets[cue]))])),probes:Object.fromEntries([0,60].map(seconds=>[seconds,probes[seconds].map(probe=>({cue:probe.cue,jaccard:jaccard(probe.active,directSets[probe.cue]),exact:JSON.stringify(probe.active)===JSON.stringify(directSets[probe.cue])}))]))};
  const sharedDirect=directSets.A.filter(id=>directSets.B.includes(id));
  return {stability:stable,specificity,coreSizes:{A:cores.A.length,B:cores.B.length},negative,compactness:spatial,recruitment,recurrent:structure,retention,directAgreement,directOverlap:{AB:{count:sharedDirect.length,cells:sharedDirect}},
    directCInCores:Object.fromEntries(['A','B'].map(cue=>{const cells=directSets.C.filter(id=>cores[cue].includes(id));return [cue,{count:cells.length,cells}];})),
    patternCompletion:pattern,potentiation:weights,readback:{0:confusion(probes[0]),60:confusion(probes[60])},criteria,pass:Object.values(criteria).every(c=>!c.gated||c.pass)};
}

function radicalInverse(index,base) {
  let value=0,place=1/base;
  while(index){value+=(index%base)*place;index=Math.floor(index/base);place/=base;}
  return value;
}
function ballPoint(u,v,w,radius) {
  const z=2*v-1,ring=Math.sqrt(1-z*z),angle=2*Math.PI*w,r=radius*Math.cbrt(u);
  return {x:400+r*ring*Math.cos(angle),y:400+r*ring*Math.sin(angle),z:400+r*z};
}
// SpikeIO registers input stimuli, but the upstream field's inhibition endpoint
// getter otherwise recognizes only IDs 1 and 2 without its <=20-port legacy IO.
// Register the actual 192 host input identities for inhibition/homeostasis and
// controller export. This changes no pool dynamics, capacities, or snapshot data.
function registerInputs(field,ids) {
  const inputIds=new Set(ids);
  Object.defineProperty(field,'endpointIds',{get:()=>[...ids]});
  field.isInputCell=id=>inputIds.has(id);
}
function setup(values={},condition='primary',{inhibition,audit:auditEnabled=true}={}) {
  const opts=options(values),cueSelection=copy(CUE_SETS[opts.cues]),cues=cueSelection.words;
  if(condition!=='primary'&&!CONTROLS.includes(condition))throw new Error('Unknown condition: '+condition);
  const config={dimensions:3,extent:{x:800,y:800,z:800},maxCells:2000,pairingClock:opts.pairingClock,...DECAY_CONFIG[opts.decay]};
  for(const key of ['radius','initialWeight','maxSynapses','growthPeriod','inhibitionStrength','inhibitionRadiusFactor',
    'competitionMargin','exploration','hebbianRate','stdpWindow','maxWeight','weightDecay','unusedDecay','healthLoss','weightFloor','threshold','leakRate','refractory'])
    if(opts[key]!==undefined)config[key]=opts[key];
  const features={hebbian:condition!=='hebbian-off',lateralInhibition:inhibition??condition!=='inhibition-off',
    activityScaledInhibition:condition==='inhibition-off'||inhibition===false?false:opts.activityScaledInhibition,
    gradient:opts.secretion>0,reward:false,consolidation:false,homeostasis:opts.homeostasis};
  const formed=new Map(),active=new Set(),poolSet=new Set();let capture=false,weightAudit;
  const field=new SpikingField({empty:true,seed:opts.seed,config,features,onEvent:event=>{
    if(event.type==='formed')formed.set(event.synapse.id,copy(event.synapse));
    weightAudit?.observe(event);
    if(capture&&event.type==='spike'&&poolSet.has(event.spike.neuronId))active.add(event.spike.neuronId);
  }});
  const streams={placement:(opts.seed^0x41c64e6d)>>>0,projection:(opts.seed^0x9e3779b9)>>>0,shuffle:(opts.seed^0x85ebca6b)>>>0,jitter:(opts.seed^0x27d4eb2f)>>>0};
  const jitterRandom=random(streams.jitter),stimulusSchedule={A:[],B:[]};
  const placement=random(streams.placement),rotation=placement(),shifts=[placement(),placement(),placement()];
  const featureCells=Array.from({length:WORD_CODE.features},(_,i)=>{
    const cell=field.addNeuron(ballPoint(1,(i+.5)/WORD_CODE.features,(i/((1+Math.sqrt(5))/2)+rotation)%1,300));
    cell.radius=opts.featureRadius;
    if(!opts.featureGrowth)cell.nextGrowthAt=1e12;
    return cell;
  });
  const poolCells=Array.from({length:opts.pool},(_,i)=>{
    const coordinates=[2,3,5].map((base,axis)=>(radicalInverse(i+1,base)+shifts[axis])%1);
    const cell=field.addNeuron({...ballPoint(...coordinates,opts.poolRadius),recordOutput:false,secretionRate:opts.secretion});
    if(condition==='growth-off')cell.nextGrowthAt=1e12;
    poolSet.add(cell.id);return cell;
  });
  const projection=random(streams.projection),seedEdges=[];
  weightAudit=createWeightAudit(field,poolSet,{enabled:auditEnabled});
  for(const cell of poolCells)weightAudit.attach(cell);
  for(const source of featureCells)for(const target of sample(poolCells,opts.k,projection)){
    const edge=source.connect(target,field.time,opts.w0);
    if(!edge)throw new Error('Native connect() refused a seed edge. Check reach and capacity.');
    seedEdges.push({id:edge.id,sourceId:source.id,targetId:target.id,weight:edge.weight,delay:edge.delay});
  }
  if(condition==='shuffled'){
    const shuffled=sample(poolCells.map(({x,y,z})=>({x,y,z})),poolCells.length,random(streams.shuffle));
    poolCells.forEach((cell,i)=>Object.assign(cell,shuffled[i]));
  }
  registerInputs(field,featureCells.map(cell=>cell.id));
  const inputs=featureCells.map((cell,bit)=>({name:'f'+bit,cells:[cell.id]}));
  const session=new DevelopmentSession(field,{}, {inputs,outputs:[]});
  const hitThreshold=Math.ceil(field.config.threshold/opts.w0),directSets={},directHits={};
  for(const [cue,word] of Object.entries(cues)){
    const sources=new Set(encodeWord(word).map(bit=>featureCells[bit].id)),counts=new Map();
    for(const edge of seedEdges)if(sources.has(edge.sourceId))counts.set(edge.targetId,(counts.get(edge.targetId)??0)+1);
    directSets[cue]=sorted([...counts].filter(([,hits])=>hits>=hitThreshold).map(([id])=>id));
    directHits[cue]=[...counts].sort((a,b)=>a[0]-b[0]).map(([id,hits])=>({id,hits}));
  }
  return {opts,condition,cues,cueSelection,field,session,formed,seedEdges,directSets,directHits,hitThreshold,streams,stimulusSchedule,weightAudit,
    features:featureCells.map(cell=>cell.id),pool:poolCells.map(cell=>cell.id),
    positions:new Map(poolCells.map(({id,x,y,z})=>[id,{x,y,z}])),
    trial(cue){
      if(!['A','B'].includes(cue))throw new Error('Only A and B are formation cues.');
      weightAudit.setEpoch(Math.floor((stimulusSchedule.A.length+stimulusSchedule.B.length)/2)+1);
      active.clear();capture=true;
      const t0=field.tick+1,captureTicks=50+opts.jitter;
      const onsets=cueBits(cue,null,cues).map(bit=>{
        const draw=jitterRandom(),offset=Math.floor(draw*(opts.jitter+1)),tick=t0+offset;
        session.io.pulse('f'+bit,tick);return {bit,cellId:featureCells[bit].id,draw,offset,tick};
      });
      stimulusSchedule[cue].push({t0,captureTicks,onsets});
      for(let tick=0;tick<captureTicks;tick++)session.step();
      capture=false;const result=sorted(active);
      for(let tick=0;tick<Math.round(opts.gap/field.config.dt);tick++)session.step();
      return result;
    }};
}
function exportMemory(run,cores) {
  // Exercise the original strict snapshot validator, without rewriting it or its data.
  const field=SpikingField.fromSnapshot(run.field.snapshot());
  registerInputs(field,run.features);
  field.lockCircuit('NeuroSphere Stage 1d formation probe');
  return {schema:'neurosphere-formation/v2',cues:copy(run.cues),cueSelection:copy(run.cueSelection),volume:copy(LAYOUT),pool:[...run.pool],features:[...run.features],cores:copy(cores),
    artifact:compileController(field,{name:'NeuroSphere formation',io:run.session.io.config})};
}
// This predicate deliberately accepts only A/B completion data, never C or other gates.
function completionCriterion(epoch,halfCompletions) {
  if(!Number.isSafeInteger(epoch)||epoch<30||epoch>80||epoch%10!==0)return false;
  return [0,60].every(seconds=>{
    const rows=halfCompletions?.[seconds];
    return Array.isArray(rows)&&rows.length===4&&['A','B'].every(cue=>[0,1].every(half=>{
      const matches=rows.filter(row=>row.cue===cue&&row.half===half);
      return matches.length===1&&Number.isFinite(matches[0].completion)&&matches[0].completion>=.8&&matches[0].completion<=1;
    }));
  });
}
function checkpointCurve(run,trials,epoch,{withHalves=false}={}) {
  const cores={A:extractCore(trials.A),B:extractCore(trials.B)},memory=exportMemory(run,cores);
  const probes={A:probeMemory(memory,'A'),C:probeMemory(memory,'C')},smaller=Math.min(cores.A.length,cores.B.length);
  const spillover=probes.C.active.filter(id=>!run.directSets.C.includes(id));
  const halfProbes={},halfCompletions={};
  if(withHalves)for(const seconds of [0,60]){
    const idle=new LockedController(memory.artifact);idle.advance(seconds);
    const checkpoint=idle.checkpoint();
    halfProbes[seconds]=['A','B'].flatMap(cue=>[0,1].map(half=>probeMemory(memory,cue,seconds,half,checkpoint)));
    halfCompletions[seconds]=halfProbes[seconds].map(probe=>({cue:probe.cue,half:probe.half,completion:completion(probe.active,cores[probe.cue])}));
  }
  return {memory,row:{epoch,tick:run.field.tick,time:run.field.time,cores,coreSizes:{A:cores.A.length,B:cores.B.length},
    reference:'Contemporaneous cores: >=80% presence in the last ten trials at this checkpoint. Full A, synchronous, zero idle; not the half-cue gate.',
    ...(withHalves?{halfProbes,halfCompletions,completionCriterion:completionCriterion(epoch,halfCompletions)}:{}),
    probes,fullACompletion:completion(probes.A.active,cores.A),fullAJaccard:jaccard(probes.A.active,cores.A),
    spillover,spilloverCount:spillover.length,spilloverFraction:smaller?spillover.length/smaller:null,
    cJaccards:{A:jaccard(probes.C.active,cores.A),B:jaccard(probes.C.active,cores.B)},cReadback:probes.C.label,
    directCInCores:Object.fromEntries(['A','B'].map(cue=>[cue,run.directSets.C.filter(id=>cores[cue].includes(id)).length]))}};
}
function runCondition(values={},condition='primary',overrides={}) {
  const run=setup(values,condition,overrides),{opts}=run;
  const trainToCriterion=overrides.trainToCriterion===true;
  if(trainToCriterion&&(condition!=='primary'||opts.epochs<30||opts.epochs>80||opts.epochs%10||overrides.checkpoints===false||overrides.trainingEpochs!==undefined))
    throw new Error('Train-to-criterion needs a primary, checkpoints, and a 30..80 epoch ceiling divisible by ten.');
  const requestedEpochs=overrides.trainingEpochs??opts.epochs;
  if(!Number.isSafeInteger(requestedEpochs)||requestedEpochs<0||requestedEpochs>opts.epochs)throw new Error('Invalid matched training duration.');
  const untrainedMemory=exportMemory(run,{A:[],B:[]}),initialProbes=probeBattery(untrainedMemory);
  const trials={A:[],B:[]},checkpoints=[],checkpointMemories=[],epochs=condition==='untrained'?0:requestedEpochs;
  let stopped=null,stopping=null;
  for(let epoch=0;epoch<epochs;epoch++){
    for(const cue of ['A','B'])trials[cue].push(run.trial(cue));
    run.weightAudit.endEpoch(epoch+1);
    if(overrides.checkpoints!==false&&(epoch+1)%10===0){
      const checkpoint=checkpointCurve(run,trials,epoch+1,{withHalves:trainToCriterion||overrides.halfCheckpoints===true});checkpoints.push(checkpoint.row);
      if(condition==='primary')checkpointMemories.push({epoch:epoch+1,memory:checkpoint.memory});
      const reached=trainToCriterion&&completionCriterion(epoch+1,checkpoint.row.halfCompletions);
      if(trainToCriterion&&!stopped&&(reached||epoch+1===epochs)){
        // Freeze the assessment now, before any later training. No C statistic enters the decision.
        stopped=copy(assessCondition(run,trials,initialProbes,{checkpoints,checkpointMemories,untrainedMemory}));
        stopping={epoch:epoch+1,reached,maximumEpochs:epochs,minimumEpochs:30,checkpointEvery:10,threshold:.8,
          reason:reached?'First qualifying A/B half-cue checkpoint.':'Maximum reached without qualifying.',
          consulted:['A even','A odd','B even','B odd'],idleSeconds:[0,60],halfCompletions:copy(checkpoint.row.halfCompletions),
          cConsulted:false,otherGatesConsulted:false};
      }
    }
  }
  const final=assessCondition(run,trials,initialProbes,{checkpoints,checkpointMemories,untrainedMemory});
  if(!trainToCriterion)return final;
  if(!stopped)throw new Error('Missing stopping checkpoint.');
  stopped.summary.stopping=stopping;
  // Continuation is evidence only; acceptance and memory.json remain at the first stop.
  stopped.continuation={summary:final.summary,trials:final.trials,memory:final.memory};
  stopped.checkpointMemories=checkpointMemories;
  return stopped;
}
function assessCondition(run,trials,initialProbes,{checkpoints=[],checkpointMemories=[],untrainedMemory}={}) {
  const {field,pool,positions,directSets,opts,condition}=run,epochs=trials.A.length;
  const cores={A:extractCore(trials.A),B:extractCore(trials.B)},poolSet=new Set(pool),featureSet=new Set(run.features);
  const weightAudit=run.weightAudit.finish();
  const structuralAudit=summarizeAudit(weightAudit,{cores,pool,stimulusSchedule:run.stimulusSchedule,seedEdges:run.seedEdges,config:field.config,gap:opts.gap,captureTicks:50+opts.jitter});
  const liveEdges=field.links.filter(edge=>edge.active&&edge.target.alive);
  const formedEdges=liveEdges.filter(edge=>run.formed.has(edge.id)&&poolSet.has(edge.sourceId)&&poolSet.has(edge.targetId));
  const changedAfferents=liveEdges.filter(edge=>featureSet.has(edge.sourceId)&&poolSet.has(edge.targetId)&&edge.weight!==opts.w0);
  const afferentChanges=changedAfferents.map(({id,weight})=>({id,weight}));
  let beforeAblation=null,intervenedEdges=[];
  if(condition==='prune-formed'){
    beforeAblation=probeBattery(exportMemory(run,cores));
    const targets=formedEdges;
    intervenedEdges=targets.map(({id,sourceId,targetId,weight})=>({id,sourceId,targetId,weight}));
    for(const edge of targets){
      edge.prune();const source=field.getNeuron(edge.sourceId);source.synapses=source.synapses.filter(item=>item!==edge);
    }
  }
  const growthEdges=formedEdges.filter(edge=>edge.active).map(({id,sourceId,targetId,weight})=>({id,sourceId,targetId,weight}));
  const memory=condition==='untrained'?untrainedMemory:exportMemory(run,cores);
  const battery=condition==='untrained'?initialProbes:probeBattery(memory),{probes,halfProbes}=battery,stats=copy(field.stats);
  const result=metrics({trials,cores,pool,positions,growthEdges,stats,probes,seed:opts.seed,directSets,
    halfProbes,untrainedHalfProbes:initialProbes.halfProbes,initialWeight:opts.initialWeight});
  const effective={config:copy(field.config),features:copy(field.features),featureRadius:opts.featureRadius,
    featureGrowth:opts.featureGrowth,poolGrowth:condition!=='growth-off',rngStreams:run.streams,
    placement:'Shifted Halton (bases 2,3,5) mapped uniformly by volume into a ball; Fibonacci feature shell.',
    inputEndpoints:[...run.features],seedEdgeCount:run.seedEdges.length,seedWeight:opts.w0,k:opts.k,epochs,
    gap:opts.gap,gapTicks:Math.round(opts.gap/field.config.dt),secretion:opts.secretion,secretionPopulation:'All pool cells, constant native secretion; feature cells secrete zero.',
    jitter:opts.jitter,captureTicks:50+opts.jitter,jitterRule:'Per feature per trial: floor(draw*(J+1)), dedicated seeded LCG, including recorded draws when J=0. Probes are synchronous.',
    inputRegistration:'All SpikeIO feature IDs are field/controller endpoints; no pool endpoints.',
    decayMode:opts.decay,cueMode:opts.cues,shuffledCoordinates:condition==='shuffled',shuffledSeedDelays:'Original seeded delays retained.'};
  const firstTrial=Object.fromEntries(['A','B'].map(cue=>[cue,{active:trials[cue][0]?.length??null,
    fraction:trials[cue].length?trials[cue][0].length/pool.length:null,directFraction:directSets[cue].length/pool.length}]));
  const baseline=condition==='untrained'?{noFormationCores:cores.A.length===0&&cores.B.length===0,
    recruitment:0,formed:stats.formed,probes:Object.fromEntries([0,60].map(seconds=>[seconds,probes[seconds].map(probe=>({
      cue:probe.cue,active:probe.active.length,direct:directSets[probe.cue].length,
      subset:probe.active.every(id=>directSets[probe.cue].includes(id)),
      exact:JSON.stringify(probe.active)===JSON.stringify(directSets[probe.cue]),
      compactness:compactness(probe.active,pool,positions,(opts.seed^0x1b873593)>>>0)
    }))]))}:null;
  const beforeCompletion=beforeAblation?patternCompletion(cores,directSets,beforeAblation.halfProbes,initialProbes.halfProbes):null;
  const ablation=beforeAblation?{target:'growth-formed pool-to-pool',
    mode:'prune',edgeCount:intervenedEdges.length,edgesBefore:intervenedEdges,
    beforeProbes:beforeAblation.probes,beforeHalfProbes:beforeAblation.halfProbes,beforeCompletion,
    completionDrop:Object.fromEntries([0,60].map(seconds=>[seconds,result.patternCompletion.rows[seconds].map((row,i)=>({cue:row.cue,half:row.half,
      before:beforeCompletion.rows[seconds][i].trained,after:row.trained,
      pass:row.trained!==null&&row.trained<.6&&row.trained<beforeCompletion.rows[seconds][i].trained}))])),
    response:Object.fromEntries([0,60].map(seconds=>[seconds,probes[seconds].map((probe,i)=>{
      const prior=beforeAblation.probes[seconds][i],direct=directSets[probe.cue];
      const beforeRecruits=prior.active.filter(id=>!direct.includes(id)),afterRecruits=probe.active.filter(id=>!direct.includes(id));
      return {cue:probe.cue,jaccardBeforeAfter:jaccard(probe.active,prior.active),exactBeforeAfter:JSON.stringify(probe.active)===JSON.stringify(prior.active),
        recruitedBefore:beforeRecruits,recruitedAfter:afterRecruits,
        directBefore:prior.active.filter(id=>direct.includes(id)),directAfter:probe.active.filter(id=>direct.includes(id))};
    })]))}:null;
  return {summary:{condition,seed:opts.seed,options:copy(opts),effective,simulationSeconds:field.time,stats,firstTrial,
    pool:{initial:pool.length,alive:field.neurons.filter(cell=>poolSet.has(cell.id)).length},
    directSets,cores,seedEdgesSurviving:liveEdges.filter(edge=>run.seedEdges.some(seed=>seed.id===edge.id)).length,
    changedAfferents:afferentChanges.length,growthPoolEdgesEver:[...run.formed.values()].filter(edge=>poolSet.has(edge.sourceId)&&poolSet.has(edge.targetId)).length,
    probes,halfProbes,untrainedHalfProbes:initialProbes.halfProbes,baseline,ablation,structuralAudit,checkpoints,...result},
    trials:{...trials,stimulusSchedule:run.stimulusSchedule,cores,directSets,directHits:run.directHits,hitThreshold:run.hitThreshold,seedEdges:run.seedEdges,growthEdges,weightAudit,checkpoints},memory,checkpointMemories};
}
function evaluateSuite(primary,controls,values={}) {
  const opts=options(values),config=primary.effective?.config;
  const growthOffDiscriminates=['9-pattern-completion','10-potentiation'].every(key=>!controls['growth-off'].criteria[key].pass);
  const hebbianOffDiscriminates=['9-pattern-completion','10-potentiation'].every(key=>!controls['hebbian-off'].criteria[key].pass);
  const ablation=controls['prune-formed'].ablation;
  const formedAblationDiscriminates=Boolean(ablation)&&[0,60].every(seconds=>['A','B'].every(cue=>[0,1].every(half=>{
    const rows=ablation.completionDrop[seconds].filter(row=>row.cue===cue&&row.half===half);
    return rows.length===1&&rows[0].after!==null&&rows[0].after<.6&&rows[0].before>rows[0].after;
  })));
  const failures=Object.entries(primary.criteria).filter(([,row])=>row.gated&&!row.pass).map(([name])=>name);
  if(!growthOffDiscriminates)failures.push('growth-off must fail criteria 9 and 10');
  if(!formedAblationDiscriminates)failures.push('prune-formed must lower every A/B half completion below 0.6');
  if(!hebbianOffDiscriminates)failures.push('hebbian-off must fail criteria 9 and 10');
  const axes=new Set(['seed','pool','inhibitionStrength','inhibitionRadiusFactor']);
  const primaryProtocol=Object.entries(DEFAULTS).every(([key,value])=>axes.has(key)||opts[key]===value)&&[500,1000].includes(opts.pool)&&[.5,1,2].includes(opts.inhibitionStrength)&&[.6,1].includes(opts.inhibitionRadiusFactor)&&config?.pairingClock==='arrival'&&config?.competitionMargin===1&&config?.exploration===.1&&
    ['weightDecay','unusedDecay','healthLoss'].every(key=>config?.[key]===0);
  if(!primaryProtocol)failures.push('diagnostic protocol: Stage 1f requires the fixed Stage 1e scaffold and declared inhibition/pool axes');
  return {growthOffDiscriminates,formedAblationDiscriminates,hebbianOffDiscriminates,primaryProtocol,pass:failures.length===0,failedCriteria:failures};
}
function runSuite(values={},progress=()=>{}) {
  const opts=options(values),results={};
  for(const condition of ['primary',...CONTROLS]){progress(condition);results[condition]=runCondition(opts,condition);}
  return assembleSuite(opts,results);
}
// Independent condition runs may be scheduled concurrently by an external host.
// Assembly and acceptance are identical to the sequential CLI's runSuite.
function assembleSuite(values,results) {
  const opts=options(values),cueSelection=copy(CUE_SETS[opts.cues]);
  for(const condition of ['primary',...CONTROLS]){
    if(results[condition]?.summary.condition!==condition||JSON.stringify(results[condition].summary.options)!==JSON.stringify(opts))throw new Error('Missing or mismatched condition: '+condition);
  }
  const primary=results.primary.summary,controls=Object.fromEntries(CONTROLS.map(name=>[name,results[name].summary]));
  const decision=evaluateSuite(primary,controls,opts);
  const summary={schema:'neurosphere-formation-report/v6',stage:'1f',seed:opts.seed,options:opts,cues:cueSelection.words,cueSelection,
    protocol:{activeTicks:50+opts.jitter,baseCaptureTicks:50,jitterTicks:opts.jitter,silentTicks:Math.round(opts.gap/.02),gapSeconds:opts.gap,coreWindow:10,coreOccurrence:.8,probeIdleSeconds:[0,60],
      probesSynchronous:true,probeCaptureTicks:50,
      halfCueBits:Object.fromEntries(LABELS.map(cue=>[cue,[cueBits(cue,0,cueSelection.words),cueBits(cue,1,cueSelection.words)]])),
      completionReference:'Same trained core for trained and untrained A/B; fixed directSet(C) for C. Both halves at both delays are required.',
      checkpoints:{everyEpochs:10,probes:['C','full A'],idleSeconds:0,reference:'Contemporaneous last-ten cores. Before final external pruning; no formation for the untrained control.'}},
    interpretation:'Unassigned-pool formation experiment. Summation through unpotentiated formed edges is not evidence of recurrent Hebbian learning; potentiation is now measured. Retention is locked, not ongoing plastic retention.',
    primary,controls,perSeedResults:[{seed:opts.seed,gap:opts.gap,pass:decision.pass,failedCriteria:decision.failedCriteria}],...decision};
  return {summary,trials:Object.fromEntries(Object.entries(results).map(([name,result])=>[name,result.trials])),
    memory:results.primary.memory,controlMemories:Object.fromEntries(CONTROLS.map(name=>[name,results[name].memory])),checkpointMemories:results.primary.checkpointMemories??[]};
}
function sweepOptions(values) {
  const opts=options(values),grid=[];
  if(opts.cues!=='disjoint'||opts.decay!=='off'||['weightDecay','unusedDecay','healthLoss'].some(key=>opts[key]!==undefined&&opts[key]!==0))
    throw new Error('Specificity sweeps require decay off and disjoint cues.');
  for(const inhibitionStrength of [.5,1,2])for(const initialWeight of [.4,.3])for(const mode of ['fixed','homeostasis','activity-scaled'])
    grid.push(options({...opts,inhibitionStrength,initialWeight,homeostasis:mode==='homeostasis',activityScaledInhibition:mode==='activity-scaled'}));
  return grid;
}
function diagnosticOptions(values={}) {
  const grid=[]; // Stage 1f's declared six cells, independent of historical CLI knobs.
  for(const inhibitionStrength of [.5,1,2])for(const inhibitionRadiusFactor of [.6,1])
    grid.push(options({seed:1,inhibitionStrength,inhibitionRadiusFactor}));
  return grid;
}
function combineRuns(runs,kind) {
  if(!['sweep','diagnostic'].includes(kind)||!runs.length)throw new Error('Invalid formation grid.');
  const run={summary:copy(runs[0].summary),trials:copy(runs[0].trials),memory:copy(runs[0].memory)};
  run.summary[kind]=runs.map((item,index)=>({index,options:item.summary.options,cues:item.summary.cues,cueSelection:item.summary.cueSelection,
    primary:item.summary.primary,controls:item.summary.controls,pass:item.summary.pass,failedCriteria:item.summary.failedCriteria}));
  run.trials[kind]=runs.map((item,index)=>({index,trials:copy(item.trials)}));
  run.memory[kind]=runs.map((item,index)=>({index,memory:copy(item.memory)}));
  run.controlMemories={[kind]:runs.map((item,index)=>({index,memories:copy(item.controlMemories)}))};
  run.checkpointMemories={[kind]:runs.map((item,index)=>({index,memories:copy(item.checkpointMemories)}))};
  run.summary.gridDecision={kind,cells:runs.length,allCellsPass:runs.every(item=>item.summary.pass),
    purpose:kind==='diagnostic'?'Predeclared seed-1 inhibition comparison; confirmation is required for Stage 1f GO.':'Historical specificity comparison; not Stage 1f confirmation.'};
  run.summary.pass=run.summary.gridDecision.allCellsPass;
  return run;
}
const json=value=>JSON.stringify(value,null,2)+'\n';
function writeRun(root,run,timing) {
  fs.mkdirSync(root,{recursive:true});let directory;
  const start=Date.parse(timing.timestamp);if(!Number.isFinite(start))throw new Error('Invalid output timestamp.');
  // Parallel configurations can start in the same millisecond with the same
  // seed. Reserve a directory atomically; never overwrite another run's files.
  for(let offset=0;offset<10000;offset++){
    const stamp=new Date(start+offset).toISOString().replace(/[:.]/g,'-');
    const candidate=path.join(root,stamp+'-'+run.summary.seed);
    try {fs.mkdirSync(candidate);directory=candidate;break;}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  if(!directory)throw new Error('Unable to reserve a unique output directory.');
  writeArtifacts(directory,run,timing);
  return directory;
}
function writeArtifacts(directory,run,timing) {
  fs.writeFileSync(path.join(directory,'summary.json'),json(run.summary));
  fs.writeFileSync(path.join(directory,'timing.json'),json(timing));
  fs.writeFileSync(path.join(directory,'trials.json'),json(run.trials));
  fs.writeFileSync(path.join(directory,'memory.json'),json(run.memory));
  if(run.controlMemories)fs.writeFileSync(path.join(directory,'controls.json'),json(run.controlMemories));
  if(run.checkpointMemories)fs.writeFileSync(path.join(directory,'checkpoints.json'),json(run.checkpointMemories));
  if(run.continuation)fs.writeFileSync(path.join(directory,'continuation.json'),json(run.continuation));
}
async function main(argv) {
  const args=parseArgs(argv);
  if(args.help){process.stdout.write('Usage: npm run demo:formation -- --study [--output directory]\nIndividual diagnostic suites: --seed 1 2 3 [--sweep | --diagnostic] [--output directory]\n'+
    'Numeric flags: '+Object.keys(BOUNDS).map(name=>'--'+name).join(' ')+'\n'+
    'Modes: --decay off|default --cues disjoint|shared --pairingClock arrival|emission. --jitter is an integer tick bound.\n'+
    '--study (also the no-argument default): Stage 1g train-to-criterion, baseline seeds 1/2/3 plus seed-1 inhibition 1.0/0.6 comparison; curves continue to 80.\n'+
    '--diagnostic: historical fixed-epoch Stage 1f inhibition grid, all controls. Individual/grid runs cannot declare Stage 1g GO.\n'+
    'Variants: --homeostasis --featureGrowth --activityScaledInhibition; --secretion 2 enables gradient. Prune-formed is always included. Defaults: '+JSON.stringify(DEFAULTS)+'\n');return 0;}
  const root=path.resolve(args.output??path.join(__dirname,'../outputs/formation'));let pass=true;
  if(args.study||argv.length===0){const result=await require('./formation-criterion.cjs').runStudy(root);process.stdout.write('Stage 1g: '+(result.summary.pass?'GO':'NO-GO')+'; Results: '+result.directory+'\n');return result.summary.pass?0:1;}
  for(const seed of args.seeds){
    const start=performance.now(),timestamp=new Date().toISOString(),opts={...args.options,seed};
    const grid=args.diagnostic?diagnosticOptions(opts):args.sweep?sweepOptions(opts):[opts],runs=[];
    for(let i=0;i<grid.length;i++)runs.push(runSuite(grid[i],condition=>process.stderr.write('seed '+seed+', cell '+(i+1)+'/'+grid.length+': '+condition+'\n')));
    const run=args.sweep||args.diagnostic?combineRuns(runs,args.sweep?'sweep':'diagnostic'):runs[0];
    const directory=writeRun(root,run,{timestamp,nodeVersion:process.version,wallTimeMs:performance.now()-start});
    for(let i=0;i<runs.length;i++){
      const report=runs[i].summary;pass=pass&&report.pass;
      process.stdout.write('seed '+seed+', cell '+(i+1)+': '+(report.pass?'PASS':'FAIL')+
        (report.failedCriteria.length?' ('+report.failedCriteria.join(', ')+')':'')+'\n');
    }
    process.stdout.write('Results: '+directory+'\n');
  }
  process.stdout.write('Stage 1g GO requires --study, all three baseline seeds and their matched-duration controls.\n');
  return 1;
}
module.exports={DEFAULTS,CUES,LEGACY_CUES,CONTROLS,DECAY_CONFIG,selectCues,options,parseArgs,random,sample,extractCore,stability,meanDistance,compactness,recurrent,weightDistribution,potentiation,decode,
  cueBits,completion,patternCompletion,recruitmentBreakdown,probeMemory,probeAll,probeBattery,metrics,setup,exportMemory,
  completionCriterion,checkpointCurve,runCondition,runSuite,assembleSuite,evaluateSuite,sweepOptions,diagnosticOptions,combineRuns,writeRun,writeArtifacts,json,main};
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write('Formation error: '+error.message+'\n');process.exitCode=2;});
