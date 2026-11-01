'use strict';
const {LockedController,loadVocabulary} = require('../src/index.cjs');
const {request,DOMAIN}=require('./readout-view.cjs');

// A fresh native locked controller per request. Observers read state and invoke
// the original methods; the scientific harness and engine are never edited.
function probe(memory,body) {
  const input=request(memory,body),{bits,idleSeconds}=input,trace=[],samples=[],pool=new Set(memory.pool);
  const runtime=new LockedController(memory.artifact);
  runtime.advance(idleSeconds);
  const controller=LockedController.restore(runtime.checkpoint(),spike=>trace.push({neuronId:spike.neuronId,time:spike.time-idleSeconds}));
  const t0=controller.tick+1,dt=controller.config.dt;
  const measures=Object.fromEntries(['A','B'].map(c=>[c,{...memory.outputs[c],arrivingWeight:0,integratedWeight:0,
    peakPotential:0,peakEffectiveThreshold:null,peakMargin:-Infinity,firstSpike:null,membrane:[]}]));
  for(const c of ['A','B']) {
    const cell=controller.getNeuron(memory.outputs[c].id),step=cell.step,fire=cell.fire,m=measures[c];
    Object.defineProperty(cell,'step',{value:function(delta,env){
      const due=this.inbox.filter(msg=>msg.at<=env.time+1e-9),charge=due.reduce((sum,msg)=>sum+msg.weight,0),refractory=env.time<this.refractoryUntil;
      m.arrivingWeight+=charge; let preview;
      if(!refractory){m.integratedWeight+=charge;preview=this.previewThreshold(delta,env.time);const margin=preview.potential-preview.threshold;
        if(margin>m.peakMargin){m.peakMargin=margin;m.peakPotential=preview.potential;m.peakEffectiveThreshold=preview.threshold;}}
      const result=step.call(this,delta,env);
      m.membrane.push({time:env.time-idleSeconds,value:preview?.potential??this.potential,threshold:preview?.threshold??this.firingThreshold,refractory});
      return result;
    }});
    Object.defineProperty(cell,'fire',{value:function(...args){if(!m.firstSpike)m.firstSpike={potential:this.potential,effectiveThreshold:this.firingThreshold,integratedWeight:m.integratedWeight};return fire.apply(this,args);}});
  }
  const capture=()=>samples.push({time:controller.time-idleSeconds,values:controller.neurons.filter(n=>Math.abs(n.potential-n.restLevel)>1e-6).map(n=>[n.id,n.potential])});
  for(const bit of bits)controller.io.pulse('f'+bit,t0);
  capture();for(let tick=0;tick<50;tick++){controller.step();capture();}
  const active=[...new Set(trace.filter(s=>pool.has(s.neuronId)).map(s=>s.neuronId))].sort((a,b)=>a-b),vocabulary=loadVocabulary();
  const outputs=Object.fromEntries(['A','B'].map(c=>{
    const m=measures[c],times=trace.filter(s=>s.neuronId===m.id).map(s=>s.time),core=memory.cores[c];
    return [c,{...m,word:vocabulary.get(m.conceptId).word,fired:times.length>0,spikeTimes:times,
      latencyTicks:times.map(t=>Math.round((t+idleSeconds)/dt)-t0),inputMargin:m.arrivingWeight-m.threshold,
      coreCellsFired:active.filter(id=>core.includes(id)).length,coreSize:core.length}];
  }));
  const matches=Object.values(outputs).filter(o=>o.fired),status=matches.length===1?'recalled':matches.length?'ambiguous':'unknown';
  return {kind:'readout',memoryId:'readout-'+memory.seed,seed:memory.seed,word:input.word,status,readoutStatus:matches.length===1?'decoded':matches.length?'ambiguous':'silent',
    response:matches.map(o=>o.word).join(' / '),mode:input.mode,idleSeconds,half:input.half,cue:input.cue,inputBits:bits,allBits:input.allBits,
    seconds:1,trace,samples,active,outputs,matches,recalled:matches,activated:Object.values(outputs),routedDomains:[DOMAIN],
    coreCellsFired:Object.fromEntries(['A','B'].map(c=>[c,outputs[c].coreCellsFired])),
    channel:'sense',input:{name:'Sense Input',features:bits.length,domains:1},output:{name:'Output',status,text:matches.map(o=>o.word).join(' / ')},
    codebook:memory.codebook,membraneSampling:'Output traces show native pre-reset potential at each nonrefractory step; other traces sample state after each step.'};
}
module.exports={probe};
