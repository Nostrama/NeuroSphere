'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadVocabulary,EngramVolume,EngramMemory}=require('../src/index.cjs');
const {compactMemory,LAYOUT,domainCenter}=require('../src/domain-layout.cjs');
const legacy=require('../outputs/pilot-v3/engram-memory.json');
const vocabulary=loadVocabulary();
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
test('legacy memories move into one bounded volume without changing their circuit or recall',()=>{
  const before=structuredClone(legacy),moved=compactMemory(legacy);
  assert.deepEqual(legacy,before);assert.deepEqual(moved.artifact.edges,legacy.artifact.edges);assert.deepEqual(moved.bindings,legacy.bindings);assert.deepEqual(moved.artifact.io,legacy.artifact.io);
  const oldMemory=new EngramMemory(legacy),newMemory=new EngramMemory(moved);
  for(const binding of moved.bindings){const word=vocabulary.get(binding.conceptId).word;assert.deepEqual(newMemory.recall(word),oldMemory.recall(word));assert.equal(newMemory.recall(word).status,'recalled');}
  assert.equal(newMemory.recall('banana').status,'unknown');assert.deepEqual(compactMemory(moved),moved);
});
test('new training volumes interleave every domain throughout one continuous volume',()=>{
  const volume=new EngramVolume(vocabulary,vocabulary.samplePerDomain(2).map(record=>record.id));const memory=volume.export();
  assert.deepEqual(memory.artifact.config.extent,LAYOUT.extent);assert.equal(memory.volume.placement,'interleaved');
  const membership=new Map();for(const r of memory.regions){assert.deepEqual(r.center,LAYOUT.center);assert.equal(r.radius,LAYOUT.radius);for(const id of r.featureCells)membership.set(id,r);}
  for(const b of memory.bindings)for(const id of b.assembly)membership.set(id,memory.regions.find(r=>r.domainId===b.domainId));
  for(const node of memory.artifact.nodes){assert.ok(distance(node,LAYOUT.center)<=360);const actual=volume.field.neurons.find(n=>n.id===node.id);assert.deepEqual([node.x,node.y,node.z],[actual.x,actual.y,actual.z]);}
  for(const r of memory.regions){const cells=memory.artifact.nodes.filter(n=>membership.get(n.id)===r);const octants=new Set(cells.map(n=>(n.x>=400?1:0)+(n.y>=400?2:0)+(n.z>=400?4:0)));assert.equal(octants.size,8);assert.ok(cells.some(n=>distance(n,LAYOUT.center)<120));assert.ok(cells.some(n=>distance(n,LAYOUT.center)>330));}
  assert.equal(new Set(memory.artifact.nodes.map(n=>[n.x,n.y,n.z].join(','))).size,memory.artifact.nodes.length);
  assert.ok(memory.artifact.edges.every(e=>membership.get(e.sourceId)===membership.get(e.targetId)));
});
test('learning in a neighboring domain cannot change the first domain weights or recall',()=>{
  const a=vocabulary.findWord('aardvark')[0],b=vocabulary.findWord('aback')[0];
  const alone=new EngramVolume(vocabulary,[a.id]).train().export(),together=new EngramVolume(vocabulary,[a.id,b.id]).train().export();
  const ids=new Set(alone.artifact.nodes.map(n=>n.id));
  assert.deepEqual(together.artifact.nodes.filter(n=>ids.has(n.id)),alone.artifact.nodes);
  assert.deepEqual(together.artifact.edges.filter(e=>ids.has(e.sourceId)),alone.artifact.edges);
  assert.deepEqual(new EngramMemory(alone).recall(a.word,{domainId:a.domainId}),new EngramMemory(together).recall(a.word,{domainId:a.domainId}));
  assert.equal(new EngramMemory(together).recall(a.word,{domainId:b.domainId}).status,'unknown');
});
test('shared snapshots reject escaping neurons, invalid layout metadata and cross-domain edges',()=>{
  const saved=compactMemory(legacy);
  const escaped=structuredClone(saved);Object.assign(escaped.artifact.nodes[0],{x:799,y:799,z:799});assert.throws(()=>new EngramMemory(escaped),/escaped/);
  const invalid=structuredClone(saved);invalid.regions[1].radius=100;assert.throws(()=>new EngramMemory(invalid),/compartment/);
  const crossed=structuredClone(saved);crossed.artifact.edges[0].targetId=saved.bindings.find(b=>b.domainId==='002').assembly[0];assert.throws(()=>new EngramMemory(crossed),/Cross-domain/);
});
test('v1 spherical compartments migrate without altering spike timing, cell state or source snapshot',()=>{
  const v1=structuredClone(legacy);
  for(const region of v1.regions){const old=region.center,next=domainCenter(region.domainId),ids=new Set([...region.featureCells,...v1.bindings.filter(b=>b.domainId===region.domainId).flatMap(b=>b.assembly)]);for(const node of v1.artifact.nodes.filter(n=>ids.has(n.id)))for(const axis of ['x','y','z'])node[axis]+=next[axis]-old[axis];region.center=next;region.radius=100;}
  v1.volume={schema:'neurosphere-compartments/v1',center:{...LAYOUT.center},radius:400,extent:{...LAYOUT.extent},isolation:LAYOUT.isolation};v1.artifact.config.extent={...LAYOUT.extent};
  const before=structuredClone(v1),moved=compactMemory(v1);assert.deepEqual(v1,before);assert.deepEqual(moved.artifact.edges,v1.artifact.edges);assert.deepEqual(moved.artifact.io,v1.artifact.io);
  const withoutPosition=n=>{const {x,y,z,...rest}=n;return rest;};assert.deepEqual(moved.artifact.nodes.map(withoutPosition),v1.artifact.nodes.map(withoutPosition));
  const {LockedController,encodeWord}=require('../src/index.cjs');
  const measure=saved=>{const trace=[],runtime=new LockedController(saved.artifact,event=>trace.push([event.neuronId,event.time]));for(const r of saved.regions)for(const bit of encodeWord('aardvark'))runtime.io.pulse('d'+r.domainId+'_f'+bit,1);runtime.advance(1);return trace;};
  assert.deepEqual(measure(moved),measure(v1));assert.deepEqual(new EngramMemory(moved).recall('aardvark'),new EngramMemory(v1).recall('aardvark'));assert.deepEqual(compactMemory(moved),moved);
});
