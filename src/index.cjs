'use strict';

const core = require('./neuron/neuron.js');
const simulation = require('./neuron/simulation.js');
const controller = require('./neuron/controller.js');
const development = require('./neuron/development.js');
const vocabulary = require('./vocabulary.cjs');

// Keep Neuron's dynamics untouched; this is the headless package boundary.
module.exports = Object.freeze({
  ...simulation,
  ...development,
  TextMemory: require('./text-memory.cjs').TextMemory,
  FactMemory: require('./fact-memory.cjs').FactMemory,
  ...require('./engram-volume.cjs'),
  loadVocabulary: vocabulary.loadVocabulary,
  encodeWord: vocabulary.encodeWord,
  normalizeWord: vocabulary.normalize,
  SpikeIO: require('./neuron/spike-io.js').SpikeIO,
  SpatialHash: require('./neuron/spatial.js').SpatialHash,
  LogicTask: require('./neuron/logic-task.js').LogicTask,
  AssemblyTask: require('./neuron/assembly-task.js').AssemblyTask,
  LockedController: controller.LockedController,
  compileController: controller.compile,
  resumeController: controller.resume,
  inspectController: controller.structure,
  core,
  controller,
  population: require('./neuron/population.js'),
  presets: require('./neuron/presets.js')
});

