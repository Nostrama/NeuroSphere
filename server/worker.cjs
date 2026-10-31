'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { loadVocabulary, EngramVolume, EngramMemory, LockedController } = require('../src/index.cjs');

try {
  if (workerData.action === 'train') {
    const vocabulary = loadVocabulary();
    const volume = new EngramVolume(vocabulary, workerData.conceptIds, { seed: workerData.seed });
    for (let epoch = 1; epoch <= workerData.epochs; epoch++) {
      volume.train({ epochs: 1 });
      parentPort.postMessage({ type: 'progress', stage: 'training', epoch, total: workerData.epochs, seconds: volume.field.time });
    }
    const saved = volume.export(), memory = new EngramMemory(saved);
    let exact = 0, ambiguous = 0, unknown = 0;
    for (let index = 0; index < workerData.conceptIds.length; index++) {
      const record = vocabulary.get(workerData.conceptIds[index]);
      const result = memory.recall(record.word);
      if (result.status === 'recalled' && result.recalled[0].conceptId === record.id) exact++;
      else if (result.status === 'ambiguous') ambiguous++;
      else unknown++;
      parentPort.postMessage({ type: 'progress', stage: 'checking', checked: index + 1, totalWords: workerData.conceptIds.length, epoch: workerData.epochs, total: workerData.epochs });
    }
    parentPort.postMessage({ type: 'complete', memory: saved, evaluation: { exact, total: workerData.conceptIds.length, ambiguous, unknown, scope: 'Exact recall of the taught words; not a held-out test.' } });
  } else if (workerData.action === 'recall') {
    const memory = new EngramMemory(workerData.memory);
    const result = memory.recall(workerData.word, { domainId: workerData.domainId });
    // Replay the same untouched controller with a passive spike observer. The
    // animation uses measured events, never a synthetic illustration of recall.
    const trace = [];
    const runtime = new LockedController(workerData.memory.artifact, spike => trace.push({ neuronId: spike.neuronId, time: spike.time }));
    for (const domain of result.routedDomains) for (const bit of result.inputBits) runtime.io.pulse('d' + domain + '_f' + bit, 1);
    const samples=[];
    // Observe the same fixed-step controller. Reading state never changes it.
    const capture=()=>samples.push({time:runtime.time,values:runtime.neurons.filter(cell=>Math.abs(cell.potential-cell.restLevel)>1e-6).map(cell=>[cell.id,cell.potential])});
    capture();
    const steps=Math.floor((1+1e-10)/runtime.config.dt);
    for(let step=0;step<steps;step++) {runtime.step();capture();}
    const fired = new Set(trace.map(event => event.neuronId));
    for (const binding of workerData.memory.bindings.filter(binding => result.routedDomains.includes(binding.domainId))) {
      const count = binding.assembly.filter(id => fired.has(id)).length;
      if (count !== (result.activated.find(item => item.conceptId === binding.conceptId)?.activeCells ?? 0)) throw new Error('The observed replay did not match recall.');
    }
    parentPort.postMessage({ type: 'complete', result: { ...result, trace, samples, seconds: 1 } });
  } else throw new Error('Unknown worker action.');
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
}
