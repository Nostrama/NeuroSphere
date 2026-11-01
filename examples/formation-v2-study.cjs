'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto'),{performance}=require('node:perf_hooks');
const v=require('./formation-v2.cjs'),f=require('./formation.cjs');
const ROOT=path.resolve(__dirname,'..');
function declaration(){return {stage:'1-v2',sourcePlan:'docs/FORMATION_V2_PLAN.md',protocol:v.options(),
  cells:[...[1,2,3].map(seed=>({id:'baseline-'+seed,role:'baseline',options:v.options({seed})})),
    ...[3,4].flatMap(g=>[.6,.7].filter(w0=>g!==4||w0!==.7).map(w0=>({id:'diagnostic-g'+g+'-w'+w0,role:'diagnostic',options:v.options({g,w0})}))),
    {id:'diagnostic-synapses-8',role:'diagnostic',options:v.options({maxSynapses:8})}],
  primaryDiagnostic:'baseline-1 is the g=4/w0=0.7/maxSynapses=10 cell; reuse that run.',
  scaffold:{bits:192,groupSize:4,featureCount:768,totalCells:1268,featurePlacement:'Each bit owns g consecutive indices of a single 192*g-point Fibonacci shell, radius 300. Each cell has permanent reach 600 and nextGrowthAt 1e12.',
    poolPlacement:'The unchanged Stage 1 shifted Halton ball, radius 120, own cell radius 60.',input:'One native SpikeIO port per bit, cells array contains all group IDs; assert every group member fires once at its scheduled tick.',
    projections:'Independent seeded projection stream; 8 distinct pool targets per feature cell, native connect() with explicit w0.',
    directSet:'Seed-topology count >=ceil(1.02/w0)=2. Primed means exactly one hit. No equality with simulated activation is assumed.',
    weights:{initialWeight:.4,maxWeight:'w0',primaryW0:.7,threshold:1.02,leakRate:1.4,maxSynapses:10},
    featureGrowth:false,decay:'weightDecay=unusedDecay=healthLoss=0',clock:'arrival',margin:1,exploration:.1,inhibition:[.5,.6],cues:'ID-ordered disjoint words via unchanged loadVocabulary/selectCues.'},
  training:{jitter:8,jitterUnit:'One independent seeded integer draw per bit; all g copies share onset. Save draws and feature spike evidence.',captureTicks:58,gapSeconds:10,
    stopping:{checkpoints:Array.from({length:12},(_,i)=>(i+1)*10),minimum:30,maximum:120,threshold:.8,
      rule:'First checkpoint >=30 with both fixed halves of A and B >=0.8 at both 0/60-second delays on contemporaneous cores. C and all other gates are excluded.'},
    continuation:'Continue primary to 120 regardless of first stopping point. Never replace stopping memory based on later gates.',
    curves:'Report contemporary metrics and retrospectively recomputed frozen-stop metrics for every checkpoint. Frozen-reference curves cannot influence the stopping rule.'},
  gates:{stop:[1,2,3,4,7,8,9,10],stability:.7,specificity:.2,size:[5,'0.25*P'],negative:'C rejects, each Jaccard <=0.25, spillover <=25% of smaller core, both delays.',
    recurrent:'Within-core count >=core size and density >=3*pool density for both cores.',
    retention:'Unchanged Stage 1 criterion 8: full A at 60 seconds has Jaccard >=0.8 with A; B also reported.',
    completion:'Each of four fixed halves at both delays >=0.8 and gain >=0.25 vs untrained on the same core.',median:.6,capFractionThreshold:.69,
    continued:{epoch:120,reference:'Frozen stopping cores for specificity, spillover, completion, retention and within-core median.',gates:[2,4,8,9],median:.65,
      drift:'Jaccard(frozen stopping core, contemporaneous epoch-120 core) >=0.8 for BOTH A/B.',contemporaneous:'Report separately; never substitute into gate 11.'},
    reported:[5,6,'strict stability','cap fraction','primed and truly-neutral recruits','direct overlaps','churn','weight versus predicted pairings','fan-in']},
  controls:{standard:v.CONTROLS,matched:'Growth/Hebbian/inhibition/shuffled use primary stopping epoch. Untrained zero. Native prune-formed acts on the exact restored stopping circuit.',
    required:'Growth-off and Hebbian-off each fail both 9 and 10; pruning lowers every half below 0.6 from a higher value.',
    continuedPlastic:'Primary own epoch-120 continuation.',continuedHebbianOff:'Native checkpoint restore at stop, then recorded field.setFeatures({hebbian:false}); structure may keep growing until 120.',
    noPostStopEpochs:'If stop=120, continued controls have zero additional epochs; report this limit without extending training.'},
  basin:{counts:[2,3,4,5,6,8],subsets:[[0,2,4,6,1,3,5,7],[1,3,5,7,0,2,4,6]],
    rule:'Prefix of each fixed index order in the sorted eight-bit code; at 4 bits these are exactly the two existing halves. At 8 both orders are the same full cue. No subset search.',
    probes:'Synchronous independent locked clones, both delays, A/B, trained and initial untrained against the same stopping reference; also report epoch-120 contemporary and frozen-reference basins.'},
  audit:{observer:'Unchanged Stage 1e native potentiation and competition observers. Continued phase imports and merges the original edge lifecycles.',
    prediction:'Aff-only continuous leaky integration of all grouped seed arrivals until threshold 1.02, first crossing per endpoint; actual recurrent delay, inclusive lag 0..0.32 s, since birth. Does not model youth, adaptation, inhibition, rounding or recurrence. Predicted counts never replace observed native events.'},
  decision:'GO only when every baseline seed reaches criterion, passes stop gates, gate 11 and all three required control discriminations. All seven cells saved; diagnostics cannot replace primary. Exit 0 GO, 1 scientific NO-GO, 2 execution error.'};}
function codeHash(){const hash=createHash('sha256');for(const name of ['formation-v2.cjs','formation-v2-audit.cjs','formation-v2-study.cjs','formation.cjs','formation-audit.cjs','association-audit.cjs'])hash.update(fs.readFileSync(path.join(__dirname,name)));return hash.digest('hex');}
function write(directory,name,value){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,name+'.json'),f.json(value));}
function saveCondition(directory,result){for(const name of ['summary','memory','trials','development'])if(result[name])write(directory,name,result[name]);
  if(result.untrainedMemory)write(directory,'initial-memory',result.untrainedMemory);
  if(result.curve)write(directory,'curve',result.curve);
  for(const cp of result.checkpointMemories||[])write(path.join(directory,'checkpoints',String(cp.epoch).padStart(3,'0')),'memory',cp.memory);
}
function persistCase(directory,run){
  write(directory,'summary',run.summary);saveCondition(path.join(directory,'primary'),run.primary);
  write(path.join(directory,'initial'),'memory',run.primary.untrainedMemory);write(path.join(directory,'initial'),'basin',run.primary.untrainedBasin);
  for(const [condition,result] of Object.entries(run.controls))saveCondition(path.join(directory,'controls',condition),result);
}
function decide(cells){
  const plan=declaration(),failures=[];if(cells.length!==plan.cells.length)failures.push('All seven declared cells must be saved.');
  for(const spec of plan.cells){const matching=cells.filter(c=>c.id===spec.id&&f.json(c.options)===f.json(spec.options));
    if(matching.length!==1){failures.push('Missing or mismatched '+spec.id);continue;}
    if(spec.role==='baseline'&&!matching[0].summary.pass)failures.push(spec.id+': '+matching[0].summary.failedCriteria.join(', '));
  }return {pass:!failures.length,failedCriteria:failures};
}
async function worker(directory,id){
  const log=fs.openSync(path.join(directory,'case-'+id+'.log'),'w');
  const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[__filename,'--worker',directory,id],{cwd:ROOT,windowsHide:true,stdio:['ignore',log,log]});p.once('error',reject);p.once('close',resolve);});
  fs.closeSync(log);if(code!==0)throw new Error(id+' execution failed; inspect its worker log.');
}
async function runStudy(output){
  const timestamp=new Date().toISOString(),start=performance.now(),directory=path.join(path.resolve(output),timestamp.replace(/[:.]/g,'-')+'-stage1v2');
  fs.mkdirSync(directory,{recursive:true});const plan=declaration();write(directory,'plan',plan);
  const implementationHash=codeHash(),sourcePlanHash=createHash('sha256').update(fs.readFileSync(path.join(ROOT,plan.sourcePlan))).digest('hex');
  const concurrency=Math.max(1,Math.min(7,Math.floor(os.availableParallelism()/2))),timing=()=>({timestamp,nodeVersion:process.version,wallTimeMs:performance.now()-start,implementationHash,sourcePlanHash,concurrency});
  write(directory,'timing',timing());process.stdout.write('Declared Stage 1 v2 study: '+directory+'\n');
  let index=0;const outcomes=await Promise.allSettled(Array.from({length:concurrency},async()=>{while(index<plan.cells.length){const spec=plan.cells[index++];await worker(directory,spec.id);
    const summary=JSON.parse(fs.readFileSync(path.join(directory,'cases',spec.id,'summary.json')));process.stdout.write(spec.id+': stop '+summary.stopping.epoch+', '+(summary.pass?'PASS':'FAIL: '+summary.failedCriteria.join(', '))+'\n');}}));
  const errors=outcomes.filter(r=>r.status==='rejected');if(errors.length)throw new AggregateError(errors.map(r=>r.reason),'V2 study execution errors.');
  if(implementationHash!==codeHash())throw new Error('Runtime changed during the study.');
  const cells=plan.cells.map(spec=>({...spec,summary:JSON.parse(fs.readFileSync(path.join(directory,'cases',spec.id,'summary.json')))}));
  const summary={schema:'neurosphere-formation-v2-study/v1',stage:'1-v2',plan,cells,...decide(cells)};write(directory,'summary',summary);write(directory,'timing',timing());return {directory,summary};
}
async function main(argv){
  if(argv[0]==='--worker'){
    const [,directory,id]=argv,plan=JSON.parse(fs.readFileSync(path.join(directory,'plan.json'))),start=performance.now();
    if(f.json(plan)!==f.json(declaration()))throw new Error('Declaration changed.');const spec=plan.cells.find(c=>c.id===id);if(!spec)throw new Error('Undeclared cell.');
    const run=v.runSuite(spec.options,condition=>process.stdout.write(id+'/'+condition+'\n')),target=path.join(directory,'cases',id);persistCase(target,run);
    write(target,'timing',{nodeVersion:process.version,wallTimeMs:performance.now()-start});return 0;
  }
  let output=path.join(ROOT,'outputs/formation-v2');
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--study')continue;
    if(argv[i]==='--output'&&argv[i+1]&&!argv[i+1].startsWith('--')){output=argv[++i];continue;}
    if(argv[i]==='--help'){process.stdout.write('node examples/formation-v2.cjs [--study] [--output DIRECTORY]\nOnly the predeclared study is exposed; exit 0 GO, 1 scientific NO-GO, 2 execution error.\n');return 0;}
    throw new Error('Unknown option: '+argv[i]);
  }
  const result=await runStudy(output);process.stdout.write('Stage 1 v2 '+(result.summary.pass?'GO':'NO-GO')+'; Results: '+result.directory+'\n');return result.summary.pass?0:1;
}
module.exports={declaration,codeHash,decide,persistCase,runStudy,main};
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(error.stack+'\n');if(error.errors)for(const e of error.errors)process.stderr.write(e.stack+'\n');process.exitCode=2;});
