'use strict';
const { SpikingField } = require('./neuron/field.js');
const { DevelopmentSession } = require('./neuron/development.js');
const { LockedController, compile } = require('./neuron/controller.js');
const { encodeWord, WORD_CODE } = require('./vocabulary.cjs');
const { LAYOUT, domainCenter, distributeNeurons, validateCompartments } = require('./domain-layout.cjs');
const { applyDomainPolicy } = require('./domain-policy.cjs');
const copy = value => structuredClone(value);
const ENCODING = WORD_CODE.version;
const SCHEMA = 'neurosphere-engram-volume/v1';
const inputName = (domain, bit) => 'd' + domain + '_f' + bit;
const outputName = id => 'c' + id.replaceAll('-', '_');

// Experimental scaffold: shared feature cells project to three-cell assemblies.
// Word->assembly associations are learned through Neuron's Hebbian update.
// The scaffold and domain labels are assigned by the host, not self-discovered.
class EngramVolume {
  constructor(vocabulary, conceptIds, { seed = 1, learning = true } = {}) {
    if (!Array.isArray(conceptIds) || !conceptIds.length || new Set(conceptIds).size !== conceptIds.length) throw new Error('Supply distinct concept IDs.');
    if (typeof learning !== 'boolean') throw new Error('learning must be boolean.');
    const records = conceptIds.map(id => vocabulary.get(id));
    const grouped = new Map();
    for (const record of records) {
      if (!grouped.has(record.domainId)) grouped.set(record.domainId, []);
      grouped.get(record.domainId).push(record);
    }
    for (const group of grouped.values()) if (group.length > 8) throw new Error('This pilot supports at most eight engrams per domain; the full corpus is available for selection.');
    this.sourceHash = vocabulary.sourceHash;
    this.records = records;
    this.bindings = [];
    this.regions = [];
    this.epochs = 0;
    this.learning = learning;
    this.field = new SpikingField({ empty: true, seed,
      config: { dimensions: 3, extent: { ...LAYOUT.extent }, maxCells: 2000,
        radius: 150, maxSynapses: 8, growthPeriod: 10000, initialWeight: 0.02, weightFloor: 0.001,
        weightDecay: 0.0001, unusedDecay: 0, healthLoss: 0, pairingClock: 'arrival' },
      features: { hebbian: learning, reward: false, gradient: false, consolidation: false }
    });
    const inputs = [], outputs = [];
    const add = position => {
      const cell = this.field.addNeuron(position);
      cell.nextGrowthAt = 10000;
      return cell;
    };
    for (const [domainId, group] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
      const center = domainCenter(domainId);
      const features = [];
      for (let bit = 0; bit < WORD_CODE.features; bit++) {
        const y = 1 - 2 * (bit + 0.5) / WORD_CODE.features, angle = bit * 2.3999632297, r = Math.sqrt(1 - y * y);
        const cell = add({ x: center.x + 40 * r * Math.cos(angle), y: center.y + 40 * y, z: center.z + 40 * r * Math.sin(angle) });
        features.push(cell);
        inputs.push({ name: inputName(domainId, bit), cells: [cell.id] });
      }
      this.regions.push({ domainId, center, radius: 100, featureCells: features.map(cell => cell.id) });
      group.forEach((record, index) => {
        const assembly = Array.from({ length: 3 }, (_, member) => add({ x: center.x - 30 + index * 8, y: center.y + 60, z: center.z - 20 + member * 20, recordOutput: true }));
        // Require more coincident learned features than the generic relay cell.
        // This fixed pilot threshold is independent of the queried word or label.
        assembly[0].threshold = 1.6;
        for (const feature of features) if (!feature.connect(assembly[0], 0, 0.02)) throw new Error('Feature projection could not be allocated.');
        if (!assembly[0].connect(assembly[1], 0, 1.3) || !assembly[1].connect(assembly[2], 0, 1.3)) throw new Error('Assembly could not be allocated.');
        outputs.push({ name: outputName(record.id), cells: assembly.map(cell => cell.id), mode: 'count' });
        this.bindings.push({ conceptId: record.id, domainId, assembly: assembly.map(cell => cell.id) });
      });
    }
    // Retain the established scaffold's transmission delays, then place the
    // actual neurons throughout the common volume before any learning steps.
    // No model RNG draws or additional connections are introduced by placement.
    distributeNeurons(this.field.neurons,this.regions,this.bindings);
    this.session = new DevelopmentSession(this.field, {}, { inputs, outputs });
    const membership=new Map();
    for(const region of this.regions)for(const id of region.featureCells)membership.set(id,region.domainId);
    for(const binding of this.bindings)for(const id of binding.assembly)membership.set(id,binding.domainId);
    applyDomainPolicy(this.field,membership);
    this.teacher = new Map();
    const prior = this.field.env.forNeuron.bind(this.field.env);
    this.field.env.forNeuron = (cell, frame) => {
      const env = prior(cell, frame);
      if (this.teacher.get(cell.id) === this.field.tick) env.forcedSpike = true;
      return env;
    };
  }

  train({ epochs = 24 } = {}) {
    if (this.field.circuitLock) throw new Error('The volume is locked. Create a new training volume.');
    if (!Number.isInteger(epochs) || epochs < 1 || epochs + this.epochs > 100) throw new Error('Use a total of 1–100 training epochs.');
    const groups = this.regions.map(region => this.records.filter(record => record.domainId === region.domainId));
    const slots = Math.max(...groups.map(group => group.length));
    for (let epoch = 0; epoch < epochs; epoch++) for (let slot = 0; slot < slots; slot++) {
      const start = this.field.tick;
      this.teacher.clear();
      for (const group of groups) {
        const record = group[slot];
        if (!record) continue;
        for (const bit of encodeWord(record.word)) this.session.io.pulse(inputName(record.domainId, bit), start + 1);
        const binding = this.bindings.find(item => item.conceptId === record.id);
        this.teacher.set(binding.assembly[0], start + 8);
      }
      for (let tick = 0; tick < 100; tick++) this.session.step();
      this.teacher.clear();
    }
    this.epochs += epochs;
    return this;
  }

  export() {
    // Snapshot and lock a copy: measuring recall must not train or freeze the host.
    const field = SpikingField.fromSnapshot(this.field.snapshot());
    field.lockCircuit('NeuroSphere engram recall export');
    return { schema: SCHEMA, encoding: ENCODING, sourceHash: this.sourceHash,
      volume: copy(LAYOUT),
      regions: copy(this.regions), bindings: copy(this.bindings),
      training: { epochs: this.epochs, hebbian: this.learning, scaffold: 'assigned three-cell assemblies; dense shared feature projections' },
      artifact: compile(field, { name: 'NeuroSphere word engrams', io: this.session.io.config }) };
  }
}

class EngramMemory {
  constructor(saved) {
    if (saved?.schema !== SCHEMA || saved.encoding !== ENCODING || !/^[a-f0-9]{64}$/.test(saved.sourceHash)) throw new Error('Unsupported engram memory.');
    new LockedController(saved.artifact);
    const ids = new Set(saved.artifact.nodes.map(cell => cell.id));
    if (!Array.isArray(saved.regions) || !saved.regions.length || saved.regions.length > 9 || !Array.isArray(saved.bindings) || !saved.bindings.length || saved.bindings.length > 72) throw new Error('Invalid engram layout.');
    const domains = new Set(), occupied = new Set(), concepts = new Set(), membership = new Map(), counts = new Map();
    for (const region of saved.regions) {
      if (!/^00[1-9]$/.test(region.domainId) || domains.has(region.domainId) || !Array.isArray(region.featureCells) || region.featureCells.length !== WORD_CODE.features) throw new Error('Invalid feature region.');
      domains.add(region.domainId);
      region.featureCells.forEach((id, bit) => {
        const port = saved.artifact.io.inputs.find(input => input.name === inputName(region.domainId, bit));
        if (!ids.has(id) || occupied.has(id) || !port || port.cells.length !== 1 || port.cells[0] !== id) throw new Error('Invalid feature cell or input port.');
        occupied.add(id);
        membership.set(id, region.domainId);
      });
    }
    for (const binding of saved.bindings) {
      if (!/^\d{3}-\d{3}-\d{3}$/.test(binding.conceptId) || concepts.has(binding.conceptId) || !domains.has(binding.domainId) || binding.conceptId.split('-')[0] !== binding.domainId || !Array.isArray(binding.assembly) || binding.assembly.length !== 3) throw new Error('Invalid engram binding.');
      concepts.add(binding.conceptId);
      for (const id of binding.assembly) { if (!ids.has(id) || occupied.has(id)) throw new Error('Overlapping or missing assembly cell.'); occupied.add(id); membership.set(id, binding.domainId); }
      counts.set(binding.domainId, (counts.get(binding.domainId) ?? 0) + 1);
      if (counts.get(binding.domainId) > 8) throw new Error('Too many assemblies in a domain.');
    }
    if (occupied.size !== ids.size) throw new Error('Unmapped neurons in engram memory.');
    if (saved.artifact.edges.some(edge => membership.get(edge.sourceId) !== membership.get(edge.targetId))) throw new Error('Cross-domain edges are not part of this pilot.');
    validateCompartments(saved);
    this.saved = copy(saved);
  }

  recall(word, { domainId = null, idleSeconds = 0 } = {}) {
    const bits = encodeWord(word);
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0 || idleSeconds > 3600) throw new Error('Idle delay must be 0–3600 simulated seconds.');
    const regions = this.saved.regions.filter(region => domainId === null || region.domainId === domainId);
    if (!regions.length) throw new Error('That domain is not enrolled in this volume.');
    const fired = new Set();
    const runtime = new LockedController(this.saved.artifact, spike => fired.add(spike.neuronId));
    runtime.advance(idleSeconds);
    fired.clear();
    for (const region of regions) for (const bit of bits) runtime.io.pulse(inputName(region.domainId, bit), runtime.tick + 1);
    runtime.advance(1);
    const activated = this.saved.bindings.filter(binding => regions.some(region => region.domainId === binding.domainId)).map(binding => ({
      conceptId: binding.conceptId, domainId: binding.domainId, activeCells: binding.assembly.filter(id => fired.has(id)).length, assemblySize: 3
    })).filter(binding => binding.activeCells > 0);
    const recalled = activated.filter(binding => binding.activeCells === binding.assemblySize);
    return { status: recalled.length === 0 ? 'unknown' : recalled.length === 1 ? 'recalled' : 'ambiguous', recalled, activated, inputBits: bits, routedDomains: regions.map(region => region.domainId) };
  }

  export() { return copy(this.saved); }
}

module.exports = { EngramVolume, EngramMemory };
