'use strict';
const {createHash}=require('node:crypto');
const {SpikingField}=require('./neuron/field.js');
const {LAYOUT}=require('./domain-layout.cjs');
const {applyDomainPolicy}=require('./domain-policy.cjs');
const SCHEMA='neurosphere-text-learning/v1';
const LIMITS=Object.freeze({lessons:16,questionTokens:8,responseTokens:8,characters:200,features:64,activeBits:8,rounds:32,slotTicks:12});
const END='\u0000end';
function tokenize(text){
  if(typeof text!=='string'||!text.trim()||text.length>LIMITS.characters)throw new Error('Use 1–200 characters.');
  const tokens=text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)??[];
  if(!tokens.length||tokens.length>LIMITS.questionTokens)throw new Error('Use 1–8 words.');
  return tokens;
}
function tokenBits(token){const found=new Set();for(let n=0;found.size<LIMITS.activeBits;n++){const bytes=createHash('sha256').update('neurosphere-token-v1:'+n+':'+token).digest();for(const value of bytes){found.add(value%LIMITS.features);if(found.size===LIMITS.activeBits)break;}}return [...found];}
function position(id){const fract=x=>x-Math.floor(x),r=350*Math.cbrt(fract(id*.7548776662)),y=1-2*fract(id*.569840291),a=2*Math.PI*fract(id*.438579);return{x:400+r*Math.sqrt(1-y*y)*Math.cos(a),y:400+r*y,z:400+r*Math.sqrt(1-y*y)*Math.sin(a)};}
function clearElectrical(field){
  for(const cell of field.neurons){cell.potential=cell.restLevel;cell.inbox=[];cell.charges=[];cell.lastTrigger=null;cell.adaptation=0;cell.refractoryUntil=field.time;cell.activity=0;for(const edge of cell.synapses)if(edge.pendingPreSpikes)edge.pendingPreSpikes=[];}
  field.inputSpikes=[];field.outputs=[];field.delivered.clear();field.spikeRecords.clear();field.metrics=[];field.events=[];field.firstDelivery=null;
}
class TextMemory {
  constructor(saved=null){
    if(saved){
      if(saved.schema!==SCHEMA||!Number.isInteger(saved.revision)||saved.revision<0||!Array.isArray(saved.nodes)||!Array.isArray(saved.lessons)||saved.lessons.length>LIMITS.lessons||saved.snapshot?.circuitLock)throw new Error('Invalid text checkpoint.');
      this.field=SpikingField.fromSnapshot(saved.snapshot);this.nodes=structuredClone(saved.nodes);this.lessons=structuredClone(saved.lessons);this.revision=saved.revision;
    }else{
      this.field=new SpikingField({empty:true,seed:17,config:{dimensions:3,extent:{...LAYOUT.extent},maxCells:2000,radius:800,maxSynapses:10,growthPeriod:10000,initialWeight:.02,weightFloor:.001,weightDecay:0,unusedDecay:0,healthLoss:0,refractory:.08,pairingClock:'arrival'},features:{hebbian:true,reward:false,gradient:false,consolidation:false}});
      this.nodes=[];this.lessons=[];this.revision=0;
    }
    this.meta=new Map(this.nodes.map(n=>[n.id,n]));this.membership=new Map(this.nodes.map(n=>[n.id,n.domainId]));this.inputIds=new Set();this.teachers=new Set();this.learningTargets=new Set();this.slot=-1;this.teaching=false;
    this.validate();applyDomainPolicy(this.field,this.membership);
    const prior=this.field.env.forNeuron.bind(this.field.env);
    this.field.env.forNeuron=(cell,frame)=>{
      const env=prior(cell,frame),meta=this.meta.get(cell.id);
      env.features={...env.features,hebbian:this.learningTargets.has(cell.id)};
      env.inputClamped=meta.role==='input'||(meta.role==='detector'&&meta.position!==this.slot)||this.teaching;
      if(meta.role==='input'){env.inputPulse=this.inputIds.has(cell.id);env.inputExempt=true;}
      if(this.teachers.has(cell.id))env.forcedSpike=true;
      return env;
    };
  }
  validate(){
    const ids=new Set(this.field.neurons.map(n=>n.id));
    if(this.nodes.length!==ids.size||this.meta.size!==ids.size||this.nodes.some(n=>!ids.has(n.id)||!/^00[1-9]$/.test(n.domainId)||!['input','detector','gate','output'].includes(n.role)))throw new Error('Invalid text neuron membership.');
    if(this.field.links.some(e=>this.membership.get(e.sourceId)!==this.membership.get(e.targetId)))throw new Error('Cross-domain text connection.');
    const config=this.field.config,features=this.field.features;
    if(config.dt!==.02||config.dimensions!==3||config.weightDecay!==0||config.unusedDecay!==0||config.healthLoss!==0||config.maxSynapses!==10||config.pairingClock!=='arrival'||!features.hebbian||features.gradient||features.reward||features.consolidation)throw new Error('Unsupported text learning configuration.');
    for(const node of this.field.neurons){if(![node.x,node.y,node.z].every(Number.isFinite)||Math.hypot(node.x-400,node.y-400,node.z-400)>400)throw new Error('Text neuron outside shared volume.');if(node.nextGrowthAt!==1e12)throw new Error('Autonomous text growth is not enabled.');}
    const lessonIds=new Set(),owned=new Set();
    for(const lesson of this.lessons){
      tokenize(lesson.question);tokenize(lesson.answer);
      if(lesson.id!=='phrase-'+(lessonIds.size+1)||!/^00[1-9]$/.test(lesson.domainId)||lessonIds.has(lesson.id)||!Array.isArray(lesson.detectors)||!Array.isArray(lesson.outputs)||lesson.detectors.length!==tokenize(lesson.question).length+1||lesson.outputs.length!==tokenize(lesson.answer).length+1)throw new Error('Invalid text lesson.');
      lessonIds.add(lesson.id);
      for(const [role,members]of [['gate',[lesson.gate]],['detector',lesson.detectors],['output',lesson.outputs]])for(const [index,id]of members.entries()){const node=this.meta.get(id);if(owned.has(id)||!node||node.role!==role||node.lessonId!==lesson.id||node.domainId!==lesson.domainId||(role!=='gate'&&node.position!==index))throw new Error('Invalid text assembly.');owned.add(id);}
      if(this.meta.get(lesson.outputs.at(-1)).token!==END||lesson.outputs.slice(0,-1).some(id=>this.meta.get(id).token===END))throw new Error('Invalid response terminator.');
    }
    for(const n of this.nodes){if(n.role==='input'&&(!Number.isInteger(n.bit)||n.bit<0||n.bit>=LIMITS.features))throw new Error('Invalid text feature.');if(n.role==='output'&&(typeof n.token!=='string'||(n.token!==END&&tokenize(n.token).length!==1)))throw new Error('Invalid response token.');}
    for(const lesson of this.lessons){const bank=this.nodes.filter(n=>n.lessonId===lesson.id&&n.role==='input');if(bank.length!==LIMITS.features||new Set(bank.map(n=>n.bit)).size!==LIMITS.features||bank.some(n=>n.domainId!==lesson.domainId))throw new Error('Invalid text feature bank.');for(const node of bank)owned.add(node.id);}
    if(owned.size!==ids.size)throw new Error('Unassigned text neuron.');
    for(const edge of this.field.links){const from=this.meta.get(edge.sourceId),to=this.meta.get(edge.targetId);if(from.lessonId!==to.lessonId||!['input/detector','detector/gate','gate/output'].includes(from.role+'/'+to.role))throw new Error('Unsupported text projection.');}
  }
  add(meta){const cell=this.field.addNeuron({...position(this.field.nextId),recordOutput:meta.role==='output'});cell.nextGrowthAt=1e12;const node={id:cell.id,...meta};this.nodes.push(node);this.meta.set(cell.id,node);this.membership.set(cell.id,node.domainId);return cell;}
  connect(source,target,weight=.02,delay=.04){
    if(this.membership.get(source.id)!==this.membership.get(target.id))throw new Error('Cross-domain projection refused.');
    const edge=source.connect(target,this.field.time,weight);if(!edge)throw new Error('Could not allocate text connection.');edge.delay=delay;return edge;
  }
  enroll(question,answer,domainId='005'){
    const q=tokenize(question),a=tokenize(answer);if(!/^00[1-9]$/.test(domainId))throw new Error('Choose a known domain.');
    if(this.lessons.length>=LIMITS.lessons)throw new Error('This experiment supports 16 phrase lessons.');
    if(this.lessons.some(l=>l.domainId===domainId&&tokenize(l.question).join(' ')===q.join(' ')))throw new Error('That question is already taught in this domain.');
    const id='phrase-'+(this.lessons.length+1);
    // A bank per lesson keeps every neuron within Neuron's ten-terminal limit.
    const bank=Array.from({length:LIMITS.features},(_,bit)=>this.add({role:'input',domainId,lessonId:id,bit}));
    const gate=this.add({role:'gate',domainId,lessonId:id});gate.threshold=q.length+1-.3;gate.leakRate=0;
    const detectors=[...q,END].map((_,index)=>{const cell=this.add({role:'detector',domainId,lessonId:id,position:index});cell.threshold=3.6;for(const input of bank)this.connect(input,cell);this.connect(cell,gate,1);return cell.id;});
    const outputs=[...a,END].map((token,index)=>{const cell=this.add({role:'output',domainId,lessonId:id,position:index,token});cell.threshold=.4;this.connect(gate,cell,.02,.12+index*.14);return cell.id;});
    const lesson={id,question:question.trim(),answer:answer.trim(),domainId,gate:gate.id,detectors,outputs};this.lessons.push(lesson);return lesson;
  }
  drive(token,domainId=null){const bits=new Set(tokenBits(token));this.inputIds=new Set(this.nodes.filter(n=>n.role==='input'&&(!domainId||n.domainId===domainId)&&bits.has(n.bit)).map(n=>n.id));}
  step(){this.field.step();this.inputIds.clear();this.teachers.clear();}
  teach(question,answer,domainId='005',onProgress=()=>{}){
    const lesson=this.enroll(question,answer,domainId),tokens=[...tokenize(question),END],field=this.field;
    this.teaching=true;this.learningTargets=new Set([...lesson.detectors,...lesson.outputs]);
    for(let round=0;round<LIMITS.rounds;round++){
      clearElectrical(field);
      for(let slot=0;slot<tokens.length;slot++){this.slot=slot;for(let tick=1;tick<=LIMITS.slotTicks;tick++){if(tick===1)this.drive(tokens[slot],domainId);if(tick===6)this.teachers.add(lesson.detectors[slot]);this.step();}}
      this.slot=-1;const outputTicks=12+(lesson.outputs.length-1)*7;
      for(let tick=1;tick<=outputTicks;tick++){if(tick===1)this.teachers.add(lesson.gate);lesson.outputs.forEach((id,index)=>{if(tick===10+index*7)this.teachers.add(id);});this.step();}
      onProgress({epoch:round+1,total:LIMITS.rounds});
    }
    this.teaching=false;this.learningTargets.clear();clearElectrical(field);this.revision++;this.validate();return lesson;
  }
  checkpoint(){const snapshot=this.field.snapshot();snapshot.endpointPlacement=this.field.assessEndpointPlacement();return{schema:SCHEMA,revision:this.revision,nodes:structuredClone(this.nodes),lessons:structuredClone(this.lessons),snapshot};}
  recall(text,{domainId=null,record=true}={}){
    const tokens=[...tokenize(text),END],runtime=new TextMemory(this.checkpoint()),field=runtime.field;
    if(domainId!==null&&!/^00[1-9]$/.test(domainId))throw new Error('Unknown domain.');
    clearElectrical(field);if(field.neurons.length)field.lockCircuit('Read-only phrase recall');const start=field.time,trace=[],samples=[];
    field.onEvent=event=>{if(event.type==='spike')trace.push({neuronId:event.spike.neuronId,time:Number((event.spike.time-start).toFixed(8))});};
    const capture=()=>{if(record)samples.push({time:Number((field.time-start).toFixed(8)),values:field.neurons.filter(n=>Math.abs(n.potential-n.restLevel)>1e-6).map(n=>[n.id,n.potential])});};capture();
    for(let slot=0;slot<tokens.length;slot++){runtime.slot=slot;for(let tick=1;tick<=LIMITS.slotTicks;tick++){if(tick===1)runtime.drive(tokens[slot],domainId);runtime.step();capture();}}
    runtime.slot=-1;
    for(let tick=0;tick<110;tick++){runtime.step();capture();}
    const fired=new Set(trace.map(e=>e.neuronId));
    const responses=[];
    for(const lesson of runtime.lessons){if(!fired.has(lesson.gate))continue;const events=trace.filter(e=>runtime.meta.get(e.neuronId)?.lessonId===lesson.id&&runtime.meta.get(e.neuronId)?.role==='output');const decoded=events.map(e=>({...e,...runtime.meta.get(e.neuronId)}));if(decoded.length!==lesson.outputs.length||decoded.some((n,i)=>n.position!==i)||decoded.at(-1)?.token!==END)continue;responses.push({conceptId:lesson.id,domainId:lesson.domainId,word:decoded.slice(0,-1).map(n=>n.token).join(' '),tokens:decoded.slice(0,-1).map(n=>({text:n.token,neuronId:n.id,time:n.time})),activeCells:lesson.outputs.length,assemblySize:lesson.outputs.length,gate:lesson.gate});}
    const status=responses.length===1?'recalled':responses.length>1?'ambiguous':'unknown';
    return{kind:'text',status,word:text,response:responses.length===1?responses[0].word:null,matches:responses,recalled:responses,activated:responses,trace:record?trace:[],samples,seconds:Number((field.time-start).toFixed(8)),routedDomains:[...new Set(runtime.nodes.filter(n=>!domainId||n.domainId===domainId).map(n=>n.domainId))],inputBits:tokens.flatMap(tokenBits),inputTokens:tokens.slice(0,-1),revision:this.revision};
  }
}
module.exports={TextMemory,tokenize,tokenBits,LIMITS,SCHEMA};
