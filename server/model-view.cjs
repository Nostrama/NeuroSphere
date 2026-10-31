'use strict';
const { EngramMemory } = require('../src/index.cjs');
const { compactMemory } = require('../src/domain-layout.cjs');

function validateMemory(memory, vocabulary) {
  new EngramMemory(memory);
  if (memory.sourceHash !== vocabulary.sourceHash) throw new Error('This memory belongs to a different vocabulary.');
  for (const region of memory.regions) {
    if (!region.center || !['x','y','z'].every(axis => Number.isFinite(region.center[axis])) || !Number.isFinite(region.radius) || region.radius <= 0) throw new Error('This memory has invalid region coordinates.');
  }
  memory.bindings.forEach(binding => vocabulary.get(binding.conceptId));
  return compactMemory(memory);
}

function summary(memory, vocabulary, { id, name, origin, createdAt, evaluation = null } = {}) {
  return { id, name, origin, createdAt, evaluation, words: memory.bindings.length,
    domains: memory.regions.length, neurons: memory.artifact.nodes.length,
    connections: memory.artifact.edges.length,
    epochs: Number.isInteger(memory.training?.epochs) ? memory.training.epochs : null,
    conceptIds: memory.bindings.map(binding => binding.conceptId) };
}

function scene(memory, vocabulary) {
  const roles = new Map();
  for (const region of memory.regions) region.featureCells.forEach((id, bit) => roles.set(id, { role: 'input', domainId: region.domainId, bit }));
  for (const binding of memory.bindings) binding.assembly.forEach((id, member) => roles.set(id, { role: 'memory', domainId: binding.domainId, conceptId: binding.conceptId, member }));
  return {
    nodes: memory.artifact.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, z: node.z, threshold:node.threshold,restLevel:node.restLevel,leakRate:node.leakRate,health:node.health,age:node.age, ...roles.get(node.id) })),
    edges: memory.artifact.edges.map(edge => ({ id:edge.id,source: edge.sourceId, target: edge.targetId, weight: edge.weight,delay:edge.delay,consolidated:edge.consolidated })),
    regions: memory.regions.map(region => ({ domainId: region.domainId, name: vocabulary.domains[region.domainId].name, center: region.center, radius: region.radius })),
    concepts: memory.bindings.map(binding => ({ ...binding, word: vocabulary.get(binding.conceptId).word, sense: vocabulary.get(binding.conceptId).sense })),
    extent: memory.artifact.config.extent,
    volume: memory.volume,
    ports: {
      sense: {name:'Sense Input',kind:'encoded-word-bus',position:{x:0,y:400,z:400},cellIds:memory.regions.flatMap(region=>region.featureCells)},
      output: {name:'Output',kind:'engram-readout',position:{x:800,y:400,z:400},cellIds:memory.bindings.flatMap(binding=>binding.assembly)}
    }
  };
}
module.exports = { validateMemory, summary, scene };
