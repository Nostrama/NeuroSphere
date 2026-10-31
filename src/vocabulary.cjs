'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalize, validate } = require('./vocabulary/upstream-engine.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const WORD_CODE = Object.freeze({ version: 'neurosphere-word-v2/192/8', features: 192, active: 8 });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function loadVocabulary() {
  const bytes = fs.readFileSync(path.join(__dirname, '../data/a-concept-brain.json'));
  const brain = validate(JSON.parse(bytes));
  const records = freeze(brain.concepts.map(record => ({ ...record, domainId: record.id.split('-')[0], branchId: record.id.split('-').slice(0, 2).join('-') })));
  const domains = freeze(structuredClone(brain.domains));
  const byId = new Map(records.map(record => [record.id, record]));
  return Object.freeze({
    sourceHash: hash(bytes), records, domains,
    get(id) { const record = byId.get(id); if (!record) throw new Error('Unknown concept ID: ' + id); return record; },
    findWord(word) { return records.filter(record => normalize(record.word) === normalize(word)); },
    samplePerDomain(count = 2) {
      if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Choose 1–8 records per domain for this pilot.');
      return Object.keys(domains).flatMap(domainId => {
        const seen = new Set();
        return records.filter(record => {
          if (record.domainId !== domainId || seen.has(normalize(record.word))) return false;
          seen.add(normalize(record.word)); return true;
        }).slice(0, count);
      });
    }
  });
}

// A sparse exact-spelling input code. It does not encode meaning or look up a word.
function encodeWord(word) {
  if (typeof word !== 'string' || word.length > 200) throw new Error('A word cue must be a string of at most 200 characters.');
  const text = normalize(word);
  if (!text) throw new Error('A word cue must contain letters or digits.');
  const bits = new Set();
  for (let counter = 0; bits.size < WORD_CODE.active; counter++) {
    const bytes = createHash('sha256').update('neurosphere-word-v2:' + counter + ':' + text).digest();
    for (let offset = 0; offset < bytes.length; offset += 2) {
      const value = bytes.readUInt16BE(offset);
      if (value >= Math.floor(65536 / WORD_CODE.features) * WORD_CODE.features) continue;
      bits.add(value % WORD_CODE.features);
      if (bits.size === WORD_CODE.active) break;
    }
  }
  return [...bits].sort((a, b) => a - b);
}
module.exports = { loadVocabulary, normalize, encodeWord, WORD_CODE };
