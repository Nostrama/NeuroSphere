'use strict';
// Reuse Stage 1e native observers; resume the same ledger across the phase boundary.
const base=require('./formation-audit.cjs'),phase=require('./association-audit.cjs');
function resumeAudit(field,pool,saved,stopEpoch){
  const current=phase.createAudit(field,pool,{audit:saved,epoch:stopEpoch});
  let currentEpoch=stopEpoch;
  return {observe:current.observe,setEpoch:n=>{if(n!==currentEpoch){current.setEpoch(n-stopEpoch);currentEpoch=n;}},endEpoch:()=>current.endEpoch(),finish(){
    const next=current.finish(),prior=new Map(saved.lifecycles.map(e=>[e.id,e]));
    const updated=new Map(next.lifecycles.map(e=>[e.id,e]));
    const lifecycles=saved.lifecycles.map(old=>{
      const row=updated.get(old.id);if(!row)return structuredClone(old);
      const result={...old,deathEpoch:row.deathEpoch===null?null:row.deathEpoch+stopEpoch,deathTick:row.deathTick,deathTime:row.deathTime,
        finalWeight:row.finalWeight,surviving:row.surviving};
      for(const key of ['potentiationEvents','potentiationGain','competitionEvents','competitionLoss'])result[key]=old[key]+row[key];
      result.unobservedWeightChange=result.finalWeight-result.initialWeight-result.potentiationGain+result.competitionLoss;return result;
    });
    for(const row of next.lifecycles)if(!prior.has(row.id)){
      const {inherited,...record}=row;record.birthEpoch+=stopEpoch;if(record.deathEpoch!==null)record.deathEpoch+=stopEpoch;lifecycles.push(record);
    }
    return {enabled:true,endTime:next.endTime,endTick:next.endTick,epochs:[...structuredClone(saved.epochs),...next.epochs.map(e=>({...e,epoch:e.epoch+stopEpoch}))],lifecycles};
  }};
}
function afferentPredictions(rows,seedEdges,config){
  const bySource=new Map();for(const edge of seedEdges){if(!bySource.has(edge.sourceId))bySource.set(edge.sourceId,[]);bySource.get(edge.sourceId).push(edge);}
  return rows.map(row=>{
    const incoming=new Map();
    for(const onset of row.onsets)for(const cellId of onset.cellIds)for(const edge of bySource.get(cellId)||[]){
      if(!incoming.has(edge.targetId))incoming.set(edge.targetId,[]);
      incoming.get(edge.targetId).push({time:(onset.tick-row.t0)*config.dt+edge.delay,weight:edge.weight});
    }
    const arrivals=new Map();
    for(const [id,hits] of incoming){
      hits.sort((a,b)=>a.time-b.time);let potential=0,last=0;
      for(const hit of hits){potential=potential*Math.exp(-config.leakRate*(hit.time-last))+hit.weight;last=hit.time;
        if(potential>=config.threshold){arrivals.set(id,hit.time);break;}}
    }
    return {cue:row.cue,epoch:row.epoch,t0:row.t0*config.dt,arrivals};
  });
}
function summarize(audit,{cores,pool,rows,seedEdges,config,gap=10,jitter=8}){
  const schedules=afferentPredictions(rows,seedEdges,config),epochSeconds=2*((50+jitter)*config.dt+gap);
  const records=audit.lifecycles.map(e=>({...e,ageEpochs:((e.deathTime??audit.endTime)-e.birthTime)/epochSeconds,
    predicted:base.predictedPairings(e,schedules,{window:config.stdpWindow,clock:config.pairingClock})}));
  const live=records.filter(e=>e.surviving),dead=records.filter(e=>!e.surviving),A=new Set(cores.A),B=new Set(cores.B);
  const groups={withinA:live.filter(e=>A.has(e.sourceId)&&A.has(e.targetId)),withinB:live.filter(e=>B.has(e.sourceId)&&B.has(e.targetId)),
    betweenCores:live.filter(e=>A.has(e.sourceId)&&!B.has(e.sourceId)&&B.has(e.targetId)&&!A.has(e.targetId)||B.has(e.sourceId)&&!A.has(e.sourceId)&&A.has(e.targetId)&&!B.has(e.targetId)),poolWide:live};
  const sum=key=>audit.epochs.reduce((s,row)=>s+row[key],0);
  return {measurement:'Native Stage 1e positive-weight and competition observers; full formation history, before any external pruning.',
    prediction:'Continuous-time afferent-only first threshold crossing: sum stored seed weights with exp(-leakRate*dt) decay, threshold 1.02, then add the native recurrent delay. Inclusive lag 0..0.32 s, after edge birth. Unlike the old one-hit model, a lone afferent cannot predict a spike. Omits inhibition, youth/adaptation, tick rounding and recurrent firing; observed positive events remain separate.',
    epochSeconds,epochs:audit.epochs,totals:{formed:records.length,pruned:dead.length,surviving:live.length,
      potentiationEvents:sum('potentiationEvents'),potentiationGain:sum('potentiationGain'),competitionEvents:sum('competitionEvents'),competitionLoss:sum('competitionLoss'),
      unexpectedGrowthChanges:sum('unexpectedGrowthChanges'),prunesPerEpoch:audit.epochs.length?dead.length/audit.epochs.length:0,
      maxAbsUnobservedWeightChange:Math.max(0,...records.map(e=>Math.abs(e.unobservedWeightChange)))},
    lifetimes:{survivingAgeEpochs:base.distribution(live.map(e=>e.ageEpochs)),prunedLifetimeEpochs:base.distribution(dead.map(e=>e.ageEpochs))},
    fanIn:Object.fromEntries([['A',cores.A,groups.withinA],['B',cores.B,groups.withinB],['poolWide',pool,live]].map(([label,ids,edges])=>{
      const cells=ids.map(id=>({id,count:edges.filter(e=>e.targetId===id).length}));return [label,{...base.distribution(cells.map(e=>e.count)),cells}];})),
    groups:Object.fromEntries(Object.entries(groups).map(([name,edges])=>[name,{count:edges.length,weights:base.distribution(edges.map(e=>e.finalWeight)),
      capFraction:edges.length?edges.filter(e=>e.finalWeight>=.69).length/edges.length:0,
      predictedPairings:base.distribution(edges.filter(e=>e.predicted.modelledTrials).map(e=>e.predicted.qualifying)),
      byAge:base.binnedMeans(edges,'age'),byPairings:base.binnedMeans(edges,'pairings'),byAgeAndPairings:base.binnedMeans(edges,'joint')}])) ,edges:records};
}
module.exports={resumeAudit,afferentPredictions,summarize};
