'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server/app.cjs');
const {TextMemory,SCHEMA}=require('../src/text-memory.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'neurosphere-text-test-'));
let app,base;
const json=async(route,body)=>{const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,value:await r.json()};};
async function start(){app=createApp({dataDir:temporary});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;}
async function finished(){const deadline=Date.now()+30000;let job;do{await new Promise(r=>setTimeout(r,50));job=(await json('/api/job')).value.job;}while(job.status==='running'&&Date.now()<deadline);return job;}
before(start);
after(async()=>{await app.close();const resolved=fs.realpathSync(temporary);assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('neurosphere-text-test-'));fs.rmSync(resolved,{recursive:true,force:true});});

test('empty text workspace is explicit and teaching saves only after measured recall checks',async()=>{
  assert.equal((await json('/api/bootstrap')).value.memory.id,'demo');
  const opened=await json('/api/text/open',{});assert.equal(opened.status,200);assert.equal(opened.value.memory.words,0);
  assert.equal((await json('/api/sense',{word:'hello'})).value.status,'unknown');
  const teach=await json('/api/text/teach',{question:'What color is the lamp?',answer:'blue'});assert.equal(teach.status,202);
  assert.equal((await json('/api/load',{id:'demo'})).status,409);
  const job=await finished();assert.equal(job.status,'complete',JSON.stringify(job));assert.equal(job.memory.evaluation.exact,1);
  const result=await json('/api/sense',{word:'what color is the lamp'});assert.equal(result.status,200);assert.equal(result.value.output.text,'blue');assert.equal(result.value.memoryId,'text');assert.equal(result.value.revision,1);
  assert.equal((await json('/api/sense',{word:'what color is the cup'})).value.status,'unknown');
  assert.equal((await json('/api/sense',{word:'hello',domainId:'005'})).status,400);
  assert.equal((await json('/api/recall',{word:'hello'})).status,409);
});

test('incremental save preserves lessons and invalid or cancelled teaching preserves the checkpoint',async()=>{
  assert.equal((await json('/api/text/teach',{question:'What color is the cup?',answer:'red'})).status,202);
  const job=await finished();assert.equal(job.status,'complete',JSON.stringify(job));assert.equal(job.memory.evaluation.exact,2);
  assert.equal((await json('/api/sense',{word:'what color is the lamp'})).value.response,'blue');
  assert.equal((await json('/api/sense',{word:'what color is the cup'})).value.response,'red');
  const before=(await json('/api/export')).value;assert.equal(before.schema,SCHEMA);
  for(const body of [{question:'',answer:'x'},{question:'hello',answer:'x',domainId:'invalid'},{question:'a '.repeat(9),answer:'x'}])assert.equal((await json('/api/text/teach',body)).status,400);
  await json('/api/text/teach',{question:'What color is the lamp?',answer:'yellow'});assert.equal((await finished()).status,'failed');
  assert.deepEqual((await json('/api/export')).value,before);
  await json('/api/text/teach',{question:'a b c d e f g h',answer:'a b c d e f g h'});
  assert.equal((await json('/api/train/cancel',{})).value.job.status,'cancelled');
  assert.deepEqual((await json('/api/export')).value,before);
  assert.ok(fs.existsSync(path.join(temporary,'text-workspace.json.previous')));
});

test('restart restores plastic text memory, scene and decoding without retraining',async()=>{
  const before=(await json('/api/export')).value;
  await app.close();await start();
  assert.equal((await json('/api/bootstrap')).value.memory.kind,'text');
  assert.equal((await json('/api/bootstrap')).value.records.length,1826,'phrase lessons must not enter the vocabulary picker');
  assert.deepEqual((await json('/api/export')).value,before);
  assert.equal((await json('/api/sense',{word:'what color is the lamp'})).value.output.text,'blue');
  const {scene,records}= (await json('/api/scene')).value;
  assert.equal(records.length,2);assert.equal(scene.nodes.length,before.nodes.length);assert.equal(scene.volume.placement,'interleaved');
  const ids=new Set(scene.nodes.map(n=>n.id));assert.ok(scene.edges.every(e=>ids.has(e.source)&&ids.has(e.target)));
  assert.deepEqual(scene.ports.output.cellIds,scene.nodes.filter(n=>n.textRole==='output').map(n=>n.id));
  assert.equal((await json('/api/text')).value.lessons.length,2);
  assert.ok((await json('/api/runs')).value.runs.some(r=>r.id==='text'));
  assert.equal((await json('/api/load',{id:'demo'})).status,200);
  assert.equal((await json('/api/sense',{word:'aardvark'})).value.status,'recalled');
  assert.equal((await json('/api/load',{id:'text'})).status,200);
  assert.equal(new TextMemory(before).recall('what color is the cup').response,'red');
});

test('checkpoint import validates before replacement and archives the previous text workspace',async()=>{
  const before=(await json('/api/export')).value,broken=structuredClone(before);broken.nodes[0].domainId='999';
  assert.equal((await json('/api/import',{memory:broken})).status,400);
  assert.deepEqual((await json('/api/export')).value,before);
  assert.equal((await json('/api/import',{memory:before})).status,200);
  const backups=fs.readdirSync(temporary).filter(name=>name.startsWith('text-backup-'));
  assert.equal(backups.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary,backups[0]),'utf8')),before);
  assert.equal((await json('/api/sense',{word:'what color is the cup'})).value.response,'red');
});
