'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadVocabulary, EngramVolume, EngramMemory } = require('..');

function runExperiment() {
  const vocabulary = loadVocabulary();
  const records = vocabulary.samplePerDomain(2);
  const ids = records.map(record => record.id);
  const volume = new EngramVolume(vocabulary, ids);
  const before = new EngramMemory(volume.export());
  volume.train({ epochs: 24 });
  const saved = volume.export();
  const memory = new EngramMemory(saved);
  const disabled = new EngramMemory(new EngramVolume(vocabulary, ids, { learning: false }).train({ epochs: 24 }).export());
  const featureCells = new Set(saved.regions.flatMap(region => region.featureCells));
  const ablated = structuredClone(saved);
  for (const edge of ablated.artifact.edges) if (featureCells.has(edge.sourceId)) edge.weight = 0.02;
  const withoutWeights = new EngramMemory(ablated);
  const exact = (model, record) => {
    const result = model.recall(record.word);
    return result.status === 'recalled' && result.recalled[0].conceptId === record.id;
  };
  const rows = records.map(record => ({
    conceptId: record.id, word: record.word, domainId: record.domainId,
    before: exact(before, record), learned: exact(memory, record),
    learningDisabled: exact(disabled, record), ablated: exact(withoutWeights, record)
  }));
  const probes = ['banana', 'quantum', 'neurosphere', 'xyzzy', 'notaword', 'zebra', 'water', 'computer'];
  const negatives = probes.map(word => ({ word, ...memory.recall(word) }));
  const restored = new EngramMemory(JSON.parse(JSON.stringify(saved)));
  const restoredExact = records.filter(record => exact(restored, record)).length;
  const retainedProbe = restored.recall(records[0].word, { idleSeconds: 60 });
  const report = {
    schema: 'neurosphere-engram-pilot/v1',
    interpretation: 'Developmental exact-word associative recall on an assigned scaffold. Retention uses an explicit circuit lock. No claim of semantic understanding, neural storage of definitions, autonomous domain discovery, generalization, or biological engrams.',
    sourceHash: vocabulary.sourceHash, availableConcepts: vocabulary.records.length,
    codeHashes: Object.fromEntries(['src/engram-volume.cjs', 'src/vocabulary.cjs', 'examples/engrams.cjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')])),
    inputCode: saved.encoding, leadingCellThreshold: 1.6,
    enrolledConcepts: records.length, domains: saved.regions.length, neurons: saved.artifact.nodes.length,
    synapses: saved.artifact.edges.length, epochs: 24, trainingSeconds: volume.field.time,
    exactBefore: rows.filter(row => row.before).length, exactLearned: rows.filter(row => row.learned).length,
    exactLearningDisabled: rows.filter(row => row.learningDisabled).length,
    exactAfterAblation: rows.filter(row => row.ablated).length,
    untrainedProbeCount: negatives.length, untrainedProbeFalseRecalls: negatives.filter(row => row.status !== 'unknown').length,
    exactAfterSerialization: restoredExact,
    firstWordRetainedAfter60SecondsLocked: retainedProbe.status === 'recalled' && retainedProbe.recalled[0].conceptId === records[0].id,
    rows, negatives
  };
  return { report, memory: saved };
}

if (require.main === module) {
  const { report, memory } = runExperiment();
  const output = process.argv[2];
  if (output) {
    const directory = path.resolve(output);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'engram-pilot.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(directory, 'engram-memory.json'), JSON.stringify(memory) + '\n');
  }
  const { rows, negatives, ...summary } = report;
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (report.exactBefore !== 0 || report.exactLearned !== report.enrolledConcepts || report.exactLearningDisabled !== 0 || report.exactAfterAblation !== 0 || report.untrainedProbeFalseRecalls !== 0 || report.exactAfterSerialization !== report.enrolledConcepts || !report.firstWordRetainedAfter60SecondsLocked) process.exitCode = 1;
}
module.exports = { runExperiment };
