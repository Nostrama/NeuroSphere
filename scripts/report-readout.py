"""Render Stage 3 scientific evidence with the already-installed plotting toolchain."""
import json, os, sys
from pathlib import Path
root=Path(__file__).resolve().parents[1];study=Path(sys.argv[1]).resolve()
read=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
report=read(study/'summary.json');cells={c['id']:c['summary'] for c in report['cells']}
validation=read(study/'validation.json')
assert validation['allEvidenceChecks'] and validation['nativeSourceByteIdentical']
fmt=lambda x:'n/a' if x is None else f'{x:.4f}'
flag=lambda x:'PASS' if x else 'FAIL'
def table(headers,rows):return ['| '+' | '.join(headers)+' |','|'+'---|'*len(headers)]+['| '+' | '.join(map(str,row))+' |' for row in rows]
link=f'../outputs/readout/{study.name}'
lines=['# Stage 3: learned readout of self-formed engrams','',f"**Outcome: {'GO' if report['pass'] else 'NO-GO'}.** All three primary seeds, the six-cell seed 1 diagnostic (including the reused primary), and every required control are saved. Diagnostic settings do not replace the primary.",'',
       '**Positive finding:** the two predeclared factor 0.25 cells with teacher ticks 24/32 pass R1–R4 and all five controls on seed 1. Half-cue activation can therefore drive a learned labelled output in those saved circuits, while the original memory remains exact. The primary factor 0.4 protocol does not satisfy the three-seed acceptance rule.','',
       'Both plans were committed first (`096d535`). The ordinary-projection correction was committed as `2c1834f`, and native teacher-forcing/veto measurements as `c35e545`, before implementation and scientific runs. No result-dependent retuning was performed.','',
       '## Starting memories and phase boundary','',
       'Each seed starts from a newly reproduced, unlocked Stage 1g stop at 70/60/70 epochs. The entire native locked export, frozen reference cores, ordered formed edges/weights, original training responses and jitter schedule are compared byte-for-byte with the original evidence before readout. All memory-preservation metrics use those frozen references.','',
       'Two recordOutput cells at the volume centre receive an ordinary native Synapse from **every** pool cell at weight 0.02. Wiring does not address reference membership. Each source retains radius 60 and the engine computes its actual distance-based delay. Explicit constructor wiring implements the declared dense apparatus; it is not endogenous growth. Both outputs have no outgoing synapses, cannot grow, and neither send nor receive native lateral inhibition.','',
       '**Permanent phase settings:** maxSynapses rises from 8 to 10, weightFloor becomes 0, and every pool cell has nextGrowthAt=1e12. All are carried in native snapshots and effective metadata. Existing decay and health loss remain off. With growth frozen and decay off, the floor change is inert for existing edges; R4 tests this using exact weight equality. No temporary configuration changes or snapshot adapters are used. Native fixScaffold cannot represent these 0.02 projections: it clamps to 0.3, refuses pruning and restricts reload to fixed tract machinery.','',
       'Plasticity is scoped postsynaptically to O_A/O_B through the per-cell environment override used by fact-memory. The field’s global Hebbian flag does not express that host policy; effective metadata records the O-only scope and the Hebbian-off control. Native development restore reinstates the same host scope. Locked probes require no override because native circuit locking disables plasticity.','',
       'The primary threshold for each O is 0.4×its frozen core size×1.65. Teacher tick 24 uses native forcedSpike; O cells are not clamped and can fire naturally. Native refractoriness can veto a teacher request, and every request/delivery/veto is recorded. The two alternative teacher ticks 16/32 and threshold factor 0.25 are predeclared diagnostics.','',
       'Each readout epoch presents jittered full A, teacher O_A, gap 10 s, then full B/teacher O_B and another gap 10 s. Eight independent draws from a dedicated seed stream give offsets 0..15; capture is 65 ticks. Checkpoints every 10 select the first epoch≥20 satisfying R1–R3 at both 0/60-second delays, capped at 80. R4 is not consulted by the stopping rule. The primary continues to 80 for curves. All trained controls match the selected stop.','',
       '## Primary acceptance','']
rows=[]
for name,s in cells.items():
    p=s['primary'];outputs=read(study/'cases'/name/'primary/memory.json')['outputs'];rows.append([name,s['options']['teacherTick'],s['options']['thresholdFactor'],f"{s['stopping']['epoch']}/{s['stopping']['reached']}",
      '/'.join(str(len(p['refs'][c])) for c in ['A','B']),'/'.join(fmt(outputs[c]['threshold']) for c in ['A','B']),*[flag(p['gates'][k]) for k in ['R1','R2','R3','R4']],flag(s['pass'])])
lines+=table(['Cell','Teacher tick','Threshold factor','Stop/reached','Frozen A/B sizes','O thresholds A/B','R1 full','R2 halves','R3 C','R4 memory','Result'],rows)+['','### Required control discriminations','']
keys=['readoutHebbianOff','pruneReadout','swappedTeacher','pruneFormed','untrainedReadout']
lines+=table(['Cell',*keys],[[name,*[flag(s['discrimination'][k]) for k in keys]] for name,s in cells.items()])+['',
       'Readout-Hebbian-off and untrained-readout must produce no O response. Prune-readout removes only weights>0.1 and must fail R1 while preserving all pool responses. Swapped teaching must reverse both full-cue labels at both delays. Prune-formed must fail R2 **while R1 still passes**. A failed discrimination is a scientific failure, not a reason to change threshold.','',
       '## Decoded output and native firing','',
       'The emitted word is explicitly a **host codebook lookup**: the firing O cell stores a concept ID, and the CLI prints `vocabulary.get(id).word`. It is neither generated language nor copying the input string. The swapped-teacher control tests whether output identity follows the learned teacher label.','',
       '```powershell','node examples/readout.cjs --cue aardvark','```','',
       'The default CLI uses seed 1 of the most recent completed study, including a correctly reported NO-GO study. Use `--memory FILE` to inspect a specific saved circuit. A silent or ambiguous response is printed as such; no word is invented. Spike time is simulated time after the locked probe’s 0/60 s idle; latency is relative to the cue tick.','',
       'Input margin is the sum of weights arriving during the 1 s capture minus the fixed threshold. It includes arrivals discarded during refractoriness, so it is not by itself a firing criterion. The separately reported peak membrane margin includes native leak and effective threshold and uses only nonrefractory ticks. Independent replay recomputes both from native pool spike times and actual output-edge delays.','']
rows=[]
for seed in [1,2,3]:
    p=cells[f'baseline-{seed}']['primary']
    for delay in ['0','60']:
        for row in p['observed']['probes'][delay]+p['observed']['halfProbes'][delay]:
            show=lambda c:'silent' if not row['outputs'][c]['fired'] else ','.join(map(str,row['outputs'][c]['latencyTicks']))
            rows.append([seed,delay,row['cue']+(' full' if row['half'] is None else f" half{row['half']}"),show('A'),show('B'),fmt(row['outputs']['A']['inputMargin']),fmt(row['outputs']['B']['inputMargin']),fmt(row['outputs']['A']['peakMargin']),fmt(row['outputs']['B']['peakMargin']),f"{row['coreCellsFired']['A']}/{row['coreCellsFired']['B']}"])
lines+=table(['Seed','Idle seconds','Cue','O_A latency ticks','O_B latency ticks','A input margin','B input margin','A peak membrane margin','B peak membrane margin','Core cells A/B fired'],rows)+['','## Memory preservation: strict R4','']
components=['poolWeightsExactlyUnchanged','2-specificity','4-negative-cue','8-retention','9-pattern-completion']
lines+=table(['Cell',*components],[[name,*[flag(s['primary']['memoryPreservation'][k]) for k in components]] for name,s in cells.items()])+['',
       'R4 compares exact ordered pool→pool edge identities and numeric weights with Stage 1g, without a tolerance. It also evaluates frozen-reference specificity, absolute negative-cue rejection/containment, retention and half-completion/gain against the initial untrained formation scaffold. Every original afferent weight is checked unchanged during training as an additional host-scope invariant.','',
       '## Training and teacher-veto curves','',f'![Readout training and teacher-veto curves]({link}/training-curves.png)','',
       'The margin curves are native membrane margins, not an observer label score. The teacher curves show cumulative veto fractions; the raw delivered/veto/natural-before indicators remain available for every epoch. Vertical markers identify the checkpoint selected solely by R1–R3.','']
rows=[];continued={}
for name,s in cells.items():
    late=read(study/'cases'/name/'continued-primary/summary.json');continued[name]=late
    for cue in ['A','B']:
        data=late['teacher']['epochs'];rows.append([name,cue,s['primary']['teacher']['firstNaturalBeforeTeacher'][cue],late['teacher']['firstNaturalBeforeTeacher'][cue],sum(row[cue]['delivered'] for row in data),sum(row[cue]['refractoryVeto'] for row in data),sum(row[cue]['naturalBefore'] for row in data)])
lines+=table(['Cell','O label','First natural-before-teacher epoch by stop','First by 80','Delivered teachers through 80','Vetoed teachers through 80','Epochs with natural-before'],rows)+['',f'![Predeclared timing and threshold diagnostic]({link}/diagnostic-curves.png)','',
       'All six seed-1 settings are shown. Solid curves are full-cue margins; dashed curves are the weakest corresponding half. The right panels show native teacher vetoes. These diagnostic curves remain separate from primary acceptance.','']
for seed in [1,2,3]:
    s=cells[f'baseline-{seed}'];lines += [f'### Seed {seed}: checkpoint record',''];rows=[]
    for cp in s['trainingCurve']:
        vals=lambda cue,half=None:[row for delay in ['0','60'] for row in (cp['observed']['probes'][delay] if half is None else cp['observed']['halfProbes'][delay]) if row['cue']==cue and row['half']==half]
        full=vals('A');halves=[row for h in [0,1] for row in vals('A',h)];negative=vals('C')
        rows.append([cp['epoch'],*[flag(cp['gates'][k]) for k in ['R1','R2','R3','R4']],fmt(min(row['outputs']['A']['peakMargin'] for row in full)),fmt(min(row['outputs']['A']['peakMargin'] for row in halves)),fmt(max(row['outputs'][c]['peakMargin'] for row in negative for c in ['A','B']))])
    lines+=table(['Epoch','R1','R2','R3','R4','FullA min membrane margin','HalfA min margin','C max margin'],rows)+['']
lines+=['## Readout weights and selectivity','',
       'Core groups are frozen references; shared A/B members appear in both groups and are explicitly counted. “Other” excludes both. Selectivity is (mean own-core input weight−mean other-core input weight)/1.65.','']
rows=[]
for name,s in cells.items():
    for output in ['A','B']:
        w=s['primary']['weights'][output]
        for group in ['refA','refB','other']:
            d=w[group];rows.append([name,output,group,d['count'],fmt(d['min']),fmt(d['p25']),fmt(d['median']),fmt(d['p75']),fmt(d['max']),fmt(d['mean']),fmt(w['selectivity']),w['overlapCount']])
lines+=table(['Cell','O','Source group','Count','Min','Q25','Median','Q75','Max','Mean','Selectivity','Shared A/B'],rows)+['','## All controls','']
rows=[]
for name,s in cells.items():
    for condition,p in s['controls'].items():
        rows.append([name,condition,p['epoch'],*[flag(p['gates'][k]) for k in ['R1','R2','R3','R4']],len(p.get('ablation',{}).get('removed',[])),p.get('ablation',{}).get('poolResponsesUnchanged','n/a')])
lines+=table(['Cell','Control','Epoch','R1','R2','R3','R4','Pruned edges','Pool responses unchanged'],rows)+['',
       'R4 is intentionally false after prune-formed because that control removes the memory’s recurrent edges. Swapped-teacher is judged by reversed labels, not normal-label R1. These distinctions do not relax any required discrimination.','',
       '## Interpretation','',
       'The primary protocol remains **NO-GO**. All three seeds preserve the memory exactly and reject C, but every seed fails partial-cue readout by epoch 80. Seeds 1/3 pass full-cue accuracy; seed 2 does not. Its full-A peak membrane margin is −0.0080579138, a real native non-spike, not a rounding-adjusted success. Pool completion remains sufficient for the original Stage 1g gate, but the learned readout weights and native leaky integration do not consistently clear the declared output threshold. No threshold or teacher timing was changed after observing this.','',
       'There is a measured positive result: the output projections learn source selectivity while all pool→pool weights remain exactly unchanged. At the primary stops, mean own-core weights are 0.73–0.81, compared with 0.02 initialization and 0.06–0.15 from the other core. The default saved seed-1 primary decodes aardvark through O_A at simulated 0.38 s (18 ticks after the cue), with 68 reference-A cells firing, summed-arrival margin +9.7302 and native peak membrane margin +1.9242. The untrained C remains silent at both delays. The printed word is the explicitly declared codebook lookup.','',
       'A scale estimate helps interpret the primary threshold mismatch: 80% completion multiplied by mean own-core weight 0.73–0.81 gives about 0.58–0.65 units per reference cell, below the declared 0.4×1.65=0.66 threshold scale even before leak. Actual recruited cells and weights are nonuniform, so this estimate is not a substitute for the native margins above. It explains why passing the assembly-completion gate alone does not guarantee output firing when readout weights remain below the plan’s expected ≥1.0 range. This is a post-result interpretation, not an added criterion.','',
       'All five controls are judged literally above. Hebbian-off and untrained output cells remain silent; readout pruning preserves pool responses. Primary seeds 1/2 fail swapped-teacher discrimination and the required preservation of full-cue readout after formed-edge pruning. Seed 3 passes every control but still fails R2. A cell that fails one of these requirements is not rescued by passing normal-label gates.','',
       'The predeclared tick 24/factor 0.25 and tick 32/factor 0.25 settings reach R1–R3 at epoch 70 and pass R4. Their O cells begin firing naturally before the teacher at epochs 59/64 and 55/52 respectively, after which native refractory vetoes are recorded. Primary-factor outputs never fire before the teacher through 80. Tick 16 produces much weaker own-core weights, consistent with the prediction that it misses causal arrivals. The lower-factor findings are seed-1 diagnostics only; they are not three-seed confirmation and do not change the primary result.','',
       'Fully discriminating seed-1 diagnostic cells: '+(', '.join(name for name,s in cells.items() if name.startswith('diagnostic-') and s['pass']) or 'none')+'. Their detailed control failures or passes are retained above. No further threshold cell, engine change or UI integration was added.','',
       '## Reproduce and verify','', '```powershell','npm run demo:readout -- --study','node examples/readout.cjs --cue aardvark','npm test','npm run verify',f'node scripts/verify-readout.cjs outputs/readout/{study.name} baseline-1','```','',
       'Exit 0 from the study means all primary seeds and controls pass, exit 1 is scientific NO-GO, exit 2 is execution error. Inference exits 0 for a successfully executed probe, even when the circuit is silent. Dates, Node version and measured wall time are isolated in timing.json; summary.json is deterministic.','',
       f"Validation: all 188 distinct tests passed, including 10 new readout tests and 6 inhibitory tests; the 15 localhost tests blocked by sandbox EACCES passed on the permitted rerun. All three unlocked Stage 1g origins reproduce the original bytes. Independent native replay checked {validation['replayedCircuits']} saved circuits and {validation['nativeProbeResponses']} probe responses across all eight readout cells and their controls/checkpoints. Audits recompute native O margins, teacher schedules/vetoes, exact ablations, frozen-reference gates and stop selection. All 11 native files remain byte-identical, and no runtime/UI dependencies were added. Machine-readable validation and per-cell verification results accompany the evidence.",'']
(root/'docs/READOUT.md').write_text('\n'.join(lines),encoding='utf-8')
os.environ['MPLCONFIGDIR']=str(root.parent/'matplotlib-readout')
import matplotlib
matplotlib.use('Agg');matplotlib.rcParams['svg.hashsalt']='neurosphere-readout'
import matplotlib.pyplot as plt
fig,axes=plt.subplots(3,3,figsize=(15,11),layout='constrained');colors={'A':'#087f8c','B':'#9856a7'}
for seed,axs in zip([1,2,3],axes):
    s=cells[f'baseline-{seed}'];curve=s['trainingCurve'];x=[r['epoch'] for r in curve]
    for cue,color in colors.items():
        full=[min(row['outputs'][cue]['peakMargin'] for delay in ['0','60'] for row in r['observed']['probes'][delay] if row['cue']==cue) for r in curve]
        halves=[min(row['outputs'][cue]['peakMargin'] for delay in ['0','60'] for row in r['observed']['halfProbes'][delay] if row['cue']==cue) for r in curve]
        axs[0].plot(x,full,color=color,label=cue+' full');axs[0].plot(x,halves,color=color,ls='--',label=cue+' weakest half')
        negative=[max(row['outputs'][cue]['peakMargin'] for delay in ['0','60'] for row in r['observed']['probes'][delay] if row['cue']=='C') for r in curve]
        axs[1].plot(x,negative,color=color,label='C -> O_'+cue)
        teacher=continued[f'baseline-{seed}']['teacher']['epochs'];veto=[sum(row[cue]['refractoryVeto'] for row in teacher[:i+1])/(i+1) for i in range(len(teacher))]
        axs[2].plot([row['epoch'] for row in teacher],veto,color=color,label='O_'+cue)
    axs[0].set(title=f'Seed {seed}',ylabel='Minimum native membrane margin');axs[1].set(ylabel='C maximum membrane margin');axs[2].set(ylabel='Cumulative teacher-veto fraction',ylim=(-.03,1.03))
    for ax in axs:
        ax.axvline(s['stopping']['epoch'],color='#777777',ls=':',lw=1);ax.grid(alpha=.15);ax.spines[['top','right']].set_visible(False);ax.legend(fontsize=8,frameon=False)
    for ax in axs[:2]:ax.axhline(0,color='#777777',ls=':',lw=1)
for ax in axes[-1]:ax.set_xlabel('Readout epoch')
fig.suptitle('Stage 3: learned output margins and native teacher timing',fontweight='bold')
for ext in ['png','svg']:fig.savefig(study/('training-curves.'+ext),dpi=165,facecolor='white',metadata={'Date':None} if ext=='svg' else {})
svg=study/'training-curves.svg';svg.write_text('\n'.join(line.rstrip() for line in svg.read_text(encoding='utf-8').splitlines())+'\n',encoding='utf-8',newline='\n')
plt.close(fig)
diagnostics=[name for name,s in cells.items() if s['seed']==1]
fig,axes=plt.subplots(len(diagnostics),2,figsize=(13,3*len(diagnostics)),layout='constrained')
for name,axs in zip(diagnostics,axes):
    s=cells[name];curve=s['trainingCurve'];x=[r['epoch'] for r in curve]
    for cue,color in colors.items():
        full=[min(row['outputs'][cue]['peakMargin'] for delay in ['0','60'] for row in r['observed']['probes'][delay] if row['cue']==cue) for r in curve]
        halves=[min(row['outputs'][cue]['peakMargin'] for delay in ['0','60'] for row in r['observed']['halfProbes'][delay] if row['cue']==cue) for r in curve]
        axs[0].plot(x,full,color=color,label=cue+' full');axs[0].plot(x,halves,color=color,ls='--',label=cue+' weakest half')
        teacher=continued[name]['teacher']['epochs'];veto=[sum(row[cue]['refractoryVeto'] for row in teacher[:i+1])/(i+1) for i in range(len(teacher))]
        axs[1].plot([row['epoch'] for row in teacher],veto,color=color,label='O_'+cue)
    axs[0].set(title=name,ylabel='Native membrane margin');axs[0].axhline(0,color='#777777',ls=':',lw=1)
    axs[1].set(ylabel='Cumulative teacher-veto fraction',ylim=(-.03,1.03))
    for ax in axs:
        ax.axvline(s['stopping']['epoch'],color='#777777',ls=':',lw=1);ax.grid(alpha=.15);ax.spines[['top','right']].set_visible(False);ax.legend(fontsize=8,frameon=False)
for ax in axes[-1]:ax.set_xlabel('Readout epoch')
fig.suptitle('Predeclared seed-1 timing and threshold diagnostic',fontweight='bold')
for ext in ['png','svg']:fig.savefig(study/('diagnostic-curves.'+ext),dpi=150,facecolor='white',metadata={'Date':None} if ext=='svg' else {})
svg=study/'diagnostic-curves.svg';svg.write_text('\n'.join(line.rstrip() for line in svg.read_text(encoding='utf-8').splitlines())+'\n',encoding='utf-8',newline='\n')
plt.close(fig);print(root/'docs/READOUT.md')
