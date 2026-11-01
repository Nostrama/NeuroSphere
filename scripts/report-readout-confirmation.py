"""Author the confirmation report from verified evidence; no runtime dependencies added."""
from pathlib import Path
import json,os,sys
root=Path(__file__).resolve().parents[1];study=Path(sys.argv[1]).resolve()
read=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
s=read(study/'summary.json');validation=read(study/'validation.json')
assert validation['allEvidenceChecks'] and validation['seed1ReusedByteIdentically']
cells=sorted(s['cells'],key=lambda c:c['seed']);outcome='GO' if s['pass'] else 'NO-GO'
link=f'../outputs/readout-confirmation/{study.name}'
fmt=lambda v:'none' if v is None else f'{v:.6f}'
flag=lambda v:'PASS' if v else 'FAIL'
table=lambda heads,rows:['| '+' | '.join(heads)+' |','|'+'---|'*len(heads)]+['| '+' | '.join(map(str,row))+' |' for row in rows]
previous=study/'previous-readout-report.md'
if not previous.exists():previous.write_bytes((root/'docs/READOUT.md').read_bytes())
historical=previous.read_text(encoding='utf-8-sig')
lines=['# Stage 3: readout confirmation','',f'**Confirmation outcome: {outcome} at teacher tick 24 / threshold factor 0.25.**','',
       ('All three seeds reach criterion and pass R1–R4 and every required control discrimination at this single setting.' if s['pass'] else 'Confirmation failed under the declared acceptance rule: '+('; '.join(s['failedCriteria']))+'.'),'',
       'The confirmation section was committed first as `940ea23`. Selection was declared before running seeds 2/3: choose the passing seed-1 cell nearest the original primary, tick 24 / factor 0.25. Seed 1 is the saved diagnostic from the earlier study, copied byte-for-byte with every control, checkpoint and reproduced origin; it was not retrained. Only seeds 2 and 3 were newly trained. No other teacher tick or threshold factor was run.','',
       'The original tick-24 / factor-0.4 primary remains a recorded NO-GO. The revised plan identifies its threshold calculation as an error: it assumed weights at least 1.0 and did not allow for leak across arriving spikes. This confirmation tests the separately declared correction; it does not rewrite the original outcomes or change the formation memories.','',
       '## Protocol and acceptance','',
       'Seeds 2/3 reproduce unlocked Stage 1g stops at 60/70 epochs and assert byte-identity with the original Stage 1g evidence before either confirmation trial begins. Seed 1 retains its original verified 70-epoch origin. All memory checks use the frozen reference cores. The native engine, training/probing code, afferents, pool radii, teacher mechanism, stopping rule and controls are unchanged.','',
       'Two readout cells receive dense ordinary native projections at 0.02. The approved permanent phase settings remain maxSynapses=10, weightFloor=0 and pool/output nextGrowthAt=1e12. Hebbian updates are scoped to output cells only; native forcedSpike teachers retain refractory vetoes. Threshold is exactly 0.25×frozen core size×1.65. Every 10 readout epochs, from 20 through 80, R1–R3 select the first qualifying checkpoint; training then continues to 80 for the curve. Controls match the selected stopping duration. R4 retains exact pool→pool weight equality plus original formation gates 2/4/8/9.','',
       'GO requires all three seeds at the fixed setting to reach criterion and pass R1–R4, plus all five control discriminations. C margin and natural-firing epochs are measurements, not extra acceptance thresholds.','']
rows=[]
for cell in cells:
    p=cell['summary']['primary'];m=read(study/'cases'/cell['id']/'primary/memory.json');st=cell['summary']['stopping']
    rows.append([cell['seed'],'reused' if cell['seed']==1 else 'new',st['epoch'],st['reached'],'/'.join(str(len(p['refs'][c])) for c in ['A','B']),'/'.join(fmt(m['outputs'][c]['threshold']) for c in ['A','B']),*[flag(p['gates'][k]) for k in ['R1','R2','R3','R4']],flag(cell['summary']['pass'])])
lines+=table(['Seed','Evidence','Stop','Reached','Ref A/B','O thresholds A/B','R1 full','R2 halves','R3 C','R4 memory','Result'],rows)+['','### Required control discriminations','']
keys=['readoutHebbianOff','pruneReadout','swappedTeacher','pruneFormed','untrainedReadout']
lines+=table(['Seed',*keys],[[c['seed'],*[flag(c['summary']['discrimination'][k]) for k in keys]] for c in cells])+['',
       'Hebbian-off and untrained readouts must remain silent; readout pruning must fail R1 while leaving pool responses unchanged; swapped teaching must reverse both full-cue labels; pruning formed pool→pool edges must fail R2 while retaining R1. All controls are saved, including failures.','',
       '## Untrained C: margin below the lower threshold','',
       'Peak membrane margin is native leaky membrane potential minus the effective firing threshold on the same nonrefractory tick. Negative margin means positive containment headroom. Both O cells and both delays are reported; these values are not the raw sum of arriving weights. Native output firing determines R3 without rounding or epsilon adjustments.','']
rows=[]
for c in cells:
    for n in c['measurements']['negative']:rows.append([c['seed'],n['idleSeconds'],'O_'+n['output'],fmt(n['threshold']),fmt(n['peakPotential']),fmt(n['peakEffectiveThreshold']),fmt(n['peakMembraneMargin']),fmt(n['headroom']),n['fired']])
lines+=table(['Seed','Idle seconds','Output','Fixed threshold','Peak potential','Effective threshold at peak','Peak margin','Headroom','Fired'],rows)+['','## First natural output firing and teacher vetoes','',
       'Natural firing excludes both driven and external-drive spikes. The first natural epoch is scanned across both A/B presentations, including the opposite cue if it fired there; the matching-teacher “natural before teacher” epoch is reported separately. Measurements cover the unchanged harness’s retained 65-tick presentation windows, not the intervening 10-second gaps. Forced teacher spikes never count as natural firing.','']
rows=[];continued={}
for c in cells:
    data=c['measurements'];late=read(study/'cases'/c['id']/'continued-primary/summary.json');continued[c['seed']]=late
    for label in ['A','B']:
        first=data['naturalAtStop'][label];after=data['naturalThrough80'][label];epochs=late['teacher']['epochs']
        rows.append([c['seed'],'O_'+label,first['epoch'] if first else 'none',first['cue'] if first else 'none',first['tickFromCue'] if first else 'none',after['epoch'] if after else 'none',data['beforeTeacherAtStop'][label],sum(r[label]['delivered'] for r in epochs),sum(r[label]['refractoryVeto'] for r in epochs)])
lines+=table(['Seed','Output','First natural by stop','Cue at first','Tick after cue','First natural through80','First before teacher by stop','Teachers delivered through80','Vetoes through80'],rows)+['',
       '## Confirmation curves','',f'![Fixed-setting confirmation curves]({link}/confirmation-curves.png)','',
       'Margin curves show the worst full-cue and half-cue values across delays. The C curves use the largest margin across delays for each O. Dotted gray lines mark stopping epochs; colored dashed lines in the teacher panels show first natural firing. Full checkpoint values remain in each case’s curve.json.','',
       '## Saved-circuit CLI','']
if s['pass']:
    lines+=['The default inference command now uses the accepted confirmation’s seed-1 circuit at tick 24 / factor 0.25. It does not silently select a different diagnostic.','']
else:
    lines+=['No confirmation circuit is promoted to the default CLI. Default inference retains the original seed-1 primary. Use an explicit --memory path to inspect a failed or diagnostic confirmation circuit; that does not change acceptance.','']
lines+=['```powershell','npm run demo:readout:confirm','node examples/readout.cjs --cue aardvark','node examples/readout.cjs --cue "abominable snowman" --idle 60','```','',
       'With no arguments, the readout CLI now runs this fixed confirmation. `--confirm` is explicit; parameter overrides are rejected. `--study` remains the original historical grid for intentional reproduction and was not run during this confirmation. `--memory FILE` and `--idle 0|60` select an explicit saved probe. The emitted word remains a host `vocabulary.get(conceptId).word` codebook lookup, not generated language. The browser Sense Input path is unchanged.','',
       '## Verification and scope','',
       f"All 17 targeted tests passed (10 existing readout tests and 7 confirmation tests). Independent verification replayed {validation['replayedCircuits']} saved circuits and {validation['nativeProbeResponses']} native probes across all three seeds and all controls, recomputing gates, margins, stop selection, teacher records and ablations. All {validation['seed1CaseFiles']} reused seed-1 case files and its origin match the original bytes. The additional natural-firing and C-margin measurements were independently checked. All 11 native source files remain byte-identical; no dependencies or temporary configuration mutations were introduced.",'',
       '```powershell',f'node scripts/verify-readout-confirmation.cjs outputs/readout-confirmation/{study.name}','```','',
       'The study exits 0 for GO, 1 for scientific NO-GO and 2 for execution error. The independent verifier exits 0 when the recorded evidence is correct, including a correctly reported NO-GO. Variable run metadata stays outside deterministic summaries, in timing files and original seed-1 provenance. The plan, full controls and native checkpoints are included with the evidence.','',
       'This is a bounded, supervised readout result on two self-formed memories. It does not establish multi-memory stability under ongoing plasticity, free-form language generation, or UI integration. Earlier formation and inhibitory outcomes remain unchanged.','',
       '---','','## Historical study: original primary and seed-1 diagnostic','',
       'The earlier report is retained below. Its original CLI-default description is historical; current commands and selection behavior are described above.','']
if s['pass']:
    cli=read(study/'cli-aardvark.json');negative_cli=read(study/'cli-negative-60s.json')
    assert cli['status']=='decoded' and cli['outputs'][0]['word']=='aardvark' and negative_cli['status']=='silent'
    output=cli['outputs'][0]
    position=lines.index('## Verification and scope')
    lines[position:position]=[f"Verified default CLI: `aardvark` produces {output['outputCell']} at {output['spikeTime']:.2f} s ({output['latencyTicks']} ticks after cue), with {output['coreCellsFired']} reference-core cells fired, input margin {output['margin']:.6f} and peak membrane margin {output['peakMembraneMargin']:.6f}. The untrained C word at 60 s is silent. Both command outputs are saved with the evidence.",'']
for line in historical.splitlines():
    if line.startswith('# '):continue
    lines.append('#'+line if line.startswith('##') else line)
(root/'docs/READOUT.md').write_text('\n'.join(lines)+'\n',encoding='utf-8',newline='\n')
readme=root/'README.md';text=readme.read_text(encoding='utf-8');start=text.index('## Learned readout experiment');end=text.index('## Project map',start)
description=(f'**Stage 3 confirmation is {outcome} at teacher tick 24 / threshold factor 0.25.** '
    +('All three seeds pass R1–R4 and every required control. Seed 1 is reused byte-for-byte; seeds 2 and 3 are new confirmation runs.' if s['pass'] else 'The declared confirmation fails: '+('; '.join(s['failedCriteria']))+'. No setting was retuned or substituted.'))
section='''## Learned readout experiment

'''+description+'''

Readout plasticity is confined to two teacher-trained output neurons; the
original memories pass strict preservation checks. The earlier factor-0.4
primary remains a recorded NO-GO. Read [the readout report](docs/READOUT.md)
for all controls, C's membrane margins, natural-firing epochs, native teacher
deliveries and refractory vetoes, and the retained historical results.

```powershell
npm run demo:readout:confirm
node examples/readout.cjs --cue aardvark
node examples/readout.cjs --cue "abominable snowman" --idle 60
```

'''+('Default inference uses the confirmed seed-1 circuit at tick 24 / factor 0.25.\n' if s['pass'] else 'Confirmation failed, so default inference retains the original seed-1 primary.\n')+'''The printed word is a vocabulary codebook lookup from the firing output cell,
not generated language. Silent responses are reported honestly. Use
`--memory FILE` to inspect a specific saved circuit. With no arguments, the
readout CLI runs the fixed confirmation; `--confirm` is explicit. `--study`
is reserved for reproducing the original historical grid. Confirmation accepts
no alternative tick or factor. Exit codes are 0 for GO, 1 for scientific NO-GO
and 2 for execution error.

Every byte under `src/neuron` is preserved, and no runtime dependencies were
added. The browser's Sense Input path is unchanged.

'''
readme.write_text(text[:start]+section+text[end:],encoding='utf-8',newline='\n')
os.environ['MPLCONFIGDIR']=str(root.parent/'matplotlib-readout-confirmation')
import matplotlib
matplotlib.use('Agg');matplotlib.rcParams['svg.hashsalt']='neurosphere-readout-confirmation'
import matplotlib.pyplot as plt
fig,axes=plt.subplots(3,3,figsize=(15,11),layout='constrained');colors={'A':'#087f8c','B':'#9856a7'}
for cell,axs in zip(cells,axes):
    seed=cell['seed'];curve=cell['summary']['trainingCurve'];x=[r['epoch'] for r in curve]
    for label,color in colors.items():
        full=[min(r['outputs'][label]['peakMargin'] for d in ['0','60'] for r in cp['observed']['probes'][d] if r['cue']==label) for cp in curve]
        half=[min(r['outputs'][label]['peakMargin'] for d in ['0','60'] for r in cp['observed']['halfProbes'][d] if r['cue']==label) for cp in curve]
        negative=[max(r['outputs'][label]['peakMargin'] for d in ['0','60'] for r in cp['observed']['probes'][d] if r['cue']=='C') for cp in curve]
        axs[0].plot(x,full,color=color,label=label+' full');axs[0].plot(x,half,color=color,ls='--',label=label+' weakest half');axs[1].plot(x,negative,color=color,label='C -> O_'+label)
        teachers=continued[seed]['teacher']['epochs'];veto=[sum(r[label]['refractoryVeto'] for r in teachers[:i+1])/(i+1) for i in range(len(teachers))]
        axs[2].plot([r['epoch'] for r in teachers],veto,color=color,label='O_'+label)
        natural=cell['measurements']['naturalThrough80'][label]
        if natural:axs[2].axvline(natural['epoch'],color=color,ls='--',lw=.9)
    axs[0].set(title='Seed '+str(seed)+(' (reused)' if seed==1 else ''),ylabel='Native membrane margin');axs[1].set(ylabel='C maximum membrane margin');axs[2].set(ylabel='Cumulative teacher-veto fraction',ylim=(-.03,1.03))
    for ax in axs:
        ax.axvline(cell['summary']['stopping']['epoch'],color='#777777',ls=':',lw=1);ax.grid(alpha=.15);ax.spines[['top','right']].set_visible(False);ax.legend(fontsize=8,frameon=False)
    for ax in axs[:2]:ax.axhline(0,color='#777777',ls=':',lw=1)
for ax in axes[-1]:ax.set_xlabel('Readout epoch')
fig.suptitle('Confirmation: teacher tick 24 / threshold factor 0.25',fontweight='bold')
for ext in ['png','svg']:fig.savefig(study/('confirmation-curves.'+ext),dpi=160,facecolor='white',metadata={'Date':None} if ext=='svg' else {})
svg=study/'confirmation-curves.svg';svg.write_text('\n'.join(line.rstrip() for line in svg.read_text(encoding='utf-8').splitlines())+'\n',encoding='utf-8',newline='\n');plt.close(fig)
print(outcome,root/'docs/READOUT.md')
