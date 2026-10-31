'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('Neuron renderer is a byte-for-byte copy and its morphology is stable and three dimensional',()=>{
  const record=require('../docs/UI_SOURCE.json').files.find(file=>file.mode==='verbatim');const bytes=fs.readFileSync(path.join(__dirname,'..',record.destination));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),record.sha256);
  const {neuronShape}=require('../public/upstream/neuron-volume.js');const first=neuronShape(193),second=neuronShape(193);assert.deepEqual(first,second);assert.notEqual(first,second);assert.ok(first.stems.some(stem=>stem.kind==='axon'));assert.ok(first.stems.some(stem=>stem.kind==='dendrite'));assert.ok(first.stems.every(stem=>stem.points.every(point=>point.length===3&&point.every(Number.isFinite))));assert.notDeepEqual(first,neuronShape(194));
});
test('weight matrix bins contain only real edges and retain the strongest signed weight',async()=>{
  const {weightMatrix}=await import('../public/telemetry-model.mjs');
  const scene={nodes:[{id:1,domainId:'001'},{id:2,domainId:'001'},{id:3,domainId:'002'}],edges:[{source:1,target:2,weight:.2},{source:2,target:1,weight:-.6},{source:3,target:3,weight:1}]};
  const matrix=weightMatrix(scene,'001',1);assert.equal(matrix.count,2);assert.equal(matrix.cells.size,1);const cell=matrix.cells.get(0);assert.equal(cell.count,2);assert.equal(cell.weight,-.6);assert.equal(cell.edge.source,2);
  const full=weightMatrix(scene,'001',128);assert.equal(full.cells.size,2);assert.equal(full.cells.has(0),false);assert.equal(weightMatrix(scene,'missing').count,0);
});
test('telemetry reconstructs omitted resting cells and scopes population means',async()=>{
  const {potentialSeries,populationSeries}=await import('../public/telemetry-model.mjs');const nodes=[{id:1,restLevel:.1},{id:2,restLevel:.3}];const samples=[{time:0,values:[]},{time:.02,values:[[1,.5],[99,100]]}];
  assert.deepEqual(potentialSeries(samples,nodes[0]),[{time:0,value:.1},{time:.02,value:.5}]);assert.deepEqual(populationSeries(samples,nodes),[{time:0,value:.2},{time:.02,value:.4}]);assert.deepEqual(potentialSeries([],nodes[0]),[]);assert.deepEqual(populationSeries(samples,[]),[]);
});
test('console markup has unique IDs and all literal controls used by its scripts exist',()=>{
  const root=path.join(__dirname,'../public'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size);
  for(const file of ['app.js','dashboard.js']){const code=fs.readFileSync(path.join(root,file),'utf8');for(const match of code.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(match[1]),'Missing control '+match[1]);}
  assert.equal([...html.matchAll(/id="recall-form"/g)].length,1);assert.equal([...html.matchAll(/id="teach-form"/g)].length,1);assert.ok(html.includes('Sense Input'));assert.ok(ids.includes('output-title'));
});
