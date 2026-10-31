'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server/app.cjs');
const {TextMemory}=require('../src/text-memory.cjs');
const {FactMemory,SCHEMA}=require('../src/fact-memory.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'neurosphere-facts-test-'));
const phrase=new TextMemory();phrase.teach('hello there','hello');fs.writeFileSync(path.join(temporary,'text-workspace.json'),JSON.stringify(phrase.checkpoint()));
let app,base;
const json=async(route,body)=>{const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,value:await r.json()};};
async function start(){app=createApp({dataDir:temporary});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;}
async function done(){const deadline=Date.now()+30000;let job;do{await new Promise(r=>setTimeout(r,30));job=(await json('/api/job')).value.job;}while(job.status==='running'&&Date.now()<deadline);return job;}
async function teach(statement){assert.equal((await json('/api/facts/teach',{statement})).status,202);const job=await done();assert.equal(job.status,'complete',JSON.stringify(job));return job;}
before(start);
after(async()=>{await app.close();const resolved=fs.realpathSync(temporary);assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('neurosphere-facts-test-'));fs.rmSync(resolved,{recursive:true,force:true});});

test('fact workspace teaches a statement and answers both directions through the common sensory bus',async()=>{
  assert.equal((await json('/api/bootstrap')).value.memory.kind,'text');
  assert.equal((await json('/api/facts/open',{})).value.memory.words,0);
  assert.equal((await json('/api/sense',{word:'What color is the lamp?'})).value.status,'unknown');
  assert.equal((await json('/api/facts/teach',{statement:'The lamp is blue.'})).status,202);
  assert.equal((await json('/api/load',{id:'text'})).status,409);
  const job=await done();assert.equal(job.status,'complete',JSON.stringify(job));assert.equal(job.memory.evaluation.exact,1);
  assert.equal((await json('/api/sense',{word:'What color is the lamp?'})).value.output.text,'blue');
  assert.equal((await json('/api/sense',{word:'Which object is blue?'})).value.output.text,'the lamp');
  assert.equal((await json('/api/sense',{word:'Why is the lamp blue?'})).value.status,'unsupported');
  assert.equal((await json('/api/sense',{word:'What color is the lamp?',domainId:'007'})).status,400);
  assert.equal((await json('/api/recall',{word:'lamp'})).status,409);
});

test('new facts and corrections preserve the earlier text workspace and unrelated facts',async()=>{
  await teach('The cup is blue.');assert.equal((await json('/api/sense',{word:'Which object is blue?'})).value.matches.length,2);
  const job=await teach('The lamp is red.');assert.equal(job.memory.evaluation.exact,2);assert.equal(job.memory.words,2);
  assert.equal((await json('/api/sense',{word:'Which object is blue?'})).value.response,'the cup');
  const facts=(await json('/api/facts')).value;assert.equal(facts.history.length,1);assert.equal(facts.history[0].replacement,'red');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary,'text-workspace.json'),'utf8')),phrase.checkpoint());
  await json('/api/load',{id:'text'});assert.equal((await json('/api/sense',{word:'hello there'})).value.response,'hello');
  await json('/api/load',{id:'demo'});assert.equal((await json('/api/sense',{word:'aardvark'})).value.status,'recalled');
  await json('/api/load',{id:'facts'});assert.equal((await json('/api/sense',{word:'What color is the lamp?'})).value.response,'red');
});

test('invalid, duplicate, cancelled and failed fact jobs preserve the committed workspace',async()=>{
  const before=(await json('/api/export')).value;
  assert.equal((await json('/api/facts/teach',{statement:'lamp is blue and cup is red'})).status,400);
  assert.equal((await json('/api/facts/teach',{statement:'lamp is blue',domainId:'999'})).status,400);
  await json('/api/facts/teach',{statement:'The lamp is red.'});assert.equal((await done()).status,'failed');
  assert.deepEqual((await json('/api/export')).value,before);
  await json('/api/facts/teach',{statement:'The robin is a bird.'});assert.equal((await json('/api/train/cancel',{})).value.job.status,'cancelled');
  assert.deepEqual((await json('/api/export')).value,before);
});

test('restart, export and validated import preserve real scene links and archived fact history',async()=>{
  const before=(await json('/api/export')).value;assert.equal(before.schema,SCHEMA);
  await app.close();await start();assert.equal((await json('/api/bootstrap')).value.memory.kind,'facts');assert.equal((await json('/api/bootstrap')).value.records.length,1826);
  assert.deepEqual((await json('/api/export')).value,before);
  assert.equal((await json('/api/sense',{word:'What color is the lamp?'})).value.response,'red');
  const {scene}= (await json('/api/scene')).value,ids=new Set(scene.nodes.map(n=>n.id));assert.equal(scene.volume.placement,'interleaved');assert.equal(scene.sharedConcepts.length,before.concepts.length);assert.ok(scene.edges.every(e=>ids.has(e.source)&&ids.has(e.target)));
  assert.deepEqual(scene.ports.output.cellIds,scene.nodes.filter(n=>n.factRole==='readout').map(n=>n.id));
  const broken=structuredClone(before);broken.nodes[0].domainId='001';assert.equal((await json('/api/import',{memory:broken})).status,400);assert.deepEqual((await json('/api/export')).value,before);
  assert.equal((await json('/api/import',{memory:before})).status,200);
  const backups=fs.readdirSync(temporary).filter(n=>n.startsWith('fact-backup-'));assert.equal(backups.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary,backups[0]),'utf8')),before);
  assert.equal(new FactMemory(before).evaluate().exact,2);assert.ok((await json('/api/runs')).value.runs.some(r=>r.id==='text'));
});
