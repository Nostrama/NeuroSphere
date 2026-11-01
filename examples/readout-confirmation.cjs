'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{spawn}=require('node:child_process'),{performance}=require('node:perf_hooks');
const r=require('./readout.cjs'),legacy=require('./readout-study.cjs'),f=require('./formation.cjs');
const ROOT=path.resolve(__dirname,'..'),SOURCE='outputs/readout/2026-11-01T20-04-58-944Z-stage3',REUSED='diagnostic-t24-f0.25';
const FIXED=Object.freeze({teacherTick:24,thresholdFactor:.25,epochs:80});
const read=(...parts)=>JSON.parse(fs.readFileSync(path.join(...parts))),hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function write(dir,name,value){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.json'),f.json(value));}
function declaration(){const prior=legacy.declaration();return {...prior,schema:'neurosphere-readout-confirmation-declaration/v1',sourcePlanCommit:'940ea23',
  cells:[{id:REUSED,seed:1,role:'reused',options:{...FIXED}},...[2,3].map(seed=>({id:'confirmation-'+seed,seed,role:'confirmation',options:{...FIXED}}))],
  reference:{source:SOURCE,case:REUSED,rule:'Reuse every saved seed-1 case file and its reproduced origin byte-for-byte. Re-evaluate its acceptance; do not retrain seed1.'},
  selection:'The passing diagnostic nearest the original primary: tick24/factor0.25. Only seeds2/3 are run, each with all five matched controls. No other factor or tick.',
  apparatus:{...prior.apparatus,threshold:'Fixed factor0.25 * frozen reference core size * maxWeight1.65; no retuning.'},
  additionalMeasurements:{negative:'For each O at both delays: C peak membrane margin, peak potential/effective threshold, fixed threshold and headroom=-peakMargin.',
    natural:'First non-driven, non-external output spike in the recorded65-tick presentation windows, across both A/B trials; separately report first natural-before-matching-teacher epoch. Report at stop and through80. Gap spikes are outside this retained observation window.'},
  decision:'GO iff the reused seed1 and new seeds2/3 at tick24/factor0.25 reach criterion and pass R1-R4 and all five required control discriminations. Otherwise name failing gates/discriminations. Exit0GO,1scientificNO-GO,2executionerror.'};}
function codeHash(){return createHash('sha256').update(['readout-confirmation.cjs','readout.cjs','readout-study.cjs','association.cjs','formation.cjs','formation-v2.cjs'].map(n=>hash(path.join(__dirname,n))).join('\n')).digest('hex');}
function files(directory,prefix=''){return fs.readdirSync(path.join(directory,prefix),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1).flatMap(e=>{
  const rel=prefix?prefix+'/'+e.name:e.name;if(e.isDirectory())return files(directory,rel);assert.ok(e.isFile(),'Evidence must contain ordinary files.');return [rel];});}
function copyReference(directory){
  const source=path.join(ROOT,SOURCE,'cases',REUSED),target=path.join(directory,'cases',REUSED),summary=read(source,'summary.json');
  assert.equal(summary.seed,1);assert.equal(f.json(summary.options),f.json(FIXED));assert.equal(summary.pass,true);assert.equal(r.decide(summary.primary,summary.controls).pass,true);
  const hashes=Object.fromEntries(files(source).map(file=>[file,hash(path.join(source,file))]));
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(source,target,{recursive:true,errorOnExist:true,force:false});
  for(const [file,value] of Object.entries(hashes))assert.equal(hash(path.join(target,file)),value);
  fs.mkdirSync(path.join(directory,'origins'),{recursive:true});const originSource=path.join(ROOT,SOURCE,'origins/1.json'),originTarget=path.join(directory,'origins/1.json');fs.copyFileSync(originSource,originTarget);
  assert.equal(hash(originSource),hash(originTarget));assert.equal(read(originTarget).identity.byteIdentical,true);
  const provenance={source:SOURCE,case:REUSED,caseHashes:hashes,originHash:hash(originSource),originalStudyTiming:read(ROOT,SOURCE,'timing.json'),retrained:false};
  write(path.join(directory,'references'),'seed-1',provenance);return provenance;
}
function firstNatural(rows,outputs){return Object.fromEntries(['A','B'].map(label=>{
  for(const row of rows){const spike=row.outputs.find(s=>s.neuronId===outputs[label].id&&!s.driven&&!s.externalDrive);if(spike)return [label,{epoch:row.epoch,cue:row.cue,time:spike.time,tickFromCue:Math.round(spike.time/.02)-row.t0}];}
  return [label,null];}));}
function measures(directory){const primary=read(directory,'primary/summary.json'),memory=read(directory,'primary/memory.json'),continued=read(directory,'continued-primary/summary.json');
  return {seed:primary.seed,options:primary.options,stoppingEpoch:primary.epoch,
    negative:[0,60].flatMap(delay=>{const cue=primary.observed.probes[delay].find(p=>p.cue==='C');return ['A','B'].map(label=>{const o=cue.outputs[label];return {idleSeconds:delay,output:label,fired:o.fired,threshold:o.threshold,peakPotential:o.peakPotential,peakEffectiveThreshold:o.peakEffectiveThreshold,peakMembraneMargin:o.peakMargin,headroom:-o.peakMargin};});}),
    naturalAtStop:firstNatural(read(directory,'primary/trials.json').rows,memory.outputs),naturalThrough80:firstNatural(read(directory,'continued-primary/trials.json').rows,memory.outputs),
    beforeTeacherAtStop:primary.teacher.firstNaturalBeforeTeacher,beforeTeacherThrough80:continued.teacher.firstNaturalBeforeTeacher,
    scope:'Natural means !driven && !externalDrive in retained65-tick presentation windows, across both cue trials; forced teacher spikes excluded. Gap spikes are not recorded by the unchanged harness.'};
}
function decide(cells){const failures=[],declared=declaration().cells;if(cells.length!==3)failures.push('Exactly three declared seeds are required.');
  for(const cell of cells)if(!declared.some(s=>s.id===cell.id&&s.seed===cell.seed))failures.push('Undeclared cell '+cell.id);
  for(const spec of declared){const matches=cells.filter(c=>c.id===spec.id&&c.seed===spec.seed&&f.json(c.options)===f.json(FIXED));
    if(matches.length!==1){failures.push('Missing, duplicate, or mismatched seed '+spec.seed);continue;}
    const summary=matches[0].summary;assert.equal(summary.seed,spec.seed);assert.equal(f.json(summary.options),f.json(FIXED));
    const result=r.decide(summary.primary,summary.controls);assert.equal(f.json(result.discrimination),f.json(summary.discrimination));assert.equal(result.pass,summary.pass);
    for(const failure of result.failedCriteria)failures.push('seed '+spec.seed+': '+failure);
  }return {pass:failures.length===0,failedCriteria:failures};
}
async function child(directory,args,label){const log=fs.openSync(path.join(directory,label+'.log'),'w');try{
  const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[__filename,...args],{cwd:ROOT,windowsHide:true,stdio:['ignore',log,log]});p.once('error',reject);p.once('close',resolve);});
  if(code!==0)throw new Error(label+' execution error; inspect its log.');
}finally{fs.closeSync(log);}}
async function runStudy(output){
  const timestamp=new Date().toISOString(),start=performance.now(),directory=path.join(path.resolve(output),timestamp.replace(/[:.]/g,'-')+'-stage3-confirmation'),plan=declaration(),implementationHash=codeHash(),sourcePlanHash=hash(path.join(ROOT,plan.sourcePlan));
  write(directory,'plan',plan);fs.copyFileSync(path.join(ROOT,plan.sourcePlan),path.join(directory,'source-plan.md'));copyReference(directory);
  const nativeHashes=Object.fromEntries(fs.readdirSync(path.join(ROOT,'src/neuron')).filter(n=>fs.statSync(path.join(ROOT,'src/neuron',n)).isFile()).sort().map(n=>['src/neuron/'+n,hash(path.join(ROOT,'src/neuron',n))]));write(directory,'native-source-hashes',nativeHashes);
  const timing=()=>({timestamp,nodeVersion:process.version,wallTimeMs:performance.now()-start,implementationHash,sourcePlanHash});write(directory,'timing',timing());
  process.stdout.write('Declared readout confirmation: '+directory+'\nSeed1 copied byte-identically; no retraining.\n');
  const origins=await Promise.allSettled([2,3].map(seed=>child(directory,['--origin',directory,String(seed)],'origin-'+seed)));
  if(origins.some(r=>r.status==='rejected'))throw new AggregateError(origins.filter(r=>r.status==='rejected').map(r=>r.reason),'Origin reproduction failed before confirmation trials.');
  process.stdout.write('Seeds2/3 unlocked Stage1g origins reproduced byte-identically.\n');
  const workers=await Promise.allSettled(plan.cells.filter(c=>c.seed!==1).map(async spec=>{await child(directory,['--worker',directory,spec.id],spec.id);const s=read(directory,'cases',spec.id,'summary.json');process.stdout.write(spec.id+': '+(s.pass?'PASS':s.failedCriteria.join(', '))+'\n');}));
  if(workers.some(r=>r.status==='rejected'))throw new AggregateError(workers.filter(r=>r.status==='rejected').map(r=>r.reason),'Confirmation execution error.');
  assert.equal(codeHash(),implementationHash,'Runtime changed during confirmation.');assert.equal(hash(path.join(ROOT,plan.sourcePlan)),sourcePlanHash,'Plan changed during confirmation.');
  for(const [file,value] of Object.entries(nativeHashes))assert.equal(hash(path.join(ROOT,file)),value);
  const reference=read(directory,'references/seed-1.json');for(const [file,value] of Object.entries(reference.caseHashes))assert.equal(hash(path.join(directory,'cases',REUSED,file)),value);
  const cells=plan.cells.map(spec=>{const result=measures(path.join(directory,'cases',spec.id));write(path.join(directory,'measurements'),spec.id,result);return {...spec,summary:read(directory,'cases',spec.id,'summary.json'),measurements:result};});
  const acceptance=decide(cells),summary={schema:'neurosphere-readout-confirmation-study/v1',stage:3,plan,cells,...acceptance,
    defaultMemory:acceptance.pass?{seed:1,relativePath:'cases/'+REUSED+'/primary/memory.json'}:null};
  write(directory,'summary',summary);write(directory,'timing',timing());return {directory,summary};
}
function latestConfirmedMemory(base=path.join(ROOT,'outputs/readout-confirmation')){
  if(!fs.existsSync(base))return null;
  for(const name of fs.readdirSync(base).sort().reverse()){
    const directory=path.join(base,name),summaryFile=path.join(directory,'summary.json');if(!fs.existsSync(summaryFile))continue;
    const s=read(summaryFile);if(s.schema!=='neurosphere-readout-confirmation-study/v1')continue;
    if(!s.pass)return null;assert.equal(decide(s.cells).pass,true);assert.ok(s.defaultMemory&&s.defaultMemory.seed===1);
    const memory=path.resolve(directory,s.defaultMemory.relativePath);assert.ok(memory.startsWith(path.resolve(directory)+path.sep));assert.ok(fs.existsSync(memory));return memory;
  }return null;
}
async function main(argv){
  if(argv[0]==='--origin'){assert.ok(['2','3'].includes(argv[2]));return legacy.main(argv);}
  if(argv[0]==='--worker'){
    const [,directory,id]=argv,plan=read(directory,'plan.json');assert.equal(f.json(plan),f.json(declaration()));const spec=plan.cells.find(c=>c.id===id);assert.ok(spec&&[2,3].includes(spec.seed));
    const start=performance.now(),origin=read(directory,'origins',spec.seed+'.json'),baseline=r.initialFormation(origin),target=path.join(directory,'cases',id),controls={};
    const check=cp=>{assert.equal(cp.row.gates.R4,true,'R4 failure in unablated confirmation; investigate harness.');process.stdout.write(id+'/epoch '+cp.epoch+': '+Object.entries(cp.row.gates).map(([k,v])=>k+'='+v).join(' ')+'\n');write(path.join(target,'progress'),String(cp.epoch).padStart(3,'0'),cp.row);};
    const primary=r.runCondition(origin,FIXED,'primary',{baseline,onCheckpoint:check});legacy.saveCondition(path.join(target,'primary'),primary);legacy.saveCondition(path.join(target,'continued-primary'),primary.continued);write(path.join(target,'formation-untrained'),'memory',baseline.memory);
    for(const condition of ['readout-hebbian-off','swapped-teacher','untrained-readout']){
      process.stdout.write(id+'/'+condition+'\n');const result=r.runCondition(origin,FIXED,condition,{baseline,matchedEpoch:primary.summary.epoch,onCheckpoint:cp=>assert.equal(cp.row.gates.R4,true,'R4 failure in '+condition)});legacy.saveCondition(path.join(target,'controls',condition),result);controls[condition]=result.summary;
    }
    for(const condition of ['prune-readout','prune-formed']){process.stdout.write(id+'/'+condition+'\n');const result=r.pruneCondition(origin,primary,condition,baseline);legacy.saveCondition(path.join(target,'controls',condition),result);controls[condition]=result.summary;}
    write(target,'summary',{schema:'neurosphere-readout-cell/v1',id,seed:spec.seed,options:{...FIXED},stopping:primary.summary.stopping,primary:primary.summary,controls,trainingCurve:primary.curve,...r.decide(primary.summary,controls)});write(target,'timing',{nodeVersion:process.version,wallTimeMs:performance.now()-start});return 0;
  }
  let output=path.join(ROOT,'outputs/readout-confirmation');for(let i=0;i<argv.length;i++){
    if(argv[i]==='--confirm')continue;if(argv[i]==='--output'&&argv[i+1]){output=argv[++i];continue;}
    if(argv[i]==='--help'){process.stdout.write('node examples/readout.cjs --confirm [--output DIRECTORY]\nOnly tick24/factor0.25 on seeds2/3; seed1 reused. No parameter overrides.\n');return 0;}
    throw new Error('Undeclared confirmation option: '+argv[i]);
  }
  const result=await runStudy(output);process.stdout.write('Stage3 confirmation '+(result.summary.pass?'GO':'NO-GO')+'; '+result.directory+'\n');return result.summary.pass?0:1;
}
module.exports={SOURCE,REUSED,FIXED,declaration,codeHash,files,copyReference,firstNatural,measures,decide,runStudy,latestConfirmedMemory,main};
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(error.stack+'\n');for(const e of error.errors||[])process.stderr.write(e.stack+'\n');process.exitCode=2;});
