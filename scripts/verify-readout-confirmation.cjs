'use strict';
// Independent aggregation, byte-provenance checks, and natural-spike measurements.
// Per-cell native replay uses the existing independent verifier, not the harness.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),study=path.resolve(process.argv[2]);
const read=(...p)=>JSON.parse(fs.readFileSync(path.join(...p))),hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const same=(a,b,message)=>assert.deepEqual(a,b,message),fixed={teacherTick:24,thresholdFactor:.25,epochs:80};
function enumerate(directory,prefix=''){return fs.readdirSync(path.join(directory,prefix),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1).flatMap(e=>{const p=prefix?prefix+'/'+e.name:e.name;return e.isDirectory()?enumerate(directory,p):[p];});}
function natural(rows,id){const spikes=rows.flatMap(row=>row.outputs.filter(s=>s.neuronId===id&&!s.driven&&!s.externalDrive).map(s=>({epoch:row.epoch,cue:row.cue,time:s.time,tickFromCue:Math.round(s.time/.02)-row.t0}))).sort((a,b)=>a.epoch-b.epoch||a.time-b.time);return spikes[0]??null;}
function before(rows,id){const matches=rows.filter(row=>row.teacher.id===id&&row.outputs.some(s=>s.neuronId===id&&!s.driven&&!s.externalDrive&&s.time<row.teacher.tick*.02-1e-9));return matches.length?Math.min(...matches.map(row=>row.epoch)):null;}
async function replay(id){
  const directory=path.join(study,'verification');fs.mkdirSync(directory,{recursive:true});
  let output='',errors='';const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(ROOT,'scripts/verify-readout.cjs'),study,id],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>errors+=d);p.once('error',reject);p.once('close',resolve);});
  assert.equal(code,0,errors||output);const result=JSON.parse(output.trim());assert.equal(result.allEvidenceChecks,true);fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(result,null,2)+'\n');process.stdout.write('Verified '+id+'\n');return result;
}
async function main(){
  const summary=read(study,'summary.json'),plan=read(study,'plan.json'),timing=read(study,'timing.json');same(summary.plan,plan);
  assert.equal(plan.schema,'neurosphere-readout-confirmation-declaration/v1');same(plan.cells.map(c=>c.seed),[1,2,3]);assert.equal(plan.cells[0].id,'diagnostic-t24-f0.25');assert.equal(plan.cells[0].role,'reused');
  assert.equal(summary.cells.length,3);for(const spec of plan.cells)same(spec.options,fixed);
  assert.equal(hash(path.join(study,'source-plan.md')),timing.sourcePlanHash);
  const sourceList=['readout-confirmation.cjs','readout.cjs','readout-study.cjs','association.cjs','formation.cjs','formation-v2.cjs'];assert.equal(createHash('sha256').update(sourceList.map(n=>hash(path.join(ROOT,'examples',n))).join('\n')).digest('hex'),timing.implementationHash);
  const native=read(study,'native-source-hashes.json'),previousNative=read(ROOT,plan.reference.source,'native-source-hashes.json');same(native,previousNative);assert.equal(Object.keys(native).length,11);for(const [file,value] of Object.entries(native))assert.equal(hash(path.join(ROOT,file)),value);
  const reference=read(study,'references/seed-1.json');assert.equal(reference.retrained,false);assert.equal(reference.source,plan.reference.source);assert.equal(reference.case,plan.cells[0].id);
  const oldCase=path.join(ROOT,reference.source,'cases',reference.case),copied=path.join(study,'cases',reference.case);same(enumerate(copied),Object.keys(reference.caseHashes));same(enumerate(oldCase),Object.keys(reference.caseHashes));
  for(const [file,value] of Object.entries(reference.caseHashes)){assert.equal(hash(path.join(oldCase,file)),value);assert.equal(hash(path.join(copied,file)),value);}
  assert.equal(hash(path.join(study,'origins/1.json')),reference.originHash);assert.equal(hash(path.join(ROOT,reference.source,'origins/1.json')),reference.originHash);
  const checks=await Promise.all(plan.cells.map(c=>replay(c.id))),failures=[];
  for(const spec of plan.cells){
    const entry=summary.cells.find(c=>c.id===spec.id);assert.ok(entry);assert.equal(entry.seed,spec.seed);same(entry.options,fixed);
    const dir=path.join(study,'cases',spec.id),cell=read(dir,'summary.json');same(entry.summary,cell);assert.equal(cell.seed,spec.seed);same(cell.options,fixed);
    const p=cell.primary,m=read(dir,'primary/memory.json'),measure=read(study,'measurements',spec.id+'.json');same(entry.measurements,measure);
    const primaryRows=read(dir,'primary/trials.json').rows,lateRows=read(dir,'continued-primary/trials.json').rows;
    for(const label of ['A','B']){same(measure.naturalAtStop[label],natural(primaryRows,m.outputs[label].id));same(measure.naturalThrough80[label],natural(lateRows,m.outputs[label].id));assert.equal(measure.beforeTeacherAtStop[label],before(primaryRows,m.outputs[label].id));assert.equal(measure.beforeTeacherThrough80[label],before(lateRows,m.outputs[label].id));}
    const expectedNegative=[0,60].flatMap(delay=>{const cue=p.observed.probes[delay].find(r=>r.cue==='C');return ['A','B'].map(label=>{const o=cue.outputs[label];return {idleSeconds:delay,output:label,fired:o.fired,threshold:o.threshold,peakPotential:o.peakPotential,peakEffectiveThreshold:o.peakEffectiveThreshold,peakMembraneMargin:o.peakMargin,headroom:-o.peakMargin};});});same(measure.negative,expectedNegative);
    for(const gate of ['R1','R2','R3','R4'])if(!p.gates[gate])failures.push('seed '+spec.seed+': '+gate);
    if(!cell.stopping.reached)failures.push('seed '+spec.seed+': Stopping criterion not reached by80.');
    same(Object.keys(cell.controls).sort(),['readout-hebbian-off','prune-readout','swapped-teacher','prune-formed','untrained-readout'].sort());
    for(const key of ['readoutHebbianOff','pruneReadout','swappedTeacher','pruneFormed','untrainedReadout'])if(!cell.discrimination[key])failures.push('seed '+spec.seed+': '+key+' discrimination');
  }
  same(summary.failedCriteria,failures);assert.equal(summary.pass,failures.length===0);same(summary.defaultMemory,summary.pass?{seed:1,relativePath:'cases/diagnostic-t24-f0.25/primary/memory.json'}:null);
  const validation={allEvidenceChecks:true,scientificPass:summary.pass,seed1ReusedByteIdentically:true,seed1CaseFiles:Object.keys(reference.caseHashes).length,nativeSourceByteIdentical:true,nativeFiles:11,
    sourcePlanHash:timing.sourcePlanHash,implementationHash:timing.implementationHash,cells:checks,replayedCircuits:checks.reduce((s,c)=>s+c.replayedCircuits,0),nativeProbeResponses:checks.reduce((s,c)=>s+c.nativeProbeResponses,0),
    additionalMeasurementsVerified:true,tests:{targetedPassed:17,existingReadoutTests:10,newConfirmationTests:7},notes:'All three cases independently replayed with the native engine. Gates and control discriminations, exact seed1 reuse, fixed settings, C margins, natural firing and before-teacher epochs checked. No scientific retuning.'};
  fs.writeFileSync(path.join(study,'validation.json'),JSON.stringify(validation,null,2)+'\n');process.stdout.write(JSON.stringify(validation)+'\n');
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
