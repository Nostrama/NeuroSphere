'use strict';
const { LAYOUT } = require('../src/domain-layout.cjs');
const { LIMITS } = require('../src/fact-memory.cjs');
const { questions } = require('../src/fact-language.cjs');
function summary(memory) {
  return {id:'facts',kind:'facts',revision:memory.revision,name:'Fact learning workspace',origin:'Shared concepts · persistent facts',words:memory.facts.length,
    domains:new Set(memory.nodes.map(n=>n.domainId)).size,neurons:memory.nodes.length,connections:memory.field.links.length,epochs:memory.revision?LIMITS.rounds:0,
    sharedConcepts:memory.concepts.filter(c=>c.type==='term').length,conceptIds:memory.facts.map(f=>f.id),limits:LIMITS};
}
function records(memory) { return memory.facts.map(f=>({id:f.id,word:questions(f).forward,sense:'Learned '+f.relation,gloss:f.object,domainId:f.domainId})); }
function facts(memory) { return memory.facts.map(f=>({...f,questions:questions(f)})); }
function scene(memory,vocabulary) {
  const concepts = new Map(memory.concepts.map(c=>[c.key,c]));
  return {
    nodes:memory.field.neurons.map(n=>{
      const meta=memory.meta.get(n.id),concept=concepts.get(meta.conceptKey),fact=memory.facts.find(f=>f.id===meta.factId);
      const label=concept?concept.label+' · '+(meta.role==='relay'?meta.direction+' relay':meta.role==='cue'?'concept cue':'concept readout'):(fact.subject+' → '+fact.relation+' → '+fact.object+' · '+meta.direction+' engram');
      return {id:n.id,x:n.x,y:n.y,z:n.z,threshold:n.threshold,restLevel:n.restLevel,leakRate:n.leakRate,health:n.health,age:n.age,domainId:meta.domainId,
        role:['cue','relay'].includes(meta.role)?'input':'memory',factRole:meta.role,conceptKey:meta.conceptKey,conceptId:meta.factId,member:0,label};
    }),
    edges:memory.field.links.map(e=>({id:e.id,source:e.sourceId,target:e.targetId,weight:e.weight,delay:e.delay,consolidated:e.consolidated})),
    regions:[...new Set(memory.nodes.map(n=>n.domainId))].map(domainId=>({domainId,name:vocabulary.domains[domainId].name,center:{...LAYOUT.center},radius:400})),
    concepts:memory.facts.map(f=>({conceptId:f.id,domainId:f.domainId,assembly:[f.forward,f.reverse],word:questions(f).forward,sense:'Fact binding'})),
    sharedConcepts:memory.concepts.map(c=>({...c})),extent:{...LAYOUT.extent},volume:structuredClone(LAYOUT),
    ports:{sense:{name:'Sense Input',kind:'concept-cue-bus',position:{x:0,y:400,z:400},cellIds:memory.nodes.filter(n=>n.role==='cue').map(n=>n.id)},
      output:{name:'Output',kind:'concept-spike-readout',position:{x:800,y:400,z:400},cellIds:memory.nodes.filter(n=>n.role==='readout').map(n=>n.id)}}
  };
}
module.exports={summary,records,facts,scene};
