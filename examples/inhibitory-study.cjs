'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto'),{performance}=require('node:perf_hooks');
const h=require('./inhibitory-formation.cjs'),f=require('./formation.cjs'),v2=require('./formation-v2-study.cjs');
const ROOT=path.resolve(__dirname,'..'),REFERENCE='outputs/formation-v2/2026-11-01T17-59-30-265Z-stage1v2';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function declaration(){return {schema:'neurosphere-inhibitory-declaration/v1',sourcePlan:'docs/INHIBITORY_DIAGNOSTIC_PLAN.md',
  cells:[{id:'v2-f20-1',options:h.options({fraction:.2})},{id:'v2-f30-1',options:h.options({fraction:.3})},{id:'v1-f20-1',options:h.options({fraction:.2,scaffold:'v1'})}],
  inherited:v2.declaration().gates,
  population:'Declare every feature ID as an endpoint before addNeuron. Native per-ID seeded assignment applies only to ordinary pool cells. P=round(500/(1-f)); report actual E/I. No type reassignment.',
  v1:'Exact Stage 1g scaffold parameters: g1, w0=1.1, maxWeight=1.65, maxSynapses8, jitter15; diagnostic stopping horizon/continued gate extends to120. One-hit cells are also direct, not subthreshold primed in this comparison.',
  excitatoryMetrics:'All v2 gates and pool density denominators use E only. Native growth, competition and pruning still involve the physical E+I pool. Prune-formed removes all physical pool->pool edges, including I edges. Report the complete typed audit separately.',
  controls:'Growth-off, Hebbian-off, shuffled, untrained, prune-formed, continued-plastic, continued-Hebbian-off; all same inhibitory scaffold. Inhibition-off is the saved 500-E lateral-inhibition v2 primary, at its own stop and epoch120, a common reference rather than a matched-size toggle. Save once and reference explicitly.',
  reference:{path:REFERENCE,baseline:'baseline-<seed>',verified:'Saved v2 primary summary/memory/trials/curve and continued-plastic summary/memory; byte hashes recorded before running.'},
  measurement:{edges:'At every checkpoint: E->E, E->I, I->E, I->I counts and magnitude/signed quantiles; per-epoch births from native formed events.',
    trials:'Capture window only, 50+J ticks. I cell IDs and spikes; per-E signed incoming charges, physical arrival times, refractory-discarded inhibitory charge.',
    inhibitionBeforeAfferent:'Strict native message timestamp < first seed-afferent timestamp, among E with exactly one seed hit. Report both arrived messages and membrane-integrated messages (refractory drops excluded), fired IDs/fraction; simultaneous arrivals do not count as before.',
    charge:'Unweighted sum of integrated inhibitory magnitudes divided by total E population, not only receivers. Separately report total excitatory charge.',
    proxy:'For each E spike, raw integrated excitation minus inhibition over ticks [spikeTick-9,spikeTick], including current-tick inputs. This is an effective-threshold proxy, not a reconstructed leaky potential.',
    passivity:'Non-enumerable native-method observers; no altered calls, return values, config or random draws. Compare observed vs unobserved native circuit bytes in tests.'},
  confirmation:'For every seed1 cell whose stopping criterion and all v2 gates including11 pass, run that exact setting on seeds2/3. No other settings. GO requires all gates and inherited required controls on all3 at one setting. If none passes seed1, stop.',
  exit:'0 diagnostic GO;1 scientific NO-GO;2 execution error. No automatic engine fork.'};}
function write(dir,name,value){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.json'),f.json(value));}
function codeHash(){const names=['inhibitory-formation.cjs','inhibitory-audit.cjs','inhibitory-study.cjs','formation-v2.cjs','formation-v2-audit.cjs','formation.cjs','formation-audit.cjs','association-audit.cjs'];return createHash('sha256').update(names.map(n=>hash(path.join(__dirname,n))).join('\n')).digest('hex');}
function saveCondition(directory,result){
  for(const name of ['summary','memory','development'])if(result[name])write(directory,name,result[name]);
  if(result.trials){const {rows=[],...rest}=result.trials;
    write(directory,'trials',{...rest,rows:rows.map(({inhibition,...row})=>row)});
    if(rows.length)write(directory,'inhibition-trials',rows.map(({epoch,cue,t0,inhibition})=>({epoch,cue,t0,...inhibition})));
  }
  if(result.curve)write(directory,'curve',result.curve);
  for(const cp of result.checkpointMemories||[])write(path.join(directory,'checkpoints',String(cp.epoch).padStart(3,'0')),'memory',cp.memory);
}
function persistCase(directory,run){
  write(directory,'summary',run.summary);saveCondition(path.join(directory,'primary'),run.primary);
  write(path.join(directory,'initial'),'memory',run.primary.untrainedMemory);write(path.join(directory,'initial'),'basin',run.primary.untrainedBasin);
  for(const [condition,result] of Object.entries(run.controls)){
    if(condition==='inhibition-off')write(path.join(directory,'controls',condition),'reference',{path:'../../../../references/inhibition-off-'+run.summary.options.seed,summary:result.summary});
    else saveCondition(path.join(directory,'controls',condition),result);
  }
}
function copyReference(directory,seed){
  const source=path.join(ROOT,REFERENCE,'cases','baseline-'+seed),target=path.join(directory,'references','inhibition-off-'+seed),hashes={};
  for(const suffix of ['primary/summary.json','primary/memory.json','primary/trials.json','primary/curve.json','controls/continued-plastic/summary.json','controls/continued-plastic/memory.json']){
    const src=path.join(source,suffix),dest=path.join(target,suffix);hashes[suffix]=hash(src);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);
  }write(target,'provenance',{source:path.posix.join(REFERENCE,'cases','baseline-'+seed),hashes});
}
function readReference(directory,seed){const dir=path.join(directory,'references','inhibition-off-'+seed),p=JSON.parse(fs.readFileSync(path.join(dir,'provenance.json')));
  for(const [suffix,expected] of Object.entries(p.hashes))if(hash(path.join(dir,suffix))!==expected)throw new Error('Changed inhibitory reference.');
  return {summary:JSON.parse(fs.readFileSync(path.join(dir,'primary/summary.json')))};
}
function eligible(summary){return summary.stopping.reached&&Object.values(summary.primary.criteria).every(c=>!c.gated||c.pass);}
function decide(cells){
  const candidates=cells.filter(c=>c.options.seed===1&&eligible(c.summary)),outcomes=candidates.map(c=>{
    const series=cells.filter(row=>row.options.scaffold===c.options.scaffold&&row.options.fraction===c.options.fraction);
    return {id:c.id,seeds:series.map(s=>s.options.seed),pass:[1,2,3].every(seed=>series.filter(s=>s.options.seed===seed&&s.summary.pass).length===1)};
  });return {pass:outcomes.some(o=>o.pass),eligibleSeed1:candidates.map(c=>c.id),confirmation:outcomes,
    decision:candidates.length?'Report exact-setting three-seed confirmation; no alternative selection.':'No seed-1 cell passes every v2 gate; no seed-2/3 confirmation is authorized.'};
}
async function worker(directory,spec){
  write(path.join(directory,'specs'),spec.id,spec);const log=fs.openSync(path.join(directory,spec.id+'.log'),'w');
  const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[__filename,'--worker',directory,spec.id],{cwd:ROOT,windowsHide:true,stdio:['ignore',log,log]});p.once('error',reject);p.once('close',resolve);});fs.closeSync(log);
  if(code!==0)throw new Error(spec.id+' execution error; inspect log.');
  const summary=JSON.parse(fs.readFileSync(path.join(directory,'cases',spec.id,'summary.json')));process.stdout.write(spec.id+': '+summary.failedCriteria.join(', ')+'\n');return {...spec,summary};
}
async function runStudy(output){
  const timestamp=new Date().toISOString(),started=performance.now(),directory=path.join(path.resolve(output),timestamp.replace(/[:.]/g,'-')+'-inhibitory'),plan=declaration(),implementationHash=codeHash();
  write(directory,'plan',plan);copyReference(directory,1);const timing=()=>({timestamp,nodeVersion:process.version,wallTimeMs:performance.now()-started,implementationHash,sourcePlanHash:hash(path.join(ROOT,plan.sourcePlan))});write(directory,'timing',timing());
  process.stdout.write('Declared inhibitory diagnostic: '+directory+'\n');
  const initial=await Promise.allSettled(plan.cells.map(spec=>worker(directory,spec)));const errors=initial.filter(r=>r.status==='rejected');if(errors.length)throw new AggregateError(errors.map(r=>r.reason));
  const cells=initial.map(r=>r.value),eligibleCells=cells.filter(c=>eligible(c.summary));
  if(eligibleCells.length)for(const seed of [2,3])copyReference(directory,seed);
  for(const cell of eligibleCells)for(const seed of [2,3])cells.push(await worker(directory,{id:cell.id.replace(/-1$/,'-'+seed),options:h.options({...cell.options,seed})}));
  if(codeHash()!==implementationHash)throw new Error('Runtime changed during study.');
  const summary={schema:'neurosphere-inhibitory-diagnostic/v1',plan,cells,...decide(cells)};write(directory,'summary',summary);write(directory,'timing',timing());return {directory,summary};
}
async function main(argv){
  if(argv[0]==='--worker'){
    const [,directory,id]=argv,spec=JSON.parse(fs.readFileSync(path.join(directory,'specs',id+'.json'))),started=performance.now();
    if(f.json(JSON.parse(fs.readFileSync(path.join(directory,'plan.json'))))!==f.json(declaration()))throw new Error('Declaration changed.');
    const target=path.join(directory,'cases',id),progress=condition=>process.stdout.write(id+'/'+condition+'\n'),controls={};
    progress('primary');const primary=h.runCondition(spec.options,'primary',{onCheckpoint:cp=>{
      const minimum=Math.min(...[0,60].flatMap(s=>cp.row.halfCompletions[s].map(h=>h.completion??0)));
      process.stdout.write(id+'/epoch '+cp.row.epoch+': minimum half '+minimum.toFixed(4)+', E cores '+cp.row.coreSizes.A+'/'+cp.row.coreSizes.B+', spill '+cp.row.negative[0].count+'\n');
      write(path.join(target,'progress'),String(cp.row.epoch).padStart(3,'0'),cp.row);
    }});saveCondition(path.join(target,'primary'),primary);
    write(path.join(target,'initial'),'memory',primary.untrainedMemory);write(path.join(target,'initial'),'basin',primary.untrainedBasin);
    for(const condition of ['growth-off','hebbian-off','shuffled','untrained']){
      progress(condition);const result=h.runCondition(spec.options,condition,{matchedEpoch:primary.summary.epoch});saveCondition(path.join(target,'controls',condition),result);controls[condition]={summary:result.summary};
    }
    controls['inhibition-off']=readReference(directory,spec.options.seed);write(path.join(target,'controls/inhibition-off'),'reference',{path:'../../../../references/inhibition-off-'+spec.options.seed,summary:controls['inhibition-off'].summary});
    progress('prune-formed');const pruned=h.pruneFormed(primary);saveCondition(path.join(target,'controls/prune-formed'),pruned);controls['prune-formed']={summary:pruned.summary};
    saveCondition(path.join(target,'controls/continued-plastic'),primary.continued);controls['continued-plastic']={summary:primary.continued.summary};
    progress('continued-hebbian-off');const continued=h.runCondition(spec.options,'continued-hebbian-off',{primary});saveCondition(path.join(target,'controls/continued-hebbian-off'),continued);controls['continued-hebbian-off']={summary:continued.summary};
    const summary={schema:'neurosphere-inhibitory-diagnostic-cell/v1',stage:'inhibitory-diagnostic',options:h.options(spec.options),stopping:primary.summary.stopping,
      primary:primary.summary,controls:Object.fromEntries(Object.entries(controls).map(([name,r])=>[name,r.summary])),trainingCurve:primary.curve,...h.decision(primary,controls)};
    write(target,'summary',summary);write(target,'timing',{nodeVersion:process.version,wallTimeMs:performance.now()-started});return 0;
  }
  let output=path.join(ROOT,'outputs/inhibitory');for(let i=0;i<argv.length;i++){
    if(argv[i]==='--study')continue;if(argv[i]==='--output'&&argv[i+1]){output=argv[++i];continue;}
    if(argv[i]==='--help'){process.stdout.write('node examples/formation-v2.cjs --inhibitoryPopulation [--output DIRECTORY]\n');return 0;}throw new Error('Unknown option '+argv[i]);
  }
  const result=await runStudy(output);process.stdout.write('Inhibitory diagnostic '+(result.summary.pass?'GO':'NO-GO')+'; '+result.directory+'\n');return result.summary.pass?0:1;
}
module.exports={declaration,codeHash,saveCondition,persistCase,eligible,decide,runStudy,main};
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(error.stack+'\n');for(const e of error.errors||[])process.stderr.write(e.stack+'\n');process.exitCode=2;});
