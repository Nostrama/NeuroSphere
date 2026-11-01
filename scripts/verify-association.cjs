'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),study=process.argv[2],id=process.argv[3];
const {LockedController}=require(path.join(root,'src/index.cjs')),{encodeWord}=require(path.join(root,'src/vocabulary.cjs'));
const read=(...p)=>JSON.parse(fs.readFileSync(path.join(...p))),same=(x,y,label)=>assert.equal(JSON.stringify(x),JSON.stringify(y),label);
const json=x=>JSON.stringify(x,null,2)+'\n',hash=x=>crypto.createHash('sha256').update(json(x)).digest('hex');
const intersect=(a,b)=>a.filter(x=>b.includes(x)),completion=(a,b)=>intersect(a,b).length/b.length;
const jac=(a,b)=>{const n=new Set([...a,...b]).size;return n?intersect(a,b).length/n:1;};
const dir=path.join(study,'cases',id),summary=read(dir,'summary.json'),checkpoints=read(dir,'checkpoints.json'),trials=read(dir,'trials.json'),controls=read(dir,'controls.json'),memory=read(dir,'memory.json'),continued=read(dir,'continuation.json');
const origin=read(study,'origins','seed-'+summary.seed+'.json'),refs=origin.refs,cache=new Map();
const oldDir=path.join(root,'outputs/formation/2026-10-31T23-05-24-523Z-stage1g/cases/baseline-'+summary.seed);
same(origin.memory,read(oldDir,'memory.json'),'origin full memory');assert.equal(hash(origin.memory),origin.identity.memorySHA256);same(refs,origin.memory.cores,'refs');
assert.equal(hash(refs),origin.identity.coresSHA256);assert.equal(Boolean(origin.checkpoint.snapshot.circuitLock),false);
const oldTrials=read(oldDir,'trials.json').primary;
assert.equal(hash(oldTrials.growthEdges),origin.identity.formedEdgesSHA256);
same(origin.formationSchedule,oldTrials.stimulusSchedule);for(const cue of ['A','B'])same(origin.formationTrials[cue],oldTrials[cue]);
function replay(m,expected){
  assert.equal(m.schema,'neurosphere-association/v1');same(m.refs,refs,'immutable refs');const key=hash(m);
  if(cache.has(key)){same(expected,cache.get(key),'same circuit metrics');return;}
  for(const seconds of [0,60]){
    const idle=new LockedController(m.artifact);idle.advance(seconds);const cp=idle.checkpoint(),pool=new Set(m.pool);
    for(const [cue,half] of [['A',null],['B',null],['C',null],['A',0],['A',1],['B',0],['B',1]]){
      const fired=new Set(),controller=LockedController.restore(cp,spike=>{if(pool.has(spike.neuronId))fired.add(spike.neuronId);});
      const bits=[...encodeWord(m.cues[cue])].sort((a,b)=>a-b).filter((_,i)=>half===null||i%2===half);
      for(const bit of bits)controller.io.pulse('f'+bit,controller.tick+1);controller.advance(1);
      const active=[...fired].sort((a,b)=>a-b),row=expected.delays[seconds];
      if(half!==null){const saved=row.halves.find(h=>h.cue===cue&&h.half===half);same(active,saved.active,'half replay');assert.equal(completion(active,refs[cue]),saved.completion);}
      else {
        same(active,row.probes[cue].active,'full replay');
        const scores={A:jac(active,refs.A),B:jac(active,refs.B)},label=Math.max(scores.A,scores.B)<.5?'reject':scores.A>=scores.B?'A':'B';
        same(scores,row.probes[cue].scores);assert.equal(label,row.probes[cue].label);
        if(cue==='A'){assert.equal(completion(active,refs.B),row.forward);assert.equal(completion(active,refs.A),row.selfFull.A);}
        if(cue==='B'){assert.equal(completion(active,refs.A),row.reverse);assert.equal(completion(active,refs.B),row.selfFull.B);}
        if(cue==='C'){const spill=active.filter(n=>!origin.directSets.C.includes(n));same(spill,row.c.spillover);assert.equal(spill.length,row.c.count);assert.equal(spill.length/Math.min(refs.A.length,refs.B.length),row.c.fraction);same(scores,row.c.jaccards);assert.equal(label,row.c.readback);}
      }
    }
    assert.equal(expected.delays[seconds].minHalf,Math.min(...expected.delays[seconds].halves.map(h=>h.completion)));
  }cache.set(key,expected);
}
for(const [condition,rows] of Object.entries(checkpoints))for(const cp of rows)replay(cp.memory,cp.metrics);
replay(memory,summary.primary.metrics);
for(const [condition,m] of Object.entries(controls))replay(m,summary.controls[condition].metrics);
const qualifies=cp=>cp.epoch>=5&&[0,60].every(t=>cp.metrics.delays[t].forward>=.5),first=checkpoints.primary.find(qualifies);
assert.equal(summary.stopping.epoch,first?.epoch??40);assert.equal(summary.stopping.reached,!!first);
same(memory,checkpoints.primary.find(c=>c.epoch===summary.stopping.epoch).memory,'frozen stop');
same(continued.primary.memory,checkpoints.primary.at(-1).memory);assert.equal(continued.primary.epoch,40);
same(continued.unpaired.memory,checkpoints.unpaired.at(-1).memory);assert.equal(continued.unpaired.epoch,40);
const equivalent=checkpoints.unpaired.find(cp=>cp.epoch===80-origin.epoch);same(equivalent.memory.artifact,read(oldDir,'continuation.json').memory.artifact,'Unpaired native epoch-80 circuit');
const edgeCross=e=>refs.A.includes(e.sourceId)&&refs.B.includes(e.targetId)||refs.B.includes(e.sourceId)&&refs.A.includes(e.targetId);
const crossIds=memory.artifact.edges.filter(e=>origin.pool.includes(e.sourceId)&&origin.pool.includes(e.targetId)&&edgeCross(e)).map(e=>e.id);
same(summary.controls['prune-cross'].removedEdges,crossIds,'exact prune IDs');
same(controls['prune-cross'].artifact.edges,memory.artifact.edges.filter(e=>!crossIds.includes(e.id)),'unrelated edges unchanged');
same(controls['prune-cross'].artifact.nodes,memory.artifact.nodes,'nodes unchanged');
function rng(seed){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
function auditRows(data,condition){
  const unpaired=condition==='unpaired-continuation',random=rng(unpaired?origin.streams.jitter:(summary.seed^0xd1b54a35)>>>0);
  if(unpaired)for(let n=0;n<origin.epoch*16;n++)random();
  let next=origin.tick+1;
  for(const row of data.rows){
    assert.equal(row.t0,next);assert.equal(row.captureTicks,unpaired?65:50+summary.delta+summary.jitter);
    const leading=condition==='reverse-order'?'B':'A',cues=unpaired?[row.cue]:[leading,leading==='A'?'B':'A'];
    const expected=cues.flatMap((cue,i)=>[...encodeWord(origin.cues[cue])].sort((a,b)=>a-b).map(bit=>{const draw=random(),offset=(unpaired?0:i*summary.delta)+Math.floor(draw*((unpaired?15:summary.jitter)+1));return {cue,bit,cellId:origin.features[bit],draw,offset,tick:next+offset};}));
    same(row.onsets,expected,'jitter draw audit');same(row.active,[...new Set(row.spikes.map(s=>s.neuronId))].sort((a,b)=>a-b),'captured spike set');next+=row.captureTicks+500;
  }
  const audit=data.weightAudit,bySource=new Map();for(const e of origin.seedEdges){if(!bySource.has(e.sourceId))bySource.set(e.sourceId,[]);bySource.get(e.sourceId).push(e);}
  const schedules=data.rows.map(row=>{const arrivals=new Map();for(const onset of row.onsets)for(const e of bySource.get(onset.cellId)||[]){const t=(onset.tick-row.t0)*.02+e.delay;arrivals.set(e.targetId,Math.min(arrivals.get(e.targetId)??Infinity,t));}return {t0:row.t0*.02,arrivals};});
  for(const edge of audit.edges){
    assert.ok(Math.abs(edge.finalWeight-edge.initialWeight-edge.potentiationGain+edge.competitionLoss)<1e-9);
    let qualifying=0,modelled=0,unmodelled=0;
    for(const s of schedules){const pre=s.arrivals.get(edge.sourceId),post=s.arrivals.get(edge.targetId);
      if(s.t0+(pre??0)<=edge.birthTime+1e-9)continue;
      if(edge.deathTime!==null&&s.t0+(post??0)>edge.deathTime+1e-9)continue;
      if(pre===undefined||post===undefined){unmodelled++;continue;}modelled++;const lag=post-pre-edge.delay;if(lag>=-1e-9&&lag<=.32+1e-9)qualifying++;
    }
    assert.equal(edge.predicted.qualifying,qualifying);assert.equal(edge.predicted.modelledTrials,modelled);assert.equal(edge.predicted.unmodelledTrials,unmodelled);
  }
  const live=audit.edges.filter(e=>e.surviving),dead=audit.edges.filter(e=>!e.surviving);
  assert.equal(audit.totals.surviving,live.length);assert.equal(audit.totals.pruned,dead.length);assert.equal(audit.totals.formed,audit.edges.filter(e=>!e.inherited).length);
  for(const key of ['potentiationEvents','potentiationGain','competitionEvents','competitionLoss'])assert.ok(Math.abs(audit.edges.reduce((s,e)=>s+e[key],0)-audit.totals[key])<1e-8);
  if(condition==='hebbian-off-association')assert.equal(audit.totals.potentiationEvents,0);
  if(condition==='growth-off-association')assert.equal(audit.totals.formed,0);
}
for(const [condition,data] of Object.entries(trials))auditRows(data,condition);
auditRows(continued.primary,'primary');auditRows(continued.unpaired,'unpaired-continuation');
const gates={stopping:!!first,forward:true,reverse:true,selfIntegrity:true,cReadback:true,cJaccard:true,relativeContainment:true,unpairedControl:true,hebbianControl:true,pruneRecruitment:true,pruneIntegrity:true};
for(const t of [0,60]){
 const p=summary.primary.metrics.delays[t],b=summary.controls.untrained.metrics.delays[t],u=summary.controls['unpaired-continuation'].metrics.delays[t],h=summary.controls['hebbian-off-association'].metrics.delays[t],q=summary.controls['prune-cross'].metrics.delays[t];
 gates.forward&&=p.forward>=.5;gates.reverse&&=p.reverse<=b.reverse+.15;gates.selfIntegrity&&=p.minHalf>=.8&&p.selfFull.A>=.9&&p.selfFull.B>=.9;
 gates.cReadback&&=p.c.readback==='reject';gates.cJaccard&&=Math.max(p.c.jaccards.A,p.c.jaccards.B)<=.25;gates.relativeContainment&&=p.c.fraction-u.c.fraction<=.1;
 gates.unpairedControl&&=u.forward<=b.forward+.15;gates.hebbianControl&&=h.forward<=b.forward+.15;gates.pruneRecruitment&&=q.forward<.3&&q.forward<p.forward;
 gates.pruneIntegrity&&=q.halves.every(x=>Math.abs(x.completion-p.halves.find(y=>y.cue===x.cue&&y.half===x.half).completion)<=.05);
}
same(gates,summary.criteria,'independent gates');assert.equal(Object.values(gates).every(Boolean),summary.pass);
process.stdout.write(JSON.stringify({id,pass:summary.pass,replayedCircuits:cache.size,stop:summary.stopping.epoch,allEvidenceChecks:true})+'\n');
