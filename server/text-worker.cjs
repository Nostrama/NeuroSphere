'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {TextMemory,tokenize}=require('../src/text-memory.cjs');
try{
  const text=new TextMemory(workerData.checkpoint);
  if(workerData.action==='teach'){
    text.teach(workerData.question,workerData.answer,workerData.domainId,progress=>parentPort.postMessage({type:'progress',stage:'training',...progress}));
    let exact=0;
    for(const [index,lesson]of text.lessons.entries()){
      const result=text.recall(lesson.question,{domainId:lesson.domainId,record:false});
      if(result.status==='recalled'&&result.matches[0].conceptId===lesson.id&&result.response===tokenize(lesson.answer).join(' '))exact++;
      parentPort.postMessage({type:'progress',stage:'checking',checked:index+1,totalWords:text.lessons.length});
    }
    if(exact!==text.lessons.length)throw new Error('Retention check failed. The previous text workspace is unchanged.');
    parentPort.postMessage({type:'complete',checkpoint:text.checkpoint(),evaluation:{exact,total:text.lessons.length,scope:'Previously taught and new phrase recall within each domain; not a generalization test.'}});
  }else if(workerData.action==='sense')parentPort.postMessage({type:'complete',result:text.recall(workerData.word)});
  else throw new Error('Unknown text action.');
}catch(error){parentPort.postMessage({type:'error',error:error.message});}
