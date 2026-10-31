'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {jaccard}=require('../src/neuron/assembly-task.js');
const formation=require('../examples/formation.cjs');
const audit=require('../examples/formation-audit.cjs');
const study=require('../examples/formation-study.cjs');
const criterionStudy=require('../examples/formation-criterion.cjs');
const small={epochs:3,pool:150,seed:1};
let suite;
function fixture(){return suite??=formation.runSuite(small);}

test('formation metrics use the upstream Jaccard and deterministic spatial null model',()=>{
  assert.equal(jaccard([1,2],[1,2]),1);assert.equal(jaccard([1],[2]),0);assert.equal(jaccard([],[]),0);
  const positions=new Map([[1,{x:0,y:0,z:0}],[2,{x:1,y:0,z:0}],[3,{x:0,y:1,z:0}],[4,{x:100,y:100,z:100}],[5,{x:200,y:200,z:200}]]),pool=[...positions.keys()];
  const tight=formation.compactness([1,2,3],pool,positions,7),spread=formation.compactness(pool,pool,positions,7);
  assert.ok(tight.ratio<.1);assert.ok(Math.abs(spread.ratio-1)<1e-12);assert.equal(tight.randomSubsets,200);
  assert.deepEqual(tight,formation.compactness([1,2,3],pool,positions,7));assert.equal(formation.compactness([],pool,positions,7).ratio,null);
});

test('core and stability windows cannot turn silence or insufficient trials into success',()=>{
  const trials=Array.from({length:10},(_,i)=>i<8?[1,2]:[1]);assert.deepEqual(formation.extractCore(trials),[1,2]);
  assert.equal(formation.stability(Array.from({length:10},()=>[1,2])).strict,true);
  assert.equal(formation.stability(Array.from({length:10},()=>[])).strict,false);
  assert.equal(formation.stability([[1],[1],[1]]).strict,false);assert.deepEqual(formation.extractCore([]),[]);
  assert.equal(formation.decode([1],{A:[1],B:[1]}).label,'A');assert.equal(formation.decode([],{A:[],B:[]}).label,'reject');
  assert.deepEqual(formation.recurrent([1,2],[{sourceId:1,targetId:2},{sourceId:3,targetId:1},{sourceId:2,targetId:4}]),{within:1,between:2,withinBetweenRatio:.5,noBetweenEdges:false});
});

test('formation CLI validates seeds, capacity and supported knobs',()=>{
  const parsed=formation.parseArgs(['--seed','1','2','3','--epochs','3','--pool','150','--homeostasis']);
  assert.deepEqual(parsed.seeds,[1,2,3]);assert.equal(parsed.options.pool,150);assert.equal(parsed.options.homeostasis,true);
  for(const args of [['--pool','2001'],['--seed','-1'],['--seed'],['--seed','1','1'],['--unknown','3'],['--epochs','NaN']])assert.throws(()=>formation.parseArgs(args));
  assert.equal(formation.DEFAULTS.w0,1.1);assert.equal(formation.DEFAULTS.initialWeight,.4);
  assert.throws(()=>formation.options({k:9,maxSynapses:8}));assert.throws(()=>formation.options({maxSynapses:11}));
  const grid=formation.sweepOptions(small);assert.equal(grid.length,18);assert.equal(new Set(grid.map(row=>JSON.stringify(row))).size,18);
  assert.equal(formation.DEFAULTS.gap,10);assert.equal(formation.DEFAULTS.secretion,0);
  for(const gap of [-1,NaN,.51])assert.throws(()=>formation.options({gap}));
  const variants=formation.parseArgs(['--gap','0.5','--secretion','2','--activityScaledInhibition','--pruneFormed']);
  assert.equal(variants.options.gap,.5);assert.equal(variants.options.secretion,2);assert.equal(variants.options.activityScaledInhibition,true);
  assert.deepEqual(formation.CONTROLS,['growth-off','hebbian-off','inhibition-off','shuffled','untrained','prune-formed']);
  assert.equal(formation.DEFAULTS.decay,'off');assert.equal(formation.DEFAULTS.cues,'disjoint');
  assert.equal(formation.DEFAULTS.jitter,15);assert.equal(formation.DEFAULTS.epochs,80);assert.equal(formation.DEFAULTS.pairingClock,'arrival');
  assert.equal(formation.DEFAULTS.competitionMargin,1);assert.equal(formation.DEFAULTS.exploration,.1);
  assert.throws(()=>formation.options({competitionMargin:-1}));assert.throws(()=>formation.options({exploration:Infinity}));
  for(const args of [['--decay','bad'],['--cues','bad'],['--pairingClock','bad'],['--jitter','-1'],['--jitter','1.5'],['--diagnostic','--seed','2'],['--diagnostic','--sweep']])assert.throws(()=>formation.parseArgs(args));
  const diagnostic=formation.diagnosticOptions({...small,weightDecay:.1});assert.equal(diagnostic.length,6);
  assert.equal(new Set(diagnostic.map(row=>[row.inhibitionStrength,row.inhibitionRadiusFactor].join('/'))).size,6);
  assert.ok(diagnostic.every(row=>row.seed===1&&row.weightDecay===undefined&&row.gap===10&&row.decay==='off'&&row.cues==='disjoint'));
  assert.deepEqual(diagnostic[0],formation.options());
  assert.deepEqual(diagnostic.map(row=>[row.inhibitionStrength,row.inhibitionRadiusFactor]),[[.5,.6],[.5,1],[1,.6],[1,1],[2,.6],[2,1]]);
  assert.ok(diagnostic.every(row=>row.pool===500&&row.epochs===80&&row.competitionMargin===1&&row.exploration===.1));
  assert.equal(formation.parseArgs(['--study']).study,true);
  for(const args of [['--study','--pool','1000'],['--study','--seed','1'],['--study','--diagnostic']])assert.throws(()=>formation.parseArgs(args));
  assert.throws(()=>formation.sweepOptions({...small,decay:'default'}));
  assert.throws(()=>formation.sweepOptions({...small,cues:'shared'}));
});

test('numeric go/no-go bars distinguish recurrent recruitment from stable projections',()=>{
  const pool=Array.from({length:20},(_,i)=>i+1),cores={A:[1,2,3,4,5],B:[6,7,8,9,10]};
  const positions=new Map(pool.map(id=>[id,{x:id<=5?id/100:id<=10?50+id/100:100*id,y:0,z:0}]));
  const growthEdges=Object.values(cores).flatMap(core=>core.map((id,i)=>({sourceId:id,targetId:core[(i+1)%core.length],weight:1.1})));
  const trials={A:Array.from({length:10},()=>[...cores.A]),B:Array.from({length:10},()=>[...cores.B])};
  const probes=Object.fromEntries([0,60].map(seconds=>[seconds,['A','B','C'].map(cue=>({cue,active:cue==='C'?[20]:cores[cue],label:cue==='C'?'reject':cue}))]));
  const halfProbes=Object.fromEntries([0,60].map(seconds=>[seconds,['A','B','C'].flatMap(cue=>[0,1].map(half=>({cue,half,bits:formation.cueBits(cue,half),active:cue==='C'?[20]:cores[cue]})))]));
  const untrainedHalfProbes=structuredClone(halfProbes);
  for(const rows of Object.values(untrainedHalfProbes))for(const row of rows)row.active=row.active.slice(0,2);
  const input={trials,cores,pool,positions,growthEdges,stats:{formed:10,pruned:0},probes,halfProbes,untrainedHalfProbes,seed:1,directSets:{A:[1,2,3],B:[6,7,8],C:[20]}};
  const good=formation.metrics(input);assert.equal(good.pass,true);assert.equal(good.recruitment.A.fraction,.4);
  assert.equal(good.criteria['3-size'].pass,true,'Five cells are exactly the revised 0.25*P cap.');
  const sparse=formation.metrics({...input,growthEdges:growthEdges.slice(1)});
  assert.equal(sparse.criteria['7-recurrent-structure'].pass,false);
  const projection=formation.metrics({...input,directSets:{A:cores.A,B:cores.B,C:[20]}});
  assert.equal(projection.criteria['6-recruitment'].pass,false);
  const negative=structuredClone(probes);negative[60][2].active.push(19,18);
  assert.equal(formation.metrics({...input,probes:negative}).criteria['4-negative-cue'].pass,false);
  const spread=new Map(pool.map(id=>[id,{x:id%5,y:Math.floor(id/5),z:0}]));
  const nongated=formation.metrics({...input,positions:spread});assert.equal(nongated.criteria['5-compactness'].gated,false);
  assert.equal(formation.metrics({...input,positions:spread,secretion:2}).criteria['5-compactness'].gated,false);
  assert.equal(projection.criteria['6-recruitment'].gated,false);
  const shared=formation.recruitmentBreakdown(cores,{A:[1,2,3,9,10],B:[4,5,6,7,8],C:[20]});
  assert.equal(shared.A.fraction,.4);assert.equal(shared.A.neutral.fraction,0);assert.equal(shared.A.otherCueDirect.count,2);
  assert.equal(shared.overlap.coreAInDirectB.count,2);assert.equal(shared.overlap.sharedRecruits.count,0);
  assert.equal(formation.metrics({...input,directSets:{A:[1,2,3,9,10],B:[4,5,6,7,8],C:[20]}}).criteria['6-recruitment'].pass,false);
  const jittered={A:Array.from({length:10},(_,i)=>i<5?[1,2,3]:[1,2,4]),B:Array.from({length:10},(_,i)=>i<5?[6,7,8]:[6,7,9])};
  const soft=formation.metrics({...input,trials:jittered});assert.equal(soft.stability.A.strict,false);assert.equal(soft.stability.A.soft,true);
  assert.equal(soft.criteria['1-stability'].pass,true);assert.ok(soft.stability.A.mean>=.7&&soft.stability.A.mean<.8);
});

test('unassigned scaffold has permanent afferent reach, bounded fan-out, and no initial recurrent edges',()=>{
  const run=formation.setup(small),pool=new Set(run.pool),feature=new Set(run.features);
  assert.equal(run.field.rng.state,small.seed,'Scaffolding never draws from the model RNG.');
  assert.equal(run.seedEdges.length,192*8);assert.equal(run.field.links.length,192*8);
  assert.ok(run.field.links.every(edge=>feature.has(edge.sourceId)&&pool.has(edge.targetId)&&edge.weight===1.1));
  for(const cell of run.field.neurons){
    if(feature.has(cell.id)){assert.equal(cell.radius,600);assert.equal(cell.nextGrowthAt,1e12);assert.equal(cell.synapses.length,8);}
    else {assert.equal(cell.radius,60);assert.equal(cell.threshold,1.02);assert.equal(cell.recordOutput,false);assert.ok(cell.nextGrowthAt<1e12);assert.equal(cell.synapses.length,0);}
  }
  const shuffled=formation.setup(small,'shuffled');
  assert.deepEqual(shuffled.seedEdges,run.seedEdges);assert.notDeepEqual([...shuffled.positions],[...run.positions]);
  assert.deepEqual([...shuffled.positions.values()].map(JSON.stringify).sort(),[...run.positions.values()].map(JSON.stringify).sort());
  const memory=formation.exportMemory(run,{A:[],B:[]});
  assert.deepEqual(memory.artifact.endpointIds,run.features);assert.deepEqual(memory.artifact.inputIds,run.features);
  assert.ok(memory.artifact.nodes.filter(cell=>feature.has(cell.id)).every(cell=>cell.radius===600));
});

test('same seed gives byte-identical written summaries across two complete control suites',()=>{
  const first=fixture(),second=formation.runSuite(small);
  const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'neurosphere-formation-test-'));
  const a=formation.writeRun(root,first,{timestamp:'2000-01-01T00:00:00.000Z',wallTimeMs:1,nodeVersion:'test-one'});
  const b=formation.writeRun(root,second,{timestamp:'2000-01-01T00:00:01.000Z',wallTimeMs:2,nodeVersion:'test-two'});
  assert.deepEqual(fs.readFileSync(path.join(a,'summary.json')),fs.readFileSync(path.join(b,'summary.json')));
  assert.notDeepEqual(fs.readFileSync(path.join(a,'timing.json')),fs.readFileSync(path.join(b,'timing.json')));
  assert.equal(first.summary.pass,false,'Three trials cannot satisfy last-ten stability.');
});

test('timestamp collisions preserve both configurations without overwriting evidence',()=>{
  const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'neurosphere-formation-collision-'));
  const timing={timestamp:'2000-01-01T00:00:00.000Z',wallTimeMs:1,nodeVersion:'test'};
  const first={summary:{seed:1,options:{gap:.5}},trials:{A:[[1]]},memory:{example:1}};
  const second={summary:{seed:1,options:{gap:10}},trials:{A:[[2]]},memory:{example:2}};
  const a=formation.writeRun(root,first,timing),b=formation.writeRun(root,second,timing);
  assert.notEqual(a,b);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a,'summary.json'))),first.summary);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b,'summary.json'))),second.summary);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a,'memory.json'))),first.memory);
});

test('growth-off has no formed synapses and cannot claim recruitment or recurrence',()=>{
  const result=fixture().summary.controls['growth-off'];
  assert.equal(result.stats.formed,0);assert.equal(result.growthPoolEdgesEver,0);
  for(const cue of ['A','B']){assert.equal(result.recruitment[cue].fraction,0);assert.equal(result.recurrent[cue].within,0);}
  assert.equal(result.criteria['6-recruitment'].pass,false);assert.equal(result.criteria['7-recurrent-structure'].pass,false);
  assert.equal(result.criteria['9-pattern-completion'].pass,false);assert.equal(result.criteria['10-potentiation'].pass,false);
});

test('untrained cues equal seed-topology targets without inhibition and are subsets with inhibition',()=>{
  const inhibited=fixture().summary.controls.untrained;
  const uninhibited=formation.runCondition(small,'untrained',{inhibition:false}).summary;
  for(const result of [inhibited,uninhibited]){
    assert.equal(result.stats.formed,0);assert.deepEqual(result.cores,{A:[],B:[]});
    for(const cue of ['A','B'])assert.equal(result.recruitment[cue].fraction,0);
    for(const seconds of [0,60])for(const probe of result.probes[seconds]){
      assert.ok(probe.active.length>0);assert.ok(probe.active.every(id=>result.directSets[probe.cue].includes(id)));
      if(result===uninhibited)assert.deepEqual(probe.active,result.directSets[probe.cue]);
    }
  }
});

test('snapshot through memory.json reload reproduces every probe without altering the artifact',()=>{
  const run=fixture(),serialized=JSON.stringify(run.memory),memory=JSON.parse(serialized);
  assert.deepEqual(formation.probeAll(memory),run.summary.primary.probes);assert.equal(JSON.stringify(memory),serialized);
  const ablated=run.controlMemories['prune-formed'],poolIds=new Set(ablated.pool);
  assert.deepEqual(ablated.cores,memory.cores);
  for(const edge of ablated.artifact.edges){
    const original=memory.artifact.edges.find(item=>item.id===edge.id);assert.ok(original);
    assert.ok(!poolIds.has(edge.sourceId));assert.equal(edge.weight,original.weight);
  }
  assert.deepEqual(run.summary.controls['prune-formed'].ablation.beforeProbes,run.summary.primary.probes);
  assert.deepEqual(run.summary.controls['prune-formed'].ablation.beforeHalfProbes,run.summary.primary.halfProbes);
  assert.equal(run.summary.controls['afferent-ablation'],undefined);
  assert.equal(ablated.artifact.edges.length,memory.artifact.edges.filter(edge=>!poolIds.has(edge.sourceId)).length);
});

test('fixed halves partition sorted cue bits and native checkpoint branching matches independent silence',()=>{
  const run=fixture(),memory=run.memory;
  for(const cue of ['A','B','C']){
    const a=formation.cueBits(cue,0),b=formation.cueBits(cue,1);
    assert.equal(a.length,4);assert.equal(b.length,4);assert.ok(a.every(id=>!b.includes(id)));
    assert.deepEqual([...a,...b].sort((x,y)=>x-y),formation.cueBits(cue));
  }
  for(const seconds of [0,60])for(const half of [0,1])
    assert.deepEqual(formation.probeMemory(memory,'A',seconds,half),run.summary.primary.halfProbes[seconds].find(row=>row.cue==='A'&&row.half===half));
  const baseline=formation.runCondition({...small,gap:.5},'untrained',{inhibition:false});
  for(const seconds of [0,60])for(const probe of baseline.summary.halfProbes[seconds]){
    const sourceIds=new Set(probe.bits.map(bit=>baseline.memory.features[bit]));
    const expected=[...new Set(baseline.trials.seedEdges.filter(edge=>sourceIds.has(edge.sourceId)).map(edge=>edge.targetId))].sort((a,b)=>a-b);
    assert.deepEqual(probe.active,expected);
  }
});

test('half-cue completion measures added recall on one common reference and never rewards empty cores',()=>{
  const cores={A:[1,2,3,4,5],B:[6,7,8,9,10]},direct={A:[1,2,3],B:[6,7,8],C:[11,12]};
  const trained=Object.fromEntries([0,60].map(t=>[t,['A','B','C'].flatMap(cue=>[0,1].map(half=>({cue,half,bits:formation.cueBits(cue,half),active:cue==='C'?[11]:cores[cue]})))]));
  const untrained=structuredClone(trained);for(const rows of Object.values(untrained))for(const row of rows)row.active=row.active.slice(0,2);
  const result=formation.patternCompletion(cores,direct,trained,untrained);assert.equal(result.pass,true);
  assert.equal(result.rows[0][0].trained,1);assert.equal(result.rows[0][0].untrained,.4);assert.equal(result.rows[0][0].gain,.6);
  assert.equal(result.rows[0][4].trained,.5);
  assert.equal(formation.patternCompletion(cores,direct,trained,trained).pass,false,'Completion without improvement over baseline is insufficient.');
  assert.equal(formation.patternCompletion({A:[],B:[]},direct,trained,untrained).pass,false);
  trained[60][1].active=[1,2,3];assert.equal(formation.patternCompletion(cores,direct,trained,untrained).pass,false,'Each half and delay must pass.');
});

test('Stage 1f cell acceptance requires both 9 and 10 to fail in each disabled-learning control',()=>{
  const criteria=Object.fromEntries([1,2,3,4,5,6,7,8,9,10].map(n=>[String(n),{pass:![5,6].includes(n),gated:![5,6].includes(n)}]));
  const primary={criteria,effective:{config:{weightDecay:0,unusedDecay:0,healthLoss:0,pairingClock:'arrival',competitionMargin:1,exploration:.1}}};
  const controls={'growth-off':{criteria:{'9-pattern-completion':{pass:false},'10-potentiation':{pass:false}}},
    'hebbian-off':{criteria:{'1-stability':{pass:true},'9-pattern-completion':{pass:false},'10-potentiation':{pass:false}}},
    'prune-formed':{ablation:{completionDrop:Object.fromEntries([0,60].map(t=>[t,['A','B'].flatMap(cue=>[0,1].map(half=>({cue,half,before:.9,after:.4})))]))}}};
  assert.equal(formation.evaluateSuite(primary,controls).pass,true);
  assert.equal(formation.evaluateSuite(primary,controls,{gap:.5}).pass,false);
  assert.equal(formation.evaluateSuite(primary,controls,{cues:'shared'}).pass,false);
  assert.equal(formation.evaluateSuite(primary,controls,{jitter:0}).pass,false);
  assert.equal(formation.evaluateSuite(primary,controls,{epochs:40}).pass,false);
  controls['growth-off'].criteria['9-pattern-completion'].pass=true;
  assert.equal(formation.evaluateSuite(primary,controls).pass,false);controls['growth-off'].criteria['9-pattern-completion'].pass=false;
  controls['hebbian-off'].criteria['9-pattern-completion'].pass=true;
  assert.equal(formation.evaluateSuite(primary,controls).pass,false);controls['hebbian-off'].criteria['9-pattern-completion'].pass=false;
  for(const name of ['growth-off','hebbian-off']){
    controls[name].criteria['10-potentiation'].pass=true;assert.equal(formation.evaluateSuite(primary,controls).pass,false);
    controls[name].criteria['10-potentiation'].pass=false;
  }
  const row=controls['prune-formed'].ablation.completionDrop[60][0];
  row.after=.6;assert.equal(formation.evaluateSuite(primary,controls).pass,false);
  row.after=.4;row.before=.4;assert.equal(formation.evaluateSuite(primary,controls).pass,false);
  row.before=.9;controls['prune-formed'].ablation.completionDrop[60].pop();assert.equal(formation.evaluateSuite(primary,controls).pass,false);
});

test('gap is native simulated silence and pool secretion enables the existing chemical field without labeling cells',()=>{
  for(const gap of [.5,10]){const run=formation.setup({...small,gap});run.trial('A');assert.equal(run.field.tick,65+gap/.02);assert.equal(run.field.time,run.field.tick*.02);}
  const run=formation.setup({...small,secretion:2,gap:0,activityScaledInhibition:true});
  assert.equal(run.field.features.gradient,true);assert.equal(run.field.features.activityScaledInhibition,true);
  assert.ok(run.pool.every(id=>run.field.getNeuron(id).secretionRate===2));assert.ok(run.features.every(id=>run.field.getNeuron(id).secretionRate===0));
  for(let i=0;i<2;i++)run.session.step();assert.ok(run.field.chemical.values.some(value=>value>0));
  assert.doesNotThrow(()=>formation.exportMemory(run,{A:[],B:[]}));
  const disabled=formation.setup({...small,activityScaledInhibition:true},'inhibition-off');
  assert.equal(disabled.field.features.lateralInhibition,false);assert.equal(disabled.field.features.activityScaledInhibition,false);
});

test('mandatory formed-edge pruning removes only recurrent edges and preserves afferents',()=>{
  const run=formation.runCondition({...small,gap:.5},'prune-formed'),pool=new Set(run.memory.pool);
  assert.ok(run.summary.ablation.edgeCount>0);assert.equal(run.summary.ablation.mode,'prune');
  assert.ok(run.memory.artifact.edges.every(edge=>!pool.has(edge.sourceId)));
  assert.equal(run.memory.artifact.edges.length,run.trials.seedEdges.length);
  assert.equal(run.summary.recurrent.liveGrowthPoolEdges,0);
});

test('cue selection uses normalized words in ID order, skips overlaps and duplicates, and records disjoint bits',()=>{
  const records=[{id:'006',word:'abominable snowman'},{id:'004',word:'banana'},{id:'001',word:'Aardvark'},
    {id:'005',word:'aberdeen angus'},{id:'002',word:'aardvark'}];
  const selected=formation.selectCues('disjoint',{sourceHash:'fixture',records});
  assert.deepEqual(selected.words,{A:'aardvark',B:'aberdeen angus',C:'abominable snowman'});
  assert.deepEqual(Object.values(selected.records).map(row=>row.id),['001','005','006']);
  assert.equal(new Set(Object.values(selected.bits).flat()).size,24);
  assert.deepEqual(formation.selectCues().words,selected.words);
  assert.throws(()=>formation.selectCues('disjoint',{records:records.slice(-2)}));
});

test('decay-off is permanent host config; default-decay diagnostic restores all three native rates',()=>{
  for(const decay of ['off','default']){
    const run=formation.setup({...small,decay},'hebbian-off');
    for(const [key,value] of Object.entries(formation.DECAY_CONFIG[decay]))assert.equal(run.field.config[key],value);
    run.trial('A');const memory=formation.exportMemory(run,{A:[],B:[]});
    for(const [key,value] of Object.entries(formation.DECAY_CONFIG[decay]))assert.equal(memory.artifact.config[key],value);
    const afferents=run.field.links.filter(edge=>run.features.includes(edge.sourceId));
    assert.ok(afferents.length>0);assert.ok(afferents.every(edge=>decay==='off'?edge.weight===1.1:edge.weight<1.1));
  }
});

test('saved cue metadata governs replay independently of the new default vocabulary selection',()=>{
  const run=formation.runCondition({...small,cues:'shared'},'untrained',{inhibition:false});
  assert.deepEqual(run.memory.cues,formation.LEGACY_CUES);assert.equal(run.memory.schema,'neurosphere-formation/v2');
  assert.deepEqual(formation.probeMemory(run.memory,'B',0,0),run.summary.halfProbes[0].find(row=>row.cue==='B'&&row.half===0));
  assert.deepEqual(run.summary.halfProbes[0].find(row=>row.cue==='B'&&row.half===0).bits,formation.cueBits('B',0,formation.LEGACY_CUES));
  const invalid=structuredClone(run.memory);delete invalid.cues;assert.throws(()=>formation.probeMemory(invalid,'A'));
  invalid.schema='neurosphere-formation/v1';assert.deepEqual(formation.probeMemory(invalid,'A'),run.summary.probes[0][0]);
});

test('soft completion is reported at 0.7 without relaxing the strict 0.8 gate or gain bar',()=>{
  const cores={A:[1,2,3,4,5,6,7,8,9,10],B:[11,12,13,14,15,16,17,18,19,20]},direct={A:[1,2],B:[11,12],C:[21]};
  const trained=Object.fromEntries([0,60].map(t=>[t,['A','B','C'].flatMap(cue=>[0,1].map(half=>({cue,half,bits:formation.cueBits(cue,half),active:cue==='C'?[21]:cores[cue].slice(0,7)})))]));
  const baseline=structuredClone(trained);for(const rows of Object.values(baseline))for(const row of rows)row.active=row.active.slice(0,4);
  const result=formation.patternCompletion(cores,direct,trained,baseline);assert.equal(result.soft,true);assert.equal(result.pass,false);
  assert.equal(formation.patternCompletion(cores,direct,trained,trained).soft,false);
});

test('assembling independent conditions and retaining a grid preserves all controls and per-cell memories',()=>{
  const run=fixture(),results=Object.fromEntries(['primary',...formation.CONTROLS].map(name=>[name,{summary:name==='primary'?run.summary.primary:run.summary.controls[name],trials:run.trials[name],memory:name==='primary'?run.memory:run.controlMemories[name]}]));
  assert.deepEqual(formation.assembleSuite(small,results).summary,run.summary);
  assert.throws(()=>formation.assembleSuite({...small,seed:2},results));
  const grid=formation.combineRuns([run,run],'diagnostic');assert.equal(grid.summary.diagnostic.length,2);
  assert.equal(grid.summary.gridDecision.allCellsPass,false);assert.deepEqual(grid.memory.diagnostic[1].memory,run.memory);
  assert.equal(grid.summary.diagnostic[1].controls['afferent-ablation'],undefined);
  assert.equal(run.memory.diagnostic,undefined);
});

test('formed weight distributions gate the median alone and report ignition without gating it',()=>{
  const cores={A:[1,2,3],B:[4,5]},edges=[
    {sourceId:1,targetId:2,weight:.4},{sourceId:2,targetId:3,weight:1.02},
    {sourceId:1,targetId:3,weight:.8},{sourceId:3,targetId:1,weight:.6},
    {sourceId:4,targetId:5,weight:.8},{sourceId:5,targetId:4,weight:1.1},
    {sourceId:1,targetId:4,weight:.9},{sourceId:5,targetId:2,weight:.2},{sourceId:7,targetId:8,weight:.4}];
  const result=formation.potentiation(cores,edges);
  assert.equal(result.pass,true);assert.equal(result.cores.A.within.quantiles.median,.7);
  assert.equal(result.cores.A.within.quantiles.p25,.55);assert.equal(result.cores.A.within.atOrAboveThreshold,1);
  assert.equal(result.cores.A.within.fractionAtOrAboveThreshold,.25);assert.equal(result.cores.A.boundary.count,2);
  assert.equal(result.betweenCores.count,2);assert.equal(result.poolWide.count,9);assert.equal(result.poolWide.atOrAboveThreshold,2);
  const weak=structuredClone(edges);weak[1].weight=1.01;assert.equal(formation.potentiation(cores,weak).pass,true);
  assert.equal(formation.potentiation(cores,weak).cores.A.within.ignitionFraction,0);
  assert.equal(formation.potentiation(cores,weak).cores.A.within.ignitionHealthy,true);
  assert.equal(result.cores.A.within.ignitionHealthy,false);assert.equal(result.ignitionGated,false);
  assert.equal(formation.potentiation(cores,edges,.5).medianMinimum,.6,'Stage 1f uses the stated absolute 0.6 bar.');
  const boundary=edges.map(edge=>({...edge,weight:.6}));assert.equal(formation.potentiation(cores,boundary).pass,true);
  assert.equal(formation.potentiation(cores,boundary.map(edge=>({...edge,weight:.5999}))).pass,false);
  const empty=formation.potentiation(cores,[]);assert.equal(empty.pass,false);assert.equal(empty.cores.A.within.quantiles.median,null);
  assert.throws(()=>formation.weightDistribution([{weight:NaN}]));
});

test('jitter draws are independent, replayable, bounded, and identical across control schedules',()=>{
  const run=formation.setup({...small,gap:0}),other=formation.setup({...small,gap:0},'hebbian-off');
  const noJitter=formation.setup({...small,gap:0,jitter:0});assert.deepEqual(run.seedEdges,noJitter.seedEdges);
  assert.equal(run.field.rng.state,small.seed);assert.equal(noJitter.field.rng.state,small.seed);
  const featureSpikes=[];const observe=run.field.onEvent;
  run.field.onEvent=event=>{observe(event);if(event.type==='spike'&&run.features.includes(event.spike.neuronId))featureSpikes.push({id:event.spike.neuronId,tick:run.field.tick});};
  run.trial('A');other.trial('A');assert.equal(run.field.tick,65);
  assert.deepEqual(run.stimulusSchedule,other.stimulusSchedule);
  const rng=formation.random(run.streams.jitter),schedule=run.stimulusSchedule.A[0];assert.equal(schedule.t0,1);assert.equal(schedule.captureTicks,65);
  assert.equal(schedule.onsets.length,8);assert.ok(new Set(schedule.onsets.map(row=>row.offset)).size>1);
  for(const row of schedule.onsets){const draw=rng();assert.equal(row.draw,draw);assert.equal(row.offset,Math.floor(draw*16));
    assert.ok(row.offset>=0&&row.offset<=15);assert.equal(row.tick,schedule.t0+row.offset);
    assert.ok(featureSpikes.some(spike=>spike.id===row.cellId&&spike.tick===row.tick));}
  noJitter.trial('A');assert.equal(noJitter.field.tick,50);assert.ok(noJitter.stimulusSchedule.A[0].onsets.every(row=>row.offset===0&&row.tick===1));
  assert.equal(featureSpikes.length,8);assert.throws(()=>run.trial('C'));
});

test('probes stay synchronous and do not consume the formation jitter stream',()=>{
  const run=formation.setup({...small,gap:0}),untouched=formation.setup({...small,gap:0});
  const before=structuredClone(run.stimulusSchedule),memory=formation.exportMemory(run,{A:[],B:[]});
  const first=formation.probeMemory(memory,'A',0,0);assert.deepEqual(formation.probeMemory(memory,'A',0,0),first);
  assert.deepEqual(run.stimulusSchedule,before);run.trial('A');untouched.trial('A');assert.deepEqual(run.stimulusSchedule,untouched.stimulusSchedule);
  const emitter=formation.setup({...small,pairingClock:'emission'});assert.equal(emitter.field.config.pairingClock,'emission');
  assert.equal(formation.exportMemory(emitter,{A:[],B:[]}).artifact.config.pairingClock,'emission');
});

test('Hebbian-off cannot pass potentiation and uses the same recorded formation draws',()=>{
  const run=fixture();assert.deepEqual(run.trials.primary.stimulusSchedule,run.trials['hebbian-off'].stimulusSchedule);
  const disabled=run.summary.controls['hebbian-off'];assert.equal(disabled.criteria['10-potentiation'].pass,false);
  assert.ok(run.trials['hebbian-off'].growthEdges.every(edge=>edge.weight<=.4));
});

test('homeostasis and feature-growth variants survive strict snapshot export',()=>{
  const run=formation.setup({...small,homeostasis:true,featureGrowth:true});
  run.trial('A');const memory=formation.exportMemory(run,{A:[],B:[]});
  assert.equal(memory.artifact.features.homeostasis,true);
  assert.ok(run.features.every(id=>run.field.getNeuron(id).nextGrowthAt<1e12));
  assert.doesNotThrow(()=>formation.probeMemory(memory,'A'));
});

test('competition observers preserve native dynamics and count gains/losses separately from net weights',()=>{
  const opts={pool:150,k:4,maxSynapses:4,epochs:12,gap:.5,competitionMargin:.35,exploration:.3};
  const observed=formation.setup(opts),plain=formation.setup(opts,'primary',{audit:false}),trials={A:[],B:[]};
  for(let epoch=1;epoch<=opts.epochs;epoch++){
    for(const cue of ['A','B']){const active=observed.trial(cue);trials[cue].push(active);assert.deepEqual(active,plain.trial(cue));}
    observed.weightAudit.endEpoch(epoch);plain.weightAudit.endEpoch(epoch);
  }
  assert.deepEqual(observed.field.snapshot(),plain.field.snapshot(),'Observers must not change model state, event order, snapshots or RNG.');
  assert.deepEqual(formation.exportMemory(observed,{A:[],B:[]}),formation.exportMemory(plain,{A:[],B:[]}));
  assert.equal(observed.field.config.competitionMargin,.35);assert.equal(observed.field.config.exploration,.3);
  const data=observed.weightAudit.finish(),sum=key=>data.epochs.reduce((n,row)=>n+row[key],0);
  assert.ok(sum('potentiationEvents')>0);assert.ok(sum('competitionEvents')>0);assert.ok(sum('pruned')>0);
  assert.equal(sum('unexpectedGrowthChanges'),0);assert.equal(sum('formed'),data.lifecycles.length);
  for(const key of ['potentiationEvents','competitionEvents'])assert.equal(sum(key),data.lifecycles.reduce((n,row)=>n+row[key],0));
  for(const edge of data.lifecycles){
    assert.ok(Math.abs(edge.unobservedWeightChange)<1e-10);assert.ok(Math.abs(edge.competitionLoss-.12*edge.competitionEvents)<1e-10);
    assert.ok(edge.birthEpoch>=1&&edge.birthEpoch<=12);assert.equal(edge.surviving,edge.deathEpoch===null);
    if(!edge.surviving)assert.ok(edge.deathTime>=edge.birthTime);
  }
  const cores={A:formation.extractCore(trials.A),B:formation.extractCore(trials.B)};
  const summary=audit.summarizeAudit(data,{cores,pool:observed.pool,stimulusSchedule:observed.stimulusSchedule,seedEdges:observed.seedEdges,config:observed.field.config,gap:opts.gap});
  assert.equal(summary.epochSeconds,3.6);assert.equal(summary.totals.formed,observed.field.stats.formed);
  assert.equal(summary.totals.pruned,observed.field.stats.pruned);assert.ok(summary.lifetimes.survivingAgeEpochs.max<=12);
  for(const key of ['withinA','withinB','betweenCores','poolWide'])for(const bin of ['byAge','byPredictedPairings','byAgeAndPredictedPairings'])
    assert.equal(summary.weights[key][bin].reduce((n,row)=>n+row.count,0),summary.weights[key].count);
});

test('predicted pairings use earliest actual delays, inclusive timing bounds, and edge birth',()=>{
  const stimulusSchedule={A:[{t0:1,onsets:[{cellId:1,tick:1},{cellId:2,tick:6}]}],B:[]};
  const seedEdges=[{sourceId:1,targetId:10,delay:.1},{sourceId:1,targetId:10,delay:.2},{sourceId:2,targetId:11,delay:.1}];
  const schedule=audit.afferentSchedule(stimulusSchedule,seedEdges,.02),edge={sourceId:10,targetId:11,delay:.05,birthTime:0,deathTime:null};
  assert.equal(audit.predictedPairings(edge,schedule).qualifying,1);assert.equal(schedule[0].arrivals.get(10),.1);
  assert.equal(audit.predictedPairings({...edge,birthTime:.12},schedule).qualifying,0,'No delivery if edge is born at or after predicted source emission.');
  assert.equal(audit.predictedPairings({...edge,birthTime:.12},schedule,{sinceBirth:false}).qualifying,1);
  assert.equal(audit.predictedPairings({...edge,targetId:12},schedule).modelledTrials,0);
  const boundary=[{cue:'A',t0:0,arrivals:new Map([[10,0],[11,.32]])},{cue:'B',t0:0,arrivals:new Map([[10,0],[11,0]])}];
  assert.equal(audit.predictedPairings({...edge,delay:0,birthTime:-1},boundary).qualifying,2);
  assert.equal(audit.predictedPairings({...edge,delay:.001,birthTime:-1},boundary).qualifying,1);
  assert.equal(audit.predictedPairings({...edge,delay:1,birthTime:-1},boundary,{clock:'emission'}).qualifying,2);
  const empty=audit.summarizeAudit({enabled:true,epochs:[],lifecycles:[],endTime:0,endTick:0},
    {cores:{A:[],B:[]},pool:[],stimulusSchedule:{A:[],B:[]},seedEdges:[],config:{dt:.02,stdpWindow:.32,pairingClock:'arrival'},gap:10,captureTicks:65});
  assert.equal(empty.epochSeconds,22.6,'Untrained telemetry retains the configured epoch duration despite having no draws.');
});

test('Stage 1f negative-cue gate checks both delays, 25 percent spillover, Jaccard, and actual readback',()=>{
  const pool=Array.from({length:80},(_,i)=>i+1),cores={A:pool.slice(0,20),B:pool.slice(20,40)},positions=new Map(pool.map(id=>[id,{x:id,y:0,z:0}]));
  const trials={A:Array.from({length:10},()=>cores.A),B:Array.from({length:10},()=>cores.B)};
  const probes=Object.fromEntries([0,60].map(t=>[t,['A','B','C'].map(cue=>({cue,active:cue==='C'?[61,71,72,73,74,75]:cores[cue],label:cue==='C'?'reject':cue}))]));
  const halfProbes=Object.fromEntries([0,60].map(t=>[t,['A','B','C'].flatMap(cue=>[0,1].map(half=>({cue,half,bits:[],active:cue==='C'?[61]:cores[cue]})))]));
  const input={trials,cores,pool,positions,growthEdges:[],stats:{formed:0,pruned:0},probes,seed:1,directSets:{A:cores.A,B:cores.B,C:[61]},halfProbes,untrainedHalfProbes:halfProbes};
  let measured=formation.metrics(input);assert.equal(measured.criteria['4-negative-cue'].pass,true);assert.equal(measured.negative[0].spilloverFractionOfSmallerCore,.25);
  probes[60][2].active.push(76);assert.equal(formation.metrics(input).criteria['4-negative-cue'].pass,false);
  probes[60][2].active=[1,2,3,4,5];input.directSets.C=[1,2,3,4,5,61];
  assert.equal(formation.metrics(input).criteria['4-negative-cue'].pass,true,'Jaccard exactly 0.25 passes.');
  probes[60][2].active.push(6);input.directSets.C.push(6);measured=formation.metrics(input);
  assert.equal(measured.criteria['4-negative-cue'].pass,false);assert.equal(measured.directCInCores.A.count,6);
  probes[60][2].active=[...cores.A];input.directSets.C=[...cores.A,61];measured=formation.metrics(input);
  assert.equal(measured.negative[1].readback,'A','Readback is recomputed from actual response, not trusted from a stale label.');
  assert.equal(measured.criteria['4-negative-cue'].pass,false);
});

test('training checkpoints are isolated locked clones, preserve dynamics, and use contemporaneous cores',()=>{
  const opts={...small,epochs:20,gap:.5},observed=formation.runCondition(opts,'primary',{halfCheckpoints:true}),plain=formation.runCondition(opts,'primary',{checkpoints:false});
  assert.deepEqual(observed.memory,plain.memory);assert.deepEqual(observed.trials.weightAudit,plain.trials.weightAudit);
  assert.deepEqual(observed.trials.stimulusSchedule,plain.trials.stimulusSchedule);assert.deepEqual(observed.trials.A,plain.trials.A);assert.deepEqual(observed.trials.B,plain.trials.B);
  assert.equal(observed.summary.checkpoints.length,2);const checkpoint=observed.summary.checkpoints[0];assert.equal(checkpoint.epoch,10);
  assert.deepEqual(checkpoint.cores,{A:formation.extractCore(observed.trials.A.slice(0,10)),B:formation.extractCore(observed.trials.B.slice(0,10))});
  assert.deepEqual(observed.checkpointMemories[1].memory,observed.memory);
  for(const cue of ['A','C'])assert.deepEqual(checkpoint.probes[cue],formation.probeMemory(observed.checkpointMemories[0].memory,cue));
  for(const seconds of [0,60])for(const probe of checkpoint.halfProbes[seconds]){
    assert.deepEqual(probe,formation.probeMemory(observed.checkpointMemories[0].memory,probe.cue,seconds,probe.half));
    const row=checkpoint.halfCompletions[seconds].find(row=>row.cue===probe.cue&&row.half===probe.half);
    assert.equal(row.completion,formation.completion(probe.active,checkpoint.cores[probe.cue]));
  }
  assert.equal(checkpoint.fullACompletion,formation.completion(checkpoint.probes.A.active,checkpoint.cores.A));
  assert.equal(checkpoint.spilloverCount,checkpoint.probes.C.active.filter(id=>!observed.trials.directSets.C.includes(id)).length);
  assert.deepEqual(formation.runCondition({...small,epochs:0},'untrained').summary.checkpoints,[]);
});

function halfRows(value=.8){return Object.fromEntries([0,60].map(seconds=>[seconds,['A','B'].flatMap(cue=>[0,1].map(half=>({cue,half,completion:value})))]));}
test('Stage 1g stopping requires all eight valid halves, starts at 30, and ignores C and every other gate',()=>{
  const halves=halfRows();
  for(const epoch of [0,10,20,31,90])assert.equal(formation.completionCriterion(epoch,halves),false);
  for(const epoch of [30,40,80])assert.equal(formation.completionCriterion(epoch,halves),true);
  for(const seconds of [0,60])for(let i=0;i<4;i++){
    for(const value of [.79999,null,NaN,1.01]){const bad=structuredClone(halves);bad[seconds][i].completion=value;assert.equal(formation.completionCriterion(30,bad),false);}
  }
  const duplicate=structuredClone(halves);duplicate[60][3]=duplicate[60][2];assert.equal(formation.completionCriterion(30,duplicate),false);
  assert.equal(formation.completionCriterion(30,{0:halves[0]}),false);
  const curve=[10,20,30,40,50,60,70,80].map(epoch=>({epoch,halfCompletions:halfRows(epoch===30?.79:.8),spilloverFraction:1,cReadback:'A',otherGates:false}));
  assert.deepEqual(criterionStudy.stoppingDecision(curve),{epoch:40,reached:true});
  for(const row of curve){row.spilloverFraction=0;row.cReadback='reject';row.otherGates=true;}
  assert.deepEqual(criterionStudy.stoppingDecision(curve),{epoch:40,reached:true});
  assert.deepEqual(criterionStudy.stoppingDecision(curve.map(row=>({...row,halfCompletions:halfRows(.79)}))),{epoch:80,reached:false});
});

test('Stage 1g freezes the early native circuit and its audit while continuation preserves the fixed training trajectory',()=>{
  const opts={...small,epochs:40,radius:150,inhibitionStrength:0,initialWeight:.8,growthPeriod:.5,gap:.5};
  const stopped=formation.runCondition(opts,'primary',{trainToCriterion:true}),epoch=stopped.summary.stopping.epoch;
  assert.equal(epoch,30);assert.equal(stopped.summary.stopping.reached,true);
  const truncated=formation.runCondition(opts,'primary',{trainingEpochs:epoch,checkpoints:false});
  const full=formation.runCondition(opts,'primary',{checkpoints:false});
  assert.deepEqual(stopped.memory,truncated.memory);assert.deepEqual(stopped.summary.criteria,truncated.summary.criteria);
  assert.deepEqual(stopped.trials.weightAudit,truncated.trials.weightAudit);assert.equal(stopped.trials.A.length,epoch);
  assert.deepEqual(stopped.continuation.memory,full.memory);assert.deepEqual(stopped.continuation.trials.weightAudit,full.trials.weightAudit);
  assert.deepEqual(stopped.continuation.trials.stimulusSchedule,full.trials.stimulusSchedule);
  assert.equal(stopped.continuation.trials.A.length,40);assert.equal(stopped.summary.checkpoints.at(-1).epoch,epoch);
  assert.equal(stopped.continuation.summary.checkpoints.at(-1).epoch,40);assert.equal(stopped.checkpointMemories.length,4);
  assert.deepEqual(stopped.checkpointMemories.find(row=>row.epoch===epoch).memory,stopped.memory);
  const pruned=formation.runCondition(opts,'prune-formed',{trainingEpochs:epoch,checkpoints:false});
  assert.deepEqual(pruned.summary.ablation.beforeHalfProbes,stopped.summary.halfProbes);
  assert.deepEqual(pruned.summary.ablation.edgesBefore,stopped.trials.growthEdges);
  assert.equal(pruned.summary.effective.epochs,epoch);
  assert.throws(()=>formation.runCondition({...small,epochs:20},'primary',{trainToCriterion:true}));
});

function criterionFixture(spec,{pass=true,reached=true}={}){
  const run=studyFixture(spec,{pass});run.summary.stage='1g';
  run.summary.stopping={epoch:reached?40:80,reached};run.summary.trainingCurve=[];
  return run;
}
test('Stage 1g predeclares three baselines and one reported comparison; failures never cause a search',async()=>{
  const events=[],calls=[];
  const result=await criterionStudy.conductStudy({persist:name=>events.push(name),executeBatch:specs=>{
    calls.push(specs);assert.equal(events[0],'plan');return specs.map(spec=>criterionFixture(spec,{pass:spec.role!=='comparison'}));
  }});
  assert.equal(calls.length,1);assert.deepEqual(calls[0].map(row=>[row.options.seed,row.options.inhibitionStrength]),[[1,.5],[2,.5],[3,.5],[1,1]]);
  assert.equal(result.summary.pass,true,'Reported comparison is not a baseline acceptance gate.');
  const failed=structuredClone(result.cells);failed[2].run.summary.pass=false;failed[2].run.summary.failedCriteria=['10-potentiation'];
  assert.equal(criterionStudy.studyDecision(failed).pass,false);
  failed[2].run.summary.pass=true;failed[2].run.summary.stopping.reached=false;assert.equal(criterionStudy.studyDecision(failed).pass,false);
  assert.equal(criterionStudy.studyDecision(result.cells.slice(0,3)).pass,false);
  const wrong=structuredClone(result.cells);wrong[1].run.summary.options.epochs=40;assert.equal(criterionStudy.studyDecision(wrong).pass,false);
  assert.equal(criterionStudy.studyDecision([...result.cells,result.cells[0]]).pass,false);
});

test('Stage 1g assembly rejects mismatched control exposure, a later stop, and a substituted memory',()=>{
  const base=fixture(),opts=formation.options(),curve=[10,20,30,40,50,60,70,80].map(epoch=>({epoch,halfCompletions:halfRows(epoch<40?.7:.8)}));
  const results=Object.fromEntries(['primary',...formation.CONTROLS].map(condition=>{
    const summary=structuredClone(condition==='primary'?base.summary.primary:base.summary.controls[condition]);
    const epochs=condition==='untrained'?0:40;summary.options=opts;summary.effective.epochs=epochs;
    return [condition,{summary,trials:{A:Array.from({length:epochs},()=>[]),B:Array.from({length:epochs},()=>[])},memory:structuredClone(base.memory)}];
  }));
  results.primary.summary.stopping={epoch:40,reached:true,cConsulted:false,otherGatesConsulted:false};
  results.primary.continuation={summary:{checkpoints:curve,effective:{epochs:80}}};
  results.primary.checkpointMemories=[{epoch:40,memory:results.primary.memory}];
  assert.equal(criterionStudy.assembleSuite(opts,results).summary.stage,'1g');
  const exposure=structuredClone(results);exposure['growth-off'].summary.effective.epochs=80;assert.throws(()=>criterionStudy.assembleSuite(opts,exposure),/duration/);
  const late=structuredClone(results);late.primary.summary.stopping.epoch=50;assert.throws(()=>criterionStudy.assembleSuite(opts,late),/first qualifying/);
  const swapped=structuredClone(results);swapped.primary.memory={invalid:true};assert.throws(()=>criterionStudy.assembleSuite(opts,swapped),/snapshot/);
  const absent=structuredClone(results);delete absent['hebbian-off'];assert.throws(()=>criterionStudy.assembleSuite(opts,absent),/duration/);
});

function studyFixture(spec,{score=.8,spill=.1,pass=true,controlPass=true}={}){
  const base=fixture(),run={summary:structuredClone(base.summary),trials:{},memory:{},controlMemories:{},checkpointMemories:[]},s=run.summary;
  s.stage='1f';s.options=spec.options;s.seed=spec.options.seed;s.primaryProtocol=true;s.pass=pass&&controlPass;s.failedCriteria=s.pass?[]:['fixture failure'];
  s.growthOffDiscriminates=s.hebbianOffDiscriminates=s.formedAblationDiscriminates=controlPass;s.primary.pass=pass;
  for(const t of [0,60])for(const row of s.primary.patternCompletion.rows[t])if(row.cue!=='C')row.trained=score;
  for(const row of s.primary.negative)row.spilloverFractionOfSmallerCore=spill;
  return run;
}
test('candidate ranking uses every half/delay, excludes failed gates, and resolves ties in declaration order',()=>{
  const cells=['a','b','c'].map(id=>({id,run:studyFixture({options:formation.options()})}));
  cells[0].run.summary.primary.patternCompletion.rows[60][0].trained=.7;
  cells[1].run.summary.primary.pass=false;
  assert.equal(study.rankCells(cells)[0].cell.id,'c');assert.equal(study.scoreCell(cells[0]).minimumCompletion,.7);
  cells[0].run.summary.primary.patternCompletion.rows[60][0].trained=.8;assert.equal(study.rankCells(cells)[0].cell.id,'a');
  cells[0].run.summary.primary.negative[1].spilloverFractionOfSmallerCore=.2;assert.equal(study.rankCells(cells)[0].cell.id,'c');
});
test('study predeclares, freezes selection, confirms one setting, and never retries a failed confirmation',async()=>{
  const calls=[],events=[];let selection;
  const result=await study.conductStudy({persist:(name,value)=>{events.push(name);if(name==='selection')selection=value;},executeBatch:specs=>{
    calls.push(specs.map(s=>s.id));
    if(specs[0].role==='confirmation'){assert.ok(selection);assert.equal(selection.selected.id,'grid-3');assert.deepEqual(specs.map(s=>s.options.seed),[2,3]);}
    return specs.map(spec=>studyFixture(spec,{score:spec.id==='grid-3'?.95:.85,spill:.1,pass:spec.id!=='confirmation-3'}));
  }});
  assert.equal(events[0],'plan');assert.deepEqual(calls[0],['grid-0','grid-1','grid-2','grid-3','grid-4','grid-5']);
  assert.deepEqual(calls[1],['pool-baseline','pool-best']);assert.equal(calls.length,3);assert.equal(result.summary.pass,false);
  assert.deepEqual(study.settings(result.cells.at(-1).run.summary.options),study.settings(result.cells.find(c=>c.id==='grid-3').run.summary.options));
  const wrong=structuredClone(result.cells.at(-2));wrong.run.summary.options.inhibitionStrength=2;
  assert.equal(study.confirmationDecision(result.cells.find(c=>c.id==='grid-3'),[wrong,result.cells.at(-1)]).pass,false);
});
test('study can select the pool axis, deduplicates the baseline, and stops if no cell passes',async()=>{
  const calls=[];const run=await study.conductStudy({executeBatch:specs=>{calls.push(specs.map(s=>s.id));return specs.map(spec=>studyFixture(spec,{score:spec.options.pool===1000?.95:.85}));}});
  assert.deepEqual(calls[1],['pool-baseline']);assert.equal(run.summary.poolAliases[0].reuses,'pool-baseline');
  assert.equal(run.summary.selection.selected.id,'pool-baseline');assert.equal(run.summary.pass,true);assert.deepEqual(run.summary.confirmation.seeds,[1,2,3]);
  const none=[];const failed=await study.conductStudy({executeBatch:specs=>{none.push(specs);return specs.map(spec=>studyFixture(spec,{pass:false}));}});
  assert.equal(none.length,2);assert.equal(failed.summary.selection.selected,null);assert.equal(failed.summary.pass,false);
  const missing=study.confirmationDecision(run.cells.find(c=>c.id==='pool-baseline'),[]);assert.equal(missing.pass,false);
  const bad=structuredClone(run.cells.at(-1));bad.run.summary.pass=false;bad.run.summary.failedCriteria=['prune-formed'];
  assert.equal(study.confirmationDecision(run.cells.find(c=>c.id==='pool-baseline'),[run.cells.at(-2),bad]).pass,false);
});

test('maxSynapses ten is permanent native config and preserves the eight-edge seed projection',()=>{
  const run=formation.setup({...small,maxSynapses:10});assert.equal(run.field.config.maxSynapses,10);
  assert.ok(run.features.every(id=>run.field.getNeuron(id).synapses.length===8));
  assert.equal(formation.exportMemory(run,{A:[],B:[]}).artifact.config.maxSynapses,10);
});

test('formation leaves the copied Neuron source verifiable',()=>{
  const result=execFileSync(process.execPath,[path.join(__dirname,'../scripts/verify-source.cjs')],{encoding:'utf8'});
  assert.equal(JSON.parse(result).copiedFilesVerified,24);
});
