'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createApp}=require('../server/app.cjs'),view=require('../server/readout-view.cjs');
const {loadVocabulary,LockedController}=require('../src/index.cjs');
const directory=view.DEFAULT_DIRECTORY,catalog=view.createCatalog(),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'neurosphere-readout-ui-'));
let app,base;
const get=async(route,body)=>{const response=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:response.status,value:await response.json()};};
before(async()=>{app=createApp({dataDir:temporary});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;});
after(async()=>{await app.close();const resolved=fs.realpathSync(temporary);assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith('neurosphere-readout-ui-'));fs.rmSync(resolved,{recursive:true,force:true});});
test('catalog exposes only the three confirmed circuits and scene preserves all coordinates and edges',async()=>{
  const status=(await get('/api/readout')).value;assert.equal(status.available,true);assert.deepEqual(status.cells.map(c=>c.seed),[1,2,3]);
  for(const entry of status.cells){const loaded=catalog.load(entry.seed),m=loaded.memory,s=view.scene(m,loadVocabulary());assert.equal(s.nodes.length,694);assert.equal(s.nodes.filter(n=>n.role==='output').length,2);
    assert.deepEqual(s.volume.center,m.volume.center);assert.equal(s.volume.radius,m.volume.radius);
    assert.deepEqual(s.nodes.map(({id,x,y,z})=>({id,x,y,z})),m.artifact.nodes.map(({id,x,y,z})=>({id,x,y,z})));
    assert.deepEqual(s.edges.map(e=>[e.id,e.source,e.target,e.weight,e.delay]),m.artifact.edges.map(e=>[e.id,e.sourceId,e.targetId,e.weight,e.delay]));
    for(const cue of ['A','B'])assert.deepEqual(s.nodes.filter(n=>n.memberships.includes(cue)).map(n=>n.id),m.cores[cue]);
    assert.deepEqual(s.ports.output.cellIds,[693,694]);assert.equal(s.edges.filter(e=>e.kind==='readout').length,1000);
  }
  assert.equal(view.createCatalog(path.join(temporary,'missing')).status().available,false);
  assert.throws(()=>catalog.load('../../outside'));assert.throws(()=>catalog.load(4));
});
for(const seed of [1,2,3])test('seed '+seed+': every full/half/C probe at both delays matches saved native evidence',async()=>{
  const loaded=catalog.load(seed),m=loaded.memory,cell=JSON.parse(fs.readFileSync(path.join(directory,'cases',loaded.entry.caseId,'primary/summary.json')));
  assert.equal((await get('/api/readout/open',{seed})).status,200);
  const scene=(await get('/api/scene')).value;assert.equal(scene.memory.id,'readout-'+seed);assert.equal(scene.scene.kind,'readout');
  const before=(await get('/api/export')).value;assert.deepEqual(before,m);
  for(const idleSeconds of [0,60])for(const kind of ['probes','halfProbes'])for(const expected of cell.observed[kind][idleSeconds]){
    const mode=expected.cue==='C'?'untrained':expected.half===0?'half-1':expected.half===1?'half-2':'full';
    const response=await get('/api/sense',{word:m.cues[expected.cue],mode,idleSeconds});assert.equal(response.status,200,JSON.stringify(response.value));const actual=response.value;
    assert.equal(actual.memoryId,'readout-'+seed);assert.deepEqual(actual.inputBits,expected.bits);assert.deepEqual(actual.active,expected.active);assert.deepEqual(actual.coreCellsFired,expected.coreCellsFired);
    const filtered=actual.trace.filter(s=>m.pool.includes(s.neuronId)||s.neuronId===693||s.neuronId===694);
    assert.equal(filtered.length,expected.spikes.length);filtered.forEach((spike,index)=>{assert.equal(spike.neuronId,expected.spikes[index].neuronId);assert.ok(Math.abs(spike.time+idleSeconds-expected.spikes[index].time)<1e-9);});
    assert.equal(actual.trace.filter(s=>m.features.includes(s.neuronId)).length,expected.bits.length);
    assert.equal(actual.samples.length,51);assert.ok(Math.abs(actual.samples.at(-1).time-1)<1e-9);
    for(const c of ['A','B']){const a=actual.outputs[c],e=expected.outputs[c];assert.equal(a.fired,e.fired);assert.deepEqual(a.latencyTicks,e.latencyTicks);
      for(const key of ['peakMargin','peakPotential','peakEffectiveThreshold','arrivingWeight','integratedWeight','inputMargin'])assert.ok(Math.abs(a[key]-e[key])<1e-9,key);
      assert.equal(a.membrane.length,50);assert.ok(Math.abs(Math.max(...a.membrane.filter(p=>!p.refractory).map(p=>p.value-p.threshold))-a.peakMargin)<1e-9);
      assert.equal(a.word,loadVocabulary().get(m.outputs[c].conceptId).word);
    }
    if(expected.cue==='C'){assert.equal(actual.readoutStatus,'silent');assert.equal(actual.response,'');}else{assert.equal(actual.readoutStatus,'decoded');assert.equal(actual.response,m.cues[expected.cue]);}
  }
  assert.deepEqual((await get('/api/export')).value,before,'Probes must never mutate the loaded memory');
});
test('post-step samples come from the native controller while output charts retain pre-reset peaks',async()=>{
  const memory=catalog.load(1).memory;await get('/api/readout/open',{seed:1});const {value}=await get('/api/sense',{word:memory.cues.A});
  const runtime=new LockedController(memory.artifact);for(const bit of value.inputBits)runtime.io.pulse('f'+bit,1);
  for(const sample of value.samples){runtime.advance(sample.time-runtime.time);assert.deepEqual(sample.values,runtime.neurons.filter(c=>Math.abs(c.potential-c.restLevel)>1e-6).map(c=>[c.id,c.potential]));}
  const {potentialSeries}=await import('../public/telemetry-model.mjs');const output=memory.artifact.nodes.find(n=>n.id===693);
  assert.deepEqual(potentialSeries(value.samples,output,value.outputs),value.outputs.A.membrane);assert.ok(value.outputs.A.membrane.some(p=>p.value>=p.threshold));
});
test('invalid readout requests preserve the selected circuit and older modes remain available',async()=>{
  await get('/api/readout/open',{seed:1});const original=(await get('/api/export')).value;
  for(const body of [{word:'aardvark',mode:'garbage'},{word:'new word',mode:'half-1'},{word:'aardvark',idleSeconds:1},{word:'aardvark',domainId:'readout'},{word:''},{word:5}])assert.equal((await get('/api/sense',body)).status,400);
  for(const seed of [0,4,'1','../../outside'])assert.equal((await get('/api/readout/open',{seed})).status,400);
  assert.deepEqual((await get('/api/export')).value,original);assert.equal((await get('/api/recall',{word:'aardvark'})).status,409);
  assert.equal((await get('/api/load',{id:'demo'})).status,200);assert.equal((await get('/api/sense',{word:'aardvark'})).value.status,'recalled');
  assert.equal((await get('/api/load',{id:'readout-2'})).value.memory.id,'readout-2');
  assert.equal((await fetch(base+'/readout-panel.js')).status,200);
});
