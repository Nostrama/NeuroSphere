'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TextMemory,tokenize,tokenBits,LIMITS}=require('../src/text-memory.cjs');
const {applyDomainPolicy}=require('../src/domain-policy.cjs');
const roundtrip=m=>new TextMemory(JSON.parse(JSON.stringify(m.checkpoint())));
const weights=m=>new Map(m.field.links.map(e=>[e.id,e.weight]));

test('ordered tokenizer normalizes spelling, retains repeats, and bounds the experiment',()=>{
  assert.deepEqual(tokenize('  WHAT color is the lamp?! '),['what','color','is','the','lamp']);
  assert.deepEqual(tokenize('go go café'),['go','go','café']);
  assert.equal(new Set(tokenBits('lamp')).size,8);assert.deepEqual(tokenBits('lamp'),tokenBits('lamp'));
  for(const value of ['',null,'!!!','a '.repeat(9),'x'.repeat(201)])assert.throws(()=>tokenize(value));
});

test('empty workspace gives no learned response and roundtrips without inventing neurons',()=>{
  const m=roundtrip(new TextMemory());assert.equal(m.recall('hello').status,'unknown');assert.equal(m.field.neurons.length,0);
});

test('teacher pairing is necessary, and a response consists of measured output spikes',()=>{
  const untrained=new TextMemory();untrained.enroll('What color is the lamp?','bright blue');
  assert.equal(untrained.recall('what color is the lamp').status,'unknown');
  const m=new TextMemory();m.teach('What color is the lamp?','bright blue');
  const saved=m.checkpoint(),result=m.recall('WHAT color is the lamp!');
  assert.equal(result.response,'bright blue');assert.equal(result.status,'recalled');
  assert.deepEqual(result.matches[0].tokens.map(t=>t.text),['bright','blue']);
  assert.ok(result.matches[0].tokens.every(t=>result.trace.some(e=>e.neuronId===t.neuronId&&e.time===t.time)));
  assert.ok(result.matches[0].tokens[0].time<result.matches[0].tokens[1].time);
  assert.equal(result.samples.at(-1).time,result.seconds);assert.deepEqual(m.checkpoint(),saved,'recall must not change the saved network');
  for(const question of ['what color is the cup','lamp the is color what','what color is the','what color is the lamp now'])assert.equal(m.recall(question,{record:false}).status,'unknown',question);
});

test('answers depend on learned input and output synapses, not lesson metadata lookup',()=>{
  const m=new TextMemory();m.teach('the lamp is blue','yes');
  const metadata=roundtrip(m);metadata.lessons[0].question='a tree grows tall';metadata.lessons[0].answer='no';
  assert.equal(metadata.recall('the lamp is blue').response,'yes');
  assert.equal(metadata.recall('a tree grows tall').status,'unknown');
  for(const role of ['input','gate']){
    const ablated=roundtrip(m);
    for(const cell of ablated.field.neurons)if(ablated.meta.get(cell.id).role===role)for(const edge of cell.synapses)edge.weight=.001;
    assert.equal(ablated.recall('the lamp is blue').status,'unknown',role+' ablation');
  }
});

test('incremental lessons retain previous weights and survive full checkpoint restart',()=>{
  const m=new TextMemory();m.teach('What color is the lamp?','blue');const before=weights(m);
  m.teach('What color is the cup?','red');
  for(const edge of m.field.links)if(before.has(edge.id))assert.equal(edge.weight,before.get(edge.id));
  const restored=roundtrip(m);restored.teach('Where is the cup?','on the table');
  for(const [q,a]of [['what color is the lamp','blue'],['what color is the cup','red'],['where is the cup','on the table']])assert.equal(restored.recall(q,{record:false}).response,a);
  assert.equal(restored.revision,3);
  const checkpoint=restored.checkpoint();assert.throws(()=>restored.teach('What color is the lamp!','yellow'),/already taught/);assert.deepEqual(restored.checkpoint(),checkpoint);
});

test('same words in different orders learn distinct responses, including repeated tokens',()=>{
  const m=new TextMemory();m.teach('cats chase dogs','cats');m.teach('dogs chase cats','dogs');m.teach('go go stop','stop now');
  for(const [q,a]of [['cats chase dogs','cats'],['dogs chase cats','dogs'],['go go stop','stop now']])assert.equal(m.recall(q,{record:false}).response,a);
  assert.equal(m.recall('go stop go').status,'unknown');
});

test('domains stay isolated inside one volume, with explicit ambiguity on the shared bus',()=>{
  const m=new TextMemory();m.teach('what is a bank','a river edge','001');m.teach('what is a bank','a money service','005');
  assert.equal(m.recall('what is a bank').status,'ambiguous');
  assert.equal(m.recall('what is a bank',{domainId:'001'}).response,'a river edge');
  assert.equal(m.recall('what is a bank',{domainId:'005'}).response,'a money service');
  assert.equal(m.recall('what is a bank',{domainId:'009'}).status,'unknown');
  assert.ok(m.field.links.every(e=>m.membership.get(e.sourceId)===m.membership.get(e.targetId)));
  assert.ok(m.field.neurons.every(n=>Math.hypot(n.x-400,n.y-400,n.z-400)<=400));
});

test('domain policy filters sensing by membership regardless of physical proximity',()=>{
  const peers=[{id:1},{id:2},{id:3}],field={env:{forNeuron:()=>({sense:()=>peers})}};
  const membership=new Map([[1,'001'],[2,'002'],[3,'001']]);applyDomainPolicy(field,membership);
  assert.deepEqual(field.env.forNeuron({id:1}).sense(),[peers[0],peers[2]]);
  assert.deepEqual(field.env.forNeuron({id:9}).sense(),[]);
  membership.set(2,'001');assert.equal(field.env.forNeuron({id:1}).sense().length,3);
});

test('maximum length lessons fit original Neuron terminal limits and decode eight words',()=>{
  const m=new TextMemory(),q='one two three four five six seven eight',a='eight seven six five four three two one';m.teach(q,a);
  assert.equal(m.recall(q).response,a);assert.ok(m.field.neurons.every(n=>n.synapses.length<=10));
  for(let i=1;i<LIMITS.lessons;i++)m.enroll('question '+i,'answer '+i);
  assert.throws(()=>m.enroll('one more','answer'),/16/);assert.ok(m.field.neurons.length<=2000);
});

test('checkpoint validation rejects malformed membership, active growth and configuration',()=>{
  const m=new TextMemory();m.teach('hello there','hello');
  for(const corrupt of [s=>s.nodes[0].domainId='999',s=>s.nodes[0].lessonId='orphan',s=>s.snapshot.features.gradient=true,s=>s.snapshot.neurons[0].nextGrowthAt=0,s=>s.snapshot.neurons[0].x=2000,s=>s.lessons[0].outputs.pop()]){
    const saved=m.checkpoint();corrupt(saved);assert.throws(()=>new TextMemory(saved));
  }
});
