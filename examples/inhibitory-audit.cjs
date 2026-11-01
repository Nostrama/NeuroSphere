'use strict';
// Passive observers: native membrane integration, spike generation, and RNG are untouched.
const {distribution}=require('./formation-audit.cjs');
const sorted=ids=>[...new Set(ids)].sort((a,b)=>a-b);
function createObserver(run,{enabled=true}={}){
  const {field,pool,inhibitoryPool,seedEdges}=run,E=new Set(pool),I=new Set(inhibitoryPool),afferents=new Set(seedEdges.map(e=>e.id));
  let trial=null;
  for(const id of run.physicalPool){
    const cell=field.getNeuron(id),native=cell.step;
    if(!enabled)continue;
    Object.defineProperty(cell,'step',{configurable:true,value:function(dt,env){
      if(trial&&E.has(id)&&this.alive){
        const ledger=trial.cells.get(id),eligible=!env.inputClamped&&!env.assemblyClamped&&env.time>=this.refractoryUntil;
        const due=this.inbox.filter(m=>m.at<=env.time+1e-9);
        for(const m of due){
          if(afferents.has(m.synapseId))ledger.firstAfferent=Math.min(ledger.firstAfferent,m.at);
          if(m.synapticInhibition)ledger.firstInhibition=Math.min(ledger.firstInhibition,m.at);
          if(!eligible){if(m.synapticInhibition)ledger.discardedInhibition-=m.weight;continue;}
          const negative=m.synapticInhibition||m.inhibition;
          if(negative){ledger.inhibitoryCharge-=m.weight;ledger.firstIntegratedInhibition=Math.min(ledger.firstIntegratedInhibition,m.at);}
          else ledger.excitatoryCharge+=m.weight;
          ledger.recent.push({tick:field.tick,weight:m.weight});
        }
        ledger.recent=ledger.recent.filter(m=>m.tick>=field.tick-9);
      }
      return native.call(this,dt,env);
    }});
  }
  return {
    begin(cue){trial={cue,spikesI:[],proxy:[],cells:new Map(pool.map(id=>[id,{id,firstAfferent:Infinity,firstInhibition:Infinity,firstIntegratedInhibition:Infinity,
      excitatoryCharge:0,inhibitoryCharge:0,discardedInhibition:0,recent:[],fired:false}]))};},
    observe(event){if(!trial||event.type!=='spike')return;const {neuronId,time}=event.spike;
      if(I.has(neuronId))trial.spikesI.push({neuronId,time});
      if(E.has(neuronId)){
        const ledger=trial.cells.get(neuronId);ledger.fired=true;
        const recent=ledger.recent.filter(m=>m.tick>=field.tick-9);
        trial.proxy.push({neuronId,tick:field.tick,excitation:recent.filter(m=>m.weight>0).reduce((s,m)=>s+m.weight,0),
          inhibition:-recent.filter(m=>m.weight<0).reduce((s,m)=>s+m.weight,0),net:recent.reduce((s,m)=>s+m.weight,0)});
      }
    },
    end(){
      const {cue,spikesI,proxy}=trial,primed=new Set(run.primedSets[cue]),cells=[...trial.cells.values()].map(({recent,...c})=>({...c,
        firstAfferent:Number.isFinite(c.firstAfferent)?c.firstAfferent:null,firstInhibition:Number.isFinite(c.firstInhibition)?c.firstInhibition:null,
        firstIntegratedInhibition:Number.isFinite(c.firstIntegratedInhibition)?c.firstIntegratedInhibition:null}));
      const primedCells=cells.filter(c=>primed.has(c.id)),before=primedCells.filter(c=>c.firstAfferent!==null&&c.firstInhibition!==null&&c.firstInhibition<c.firstAfferent-1e-9),
        integratedBefore=primedCells.filter(c=>c.firstAfferent!==null&&c.firstIntegratedInhibition!==null&&c.firstIntegratedInhibition<c.firstAfferent-1e-9),fired=primedCells.filter(c=>c.fired);
      const result={inhibitoryCellsFiring:sorted(spikesI.map(s=>s.neuronId)),inhibitorySpikeCount:spikesI.length,inhibitorySpikes:spikesI,
        meanInhibitoryCharge:cells.reduce((s,c)=>s+c.inhibitoryCharge,0)/pool.length,primed:{count:primedCells.length,
          inhibitedBeforeAfferent:before.map(c=>c.id),inhibitedBeforeFraction:primedCells.length?before.length/primedCells.length:null,
          integratedBeforeAfferent:integratedBefore.map(c=>c.id),integratedBeforeFraction:primedCells.length?integratedBefore.length/primedCells.length:null,
          fired:fired.map(c=>c.id),firedFraction:primedCells.length?fired.length/primedCells.length:null},effectiveThresholdProxy:proxy,cells};
      trial=null;return result;
    }
  };
}
function edgeType(run,e){const I=new Set(run.inhibitoryPool);return (I.has(e.sourceId)?'I':'E')+'->'+(I.has(e.targetId)?'I':'E');}
function edgeReport(run,audit){
  const I=new Set(run.inhibitoryPool),physical=new Set(run.physicalPool),type=e=>(I.has(e.sourceId)?'I':'E')+'->'+(I.has(e.targetId)?'I':'E');
  const live=run.field.links.filter(e=>e.active&&physical.has(e.sourceId)&&physical.has(e.targetId));
  const byType=Object.fromEntries(['E->E','E->I','I->E','I->I'].map(key=>{const edges=live.filter(e=>type(e)===key);
    return [key,{count:edges.length,weights:distribution(edges.map(e=>e.weight)),signedWeights:distribution(edges.map(e=>(I.has(e.sourceId)?-1:1)*e.weight))}];}));
  const births=audit.epochs.map(row=>({epoch:row.epoch,...Object.fromEntries(Object.keys(byType).map(key=>[key,audit.lifecycles.filter(e=>e.birthEpoch===row.epoch&&type(e)===key).length]))}));
  const recruits=new Set([...run.trials.A.flat(),...run.trials.B.flat()]);
  const targetGroups={primed:run.pool.filter(id=>run.primedSets.A.includes(id)||run.primedSets.B.includes(id)),other:run.pool.filter(id=>!run.primedSets.A.includes(id)&&!run.primedSets.B.includes(id))};
  const targetWeights=Object.fromEntries(Object.entries(targetGroups).map(([name,ids])=>{const targets=new Set(ids),edges=live.filter(e=>I.has(e.sourceId)&&targets.has(e.targetId));return [name,{targetCount:ids.length,
    everFired:ids.filter(id=>recruits.has(id)).length,weights:distribution(edges.map(e=>e.weight)),edges:edges.map(e=>({id:e.id,targetId:e.targetId,weight:e.weight}))}];}));
  return {byType,birthsPerEpoch:births,inhibitoryToExcitatoryTargets:targetWeights};
}
module.exports={createObserver,edgeType,edgeReport};
