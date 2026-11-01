'use strict';
// Stage 1e observers, with explicit import of live edge lifecycles at the phase boundary.
// These wrappers only measure native calls; they do not change arguments, config or RNG.
const {distribution,predictedPairings,binnedMeans,afferentSchedule}=require('./formation-audit.cjs');
function createAudit(field,pool,origin){
  const records=new Map(),epochs=[];let epoch=0;
  const empty=()=>({epoch,formed:0,pruned:0,potentiationEvents:0,potentiationGain:0,competitionEvents:0,competitionLoss:0,unexpectedGrowthChanges:0});
  let row=empty();
  function attachEdge(edge,prior=null){
    const record={id:edge.id,sourceId:edge.sourceId,targetId:edge.targetId,delay:edge.delay,
      inherited:!!prior,birthEpoch:prior?prior.birthEpoch-origin.epoch:epoch,birthTick:prior?.birthTick??field.tick,birthTime:prior?.birthTime??edge.createdAt,
      initialWeight:edge.weight,deathEpoch:null,deathTick:null,deathTime:null,potentiationEvents:0,potentiationGain:0,competitionEvents:0,competitionLoss:0,edge};
    records.set(edge.id,record);
    const native=edge.notePostSpike;
    Object.defineProperty(edge,'notePostSpike',{configurable:true,value:function(...args){
      const before=this.weight,result=native.apply(this,args),gain=this.weight-before;
      if(gain>0){record.potentiationEvents++;record.potentiationGain+=gain;row.potentiationEvents++;row.potentiationGain+=gain;}return result;
    }});
  }
  const prior=new Map(origin.audit.lifecycles.filter(e=>e.surviving).map(e=>[e.id,e]));
  for(const edge of field.links)if(edge.active&&pool.has(edge.sourceId)&&pool.has(edge.targetId)){
    if(!prior.has(edge.id))throw new Error('Unaccounted starting pool edge.');attachEdge(edge,prior.get(edge.id));
  }
  for(const cell of field.neurons.filter(cell=>pool.has(cell.id))){
    const native=cell.grow;
    Object.defineProperty(cell,'grow',{configurable:true,value:function(env){
      const inspect=!this.circuitLocked&&this.activity>=.2&&this.growthBudget>=1&&env.time>=this.nextGrowthAt&&this.synapses.length>=this.config.maxSynapses;
      const before=inspect?this.synapses.filter(e=>records.has(e.id)).map(e=>[e,e.weight]):[];
      const result=native.call(this,env);
      for(const [edge,weight] of before)if(edge.weight!==weight){
        if(Math.abs(edge.weight-weight+field.config.competitionCost)>1e-9){row.unexpectedGrowthChanges++;continue;}
        const record=records.get(edge.id),loss=weight-edge.weight;
        record.competitionEvents++;record.competitionLoss+=loss;row.competitionEvents++;row.competitionLoss+=loss;
      }return result;
    }});
  }
  return {
    observe(event){
      if(event.type==='formed'&&pool.has(event.synapse.sourceId)&&pool.has(event.synapse.targetId)){
        const edge=field.getNeuron(event.synapse.sourceId).synapses.find(e=>e.id===event.synapse.id);attachEdge(edge);row.formed++;
      }
      if(event.type==='pruned'&&records.has(event.synapseId)){
        const r=records.get(event.synapseId);if(r.deathTime!==null)throw new Error('Duplicate prune.');
        Object.assign(r,{deathEpoch:epoch,deathTick:field.tick,deathTime:field.time,finalWeight:r.edge.weight});delete r.edge;row.pruned++;
      }
    },
    setEpoch(n){if(n!==epochs.length+1)throw new Error('Audit epochs must be consecutive.');epoch=n;row=empty();},
    endEpoch(){epochs.push({...row,endTick:field.tick,endTime:field.time});},
    finish(){return {epochs:structuredClone(epochs),endTick:field.tick,endTime:field.time,lifecycles:[...records.values()].map(({edge,...r})=>{
      const finalWeight=edge?edge.weight:r.finalWeight;
      return {...r,finalWeight,surviving:r.deathTime===null,unobservedWeightChange:finalWeight-r.initialWeight-r.potentiationGain+r.competitionLoss};
    })};}
  };
}
function schedulesFor(trials,seedEdges,dt){
  // Combine the two pulses of a paired trial before finding earliest afferent arrivals.
  // Unpaired A and B remain separate trials, with their actual 10-second separation.
  const result=[];
  for(const trial of trials){
    const schedule={t0:trial.t0,onsets:trial.onsets};
    const cue=trial.cue==='B'?'B':'A';
    const rows=afferentSchedule({A:cue==='A'?[schedule]:[],B:cue==='B'?[schedule]:[]},seedEdges,dt);
    result.push({...rows[0],epoch:trial.epoch,kind:trial.cue});
  }return result;
}
function summarize(audit,origin,trials,config,classify){
  const schedules=schedulesFor(trials,origin.seedEdges,config.dt),epochSeconds=trials.length?((audit.endTime-origin.time)/(audit.epochs.length||1)):1;
  const edges=audit.lifecycles.map(e=>({...e,
    ageEpochs:((e.deathTime??audit.endTime)-Math.max(e.birthTime,origin.time))/epochSeconds,
    predicted:predictedPairings(e,schedules,{window:config.stdpWindow,clock:config.pairingClock})}));
  const live=edges.filter(e=>e.surviving),cross=classify(live,origin.refs);
  const groups={forward:cross.forward,reverse:cross.reverse,withinA:live.filter(e=>origin.refs.A.includes(e.sourceId)&&origin.refs.A.includes(e.targetId)),
    withinB:live.filter(e=>origin.refs.B.includes(e.sourceId)&&origin.refs.B.includes(e.targetId)),poolWide:live};
  const sums=Object.fromEntries(['formed','pruned','potentiationEvents','potentiationGain','competitionEvents','competitionLoss','unexpectedGrowthChanges'].map(key=>[key,audit.epochs.reduce((sum,e)=>sum+e[key],0)]));
  return {definition:'Association-phase events only. Inherited births retain their original absolute tick/time and a negative relative birth epoch. Age bins count time exposed to this phase, in this condition\'s epoch durations. Predictions are earliest continuous afferent arrivals plus native recurrent delays; not observed STDP, and omit inhibition/recurrent-driven spikes.',
    epochs:audit.epochs,totals:{...sums,inherited:edges.filter(e=>e.inherited).length,surviving:live.length,prunesPerEpoch:sums.pruned/(audit.epochs.length||1),
      maxAbsUnobservedWeightChange:Math.max(0,...edges.map(e=>Math.abs(e.unobservedWeightChange)))},
    lifetimes:{survivingPhaseAge:distribution(live.map(e=>e.ageEpochs)),prunedPhaseLifetime:distribution(edges.filter(e=>!e.surviving).map(e=>e.ageEpochs))},
    births:audit.epochs.map(row=>({epoch:row.epoch,forward:edges.filter(e=>!e.inherited&&e.birthEpoch===row.epoch&&classify([e],origin.refs).forward.length).length,
      reverse:edges.filter(e=>!e.inherited&&e.birthEpoch===row.epoch&&classify([e],origin.refs).reverse.length).length})),
    groups:Object.fromEntries(Object.entries(groups).map(([key,items])=>[key,{count:items.length,weights:distribution(items.map(e=>e.finalWeight)),
      ignitionCount:items.filter(e=>e.finalWeight>=1.02).length,ignitionFraction:items.length?items.filter(e=>e.finalWeight>=1.02).length/items.length:0,
      predictedPairings:distribution(items.filter(e=>e.predicted.modelledTrials).map(e=>e.predicted.qualifying)),
      byAge:binnedMeans(items,'age'),byPairings:binnedMeans(items,'pairings'),byAgeAndPairings:binnedMeans(items,'joint')}])) ,edges};
}
module.exports={createAudit,schedulesFor,summarize};
