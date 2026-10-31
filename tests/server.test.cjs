'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app.cjs');
const { EngramMemory, LockedController, encodeWord } = require('../src/index.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neurosphere-ui-test-'));
let app, base, bootstrap, trainedId;
const json = async (route, body, headers = {}) => {
  const response = await fetch(base + route, body === undefined ? { headers } : { method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body) });
  return { status:response.status, value:await response.json() };
};
before(async () => {
  app = createApp({dataDir:temporary}); await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); base='http://127.0.0.1:'+app.server.address().port;
  bootstrap=(await json('/api/bootstrap')).value;
});
after(async () => { await app.close(); const resolved=fs.realpathSync(temporary); assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep)); assert.ok(path.basename(resolved).startsWith('neurosphere-ui-test-')); fs.rmSync(resolved,{recursive:true,force:true}); });

test('UI exposes the real corpus, saved geometry and static assets', async()=>{
  assert.equal(bootstrap.records.length,1826); assert.equal(bootstrap.domains.length,9); assert.equal(bootstrap.memory.words,18);
  const {value}=await json('/api/scene'); assert.equal(value.scene.nodes.length,1782);assert.equal(value.scene.edges.length,3492);
  assert.equal(value.scene.nodes.filter(node=>node.role==='memory').length,54);
  const ids=new Set(value.scene.nodes.map(node=>node.id)); assert.ok(value.scene.edges.every(edge=>ids.has(edge.source)&&ids.has(edge.target)));
  for(const route of ['/','/app.js','/volume.js','/style.css','/icon.svg','/morphology.js','/dashboard.js','/telemetry-model.mjs','/upstream/neuron-volume.js']) { const response=await fetch(base+route); assert.equal(response.status,200);assert.ok((await response.text()).length>100);assert.ok(response.headers.get('Content-Security-Policy').includes("default-src 'self'")); }
  assert.equal((await json('/package.json')).status,404);assert.equal((await json('/api/health',undefined,{Origin:'https://example.com'})).status,403);
});
test('recall reports actual engram cells and measured spike events',async()=>{
  const {status,value}=await json('/api/recall',{word:'aardvark'});assert.equal(status,200,JSON.stringify(value));assert.equal(value.status,'recalled');assert.equal(value.matches[0].word,'aardvark');assert.equal(value.matches[0].activeCells,3);
  assert.ok(value.trace.length>0);assert.ok(value.trace.every(event=>Number.isInteger(event.neuronId)&&event.time>=0&&event.time<=1));
  const exported=(await json('/api/export')).value;const binding=exported.bindings.find(item=>item.conceptId===value.matches[0].conceptId);const fired=new Set(value.trace.map(event=>event.neuronId));assert.ok(binding.assembly.every(id=>fired.has(id)));
  const unknown=await json('/api/recall',{word:'banana'});assert.equal(unknown.value.status,'unknown');assert.equal(unknown.value.matches.length,0);
  const scoped=await json('/api/recall',{word:'aardvark',domainId:'002'});assert.equal(scoped.value.status,'unknown');assert.deepEqual(scoped.value.routedDomains,['002']);
  const allowed=new Set([...exported.regions.find(r=>r.domainId==='002').featureCells,...exported.bindings.filter(b=>b.domainId==='002').flatMap(b=>b.assembly)]);
  assert.ok(scoped.value.trace.every(event=>allowed.has(event.neuronId)));assert.ok(scoped.value.samples.every(sample=>sample.values.every(([id])=>allowed.has(id))));
  assert.equal(value.samples.length,51);assert.equal(value.samples.at(-1).time,1);
  const expected=new LockedController(exported.artifact);for(const r of exported.regions)for(const bit of encodeWord('aardvark'))expected.io.pulse('d'+r.domainId+'_f'+bit,1);
  for(const sample of value.samples){expected.advance(sample.time-expected.time);assert.deepEqual(sample.values,expected.neurons.filter(cell=>Math.abs(cell.potential-cell.restLevel)>1e-6).map(cell=>[cell.id,cell.potential]));}
});
test('invalid requests preserve the current circuit',async()=>{
  const before=(await json('/api/scene')).value.memory;
  for(const body of [{conceptIds:[],epochs:24},{conceptIds:[bootstrap.defaults[0]],epochs:0},{conceptIds:[bootstrap.defaults[0]],seed:-1},{conceptIds:['missing']},{conceptIds:[bootstrap.defaults[0],bootstrap.defaults[0]]},{conceptIds:bootstrap.records.filter(r=>r.domainId==='001').slice(0,9).map(r=>r.id)}]) assert.equal((await json('/api/train',body)).status,400);
  assert.equal((await json('/api/import',{memory:{}})).status,400);
  const missingCoordinates=(await json('/api/export')).value;delete missingCoordinates.regions[0].center;assert.equal((await json('/api/import',{memory:missingCoordinates})).status,400);
  const memory=(await json('/api/export')).value;memory.sourceHash='x'.repeat(64);assert.equal((await json('/api/import',{memory})).status,400);
  assert.equal((await json('/api/scene')).value.memory.id,before.id);
});
test('Sense Input is one whole-volume bus with a measured Output and complete scene endpoints',async()=>{
  const {value:result,status}=await json('/api/sense',{word:'aardvark'});assert.equal(status,200);assert.equal(result.channel,'sense');assert.equal(result.input.name,'Sense Input');assert.equal(result.output.name,'Output');assert.equal(result.input.domains,9);assert.equal(result.input.features,result.inputBits.length);assert.equal(result.status,'recalled');assert.deepEqual(result.output.conceptIds,result.recalled.map(r=>r.conceptId));
  const {value:{scene}}=await json('/api/scene');assert.equal(scene.volume.placement,'interleaved');assert.deepEqual(new Set(scene.ports.sense.cellIds),new Set(scene.nodes.filter(n=>n.role==='input').map(n=>n.id)));assert.deepEqual(new Set(scene.ports.output.cellIds),new Set(scene.nodes.filter(n=>n.role==='memory').map(n=>n.id)));assert.equal(scene.ports.sense.position.x,0);assert.equal(scene.ports.output.position.x,800);
  const unknown=await json('/api/sense',{word:'banana'});assert.equal(unknown.value.output.status,'unknown');assert.deepEqual(unknown.value.output.conceptIds,[]);assert.equal((await json('/api/sense',{word:'aardvark',domainId:'002'})).status,400);
});
test('training is cancellable and does not replace the open memory',async()=>{
  const before=(await json('/api/scene')).value.memory.id;
  assert.equal((await json('/api/train',{conceptIds:bootstrap.defaults,epochs:100})).status,202);
  assert.equal((await json('/api/train',{conceptIds:bootstrap.defaults})).status,409);
  assert.equal((await json('/api/load',{id:'demo'})).status,409);
  const cancelled=await json('/api/train/cancel',{});assert.equal(cancelled.value.job.status,'cancelled');assert.equal((await json('/api/scene')).value.memory.id,before);
});
test('worker training saves a usable circuit and reloads it after restart',async()=>{
  const conceptIds=[bootstrap.defaults[0]];
  assert.equal((await json('/api/train',{conceptIds,epochs:24,seed:1})).status,202);
  const deadline=Date.now()+30000;let job;
  do { await new Promise(resolve=>setTimeout(resolve,100)); job=(await json('/api/job')).value.job; } while(job.status==='running'&&Date.now()<deadline);
  assert.equal(job.status,'complete',JSON.stringify(job));assert.equal(job.memory.evaluation.exact,1);assert.equal(job.memory.words,1);trainedId=job.memory.id;
  assert.ok(fs.existsSync(path.join(temporary,trainedId,'memory.json')));
  const memory=(await json('/api/export')).value;assert.equal(new EngramMemory(memory).recall('aardvark').status,'recalled');
  await app.close();app=createApp({dataDir:temporary});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
  assert.ok((await json('/api/runs')).value.runs.some(run=>run.id===trainedId));
  assert.equal((await json('/api/load',{id:trainedId})).status,200);assert.equal((await json('/api/recall',{word:'aardvark'})).value.status,'recalled');
});
test('portable memory import preserves behavior and records a saved run',async()=>{
  const memory=(await json('/api/export')).value;
  const imported=await json('/api/import',{memory,name:'Roundtrip'});assert.equal(imported.status,200);assert.notEqual(imported.value.memory.id,trainedId);assert.equal(imported.value.memory.name,'Roundtrip');
  assert.deepEqual((await json('/api/export')).value,memory);assert.equal((await json('/api/recall',{word:'aardvark'})).value.status,'recalled');
  assert.equal((await json('/api/load',{id:'../../outside'})).status,404);
});
