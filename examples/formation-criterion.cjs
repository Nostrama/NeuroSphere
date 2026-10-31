'use strict';
// Stage 1g host protocol. The engine, training dynamics and acceptance gates are unchanged.
const fs=require('node:fs'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const f=require('./formation.cjs');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function declaration(){
  return {stage:'1g',protocol:f.options(),cells:[
    ...[1,2,3].map(seed=>({id:'baseline-'+seed,role:'baseline',options:f.options({seed})})),
    {id:'comparison-1',role:'comparison',options:f.options({seed:1,inhibitionStrength:1})}],
    stopping:{epochs:[10,20,30,40,50,60,70,80],minimumEpoch:30,maximumEpoch:80,threshold:.8,
      rule:'First checkpoint >=30 where both fixed halves of both A and B complete >=0.8 of their contemporaneous cores at both 0 and 60 seconds. C and all other gates are excluded.',
      core:'At least 80% presence in the last ten trials of that cue.',
      noMatch:'Evaluate epoch 80, mark criterion not reached and fail.',
      afterStop:'Continue the same training to epoch 80 for the curve only. Never replace the first stopping circuit after seeing another gate fail.'},
    controls:{names:f.CONTROLS,training:'Match each primary stopping epoch. Controls do not choose their own duration; untrained has zero epochs.',
      pruning:'Prune only growth-formed pool-to-pool edges on the circuit at the primary stopping epoch.',
      required:'Growth-off fails 9 and 10; Hebbian-off fails 9 and 10; prune-formed lowers every A/B half at both delays below 0.6 from a higher value.'},
    acceptance:{gated:[1,2,3,4,7,8,9,10],stabilityMinimum:.7,medianWeightMinimum:.6,
      completion:'Both halves of A/B at both delays >=0.8 AND gain >=0.25 over untrained on the same contemporaneous core.',
      negativeCue:'Readback rejects C at both delays, C-to-core Jaccards <=0.25, spillover <=25% of the smaller core.',
      decision:'All three baseline seeds reach criterion and pass every gate and required control at their own stop. The comparison is reported only.'},
    checkpointProbes:{halves:['A even','A odd','B even','B odd'],idleSeconds:[0,60],additional:['full A at 0 s','C at 0 s'],
      isolation:'Independent locked native controllers. No probe or stopping decision changes formation state or RNG.'}};
}
function stoppingDecision(checkpoints){
  const first=checkpoints.find(row=>f.completionCriterion(row.epoch,row.halfCompletions));
  return {epoch:first?.epoch??80,reached:Boolean(first)};
}
function assembleSuite(values,results){
  const opts=f.options(values),primary=results.primary,stop=primary?.summary.stopping;
  if(!stop||!primary.continuation)throw new Error('Missing stopping circuit or continuation.');
  const curve=primary.continuation.summary.checkpoints,decision=stoppingDecision(curve);
  if(!same(curve.map(row=>row.epoch),[10,20,30,40,50,60,70,80])||stop.epoch!==decision.epoch||stop.reached!==decision.reached||stop.cConsulted!==false||stop.otherGatesConsulted!==false)
    throw new Error('Stopping decision does not match the first qualifying checkpoint.');
  const checkpoint=primary.checkpointMemories.find(row=>row.epoch===stop.epoch);
  if(!checkpoint||!same(primary.memory,checkpoint.memory))throw new Error('Acceptance memory differs from stopping snapshot.');
  for(const condition of ['primary',...f.CONTROLS]){
    const expected=condition==='untrained'?0:stop.epoch,result=results[condition];
    if(result?.summary.effective.epochs!==expected||result.trials.A.length!==expected||result.trials.B.length!==expected)
      throw new Error('Unmatched control training duration: '+condition);
  }
  const run=f.assembleSuite(opts,results),s=run.summary;
  const protocol=Object.entries(f.DEFAULTS).every(([key,value])=>key==='seed'||key==='inhibitionStrength'||opts[key]===value)&&
    Object.keys(opts).length===Object.keys(f.DEFAULTS).length&&[1,2,3].includes(opts.seed)&&[.5,1].includes(opts.inhibitionStrength)&&
    (opts.inhibitionStrength===.5||opts.seed===1)&&s.primaryProtocol;
  s.schema='neurosphere-formation-report/v7';s.stage='1g';s.primaryProtocol=protocol;
  s.protocol.stopping=declaration().stopping;s.protocol.matchedControlEpoch=stop.epoch;
  s.protocol.checkpoints=declaration().checkpointProbes;s.stopping=stop;
  s.trainingCurve=curve;s.continuationEpoch=primary.continuation.summary.effective.epochs;
  if(!protocol)s.failedCriteria.push('Stage 1g requires the declared baseline or seed-1 comparison protocol.');
  if(!stop.reached)s.failedCriteria.push('Half-completion stopping criterion not reached by epoch 80.');
  s.pass=s.failedCriteria.length===0;
  s.perSeedResults=[{seed:opts.seed,stoppingEpoch:stop.epoch,reached:stop.reached,pass:s.pass,failedCriteria:s.failedCriteria}];
  run.continuation=primary.continuation;
  return run;
}
function runSuite(values={},progress=()=>{}){
  const opts=f.options(values),results={};progress('primary');
  results.primary=f.runCondition(opts,'primary',{trainToCriterion:true});
  for(const condition of f.CONTROLS){progress(condition);results[condition]=f.runCondition(opts,condition,{trainingEpochs:results.primary.summary.stopping.epoch});}
  return assembleSuite(opts,results);
}
function describe(cell){
  const s=cell.run.summary,p=s.primary;
  return {id:cell.id,role:cell.role,path:'cases/'+cell.id,options:s.options,stopping:s.stopping,pass:s.pass,failedCriteria:s.failedCriteria,
    coreSizes:p.coreSizes,interCoreJaccard:p.specificity,completion:p.patternCompletion.rows,negative:p.negative,
    medianWeights:Object.fromEntries(['A','B'].map(cue=>[cue,p.potentiation.cores[cue].within.quantiles.median])),
    ignitionFractions:Object.fromEntries(['A','B'].map(cue=>[cue,p.potentiation.cores[cue].within.ignitionFraction])),
    criteria:p.criteria,controls:{growth:s.growthOffDiscriminates,hebbian:s.hebbianOffDiscriminates,pruning:s.formedAblationDiscriminates},trainingCurve:s.trainingCurve};
}
function studyDecision(cells){
  const required=declaration().cells,reasons=[];
  if(cells.length!==required.length)reasons.push('All four declared cells must be saved.');
  for(const spec of required){
    const matches=cells.filter(cell=>cell.id===spec.id&&cell.role===spec.role&&same(cell.run.summary.options,spec.options));
    if(matches.length!==1){reasons.push('Missing, duplicate or mismatched cell: '+spec.id);continue;}
    const s=matches[0].run.summary;
    if(s.stage!=='1g')reasons.push(spec.id+': wrong stage.');
    if(spec.role==='baseline'&&(!s.pass||!s.primaryProtocol||!s.stopping?.reached))reasons.push(spec.id+': '+(s.failedCriteria.join('; ')||'criterion or protocol not met'));
  }
  return {pass:reasons.length===0,reasons};
}
async function conductStudy({executeBatch,persist=()=>{},publish=()=>{}}){
  const plan=declaration();await persist('plan',plan);
  const runs=await executeBatch(plan.cells);
  if(runs.length!==plan.cells.length)throw new Error('Incomplete declared study.');
  const cells=[];
  for(let i=0;i<runs.length;i++){
    const spec=plan.cells[i],run=runs[i];
    if(!same(spec.options,run.summary.options)||run.summary.stage!=='1g')throw new Error('Mismatched study result: '+spec.id);
    const cell={...spec,run};await publish(cell);cells.push(cell);
  }
  const summary={schema:'neurosphere-formation-criterion-study/v1',stage:'1g',declaration:plan,cells:cells.map(describe),...studyDecision(cells)};
  await persist('summary',summary);return {summary,cells};
}
async function runStudy(outputRoot,{executeBatch,progress=message=>process.stderr.write(message+'\n'),implementationHash}={}){
  const started=performance.now(),timestamp=new Date().toISOString();fs.mkdirSync(outputRoot,{recursive:true});let directory;
  for(let index=0;index<10000;index++){
    const candidate=path.join(outputRoot,new Date(Date.parse(timestamp)+index).toISOString().replace(/[:.]/g,'-')+'-stage1g');
    try{fs.mkdirSync(candidate);directory=candidate;break;}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  if(!directory)throw new Error('Cannot reserve study directory.');
  const timing=()=>({timestamp,nodeVersion:process.version,wallTimeMs:performance.now()-started,...(implementationHash?{implementationHash}:{})});
  const persist=(name,value)=>fs.writeFileSync(path.join(directory,name+'.json'),f.json(value));persist('timing',timing());
  const execute=executeBatch??(specs=>specs.map(spec=>runSuite(spec.options,condition=>progress(spec.id+'/'+condition))));
  const result=await conductStudy({executeBatch:execute,persist,publish:cell=>{
    const target=path.join(directory,'cases',cell.id);fs.mkdirSync(target,{recursive:true});f.writeArtifacts(target,cell.run,timing());
    progress(cell.id+': stop '+cell.run.summary.stopping.epoch+', '+(cell.run.summary.pass?'PASS':'FAIL'));
  }});
  persist('timing',timing());return {...result,directory};
}
module.exports={declaration,stoppingDecision,assembleSuite,runSuite,describe,studyDecision,conductStudy,runStudy};
