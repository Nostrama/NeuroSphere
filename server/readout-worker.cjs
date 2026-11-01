'use strict';
const {parentPort,workerData}=require('node:worker_threads');
try { parentPort.postMessage({type:'complete',result:require('./readout-probe.cjs').probe(workerData.memory,workerData.request)}); }
catch(error) { parentPort.postMessage({type:'error',error:error.message}); }
