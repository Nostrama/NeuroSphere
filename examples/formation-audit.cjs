'use strict';
// Host telemetry only. Native calls, arguments, return values, config and RNG
// are untouched. Non-enumerable observers never enter native snapshots.
function distribution(values){
  const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;
  const q=p=>{if(!n)return null;const x=(n-1)*p,i=Math.floor(x);return sorted[i]+(sorted[Math.ceil(x)]-sorted[i])*(x-i);};
  return {count:n,mean:n?sorted.reduce((a,b)=>a+b,0)/n:null,min:q(0),p25:q(.25),median:q(.5),p75:q(.75),max:q(1)};
}
function createWeightAudit(field,pool,{enabled=true}={}){
  const records=new Map(),epochs=[],pending=new Map();let epoch=0;
  const counters=()=>{
    if(!pending.has(epoch))pending.set(epoch,{epoch,formed:0,pruned:0,potentiationEvents:0,potentiationGain:0,competitionEvents:0,competitionLoss:0,unexpectedGrowthChanges:0});
    return pending.get(epoch);
  };
  function change(record,kind,before,after){
    const row=counters(),delta=after-before;
    if(kind==='potentiation'&&delta>0){record.potentiationEvents++;record.potentiationGain+=delta;row.potentiationEvents++;row.potentiationGain+=delta;}
    if(kind==='competition'&&delta!==0){
      if(Math.abs(delta+field.config.competitionCost)>1e-9){row.unexpectedGrowthChanges++;return;}
      record.competitionEvents++;record.competitionLoss-=delta;row.competitionEvents++;row.competitionLoss-=delta;
    }
  }
  function observe(event){
    if(event.type==='formed'&&pool.has(event.synapse.sourceId)&&pool.has(event.synapse.targetId)){
      const saved=event.synapse,edge=field.getNeuron(saved.sourceId).synapses.find(e=>e.id===saved.id);
      const record={id:edge.id,sourceId:edge.sourceId,targetId:edge.targetId,delay:edge.delay,birthEpoch:epoch,birthTick:field.tick,birthTime:edge.createdAt,
        initialWeight:edge.weight,deathEpoch:null,deathTick:null,deathTime:null,potentiationEvents:0,potentiationGain:0,competitionEvents:0,competitionLoss:0,edge};
      records.set(edge.id,record);counters().formed++;
      if(enabled){
        const native=edge.notePostSpike;
        Object.defineProperty(edge,'notePostSpike',{configurable:true,value:function(...args){
          const before=this.weight,result=native.apply(this,args);change(record,'potentiation',before,this.weight);return result;
        }});
      }
    }
    if(event.type==='pruned'&&records.has(event.synapseId)){
      const record=records.get(event.synapseId);
      if(record.deathTime!==null)throw new Error('Duplicate native pruning event: '+record.id);
      record.deathEpoch=epoch;record.deathTick=field.tick;record.deathTime=field.time;record.finalWeight=record.edge.weight;delete record.edge;counters().pruned++;
    }
  }
  function attach(cell){
    if(!enabled)return;
    const native=cell.grow;
    Object.defineProperty(cell,'grow',{configurable:true,value:function(env){
      // The guard only avoids an unnecessary census. The original method is
      // always called, and alone decides whether/how to grow or compete.
      const inspect=!this.circuitLocked&&this.activity>=.2&&this.growthBudget>=1&&env.time>=this.nextGrowthAt&&this.synapses.length>=this.config.maxSynapses;
      const before=inspect?this.synapses.filter(e=>records.has(e.id)).map(e=>[e,e.weight]):[];
      const result=native.call(this,env);
      for(const [edge,weight] of before)change(records.get(edge.id),'competition',weight,edge.weight);
      return result;
    }});
  }
  return {observe,attach,enabled,
    setEpoch(value){if(!Number.isSafeInteger(value)||value<1)throw new Error('Audit epochs are one-based.');epoch=value;},
    endEpoch(value){
      if(epoch!==value||epochs.length!==value-1)throw new Error('End each formation epoch once, in order.');
      const links=field.links.filter(e=>records.has(e.id)&&e.active&&e.target.alive),row={...counters(),endTick:field.tick,endTime:field.time,
        surviving:links.length,meanWeight:links.length?links.reduce((sum,e)=>sum+e.weight,0)/links.length:null};
      epochs.push(row);pending.delete(epoch);return row;
    },
    finish(){
      return {enabled,epochs:structuredClone(epochs),endTime:field.time,endTick:field.tick,
        lifecycles:[...records.values()].map(record=>{
          const {edge,...saved}=record,finalWeight=edge?edge.weight:record.finalWeight;
          return {...saved,finalWeight,surviving:record.deathTime===null,
            unobservedWeightChange:finalWeight-record.initialWeight-record.potentiationGain+record.competitionLoss};
        })};
    }};
}
// A continuous-time, afferent-only prediction, not an observed STDP event.
// Retains actual stored afferent/recurrent delays, including shuffled geometry.
function afferentSchedule(stimulusSchedule,seedEdges,dt){
  const bySource=new Map();for(const edge of seedEdges){if(!bySource.has(edge.sourceId))bySource.set(edge.sourceId,[]);bySource.get(edge.sourceId).push(edge);}
  return ['A','B'].flatMap(cue=>stimulusSchedule[cue].map((schedule,index)=>{
    const arrivals=new Map();
    for(const onset of schedule.onsets)for(const edge of bySource.get(onset.cellId)??[]){
      const time=(onset.tick-schedule.t0)*dt+edge.delay;
      arrivals.set(edge.targetId,Math.min(arrivals.get(edge.targetId)??Infinity,time));
    }
    return {cue,epoch:index+1,t0:schedule.t0*dt,arrivals};
  })).sort((a,b)=>a.t0-b.t0);
}
function predictedPairings(edge,schedules,{window=.32,clock='arrival',sinceBirth=true}={}){
  const result={qualifying:0,modelledTrials:0,unmodelledTrials:0,byCue:{A:0,B:0},modelledByCue:{A:0,B:0}};
  for(const trial of schedules){
    const source=trial.arrivals.get(edge.sourceId),target=trial.arrivals.get(edge.targetId);
    if(sinceBirth&&trial.t0+(source??0)<=edge.birthTime+1e-9)continue;
    if(edge.deathTime!==null&&edge.deathTime!==undefined&&trial.t0+(target??0)>edge.deathTime+1e-9)continue;
    if(source===undefined||target===undefined){result.unmodelledTrials++;continue;}
    result.modelledTrials++;result.modelledByCue[trial.cue]++;
    const lag=target-source-(clock==='arrival'?edge.delay:0);
    if(lag>=-1e-9&&lag<=window+1e-9){result.qualifying++;result.byCue[trial.cue]++;}
  }
  return result;
}
const AGE_BINS=[0,10,20,40,60,80,120,Infinity],PAIRING_BINS=[0,1,5,10,20,40,60,80,120,Infinity];
function bin(value,bounds){const i=bounds.findIndex((lower,i)=>value>=lower&&value<(bounds[i+1]??Infinity));return i<0?'unmodelled':bounds[i]+'..'+(Number.isFinite(bounds[i+1])?bounds[i+1]:'inf');}
function binnedMeans(edges,kind){
  const groups=new Map();
  for(const edge of edges){
    const age=bin(edge.ageEpochs,AGE_BINS),pairs=edge.predicted.modelledTrials?bin(edge.predicted.qualifying,PAIRING_BINS):'unmodelled';
    const key=kind==='age'?age:kind==='pairings'?pairs:age+' / '+pairs;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(edge);
  }
  return [...groups].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([range,items])=>{
    const mean=fn=>items.reduce((sum,e)=>sum+fn(e),0)/items.length;
    return {range,count:items.length,meanWeight:mean(e=>e.finalWeight),meanAgeEpochs:mean(e=>e.ageEpochs),
      meanPredictedPairings:items.every(e=>e.predicted.modelledTrials)?mean(e=>e.predicted.qualifying):null,
      meanActualPotentiationEvents:mean(e=>e.potentiationEvents),meanCompetitionEvents:mean(e=>e.competitionEvents),
      ignitionFraction:mean(e=>Number(e.finalWeight>=1.02))};
  });
}
function summarizeAudit(audit,{cores,pool,stimulusSchedule,seedEdges,config,gap=10,captureTicks=50}){
  const epochSeconds=(stimulusSchedule.A[0]?.captureTicks??captureTicks)*config.dt*2+gap*2;
  const schedules=afferentSchedule(stimulusSchedule,seedEdges,config.dt),a=new Set(cores.A),b=new Set(cores.B);
  for(const edge of audit.lifecycles){
    edge.ageEpochs=((edge.deathTime??audit.endTime)-edge.birthTime)/epochSeconds;
    if(edge.surviving)edge.predicted=predictedPairings(edge,schedules,{window:config.stdpWindow,clock:config.pairingClock});
  }
  const survivors=audit.lifecycles.filter(e=>e.surviving),dead=audit.lifecycles.filter(e=>!e.surviving);
  const subsets={withinA:survivors.filter(e=>a.has(e.sourceId)&&a.has(e.targetId)),withinB:survivors.filter(e=>b.has(e.sourceId)&&b.has(e.targetId)),
    betweenCores:survivors.filter(e=>a.has(e.sourceId)&&!b.has(e.sourceId)&&b.has(e.targetId)&&!a.has(e.targetId)||b.has(e.sourceId)&&!a.has(e.sourceId)&&a.has(e.targetId)&&!b.has(e.targetId)),poolWide:survivors};
  const fanIn=Object.fromEntries([['A',cores.A,subsets.withinA],['B',cores.B,subsets.withinB],['poolWide',pool,survivors]].map(([name,ids,edges])=>{
    const counts=ids.map(id=>({id,count:edges.filter(e=>e.targetId===id).length}));return [name,{...distribution(counts.map(r=>r.count)),cells:counts}];
  }));
  const sum=key=>audit.epochs.reduce((n,row)=>n+row[key],0);
  return {measurement:'Formation before external pruning. Exact positive native notePostSpike changes and native grow competition losses; epoch-end field.links census.',
    observerEnabled:audit.enabled,epochSeconds,epochs:audit.epochs,totals:{formed:audit.lifecycles.length,pruned:dead.length,surviving:survivors.length,
      potentiationEvents:sum('potentiationEvents'),potentiationGain:sum('potentiationGain'),competitionEvents:sum('competitionEvents'),competitionLoss:sum('competitionLoss'),
      unexpectedGrowthChanges:sum('unexpectedGrowthChanges'),prunesPerEpoch:audit.epochs.length?dead.length/audit.epochs.length:0,
      erosionToPotentiationRatio:sum('potentiationGain')?sum('competitionLoss')/sum('potentiationGain'):null,
      maxAbsUnobservedWeightChange:audit.lifecycles.reduce((max,e)=>Math.max(max,Math.abs(e.unobservedWeightChange)),0)},
    lifetimeDefinition:'Elapsed simulated time since formation divided by one A+B epoch duration. Surviving ages are right-censored, not completed lifetimes.',
    lifetimes:{survivingAgeEpochs:distribution(survivors.map(e=>e.ageEpochs)),prunedLifetimeEpochs:distribution(dead.map(e=>e.ageEpochs)),observedLifetimeEpochs:distribution(audit.lifecycles.map(e=>e.ageEpochs))},
    prediction:'Earliest continuous-time seed arrival per endpoint, plus the actual recurrent delay (arrival clock); inclusive lag 0..stdpWindow with 1e-9 s numerical tolerance. Source emission must be after edge birth. Does not model inhibition, tick rounding, refractoriness or recurrent firing. Only A/B trials with both afferent arrivals are modelled; other trials are counted separately.',
    fanIn,weights:Object.fromEntries(Object.entries(subsets).map(([key,edges])=>[key,{count:edges.length,byAge:binnedMeans(edges,'age'),byPredictedPairings:binnedMeans(edges,'pairings'),byAgeAndPredictedPairings:binnedMeans(edges,'joint'),
      predictedPairings:distribution(edges.filter(e=>e.predicted.modelledTrials).map(e=>e.predicted.qualifying)),unmodelledEdges:edges.filter(e=>!e.predicted.modelledTrials).length}]))};
}
module.exports={createWeightAudit,distribution,afferentSchedule,predictedPairings,binnedMeans,summarizeAudit};
