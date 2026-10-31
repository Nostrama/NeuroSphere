'use strict';
// Declared Stage 1f study orchestration; no model or engine changes.
const fs=require('node:fs'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const f=require('./formation.cjs');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function settings(options){return Object.fromEntries(Object.entries(options).filter(([key])=>key!=='seed').sort(([a],[b])=>a<b?-1:a>b?1:0));}
function scoreCell(cell){
  const p=cell.run.summary.primary,halves=[0,60].flatMap(t=>p.patternCompletion.rows[t].filter(row=>row.cue!=='C').map(row=>row.trained));
  const spills=p.negative.map(row=>row.spilloverFractionOfSmallerCore);
  const valid=halves.length===8&&halves.every(Number.isFinite)&&spills.length===2&&spills.every(Number.isFinite);
  const minimumCompletion=valid?Math.min(...halves):null,maximumSpilloverFraction=valid?Math.max(...spills):null;
  return {minimumCompletion,maximumSpilloverFraction,score:valid?minimumCompletion-maximumSpilloverFraction:null,
    eligible:Boolean(valid&&p.pass&&cell.run.summary.primaryProtocol)};
}
function rankCells(cells,{passingOnly=true}={}){
  return cells.map((cell,index)=>({cell,index,...scoreCell(cell)})).filter(row=>row.score!==null&&(!passingOnly||row.eligible))
    .sort((a,b)=>b.score-a.score||a.index-b.index);
}
function declaration(){return {stage:'1f',protocol:f.options(),grid:f.diagnosticOptions(),
  poolAxis:{pool:1000,settings:['baseline inhibition 0.5/0.6','best passing inhibition-grid cell'],
    fallback:'If no grid cell passes, use the grid cell with greatest finite score (or baseline if none); still run only the two declared pool cells. Deduplicate identical settings.'},
  selection:{population:'All unique seed-1 inhibition-grid and pool-axis cells passing every primary gate.',
    score:'Minimum A/B half completion over both halves and both delays minus maximum C spillover fraction over both delays.',
    ties:'First in declared order: six inhibition cells, pool baseline, pool best.',
    controls:'All controls are run and saved. Control failures are not used to switch to a runner-up; the selected setting must pass them for GO.',
    confirmationSeeds:[2,3],noPassingCell:'Report the curves and stop; no additional search.',failedConfirmation:'NO-GO; no replacement candidate or further search.'},
  checkpoints:{epochs:[10,20,30,40,50,60,70,80],cues:['C','full A'],idleSeconds:0,
    reference:'Last-ten cores at that checkpoint. Full-A completion is recall against the contemporaneous A core, not half-cue completion.',
    isolation:'Independent locked clone for each cue; formation state and RNG are untouched.',
    controls:'Recorded for every trained condition before final ablation. Untrained has no training checkpoints. Primary checkpoint memories are saved.'},
  gates:{stability:'soft 0.7',negativeCue:{readback:'reject at both delays, nearest-core cutoff 0.5',jaccardMaximum:.25,spilloverFractionMaximum:.25},medianWeightMinimum:.6,
    gated:[1,2,3,4,7,8,9,10],reported:[5,6,'strict stability','ignition fraction','churn','weight vs pairings','training curve']}};}
function confirmationDecision(selected,confirmations){
  const reasons=[];
  if(!selected)return {pass:false,reasons:['No seed-1 cell passes every gate.'],seeds:[]};
  const all=[selected,...confirmations],seeds=all.map(cell=>cell.run.summary.options.seed);
  if(selected.run.summary.options.seed!==1)reasons.push('Selection must be made on seed 1.');
  if(!same([...seeds].sort((a,b)=>a-b),[1,2,3]))reasons.push('Exactly seeds 1, 2 and 3 are required.');
  if(!scoreCell(selected).eligible)reasons.push('The selected seed-1 cell is not eligible.');
  for(const cell of all){
    if(!same(settings(cell.run.summary.options),settings(selected.run.summary.options)))reasons.push(cell.id+': settings differ from the selected cell.');
    if(!cell.run.summary.pass)reasons.push(cell.id+': '+cell.run.summary.failedCriteria.join('; '));
  }
  return {pass:reasons.length===0,reasons,seeds};
}
function describe(cell){
  const s=cell.run.summary,p=s.primary;
  return {id:cell.id,role:cell.role,path:'cases/'+cell.id,options:s.options,...scoreCell(cell),pass:s.pass,failedCriteria:s.failedCriteria,
    coreSizes:p.coreSizes,interCoreJaccard:p.specificity,completion:p.patternCompletion.rows,negative:p.negative,
    medianWeights:Object.fromEntries(['A','B'].map(c=>[c,p.potentiation.cores[c].within.quantiles.median])),
    ignitionFractions:Object.fromEntries(['A','B'].map(c=>[c,p.potentiation.cores[c].within.ignitionFraction])),
    controls:{growth:s.growthOffDiscriminates,hebbian:s.hebbianOffDiscriminates,pruning:s.formedAblationDiscriminates},checkpoints:p.checkpoints};
}
async function conductStudy({executeBatch,publish=()=>{},persist=()=>{}}){
  const plan=declaration(),cells=[];await persist('plan',plan);
  async function execute(specs){
    const runs=await executeBatch(specs);if(runs.length!==specs.length)throw new Error('Incomplete study batch.');
    const added=[];
    for(let i=0;i<specs.length;i++){
      const spec=specs[i],run=runs[i];
      if(!same(run.summary.options,spec.options)||run.summary.stage!=='1f')throw new Error('Mismatched study cell: '+spec.id);
      const cell={...spec,run};await publish(cell);cells.push(cell);added.push(cell);
    }
    return added;
  }
  const grid=await execute(plan.grid.map((options,index)=>({id:'grid-'+index,role:'inhibition',options})));
  const bestGrid=rankCells(grid)[0]?.cell??rankCells(grid,{passingOnly:false})[0]?.cell??grid[0];
  const poolSpecs=[{id:'pool-baseline',role:'pool',options:f.options({pool:1000})},
    {id:'pool-best',role:'pool',options:f.options({...bestGrid.run.summary.options,pool:1000})}];
  const uniquePool=poolSpecs.filter((spec,index)=>!poolSpecs.slice(0,index).some(previous=>same(spec.options,previous.options)));
  await persist('pool-selection',{bestGrid:bestGrid.id,ranking:rankCells(grid).map(row=>({id:row.cell.id,score:row.score})),
    cells:uniquePool,aliases:poolSpecs.filter(spec=>!uniquePool.includes(spec)).map(spec=>({id:spec.id,reuses:uniquePool.find(row=>same(row.options,spec.options)).id}))});
  await execute(uniquePool);
  const ranking=rankCells(cells),selected=ranking[0]?.cell??null;
  const selection={ranking:ranking.map(row=>({id:row.cell.id,score:row.score,minimumCompletion:row.minimumCompletion,maximumSpilloverFraction:row.maximumSpilloverFraction})),
    selected:selected?{id:selected.id,options:selected.run.summary.options,...scoreCell(selected)}:null,
    rule:plan.selection,confirmationOptions:selected?[2,3].map(seed=>f.options({...selected.run.summary.options,seed})):[]};
  // Persist the winner before observing any confirmation result.
  await persist('selection',selection);
  const confirmations=selected?await execute(selection.confirmationOptions.map(options=>({id:'confirmation-'+options.seed,role:'confirmation',options}))):[];
  const decision=confirmationDecision(selected,confirmations);
  const summary={schema:'neurosphere-formation-study/v1',stage:'1f',declaration:plan,bestInhibitionCell:bestGrid.id,
    poolAliases:poolSpecs.filter(spec=>!uniquePool.includes(spec)).map(spec=>({id:spec.id,reuses:uniquePool.find(row=>same(row.options,spec.options)).id})),
    selection,cells:cells.map(describe),confirmation:decision,pass:decision.pass};
  await persist('summary',summary);return {summary,cells};
}
async function runStudy(outputRoot,{executeBatch,progress=message=>process.stderr.write(message+'\n'),implementationHash}={}){
  const started=performance.now(),timestamp=new Date().toISOString();fs.mkdirSync(outputRoot,{recursive:true});let directory;
  for(let index=0;index<10000;index++){
    const name=new Date(Date.parse(timestamp)+index).toISOString().replace(/[:.]/g,'-')+'-stage1f',candidate=path.join(outputRoot,name);
    try{fs.mkdirSync(candidate);directory=candidate;break;}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  if(!directory)throw new Error('Cannot reserve study directory.');
  const timing=()=>({timestamp,nodeVersion:process.version,wallTimeMs:performance.now()-started,
    wallTimeScope:'Elapsed study wall time at save.',...(implementationHash?{implementationHash}:{})});
  const persist=(name,value)=>fs.writeFileSync(path.join(directory,name+'.json'),f.json(value));
  persist('timing',timing());
  const execute=executeBatch??(specs=>specs.map(spec=>f.runSuite(spec.options,condition=>progress(spec.id+'/'+condition))));
  const result=await conductStudy({executeBatch:execute,persist,publish:cell=>{
    const target=path.join(directory,'cases',cell.id);fs.mkdirSync(target,{recursive:true});f.writeArtifacts(target,cell.run,timing());
    progress(cell.id+': '+(cell.run.summary.pass?'PASS':'FAIL'));
  }});
  persist('timing',timing());return {...result,directory};
}
module.exports={settings,scoreCell,rankCells,declaration,confirmationDecision,describe,conductStudy,runStudy};
