'use strict';
const root = process.argv[2], dir = process.argv[3];
const { LockedController } = require(root + '/src/neuron/controller.js');
const m = JSON.parse(require('fs').readFileSync(dir + '/memory.json', 'utf8'));
const t = JSON.parse(require('fs').readFileSync(dir + '/trials.json', 'utf8'));
const bits = { A: [21, 99, 107, 111, 117, 140, 165, 171], B: [3, 23, 29, 33, 36, 110, 116, 185] };
const feat = new Set(m.features), pool = new Set(m.pool);
const art = m.artifact, byId = new Map(art.nodes.map(n => [n.id, n]));
const featureOfInput = new Map(art.io.inputs.map(i => [i.cells[0], Number(i.name.slice(1))]));
function replay(cue) {
  const fired = new Map();
  const rt = new LockedController(art, sp => { if (pool.has(sp.neuronId) && !fired.has(sp.neuronId)) fired.set(sp.neuronId, rt.tick); });
  const t0 = rt.tick + 1;
  for (const b of bits[cue]) rt.io.pulse('f' + b, t0);
  rt.advance(1.2);
  // afferent-only expected first arrival per pool cell from the cue's active features
  const active = new Set(bits[cue]);
  const expected = new Map();
  for (const e of art.edges) if (feat.has(e.sourceId) && active.has(featureOfInput.get(e.sourceId)) && pool.has(e.targetId)) {
    const arr = t0 + e.delay / 0.02; if (!expected.has(e.targetId) || arr < expected.get(e.targetId)) expected.set(e.targetId, arr);
  }
  const core = t.primary.cores[cue];
  const rows = core.map(id => ({ id, fired: fired.get(id), afferent: expected.get(id) }));
  const direct = rows.filter(r => r.afferent !== undefined && r.fired !== undefined);
  const early = direct.filter(r => r.fired < r.afferent - 0.5), onTime = direct.filter(r => Math.abs(r.fired - r.afferent) <= 0.5), late = direct.filter(r => r.fired > r.afferent + 0.5);
  const recruits = rows.filter(r => r.afferent === undefined);
  const ticks = [...fired.values()].sort((a, b) => a - b).map(x => x - t0);
  const spread = ticks.length ? ticks.at(-1) - ticks[0] : null;
  const hist = {}; for (const x of ticks) hist[x] = (hist[x] || 0) + 1;
  console.log(`cue ${cue}: core ${core.length}, fired ${fired.size} pool cells; direct-in-core ${direct.length}: fired BEFORE own afferent ${early.length}, at afferent ${onTime.length}, after ${late.length}; recruits fired ${recruits.filter(r => r.fired !== undefined).length}/${recruits.length}`);
  console.log(`   first-spike ticks after pulse → count: ${JSON.stringify(hist)}  (spread ${spread} ticks)`);
  const lead = early.map(r => (r.afferent - r.fired).toFixed(1)); console.log(`   early cells lead their afferent by ticks: ${lead.slice(0, 12).join(', ')}${lead.length > 12 ? ' …' : ''}`);
}
replay('A'); replay('B');
// what the afferent-only spread would be
const d = art.edges.filter(e => feat.has(e.sourceId)).map(e => e.delay / 0.02).sort((a, b) => a - b);
console.log(`afferent delay ticks (all 1536): min ${d[0].toFixed(1)} max ${d.at(-1).toFixed(1)}`);
