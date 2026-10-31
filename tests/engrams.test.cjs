'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadVocabulary, encodeWord, EngramVolume, EngramMemory } = require('..');
const vocabulary = loadVocabulary();
const records = ['aardvark', 'abdomen', 'aback', 'abashed', 'abbé'].map(word => vocabulary.findWord(word)[0]);
const ids = records.map(record => record.id);
const trained = new EngramVolume(vocabulary, ids).train();
const saved = trained.export();
const memory = new EngramMemory(saved);

test('complete A-section import preserves 1826 concept records, all nine domains and homographs', () => {
  assert.equal(vocabulary.records.length, 1826);
  assert.equal(Object.keys(vocabulary.domains).length, 9);
  assert.equal(vocabulary.findWord('abacus').length, 2);
  assert.equal(vocabulary.findWord('ABBÉ')[0].word, 'abbé');
  assert.equal(vocabulary.samplePerDomain(2).length, 18);
  assert.ok(vocabulary.records.every(record => vocabulary.domains[record.domainId]));
  assert.ok(Object.isFrozen(vocabulary.records[0].links));
});

test('input coding is deterministic, independent of corpus lookup, and bounded', () => {
  assert.deepEqual(encodeWord('ABBÉ'), encodeWord('abbe'));
  const bits = encodeWord('invented-new-word');
  assert.equal(new Set(bits).size, 8);
  assert.ok(bits.every(bit => Number.isInteger(bit) && bit >= 0 && bit < 192));
  assert.throws(() => encodeWord(''));
  assert.throws(() => encodeWord({ word: 'aback' }));
});

test('untrained and Hebbian-disabled controls do not recall the taught word identities', () => {
  const untrained = new EngramMemory(new EngramVolume(vocabulary, ids).export());
  const disabled = new EngramMemory(new EngramVolume(vocabulary, ids, { learning: false }).train().export());
  for (const record of records) {
    assert.equal(untrained.recall(record.word).status, 'unknown');
    assert.equal(disabled.recall(record.word).status, 'unknown');
  }
});

test('teacher-free spikes complete the correct learned assembly, including two words in one domain', () => {
  for (const record of records) {
    const result = memory.recall(record.word);
    assert.equal(result.status, 'recalled');
    assert.deepEqual(result.recalled.map(row => row.conceptId), [record.id]);
    assert.equal(result.recalled[0].activeCells, 3);
  }
  for (const word of ['notaword', 'quantum', 'banana', 'xyzzy']) assert.equal(memory.recall(word).status, 'unknown');
});

test('domain routing isolates traffic and does not use a dictionary to route the cue', () => {
  assert.equal(memory.recall('aardvark', { domainId: '002' }).status, 'unknown');
  assert.deepEqual(memory.recall('aardvark', { domainId: '001' }).routedDomains, ['001']);
  assert.throws(() => memory.recall('aardvark', { domainId: '999' }), /not enrolled/);
});

test('ablating learned feature weights removes recall while preserving all dictionary bindings', () => {
  const ablated = structuredClone(saved);
  const featureCells = new Set(ablated.regions.flatMap(region => region.featureCells));
  for (const edge of ablated.artifact.edges) if (featureCells.has(edge.sourceId)) edge.weight = 0.02;
  const empty = new EngramMemory(ablated);
  for (const record of records) assert.equal(empty.recall(record.word).status, 'unknown');
  assert.deepEqual(ablated.bindings, saved.bindings);
});

test('serialized locked memory retains recall after silence and probing cannot mutate it', () => {
  const restored = new EngramMemory(JSON.parse(JSON.stringify(memory.export())));
  const before = restored.export();
  assert.equal(JSON.stringify(before).includes('aardvark'), false, 'The inference artifact does not contain dictionary words or definitions.');
  assert.deepEqual(restored.recall('aardvark', { idleSeconds: 60 }), memory.recall('aardvark'));
  assert.deepEqual(restored.export(), before);
  assert.throws(() => restored.recall('aardvark', { idleSeconds: Infinity }));
});

test('same-spelling senses remain ambiguous until domain context is supplied', () => {
  const senses = vocabulary.findWord('abandon');
  assert.equal(senses.length, 2);
  const model = new EngramMemory(new EngramVolume(vocabulary, senses.map(record => record.id)).train().export());
  assert.equal(model.recall('abandon').status, 'ambiguous');
  assert.equal(model.recall('abandon', { domainId: senses[0].domainId }).status, 'recalled');
});

test('layout capacities and malformed imports are rejected rather than silently clipped', () => {
  assert.throws(() => new EngramVolume(vocabulary, ['missing']));
  assert.throws(() => new EngramVolume(vocabulary, [ids[0], ids[0]]));
  const nine = vocabulary.records.filter(record => record.domainId === '001').slice(0, 9).map(record => record.id);
  assert.throws(() => new EngramVolume(vocabulary, nine), /at most eight/);
  assert.throws(() => new EngramVolume(vocabulary, ids).train({ epochs: 101 }));
  const bad = structuredClone(saved); bad.bindings[0].assembly[0] = bad.regions[0].featureCells[0];
  assert.throws(() => new EngramMemory(bad), /Overlapping/);
  const wrong = structuredClone(saved); wrong.regions[0].featureCells[0] = wrong.regions[0].featureCells[1];
  assert.throws(() => new EngramMemory(wrong), /feature cell/);
});
