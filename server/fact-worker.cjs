'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { FactMemory } = require('../src/fact-memory.cjs');
try {
  const memory = new FactMemory(workerData.checkpoint);
  if (workerData.action === 'teach') {
    memory.teach(workerData.statement,workerData.domainId,progress=>parentPort.postMessage({type:'progress',stage:'training',...progress}));
    parentPort.postMessage({type:'progress',stage:'checking',checked:0,totalWords:memory.facts.length});
    const evaluation = memory.evaluate();
    if (evaluation.exact !== evaluation.total) throw new Error('Fact retention check failed. Your previous workspace is unchanged.');
    parentPort.postMessage({type:'complete',checkpoint:memory.checkpoint(),evaluation});
  } else if (workerData.action === 'sense') parentPort.postMessage({type:'complete',result:memory.recall(workerData.word)});
  else throw new Error('Unknown fact action.');
} catch(error) { parentPort.postMessage({type:'error',error:error.message}); }
