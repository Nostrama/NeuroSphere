'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {encodeWord} = require('../src/index.cjs');
const DEFAULT_DIRECTORY = path.join(__dirname, '../outputs/readout-confirmation/2026-11-01T21-07-36-391Z-stage3-confirmation');
const DOMAIN = 'readout';
const COLORS = {A:'#64d9c5', B:'#c39cf4', both:'#f0d79d', output:'#f6bd72', pool:'#638b9e', input:'#529bae'};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function createCatalog(directory = DEFAULT_DIRECTORY) {
  let entries, issue;
  const loaded = new Map();
  function list() {
    if (entries) return entries;
    try {
      const study = read(path.join(directory, 'summary.json'));
      assert.equal(study.schema, 'neurosphere-readout-confirmation-study/v1');
      assert.equal(study.pass, true);
      assert.deepEqual(study.cells.map(c=>c.seed), [1,2,3]);
      entries = study.cells.map(cell => {
        assert.match(cell.id, /^(diagnostic-t24-f0\.25|confirmation-[23])$/);
        assert.deepEqual(cell.options, {teacherTick:24, thresholdFactor:.25, epochs:80});
        assert.equal(cell.summary.pass, true);
        assert.equal(cell.summary.stopping.reached, true);
        for (const gate of ['R1','R2','R3','R4']) assert.equal(cell.summary.primary.gates[gate], true);
        for (const control of ['readoutHebbianOff','pruneReadout','swappedTeacher','pruneFormed','untrainedReadout']) assert.equal(cell.summary.discrimination[control], true);
        return {seed:cell.seed, id:'readout-'+cell.seed, caseId:cell.id, epoch:cell.summary.stopping.epoch,
          gates:cell.summary.primary.gates, controls:cell.summary.discrimination,
          naturalEpochs:Object.fromEntries(['A','B'].map(c=>[c,cell.measurements.naturalAtStop[c]?.epoch??null]))};
      });
    } catch { issue='Confirmed readout evidence is unavailable. Restore the saved confirmation files to use this mode.'; entries=[]; }
    return entries;
  }
  return {
    status() { const cells=list(); return {available:cells.length===3, cells, message:issue??null}; },
    load(seed) {
      if (![1,2,3].includes(seed)) throw new Error('Choose seed 1, 2 or 3.');
      const entry = list().find(c=>c.seed===seed);
      if (!entry) throw new Error(issue);
      if (!loaded.has(seed)) {
        const memory=read(path.join(directory,'cases',entry.caseId,'primary/memory.json'));
        assert.equal(memory.schema,'neurosphere-readout/v1'); assert.equal(memory.seed,seed);
        assert.equal(memory.referenceIdentity.byteIdentical,true);
        assert.equal(memory.readoutEpoch,entry.epoch);
        assert.deepEqual(memory.readoutOptions,{teacherTick:24,thresholdFactor:.25,epochs:80});
        loaded.set(seed, {kind:'readout',memory,entry});
      }
      return loaded.get(seed);
    }
  };
}
function records(memory,vocabulary) {
  return ['A','B'].map(c=>({...vocabulary.get(memory.outputs[c].conceptId),domainId:DOMAIN,sense:'Self-formed assembly '+c}));
}
function summary(loaded,vocabulary) {
  const {memory:m,entry}=loaded;
  return {id:entry.id,kind:'readout',name:'Learned memory · Seed '+m.seed,origin:'Confirmed · R1–R4 pass',
    words:2,domains:1,neurons:m.artifact.nodes.length,connections:m.artifact.edges.length,epochs:m.readoutEpoch,
    conceptIds:['A','B'].map(c=>m.outputs[c].conceptId),seed:m.seed,formationEpoch:m.formationEpoch,
    cues:m.cues,outputs:Object.fromEntries(['A','B'].map(c=>[c,{...m.outputs[c],word:vocabulary.get(m.outputs[c].conceptId).word,coreSize:m.cores[c].length}])),
    gates:entry.gates,controls:entry.controls,naturalEpochs:entry.naturalEpochs};
}
function scene(memory,vocabulary) {
  const features=new Map(memory.features.map((id,bit)=>[id,bit])), pool=new Set(memory.pool);
  const outputs=new Map(Object.entries(memory.outputs).map(([cue,o])=>[o.id,{cue,...o}]));
  const cores={A:new Set(memory.cores.A),B:new Set(memory.cores.B)};
  const center={x:400,y:400,z:400};
  return {kind:'readout',nodes:memory.artifact.nodes.map(n=>{
    const memberships=['A','B'].filter(c=>cores[c].has(n.id)), output=outputs.get(n.id);
    const role=output?'output':features.has(n.id)?'input':memberships.length?'memory':'pool';
    const color=output?COLORS.output:memberships.length===2?COLORS.both:memberships.length?COLORS[memberships[0]]:COLORS[role];
    return {...n,domainId:DOMAIN,role,memberships,color,bit:features.get(n.id),conceptId:output?.conceptId,
      label:output?output.name+' · '+vocabulary.get(output.conceptId).word:role==='input'?'Input feature '+features.get(n.id):memberships.length?'Assembly '+memberships.join(' + ')+' · #'+n.id:'Pool cell #'+n.id};
  }),edges:memory.artifact.edges.map(e=>({id:e.id,source:e.sourceId,target:e.targetId,weight:e.weight,delay:e.delay,
    kind:outputs.has(e.targetId)?'readout':pool.has(e.sourceId)&&pool.has(e.targetId)?'formed':'afferent'})),
    regions:[{domainId:DOMAIN,name:'Shared memory pool',center,radius:300}],
    concepts:['A','B'].map(c=>({conceptId:memory.outputs[c].conceptId,domainId:DOMAIN,assembly:memory.cores[c],word:vocabulary.get(memory.outputs[c].conceptId).word})),
    extent:memory.artifact.config.extent,volume:{...memory.volume,placement:'shared',isolation:'shared-pool'},
    ports:{sense:{name:'Sense Input',cellIds:memory.features},output:{name:'Learned Output',cellIds:[...outputs.keys()]}}};
}
function request(memory,body) {
  const mode=body.mode??'full', idleSeconds=body.idleSeconds??0;
  if (!['full','half-1','half-2','untrained'].includes(mode)) throw new Error('Choose Full cue, Half 1, Half 2 or Untrained cue.');
  if (![0,60].includes(idleSeconds)) throw new Error('Choose immediate recall or a 60-second delay.');
  if (typeof body.word!=='string'||!body.word.trim()||body.word.length>200) throw new Error('Enter a word or short phrase, up to 200 characters.');
  const word=mode==='untrained'?memory.cues.C:body.word.trim();
  const cue=Object.keys(memory.cues).find(c=>memory.cues[c]===word.toLowerCase())??null;
  if (mode.startsWith('half-')&&!['A','B'].includes(cue)) throw new Error('Half-cue tests use one of the two learned words. Choose A or B first.');
  const allBits=encodeWord(word),half=mode==='half-1'?0:mode==='half-2'?1:null;
  return {word,cue,mode,idleSeconds,half,bits:allBits.filter((_,i)=>half===null||i%2===half),allBits};
}
module.exports={DEFAULT_DIRECTORY,DOMAIN,createCatalog,records,summary,scene,request};
