'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const c=require('../examples/readout-confirmation.cjs'),r=require('../examples/readout.cjs');
function cohort(){
  const row=(cue,label)=>({cue,outputs:{A:{fired:label==='A'},B:{fired:label==='B'}}});
  const observed=swap=>({probes:Object.fromEntries([0,60].map(d=>[d,['A','B','C'].map(cue=>row(cue,swap&&cue!=='C'?(cue==='A'?'B':'A'):null))])),halfProbes:{0:[],60:[]}});
  return c.declaration().cells.map(spec=>{
    const controls={'readout-hebbian-off':{epoch:70,gates:{R1:false},observed:observed(false)},'prune-readout':{epoch:70,gates:{R1:false},ablation:{poolResponsesUnchanged:true}},
      'swapped-teacher':{epoch:70,observed:observed(true)},'prune-formed':{epoch:70,gates:{R1:true,R2:false}},'untrained-readout':{epoch:0,observed:observed(false)}};
    const primary={epoch:70,gates:{R1:true,R2:true,R3:true,R4:true},stopping:{epoch:70,reached:true}};
    return {...spec,summary:{seed:spec.seed,options:{...spec.options},stopping:primary.stopping,primary,controls,...r.decide(primary,controls)}};
  });
}
test('confirmation declares only tick24/factor0.25, reusing seed1 and running seeds2/3',()=>{
  const d=c.declaration();assert.deepEqual(d.cells.map(x=>x.seed),[1,2,3]);assert.equal(d.cells[0].role,'reused');assert.equal(d.cells[0].id,c.REUSED);
  for(const spec of d.cells)assert.deepEqual(spec.options,{teacherTick:24,thresholdFactor:.25,epochs:80});assert.equal(Object.keys(d.controls).length,5);
});
test('all three seeds must pass every readout gate and every control discrimination',()=>{
  assert.equal(c.decide(cohort()).pass,true);
  for(const seed of [1,2,3])for(const gate of ['R1','R2','R3','R4']){
    const cells=cohort(),s=cells[seed-1].summary;s.primary.gates[gate]=false;Object.assign(s,r.decide(s.primary,s.controls));
    const result=c.decide(cells);assert.equal(result.pass,false);assert.ok(result.failedCriteria.includes('seed '+seed+': '+gate));
  }
  for(const name of ['readout-hebbian-off','prune-readout','swapped-teacher','prune-formed','untrained-readout']){
    const cells=cohort(),s=cells[1].summary,control=s.controls[name];
    if(name==='prune-readout')control.ablation.poolResponsesUnchanged=false;
    else if(name==='prune-formed')control.gates.R1=false;
    else control.observed.probes[0][0].outputs.A.fired=true;
    Object.assign(s,r.decide(s.primary,s.controls));assert.equal(c.decide(cells).pass,false,name);
  }
});
test('missing/duplicate seeds, different settings and failure to stop cannot pass',()=>{
  assert.equal(c.decide(cohort().slice(0,2)).pass,false);
  const duplicate=cohort();duplicate[2]=structuredClone(duplicate[1]);assert.equal(c.decide(duplicate).pass,false);
  const changed=cohort();changed[2].options={...changed[2].options,teacherTick:32};assert.equal(c.decide(changed).pass,false);
  const late=cohort(),s=late[2].summary;s.primary.stopping.reached=false;Object.assign(s,r.decide(s.primary,s.controls));assert.match(c.decide(late).failedCriteria.join(' '),/seed 3: Stopping/);
});
test('first natural firing excludes forced spikes and includes either cue trial',()=>{
  const outputs={A:{id:11},B:{id:12}},spike=(id,time,driven=false,externalDrive=false)=>({neuronId:id,time,driven,externalDrive});
  const rows=[{epoch:1,cue:'A',t0:1,outputs:[spike(11,.5,true,true)]},{epoch:1,cue:'B',t0:101,outputs:[spike(12,2.5,false,true)]},
    {epoch:2,cue:'A',t0:201,outputs:[spike(12,4.5)]},{epoch:3,cue:'B',t0:501,outputs:[spike(11,10.5),spike(12,10.6)]}];
  const found=c.firstNatural(rows,outputs);assert.equal(found.A.epoch,3);assert.equal(found.A.cue,'B');assert.equal(found.B.epoch,2);assert.equal(found.B.tickFromCue,24);assert.deepEqual(c.firstNatural([],outputs),{A:null,B:null});
});
test('confirmation CLI rejects all undeclared parameter overrides before running',async()=>{
  for(const args of [['--teacherTick','32'],['--thresholdFactor','.4'],['--seed','4'],['--confirm','--study'],['--confirm','--cue','aardvark']])await assert.rejects(c.main(args),/Undeclared/);
});
test('the default and explicit confirmation CLI dispatch only to the fixed confirmation runner',async()=>{
  const legacy=require('../examples/readout-study.cjs'),original=c.main,received=[];
  c.main=async argv=>{received.push(argv);return 17;};
  try{assert.equal(await legacy.main([]),17);assert.equal(await legacy.main(['--confirm','--output','fixture']),17);assert.deepEqual(received,[['--confirm'],['--confirm','--output','fixture']]);}finally{c.main=original;}
});
test('CLI promotes only a complete passing confirmation and does not conceal a newer failure',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'neurosphere-readout-confirmation-'));
  try{
    assert.equal(c.latestConfirmedMemory(base),null);const dir=path.join(base,'001'),memory=path.join(dir,'cases',c.REUSED,'primary/memory.json');fs.mkdirSync(path.dirname(memory),{recursive:true});fs.writeFileSync(memory,'{}');
    const summary={schema:'neurosphere-readout-confirmation-study/v1',pass:true,cells:cohort(),defaultMemory:{seed:1,relativePath:'cases/'+c.REUSED+'/primary/memory.json'}};fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary));
    assert.equal(c.latestConfirmedMemory(base),memory);fs.mkdirSync(path.join(base,'002'));assert.equal(c.latestConfirmedMemory(base),memory);
    fs.writeFileSync(path.join(base,'002/summary.json'),JSON.stringify({...summary,pass:false,defaultMemory:null}));assert.equal(c.latestConfirmedMemory(base),null);
  }finally{assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(base).startsWith('neurosphere-readout-confirmation-'));fs.rmSync(base,{recursive:true,force:true});}
});
