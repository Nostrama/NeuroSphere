'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FactMemory}=require('../src/fact-memory.cjs');
const {parseFact,parseQuestion,questions}=require('../src/fact-language.cjs');
const restore=m=>new FactMemory(JSON.parse(JSON.stringify(m.checkpoint())));
const weights=m=>new Map(m.field.links.map(e=>[e.id,e.weight]));

test('controlled grammar extracts color, location and category without accepting extra clauses',()=>{
  assert.deepEqual(parseFact('The Lamp is BLUE!'),{subject:'lamp',relation:'color',object:'blue'});
  assert.deepEqual(parseFact('A cup is on the table.'),{subject:'cup',relation:'location',object:'on the table'});
  assert.deepEqual(parseFact('The robin is a bird.'),{subject:'robin',relation:'category',object:'bird'});
  for(const text of ['lamp is blue and the cup is red','lamp is not blue','lamp likes blue','lamp is blue yesterday','The lamp is a bird and a fish','',null])assert.throws(()=>parseFact(text));
  assert.equal(parseQuestion('Why is the lamp blue?').supported,false);
  assert.deepEqual(parseQuestion('What colour is the lamp?'),{supported:true,cue:'lamp',relation:'color',direction:'forward'});
  assert.equal(parseQuestion('Which objects are blue?').direction,'reverse');
});

test('fact learning needs teacher pairing and responds through actual shared output cells',()=>{
  const empty=new FactMemory();assert.equal(empty.recall('What color is the lamp?').status,'unknown');
  empty.enroll('The lamp is blue.','007');assert.equal(empty.recall('What color is the lamp?').status,'unknown');
  const m=new FactMemory();m.teach('The lamp is blue.');const saved=m.checkpoint();
  for(const [q,a] of [['What color is the lamp?','blue'],['Which object is blue?','the lamp']]){
    const r=m.recall(q);assert.equal(r.response,a);assert.ok(r.matches.every(v=>v.tokens.every(t=>r.trace.some(e=>e.neuronId===t.neuronId&&e.time===t.time))));assert.ok(r.samples.length>1);assert.equal(r.seconds,r.samples.at(-1).time);
  }
  assert.deepEqual(m.checkpoint(),saved,'recall is read only');
});

test('concepts are shared across facts, reverse retrieval returns all matching objects',()=>{
  const m=new FactMemory();m.teach('The lamp is blue.');const before=weights(m);m.teach('The cup is blue.');
  assert.equal(m.concepts.filter(c=>c.label==='blue').length,1);
  const blue=m.concepts.find(c=>c.label==='blue');assert.equal(m.field.getNeuron(blue.readout).incoming.length,2);
  assert.equal(m.recall('Which objects are blue?').response,'the lamp, the cup');
  for(const e of m.field.links)if(before.has(e.id))assert.equal(e.weight,before.get(e.id),'shared readout preserves previous weights');
  assert.equal(m.recall('What color is the door?').status,'unknown');
  assert.equal(m.recall('Which object is green?').status,'unknown');
  assert.equal(m.recall('Explain blue').status,'unsupported');
});

test('all three relations work and unrelated relationships do not cross-activate',()=>{
  const m=new FactMemory();for(const fact of ['The lamp is blue.','The lamp is on the table.','The lamp is a light.','The robin is a bird.'])m.teach(fact);
  for(const fact of m.facts){const q=questions(fact);assert.equal(m.recall(q.forward).response,fact.object);assert.ok(m.recall(q.reverse).response.includes('the '+fact.subject));}
  assert.equal(m.recall('Where is the robin?').status,'unknown');assert.equal(m.recall('What color is the robin?').status,'unknown');
  assert.equal(m.evaluate().exact,4);
});

test('correction retires both directions and retains unrelated facts and weights after restart',()=>{
  const m=new FactMemory();m.teach('The lamp is blue.');m.teach('The cup is blue.');m.teach('The cup is on the table.');
  const before=weights(m),old=m.facts[0],changed=new Set(m.field.links.filter(e=>[old.forward,old.reverse].includes(e.sourceId)||[old.forward,old.reverse].includes(e.targetId)).map(e=>e.id));
  m.teach('The lamp is red.');assert.equal(m.facts.length,3);assert.equal(m.history[0].object,'blue');assert.equal(m.revision,4);
  for(const edge of m.field.links)if(before.has(edge.id)&&!changed.has(edge.id))assert.equal(edge.weight,before.get(edge.id));
  const restored=restore(m);assert.equal(restored.recall('What color is the lamp?').response,'red');assert.equal(restored.recall('Which object is blue?').response,'the cup');assert.equal(restored.recall('Where is the cup?').response,'on the table');
  restored.teach('The robin is a bird.');assert.equal(restored.evaluate().exact,4);
  const saved=restored.checkpoint();assert.throws(()=>restored.teach('The lamp is red.'),/already learned/);assert.deepEqual(restored.checkpoint(),saved);
});

test('ablating learned gate inputs, output edges, or shared concept relays removes recall',()=>{
  const m=new FactMemory();m.teach('The lamp is blue.');
  for(const target of ['input','output','relay']){
    const broken=restore(m),fact=broken.facts[0],subject=broken.concepts.find(c=>c.label==='lamp');
    for(const edge of broken.field.links)if(target==='input'&&edge.targetId===fact.forward||target==='output'&&edge.sourceId===fact.forward||target==='relay'&&edge.sourceId===subject.cue)edge.weight=.001;
    assert.equal(broken.recall('What color is the lamp?').status,'unknown',target);
  }
  const metadata=restore(m);metadata.facts[0].statement='Display-only teaching record changed.';assert.equal(metadata.recall('What color is the lamp?').response,'blue');
});

test('domain isolation survives shared coordinates and conflicting domain facts remain explicit',()=>{
  const m=new FactMemory();m.teach('The lamp is blue.','007');m.teach('The lamp is red.','001');
  assert.equal(m.recall('What color is the lamp?').status,'ambiguous');assert.equal(m.recall('What color is the lamp?',{domainId:'007'}).response,'blue');
  assert.equal(m.recall('What color is the lamp?',{domainId:'001'}).response,'red');assert.equal(m.recall('What color is the lamp?',{domainId:'009'}).status,'unknown');
  assert.ok(m.field.links.every(e=>m.membership.get(e.sourceId)===m.membership.get(e.targetId)));
  m.teach('The lamp is green.','007');assert.equal(m.recall('What color is the lamp?',{domainId:'001'}).response,'red');
});

test('eight facts sharing a concept fit terminal limits and retain both retrieval directions',()=>{
  const m=new FactMemory();for(let i=0;i<8;i++)m.teach('The object '+i+' is blue.');
  assert.equal(m.evaluate().exact,8);assert.equal(m.recall('Which objects are blue?').matches.length,8);assert.ok(m.field.neurons.every(n=>n.synapses.length<=10));
  const saved=m.checkpoint();assert.throws(()=>m.teach('The extra is red.'),/eight per domain/);assert.deepEqual(m.checkpoint(),saved);
  m.teach('The object 0 is red.');assert.equal(m.evaluate().exact,8);assert.equal(m.recall('Which objects are blue?').matches.length,7);
});

test('malformed or cross-domain checkpoints reject without changing the source',()=>{
  const m=new FactMemory();m.teach('The lamp is blue.');
  for(const corrupt of [s=>s.nodes[0].domainId='001',s=>s.snapshot.neurons[0].x=3000,s=>s.snapshot.features.gradient=true,s=>s.snapshot.neurons[0].nextGrowthAt=0,s=>s.concepts[0].cue=s.concepts[1].cue,s=>s.facts[0].valueKey='missing']){
    const saved=m.checkpoint();corrupt(saved);assert.throws(()=>new FactMemory(saved));
  }
});
