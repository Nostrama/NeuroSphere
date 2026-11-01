'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto'),{performance}=require('node:perf_hooks'),assert=require('node:assert/strict');
const r=require('./readout.cjs'),a=require('./association.cjs'),f=require('./formation.cjs');
const ROOT=path.resolve(__dirname,'..');
function declaration(){return {schema:'neurosphere-readout-declaration/v1',stage:3,sourcePlan:'docs/READOUT_PLAN.md',
  cells:[...[1,2,3].map(seed=>({id:'baseline-'+seed,seed,role:'baseline',options:r.options()})),
    ...[16,24,32].flatMap(teacherTick=>[.25,.4].filter(thresholdFactor=>teacherTick!==24||thresholdFactor!==.4).map(thresholdFactor=>({id:'diagnostic-t'+teacherTick+'-f'+thresholdFactor,seed:1,role:'diagnostic',options:r.options({teacherTick,thresholdFactor})})))],
  origin:{source:a.EVIDENCE,stops:a.STOP,rule:'Reproduce unlocked Stage1g for each seed. Before readout, byte-compare cores, ordered formed edges/weights, entire native locked export, formation responses and jitter draws with the original evidence; freeze refs.'},
  apparatus:{outputs:'Two centre cells O_A/O_B, recordOutput=true, no outgoing edges, growthAt1e12. No output clamp; natural activity retained.',
    projections:'Every pool cell to each O, ordinary native Synapse at0.02, native geometric delay; no identity-based wiring. Preserve pool radius60. Constructor wiring is the declared dense apparatus, not endogenous growth.',
    phaseBoundary:{maxSynapses:10,weightFloor:0,poolNextGrowthAt:1e12,reason:'Permanent settings, saved in effective config and native snapshots; decay alreadyoff. Existing pool weights checked with exact equality, never tolerance.'},
    threshold:'Per O: factor * frozen reference core size * maxWeight(1.65). Factor0.4 primary; do not retune.',
    plasticity:'Only postsynaptic O cells receive env.features.hebbian=true; all original cells false. Same native per-cell environment override pattern as fact-memory. Host scope metadata stored and reinstated on native development restore.'},
  training:{epochs:80,jitter:15,gap:10,captureTicks:65,teacherTick:24,order:['A','B'],phaseSeed:'(seed ^ 0x94d049bb) >>> 0; independent U{0..15} draw per cue bit, shared across matched controls.',
    teacher:'Native env.forcedSpike on the selected O at t0+teacherTick. No output clamp or refractory bypass. Save each delivered request/veto and first epoch of a natural spike before the matching teacher.',
    stopping:'First checkpoint20..80, every10, where R1/R2/R3 all pass at both delays. R4 not consulted by stopping. Continue primary to80 for curves; controls trained to the selected epoch.'},
  probes:{delays:[0,60],captureTicks:50,cues:'Full A/B/C and both fixed even/odd4-bit halves of A/B. Synchronous independent locked clones, no teacher.',
    margins:'Input margin = sum of all weights arriving during capture minus fixed O threshold, including refractory-discarded arrivals. Also report integrated charge, native first-spike potential/threshold, and peak leaky membrane margin over nonrefractory ticks. Raw charge margin alone is not a firing test.'},
  gates:{R1:'Full A->O_A only, full B->O_B only, both delays.',R2:'Each A/B half->its own O only, both delays.',R3:'Full C fires neither O, both delays.',
    R4:'Pool->pool ordered IDs/weights exactly equal original1g; original formation gates2/4/8/9 on frozen refs, including >=0.25 gain versus initial untrained formation. Failures in unablated scientific runs are harness errors to investigate before interpretation.',
    R5:'Host codebook vocabulary.get(conceptId).word; output identities follow teacher labels, not input text copying.'},
  controls:{'readout-hebbian-off':'Match stop duration, O plasticityfalse. R1 must fail; no O output on any probe.',
    'prune-readout':'Restore exact stop; natively prune pool->O weights>0.1; R1 fails and every full/half/C pool response stays exactly unchanged.',
    'swapped-teacher':'Match stop duration with O_B teaching on A and O_A on B. Full A->O_B only and B->O_A only at both delays.',
    'prune-formed':'Restore exact stop; prune all grown pool->pool edges only. R2 fails while R1 passes.',
    'untrained-readout':'Apparatus installed at1g stop, zero readout epochs; no O output on any probe.'},
  weights:'Report both O input distributions from refA/refB/other, explicitly noting overlapping reference members appear in both core groups; selectivity(mean own-mean other)/maxWeight.',
  decision:'GO iff all3baseline seeds reach criterion and passR1-R4 plus all5control discriminations. Diagnostics are reported and cannot replace the primary. Exit0GO,1scientificNO-GO,2executionerror.'};}
const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function codeHash(){return createHash('sha256').update(['readout.cjs','readout-study.cjs','formation.cjs','formation-v2.cjs','association.cjs'].map(n=>hashFile(path.join(__dirname,n))).join('\n')).digest('hex');}
function write(dir,name,value){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.json'),f.json(value));}
function saveCondition(dir,result){for(const name of ['summary','memory','trials','development','curve'])if(result[name])write(dir,name,result[name]);
  for(const cp of result.checkpointMemories||[])write(path.join(dir,'checkpoints',String(cp.epoch).padStart(3,'0')),'memory',cp.memory);
}
function decide(cells){const failures=[];for(const spec of declaration().cells){const found=cells.filter(c=>c.id===spec.id&&c.seed===spec.seed&&f.json(c.options)===f.json(spec.options));
  if(found.length!==1){failures.push('Missing or mismatched '+spec.id);continue;}if(spec.role==='baseline'&&!found[0].summary.pass)failures.push(spec.id+': '+found[0].summary.failedCriteria.join(', '));
}return {pass:failures.length===0,failedCriteria:failures};}
async function child(args,logPath){const log=fs.openSync(logPath,'w');const exit=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[__filename,...args],{cwd:ROOT,windowsHide:true,stdio:['ignore',log,log]});p.once('error',reject);p.once('close',resolve);});fs.closeSync(log);if(exit!==0)throw new Error('Readout execution failed: '+path.basename(logPath));}
async function runStudy(output){
  const timestamp=new Date().toISOString(),start=performance.now(),directory=path.join(path.resolve(output),timestamp.replace(/[:.]/g,'-')+'-stage3'),plan=declaration(),implementationHash=codeHash(),planHash=hashFile(path.join(ROOT,plan.sourcePlan));
  write(directory,'plan',plan);const timing=()=>({timestamp,nodeVersion:process.version,wallTimeMs:performance.now()-start,implementationHash,sourcePlanHash:planHash});write(directory,'timing',timing());
  process.stdout.write('Declared Stage3 study: '+directory+'\n');
  const origins=await Promise.allSettled([1,2,3].map(seed=>child(['--origin',directory,String(seed)],path.join(directory,'origin-'+seed+'.log'))));
  if(origins.some(o=>o.status==='rejected'))throw new AggregateError(origins.filter(o=>o.status==='rejected').map(o=>o.reason),'Stage1g reproduction failed before readout.');
  process.stdout.write('All3 unlocked Stage1g origins reproduced byte-identically.\n');
  const results=await Promise.allSettled(plan.cells.map(async spec=>{await child(['--worker',directory,spec.id],path.join(directory,spec.id+'.log'));
    const summary=JSON.parse(fs.readFileSync(path.join(directory,'cases',spec.id,'summary.json')));process.stdout.write(spec.id+': '+(summary.pass?'PASS':summary.failedCriteria.join(', '))+'\n');return {...spec,summary};}));
  if(results.some(x=>x.status==='rejected'))throw new AggregateError(results.filter(x=>x.status==='rejected').map(x=>x.reason),'Readout execution errors.');
  if(codeHash()!==implementationHash||hashFile(path.join(ROOT,plan.sourcePlan))!==planHash)throw new Error('Readout runtime or plan changed during study.');
  const cells=results.map(x=>x.value),summary={schema:'neurosphere-readout-study/v1',stage:3,plan,cells,...decide(cells)};
  write(directory,'summary',summary);write(directory,'timing',timing());return {directory,summary};
}
function latestMemory(){const base=path.join(ROOT,'outputs/readout');if(fs.existsSync(base))for(const name of fs.readdirSync(base).sort().reverse()){
  const directory=path.join(base,name),memory=path.join(directory,'cases/baseline-1/primary/memory.json');if(fs.existsSync(path.join(directory,'summary.json'))&&fs.existsSync(memory))return memory;
}throw new Error('No completed Stage3 primary evidence. Run node examples/readout.cjs --study first, or pass --memory FILE.');}
async function main(argv){
  if(argv[0]==='--origin'){
    const [,directory,value]=argv,seed=Number(value),started=performance.now();assert.ok([1,2,3].includes(seed));
    const {origin}=a.reproduce(seed);write(path.join(directory,'origins'),String(seed),origin);
    write(path.join(directory,'origins'),String(seed)+'-timing',{nodeVersion:process.version,wallTimeMs:performance.now()-started});process.stdout.write(f.json(origin.identity));return 0;
  }
  if(argv[0]==='--worker'){
    const [,directory,id]=argv,plan=JSON.parse(fs.readFileSync(path.join(directory,'plan.json')));assert.equal(f.json(plan),f.json(declaration()));const spec=plan.cells.find(c=>c.id===id);assert.ok(spec);
    const origin=JSON.parse(fs.readFileSync(path.join(directory,'origins',spec.seed+'.json'))),baseline=r.initialFormation(origin),target=path.join(directory,'cases',id),started=performance.now(),controls={};
    const checkpoint=cp=>{assert.equal(cp.row.gates.R4,true,'R4 failed in an unablated readout circuit: investigate before interpretation.');
      process.stdout.write(id+'/epoch '+cp.epoch+': '+Object.entries(cp.row.gates).map(([k,v])=>k+'='+v).join(' ')+'\n');write(path.join(target,'progress'),String(cp.epoch).padStart(3,'0'),cp.row);};
    process.stdout.write(id+'/primary\n');const primary=r.runCondition(origin,spec.options,'primary',{baseline,onCheckpoint:checkpoint});saveCondition(path.join(target,'primary'),primary);
    saveCondition(path.join(target,'continued-primary'),primary.continued);write(path.join(target,'formation-untrained'),'memory',baseline.memory);
    for(const condition of ['readout-hebbian-off','swapped-teacher','untrained-readout']){
      process.stdout.write(id+'/'+condition+'\n');const result=r.runCondition(origin,spec.options,condition,{baseline,matchedEpoch:primary.summary.epoch,onCheckpoint:cp=>assert.equal(cp.row.gates.R4,true,'R4 failed in '+condition)});
      saveCondition(path.join(target,'controls',condition),result);controls[condition]=result.summary;
    }
    for(const condition of ['prune-readout','prune-formed']){process.stdout.write(id+'/'+condition+'\n');const result=r.pruneCondition(origin,primary,condition,baseline);saveCondition(path.join(target,'controls',condition),result);controls[condition]=result.summary;}
    const summary={schema:'neurosphere-readout-cell/v1',id,seed:spec.seed,options:spec.options,stopping:primary.summary.stopping,primary:primary.summary,controls,
      trainingCurve:primary.curve,...r.decide(primary.summary,controls)};write(target,'summary',summary);write(target,'timing',{nodeVersion:process.version,wallTimeMs:performance.now()-started});return 0;
  }
  let output=path.join(ROOT,'outputs/readout'),cue=null,memory=null,seconds=0;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--study')continue;
    if(['--output','--cue','--memory','--idle'].includes(argv[i])&&argv[i+1]&&!argv[i+1].startsWith('--')){
      const key=argv[i],value=argv[++i];if(key==='--output')output=value;else if(key==='--cue')cue=value;else if(key==='--memory')memory=value;else{seconds=Number(value);if(![0,60].includes(seconds))throw new Error('Idle delay must be0 or60.');}continue;
    }
    if(argv[i]==='--help'){process.stdout.write('node examples/readout.cjs --study [--output DIRECTORY]\nnode examples/readout.cjs --cue aardvark [--memory FILE] [--idle 0|60]\nDecoded words are host vocabulary codebook lookups.\n');return 0;}
    throw new Error('Unknown readout option: '+argv[i]);
  }
  if(cue!==null){const selected=path.resolve(memory||latestMemory()),saved=JSON.parse(fs.readFileSync(selected));assert.equal(saved.schema,'neurosphere-readout/v1');process.stdout.write(f.json(r.decoded(saved,cue,seconds)));return 0;}
  if(memory!==null)throw new Error('--memory requires --cue.');const result=await runStudy(output);process.stdout.write('Stage3 '+(result.summary.pass?'GO':'NO-GO')+'; '+result.directory+'\n');return result.summary.pass?0:1;
}
module.exports={declaration,codeHash,saveCondition,decide,runStudy,latestMemory,main};
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(error.stack+'\n');for(const e of error.errors||[])process.stderr.write(e.stack+'\n');process.exitCode=2;});
