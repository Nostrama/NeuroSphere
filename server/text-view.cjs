'use strict';
const {LAYOUT}=require('../src/domain-layout.cjs');
const {LIMITS}=require('../src/text-memory.cjs');
function summary(text){return{id:'text',kind:'text',revision:text.revision,name:'Text learning workspace',origin:'Persistent lessons',words:text.lessons.length,domains:new Set(text.nodes.map(n=>n.domainId)).size,neurons:text.nodes.length,connections:text.field.links.length,epochs:text.revision?LIMITS.rounds:0,conceptIds:text.lessons.map(l=>l.id),limits:LIMITS};}
function records(text){return text.lessons.map(l=>({id:l.id,word:l.question,sense:'Taught phrase',gloss:l.answer,domainId:l.domainId}));}
function scene(text,vocabulary){
  const metadata=new Map(text.nodes.map(n=>[n.id,n])),roles={input:'input',detector:'memory',gate:'memory',output:'memory'};
  return{nodes:text.field.neurons.map(n=>{const meta=metadata.get(n.id);return{id:n.id,x:n.x,y:n.y,z:n.z,threshold:n.threshold,restLevel:n.restLevel,leakRate:n.leakRate,health:n.health,age:n.age,domainId:meta.domainId,role:roles[meta.role],textRole:meta.role,conceptId:meta.lessonId,member:meta.position??0,bit:meta.bit,token:meta.token==='\u0000end'?'[end]':meta.token,label:meta.role==='input'?'Token feature '+meta.bit:meta.role==='detector'?'Position detector '+(meta.position+1):meta.role==='gate'?'Phrase completion':meta.token==='\u0000end'?'End of response':'Output: '+meta.token};}),
    edges:text.field.links.map(e=>({id:e.id,source:e.sourceId,target:e.targetId,weight:e.weight,delay:e.delay,consolidated:e.consolidated})),
    regions:[...new Set(text.nodes.map(n=>n.domainId))].map(domainId=>({domainId,name:vocabulary.domains[domainId].name,center:{...LAYOUT.center},radius:400})),
    concepts:text.lessons.map(l=>({conceptId:l.id,domainId:l.domainId,assembly:[l.gate,...l.outputs],word:l.question,sense:'Taught phrase'})),extent:{...LAYOUT.extent},volume:structuredClone(LAYOUT),
    ports:{sense:{name:'Sense Input',kind:'ordered-token-bus',position:{x:0,y:400,z:400},cellIds:text.nodes.filter(n=>n.role==='input').map(n=>n.id)},output:{name:'Output',kind:'token-spike-readout',position:{x:800,y:400,z:400},cellIds:text.nodes.filter(n=>n.role==='output').map(n=>n.id)}}};
}
module.exports={summary,scene,records};
