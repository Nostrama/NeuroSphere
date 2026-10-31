'use strict';
const { SpikingField } = require('./neuron/field.js');
const { LAYOUT } = require('./domain-layout.cjs');
const { applyDomainPolicy } = require('./domain-policy.cjs');
const { parseFact, parseQuestion, questions, RELATIONS } = require('./fact-language.cjs');
const SCHEMA = 'neurosphere-fact-learning/v1';
const LIMITS = Object.freeze({ facts: 32, perDomain: 8, concepts: 128, rounds: 32 });
const knownDomain = value => typeof value === 'string' && /^00[1-9]$/.test(value);
function position(id) {
  const fract = n => n - Math.floor(n), radius = 350 * Math.cbrt(fract(id * .7548776662));
  const y = 1 - 2 * fract(id * .569840291), a = 2 * Math.PI * fract(id * .438579);
  return { x: 400 + radius * Math.sqrt(1 - y*y) * Math.cos(a), y: 400 + radius * y, z: 400 + radius * Math.sqrt(1 - y*y) * Math.sin(a) };
}
function clearTrial(field) {
  for (const cell of field.neurons) {
    cell.potential = cell.restLevel; cell.inbox = []; cell.charges = []; cell.lastTrigger = null;
    cell.adaptation = 0; cell.refractoryUntil = field.time; cell.activity = 0;
    // Teacher episodes are independent: prior traces must not retune shared readouts.
    for (const edge of cell.synapses) { edge.pendingPreSpikes = []; edge.lastPreSpike = null; edge.lastPostSpike = null; edge.eligibility = 0; }
  }
  field.inputSpikes = []; field.outputs = []; field.delivered.clear(); field.spikeRecords.clear();
  field.metrics = []; field.events = []; field.firstDelivery = null;
}
class FactMemory {
  constructor(saved = null) {
    if (saved) {
      if (saved.schema !== SCHEMA || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.nodes) || !Array.isArray(saved.concepts) || !Array.isArray(saved.facts) || !Array.isArray(saved.history) || saved.history.length > 64 || saved.snapshot?.circuitLock) throw new Error('Invalid fact checkpoint.');
      this.field = SpikingField.fromSnapshot(saved.snapshot);
      for (const key of ['nodes', 'concepts', 'facts', 'history', 'revision']) this[key] = structuredClone(saved[key]);
    } else {
      this.field = new SpikingField({ empty: true, seed: 23,
        config: { dimensions: 3, extent: { ...LAYOUT.extent }, maxCells: 2000, radius: 800, maxSynapses: 10, growthPeriod: 10000, initialWeight: .02, weightFloor: .001, weightDecay: 0, unusedDecay: 0, healthLoss: 0, refractory: .08, pairingClock: 'arrival' },
        features: { hebbian: true, reward: false, gradient: false, consolidation: false } });
      this.nodes = []; this.concepts = []; this.facts = []; this.history = []; this.revision = 0;
    }
    this.meta = new Map(this.nodes.map(n => [n.id, n]));
    this.membership = new Map(this.nodes.map(n => [n.id, n.domainId]));
    this.inputs = new Set(); this.teachers = new Set(); this.learning = new Set(); this.direction = 'forward'; this.teaching = false;
    this.validate(); applyDomainPolicy(this.field, this.membership);
    const prior = this.field.env.forNeuron.bind(this.field.env);
    this.field.env.forNeuron = (cell, frame) => {
      const env = prior(cell, frame), meta = this.meta.get(cell.id);
      env.features = { ...env.features, hebbian: this.learning.has(cell.id) };
      env.inputClamped = this.teaching || meta.role === 'cue' || (meta.direction && meta.direction !== this.direction);
      if (meta.role === 'cue') { env.inputPulse = this.inputs.has(cell.id); env.inputExempt = true; }
      if (this.teachers.has(cell.id)) env.forcedSpike = true;
      return env;
    };
  }
  validate() {
    const field = this.field, config = field.config, features = field.features;
    if (this.facts.length > LIMITS.facts || this.concepts.length > LIMITS.concepts || this.nodes.length !== field.neurons.length || this.meta.size !== this.nodes.length) throw new Error('Invalid fact capacity.');
    if (config.dt !== .02 || config.dimensions !== 3 || config.weightDecay !== 0 || config.unusedDecay !== 0 || config.healthLoss !== 0 || config.maxSynapses !== 10 || config.pairingClock !== 'arrival' || !features.hebbian || Object.entries(features).some(([k,v]) => k !== 'hebbian' && v)) throw new Error('Unsupported fact configuration.');
    const owned = new Set(), expected = new Set(), keys = new Set(), factKeys = new Set(), counts = new Map();
    const own = (id, role, domainId, extra) => {
      const n = this.meta.get(id);
      if (owned.has(id) || !n || n.role !== role || n.domainId !== domainId || Object.entries(extra).some(([k,v]) => n[k] !== v)) throw new Error('Invalid fact neuron membership.');
      owned.add(id);
    };
    const edge = (a,b) => expected.add(a + ':' + b);
    for (const concept of this.concepts) {
      if (!knownDomain(concept.domainId) || typeof concept.label !== 'string' || !concept.label || concept.label.length > 100 || !['term','relation'].includes(concept.type) || concept.key !== concept.domainId + '/' + concept.type + '/' + concept.label || keys.has(concept.key)) throw new Error('Invalid shared concept.');
      keys.add(concept.key);
      for (const [member,role] of [['cue','cue'],['forward','relay'],['reverse','relay'],['readout','readout']]) own(concept[member], role, concept.domainId, { conceptKey: concept.key, ...(role === 'relay' ? {direction:member} : {}) });
      edge(concept.cue, concept.forward); edge(concept.cue, concept.reverse);
    }
    for (const [index, fact] of this.facts.entries()) {
      const key = fact.domainId + '/' + fact.subject + '/' + fact.relation;
      if (fact.id !== 'fact-' + (index + 1) || !knownDomain(fact.domainId) || !RELATIONS.includes(fact.relation) || factKeys.has(key)) throw new Error('Invalid fact binding.');
      factKeys.add(key); counts.set(fact.domainId, (counts.get(fact.domainId) ?? 0) + 1);
      const subject = this.concepts.find(c => c.key === fact.subjectKey), relation = this.concepts.find(c => c.key === fact.relationKey), value = this.concepts.find(c => c.key === fact.valueKey);
      if (!subject || !relation || !value || subject.label !== fact.subject || relation.label !== fact.relation || value.label !== fact.object || subject.type !== 'term' || value.type !== 'term' || relation.type !== 'relation' || [subject,relation,value].some(c => c.domainId !== fact.domainId)) throw new Error('Invalid fact concepts.');
      for (const direction of ['forward','reverse']) own(fact[direction], 'gate', fact.domainId, { factId:fact.id, direction });
      edge(subject.forward, fact.forward); edge(relation.forward, fact.forward); edge(fact.forward, value.readout);
      edge(value.reverse, fact.reverse); edge(relation.reverse, fact.reverse); edge(fact.reverse, subject.readout);
    }
    if ([...counts.values()].some(n => n > LIMITS.perDomain) || owned.size !== field.neurons.length) throw new Error('Invalid fact/domain capacity.');
    for (const n of field.neurons) if (!owned.has(n.id) || !n.alive || n.nextGrowthAt !== 1e12 || ![n.x,n.y,n.z].every(Number.isFinite) || Math.hypot(n.x-400,n.y-400,n.z-400) > 400) throw new Error('Invalid fact volume.');
    const actual = new Set(field.links.map(e => e.sourceId + ':' + e.targetId));
    if (actual.size !== field.links.length || actual.size !== expected.size || [...actual].some(e => !expected.has(e))) throw new Error('Invalid fact projections.');
  }
  add(meta, threshold) {
    const cell = this.field.addNeuron({ ...position(this.field.nextId), recordOutput:meta.role === 'readout' });
    cell.nextGrowthAt = 1e12; cell.threshold = threshold;
    const node = { id:cell.id, ...meta }; this.nodes.push(node); this.meta.set(node.id,node); this.membership.set(node.id,node.domainId);
    return cell.id;
  }
  connect(sourceId, targetId, weight = .02) {
    if (this.membership.get(sourceId) !== this.membership.get(targetId)) throw new Error('Cross-domain fact projection refused.');
    const source = this.field.getNeuron(sourceId);
    if (source.synapses.length >= 10) throw new Error('Concept terminal capacity reached.');
    const edge = source.connect(this.field.getNeuron(targetId), this.field.time, weight);
    if (!edge) throw new Error('Fact projection allocation failed.'); edge.delay = .04;
  }
  concept(label, domainId, type = 'term') {
    const key = domainId + '/' + type + '/' + label, found = this.concepts.find(c => c.key === key);
    if (found) return found;
    if (this.concepts.length >= LIMITS.concepts) throw new Error('This experiment supports 128 shared concepts, including correction history.');
    const base = { domainId, conceptKey:key }, value = { key, label, domainId, type,
      cue:this.add({...base,role:'cue'},1), forward:this.add({...base,role:'relay',direction:'forward'},.8),
      reverse:this.add({...base,role:'relay',direction:'reverse'},.8), readout:this.add({...base,role:'readout'},.4) };
    this.connect(value.cue,value.forward,1); this.connect(value.cue,value.reverse,1); this.concepts.push(value); return value;
  }
  enroll(statement, domainId) {
    const parsed = parseFact(statement);
    if (!knownDomain(domainId)) throw new Error('Choose a known domain.');
    let fact = this.facts.find(f => f.domainId === domainId && f.subject === parsed.subject && f.relation === parsed.relation);
    if (fact?.object === parsed.object) throw new Error('That fact is already learned.');
    if (!fact && (this.facts.length >= LIMITS.facts || this.facts.filter(f => f.domainId === domainId).length >= LIMITS.perDomain)) throw new Error('Use at most 32 facts, with eight per domain.');
    const subject = this.concept(parsed.subject,domainId), relation = this.concept(parsed.relation,domainId,'relation'), value = this.concept(parsed.object,domainId);
    if (fact) {
      this.history.push({ ...structuredClone(fact), replacedAtRevision:this.revision + 1, replacement:parsed.object }); this.history = this.history.slice(-64);
      const gates = new Set([fact.forward,fact.reverse]);
      // Explicit correction retires this binding's six projections only.
      for (const cell of this.field.neurons) {
        for (const edge of cell.synapses) if (gates.has(edge.sourceId) || gates.has(edge.targetId)) edge.prune();
        cell.synapses = cell.synapses.filter(e => e.active);
      }
    } else {
      const id = 'fact-' + (this.facts.length + 1);
      fact = { id, domainId, forward:this.add({role:'gate',domainId,factId:id,direction:'forward'},.8), reverse:this.add({role:'gate',domainId,factId:id,direction:'reverse'},.8) };
      this.facts.push(fact);
    }
    Object.assign(fact, parsed, { statement:statement.trim(), subjectKey:subject.key, relationKey:relation.key, valueKey:value.key });
    this.connect(subject.forward,fact.forward); this.connect(relation.forward,fact.forward); this.connect(fact.forward,value.readout);
    this.connect(value.reverse,fact.reverse); this.connect(relation.reverse,fact.reverse); this.connect(fact.reverse,subject.readout);
    return { fact, subject, relation, value };
  }
  step() { this.field.step(); this.inputs.clear(); this.teachers.clear(); }
  teach(statement, domainId = '007', onProgress = () => {}) {
    // Enrollment, correction and teaching are transactional, including headless use.
    const next = new FactMemory(this.checkpoint());
    const {fact,subject,relation,value} = next.enroll(statement,domainId);
    next.teaching = true; next.learning = new Set([fact.forward,fact.reverse,subject.readout,value.readout]);
    for (let round=0; round<LIMITS.rounds; round++) {
      for (const direction of ['forward','reverse']) {
        clearTrial(next.field); next.direction = direction;
        const input = direction === 'forward' ? subject : value, output = direction === 'forward' ? value : subject;
        for (let tick=1; tick<=24; tick++) {
          if (tick === 1) next.inputs = new Set([input.cue,relation.cue]);
          if (tick === 4) next.teachers = new Set([input[direction],relation[direction]]);
          if (tick === 8) next.teachers.add(fact[direction]);
          if (tick === 12) next.teachers.add(output.readout);
          next.step();
        }
      }
      onProgress({epoch:round+1,total:LIMITS.rounds});
    }
    next.teaching = false; next.learning.clear(); clearTrial(next.field); next.revision++; next.validate();
    Object.assign(this,next); return structuredClone(fact);
  }
  checkpoint() {
    const snapshot = this.field.snapshot(); snapshot.endpointPlacement = this.field.assessEndpointPlacement();
    return { schema:SCHEMA, revision:this.revision, nodes:structuredClone(this.nodes), concepts:structuredClone(this.concepts), facts:structuredClone(this.facts), history:structuredClone(this.history), snapshot };
  }
  recall(text, {domainId = null, record = true} = {}) {
    const query = parseQuestion(text);
    if (domainId !== null && !knownDomain(domainId)) throw new Error('Unknown domain.');
    const runtime = new FactMemory(this.checkpoint()), field = runtime.field, trace = [], samples = [], start = field.time;
    const domains = [...new Set(runtime.nodes.filter(n => !domainId || n.domainId === domainId).map(n => n.domainId))];
    if (query.supported) {
      clearTrial(field); if (field.neurons.length) field.lockCircuit('Read-only fact recall'); runtime.direction = query.direction;
      field.onEvent = event => { if (event.type === 'spike') trace.push({neuronId:event.spike.neuronId,time:Number((event.spike.time-start).toFixed(8))}); };
      const cues = runtime.concepts.filter(c => (!domainId || c.domainId === domainId) && (c.type === 'term' && c.label === query.cue || c.type === 'relation' && c.label === query.relation));
      const capture = () => { if (record) samples.push({time:Number((field.time-start).toFixed(8)),values:field.neurons.filter(n => Math.abs(n.potential-n.restLevel)>1e-6).map(n => [n.id,n.potential])}); };
      capture();
      for (let tick=1; tick<=64; tick++) { if (tick === 1) runtime.inputs = new Set(cues.map(c => c.cue)); runtime.step(); capture(); }
    }
    const fired = new Set(trace.map(e => e.neuronId)), matches = [];
    // Decode shared readout cells and their actually firing incoming pathways.
    // No fact text or subject/relation/value lookup supplies the answer.
    for (const concept of runtime.concepts) {
      if (!fired.has(concept.readout)) continue;
      const gates = field.getNeuron(concept.readout).incoming.filter(e => e.active && fired.has(e.sourceId) && runtime.meta.get(e.sourceId).direction === query.direction);
      if (!gates.length) continue;
      const word = (query.direction === 'reverse' ? 'the ' : '') + concept.label, event = trace.find(e => e.neuronId === concept.readout);
      matches.push({conceptId:runtime.meta.get(gates[0].sourceId).factId, factIds:gates.map(e => runtime.meta.get(e.sourceId).factId), domainId:concept.domainId, word,
        tokens:[{text:word,neuronId:concept.readout,time:event.time}],activeCells:1,assemblySize:1,gate:gates[0].sourceId});
    }
    const answers = [...new Set(matches.map(m => m.word))];
    const status = !query.supported ? 'unsupported' : !matches.length ? 'unknown' : query.direction === 'forward' && answers.length > 1 ? 'ambiguous' : 'recalled';
    return {kind:'facts',status,word:text,response:status === 'recalled' ? answers.join(', ') : null,query,matches,recalled:matches,activated:matches,
      trace:record?trace:[],samples,seconds:query.supported?Number((field.time-start).toFixed(8)):1.28,routedDomains:domains,inputTokens:query.supported?[query.cue,query.relation]:[],inputBits:[],revision:this.revision};
  }
  evaluate() {
    let exact = 0;
    for (const fact of this.facts) {
      const q = questions(fact), forward = this.recall(q.forward,{domainId:fact.domainId,record:false}), reverse = this.recall(q.reverse,{domainId:fact.domainId,record:false});
      const expected = this.facts.filter(f => f.domainId === fact.domainId && f.relation === fact.relation && f.object === fact.object).map(f => 'the ' + f.subject).sort();
      if (forward.status === 'recalled' && forward.response === fact.object && reverse.status === 'recalled' && JSON.stringify(reverse.matches.map(m => m.word).sort()) === JSON.stringify(expected)) exact++;
    }
    return {exact,total:this.facts.length,scope:'Forward and reverse recall of every current fact within its domain; controlled grammar, not general language understanding.'};
  }
}
module.exports = { FactMemory, SCHEMA, LIMITS };
