'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{performance}=require('node:perf_hooks');
const a=require('./association.cjs'),f=require('./formation.cjs');
function declaration(){return {stage:'2',sourcePlan:'docs/ASSOCIATION_PLAN.md',formation:f.options(),formationStops:a.STOP,evidence:a.EVIDENCE,
  cells:[...[1,2,3].map(seed=>({id:'baseline-'+seed,role:'baseline',seed,delta:12,jitter:5})),
    ...[6,12,24].flatMap(delta=>[5,15].filter(jitter=>delta!==12||jitter!==5).map(jitter=>({id:'diagnostic-'+delta+'-'+jitter,role:'diagnostic',seed:1,delta,jitter})))],
  diagnosticPrimary:'baseline-1 is also the 12/5 diagnostic cell; the same saved run is reused.',
  stopping:{checkpoints:[5,10,15,20,25,30,35,40],minimum:5,maximum:40,threshold:.5,idleSeconds:[0,60],
    rule:'First checkpoint whose A-alone recruitment of refB is >=0.5 at both delays. Nothing else is consulted. Evaluate there and continue to 40 only for the curve.'},
  acceptance:{forward:.5,reverse:'<= its Stage 1g baseline + 0.15',halfSelfCompletion:.8,fullSelfRecall:.9,
    cReadback:'Nearest-ref-core Jaccard <0.5 (reject)',cJaccardMaximum:.25,cRelativeSpillover:'<= matched unpaired fraction + 0.10',absoluteSpilloverCap:{value:.25,gated:false},
    requiredControls:{'unpaired-continuation':'forward <= baseline + 0.15','hebbian-off-association':'forward <= baseline + 0.15',
      'prune-cross':'forward <0.3 and below pre-prune; all four self half completions change by no more than 0.05 at both delays'},
    go:'Every gated condition and required control passes on all three baseline seeds. Diagnostics and reported controls cannot change this decision.'},
  controls:{required:['unpaired-continuation','hebbian-off-association','prune-cross'],reportedSeed1:['reverse-order','growth-off-association'],baseline:'untrained = exact Stage 1g stop before association',
    exposure:'Controls evaluated at primary stop. Unpaired continuation proceeds to 40 separately for the dashed curve, with A then B each epoch, jitter 15 and 10-second gaps exactly as Stage 1g.',
    hebbian:'Native field.setFeatures({hebbian:false}) at the verified unlocked boundary; permanent for the phase and recorded in featureHistory.',
    growth:'Pool nextGrowthAt=1e12 at the boundary only.',pruning:'Native prune() on the union of surviving formed A-to-B and B-to-A edges; remove inactive references from source.synapses, preserving all other edges.'},
  measurement:{refs:'Frozen Stage 1g cores; all Stage 2 gates and metrics use these exact IDs.',cross:'Inclusive ref memberships: source in A and target in B, or reverse. Shared members can make an edge count in both directions; prune the union once. Report shared counts explicitly.',
    contemporaneous:'80% presence in last ten responses. Paired whole-trial activity is assigned to both co-presented cues, with no causal attribution; never used for gates.',
    prediction:'Stage 1e earliest continuous-time afferent model, combined A/B schedule per paired trial, actual afferent and recurrent delays, lag 0..0.32 s, source after edge birth; predicted counts distinguished from observed positive native STDP events.',
    phases:'Reproduce each seed in an unlocked field once, validate exact cores/edges/weights/full export/trials/draws, then native DevelopmentSession checkpoint/restore for identical independent controls. No unlocking or snapshot rewriting.',
    randomness:'Dedicated association LCG: seed XOR 0xd1b54a35. Unpaired resumes the Stage 1g jitter stream after formationEpoch*16 draws. Every draw is saved.',
    figures:'Per baseline seed: forward, reverse, min A half, min B half and C spillover; primary solid, unpaired dashed. Show both delays when they differ.'}};}
function decide(cells){
  const plan=declaration(),failures=[];
  if(cells.length!==plan.cells.length)failures.push('All eight declared cells must be saved.');
  for(const spec of plan.cells){
    const matches=cells.filter(c=>c.id===spec.id&&c.seed===spec.seed&&c.delta===spec.delta&&c.jitter===spec.jitter);
    if(matches.length!==1){failures.push('Missing or duplicate '+spec.id);continue;}
    if(spec.role==='baseline'&&!matches[0].summary.pass)failures.push(spec.id+': '+matches[0].summary.failedCriteria.join(', '));
  }return {pass:!failures.length,failedCriteria:failures};
}
function write(directory,name,value){fs.writeFileSync(path.join(directory,name+'.json'),f.json(value));}
function codeHash(){const {createHash}=require('node:crypto'),h=createHash('sha256');for(const file of ['association.cjs','association-audit.cjs','association-study.cjs','formation.cjs','formation-audit.cjs'])h.update(fs.readFileSync(path.join(__dirname,file)));return h.digest('hex');}
async function batch(items,job,concurrency){let next=0;const outcomes=await Promise.allSettled(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(next<items.length)await job(items[next++]);}));const errors=outcomes.filter(r=>r.status==='rejected');if(errors.length)throw new AggregateError(errors.map(r=>r.reason),'Study worker error.');}
async function worker(mode,directory,item){
  const log=fs.openSync(path.join(directory,mode+'-'+item+'.log'),'w');
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[__filename,'--worker',mode,directory,String(item)],{cwd:a.ROOT,windowsHide:true,stdio:['ignore',log,log]});child.once('error',reject);child.once('close',resolve);});
  fs.closeSync(log);if(code!==0)throw new Error(mode+'/'+item+' execution failed (see worker log).');
}
async function runStudy(outputRoot){
  const timestamp=new Date().toISOString(),start=performance.now(),directory=path.join(path.resolve(outputRoot),timestamp.replace(/[:.]/g,'-')+'-stage2');
  fs.mkdirSync(directory,{recursive:true});const plan=declaration();write(directory,'plan',plan);
  const planBytes=fs.readFileSync(path.join(a.ROOT,'docs/ASSOCIATION_PLAN.md')),sourcePlanHash=require('node:crypto').createHash('sha256').update(planBytes).digest('hex');
  const implementationHash=codeHash(),concurrency=Math.max(1,Math.min(8,Math.floor(os.availableParallelism()/2)));
  const timing=()=>({timestamp,nodeVersion:process.version,wallTimeMs:performance.now()-start,implementationHash,sourcePlanHash,concurrency});write(directory,'timing',timing());
  process.stdout.write('Declared Stage 2 study: '+directory+'\n');
  fs.mkdirSync(path.join(directory,'origins'));
  await batch([1,2,3],async seed=>{await worker('origin',directory,seed);process.stdout.write('Seed '+seed+' Stage 1g origin reproduced and byte-verified.\n');},3);
  await batch(plan.cells,async spec=>{await worker('case',directory,spec.id);const summary=JSON.parse(fs.readFileSync(path.join(directory,'cases',spec.id,'summary.json')));process.stdout.write(spec.id+': stop '+summary.stopping.epoch+', reached '+summary.stopping.reached+', '+(summary.pass?'PASS':'FAIL: '+summary.failedCriteria.join(', '))+'\n');},concurrency);
  const cells=plan.cells.map(spec=>({...spec,summary:JSON.parse(fs.readFileSync(path.join(directory,'cases',spec.id,'summary.json')))}));
  if(codeHash()!==implementationHash)throw new Error('Implementation changed during study.');
  const summary={schema:'neurosphere-association-study/v1',stage:'2',plan,cells,...decide(cells)};write(directory,'summary',summary);write(directory,'timing',timing());
  return {directory,summary};
}
async function main(argv){
  if(argv[0]==='--worker'){
    const [,mode,directory,item]=argv,started=performance.now(),plan=JSON.parse(fs.readFileSync(path.join(directory,'plan.json')));
    if(f.json(plan)!==f.json(declaration()))throw new Error('Worker declaration mismatch.');
    if(mode==='origin'){
      const seed=Number(item);if(![1,2,3].includes(seed))throw new Error('Invalid origin seed.');
      const {origin}=a.reproduce(seed);write(path.join(directory,'origins'),'seed-'+seed,origin);
    }else if(mode==='case'){
      const spec=plan.cells.find(c=>c.id===item);if(!spec)throw new Error('Undeclared cell.');
      const origin=JSON.parse(fs.readFileSync(path.join(directory,'origins','seed-'+spec.seed+'.json')));
      const run=a.runSuite(origin,spec,condition=>process.stdout.write(spec.id+'/'+condition+'\n'));
      const target=path.join(directory,'cases',item);fs.mkdirSync(target,{recursive:true});
      for(const name of ['summary','memory','trials','controls','checkpoints','continuation'])write(target,name,run[name]);
      write(target,'timing',{nodeVersion:process.version,wallTimeMs:performance.now()-started});
    }else throw new Error('Unknown worker mode.');return 0;
  }
  let output=path.join(a.ROOT,'outputs/association');
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--study')continue;
    if(argv[i]==='--output'&&argv[i+1]){output=argv[++i];continue;}
    if(argv[i]==='--help'){process.stdout.write('node examples/association.cjs [--study] [--output DIRECTORY]\nRuns only the predeclared Stage 2 study. Exit 0 GO, 1 scientific NO-GO, 2 execution error.\n');return 0;}
    throw new Error('Unknown option: '+argv[i]);
  }
  const result=await runStudy(output);process.stdout.write('Stage 2 '+(result.summary.pass?'GO':'NO-GO')+'; Results: '+result.directory+'\n');return result.summary.pass?0:1;
}
module.exports={declaration,decide,runStudy,main};
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(error.stack+'\n');if(error.errors)for(const e of error.errors)process.stderr.write(e.stack+'\n');process.exitCode=2;});
