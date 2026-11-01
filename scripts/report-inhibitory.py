"""Render the declared scientific evidence; Python is an authoring tool, not a project dependency."""
import json, os, sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
study = Path(sys.argv[1]).resolve()
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
report = read(study/'summary.json')
validation = read(study/'validation.json')
assert validation['allEvidenceChecks'] and validation['nativeSourceByteIdentical']
cells = {c['id']: c['summary'] for c in report['cells']}
fmt = lambda x: 'n/a' if x is None else f'{x:.4f}'
def minimum(values):
    values=list(values)
    return min(values) if values and all(v is not None for v in values) else None
def halfmin(p): return minimum(r['trained'] for s in ['0','60'] for r in p['patternCompletion']['rows'][s] if r['cue']!='C')
def medians(p): return '/'.join(fmt(p['potentiation']['cores'][c]['within']['quantiles']['median']) for c in ['A','B'])
def cap(p): return '/'.join(fmt(p['potentiation']['cores'][c]['within']['capFraction']) for c in ['A','B'])
def table(headers,rows): return ['| '+' | '.join(headers)+' |','|'+'---|'*len(headers)]+['| '+' | '.join(map(str,row))+' |' for row in rows]
def flag(value): return 'PASS' if value else 'FAIL'
link=f'../outputs/inhibitory/{study.name}'
lines=['# Inhibitory-population diagnostic','',f"**Outcome: {'GO' if report['pass'] else 'NO-GO'}.** {report['decision']}",'',
       'This is a diagnostic, not a new stage. Both requested plans were committed before implementation (`096d535`); the readout correction was committed separately (`2c1834f`). The declaration and source hashes were saved before any scientific run. No parameter, gate, or stopping rule was changed after observing results.','',
       '## Protocol','',
       'Native inhibitory populations replace lateral inhibition. Feature endpoints are registered before cell creation so all feature cells remain excitatory; native per-ID seeded assignment chooses the inhibitory pool cells. At fractions 0.2/0.3, total pool sizes are 625/714. Actual E/I counts are reported below. All acceptance metrics—including density denominators, negative-cue spillover and frozen-core gate 11—use excitatory cells only. The native graph includes both types.','',
       'The v2 scaffold retains g=4, w0=maxWeight=0.7, initialWeight=0.4, maxSynapses=10, jitter8 per bit, gap 10 s, decay/health loss off, margin1.0/exploration0.1, arrival clock and ID-ordered disjoint cues. The v1 comparison uses the exact Stage 1g scaffold: g=1, w0=1.1, maxWeight=1.65, maxSynapses=8, jitter15. Both follow the diagnostic stopping horizon and continuation to 120. A v1 one-hit cell is already direct; it is not a subthreshold primed cell.','',
       'At each ten-epoch checkpoint, only the four A/B half completions at both delays govern stopping: first checkpoint at least 30 with all at least 0.8, capped at 120. C and other gates never choose the stop. Gate 11 tests the frozen stopping cores at 120, including drift at least 0.8 for both cores. A stop at 120 leaves zero additional training for the continued controls.','',
       'Growth-off, Hebbian-off, shuffled and untrained use the same inhibitory scaffold. Native prune-formed removes every physical pool→pool edge, including inhibitory edges, preserving afferents. Continued-Hebbian-off restores the stopping circuit and disables Hebbian learning permanently. The **inhibition-off reference is the existing 500-E v2 primary**, at its own stop and at 120, with lateral inhibition0.5/0.6. Its native artifacts and source hashes are copied once. It is a common scaffold reference, not a matched-size population toggle; changing pool size also changes afferent density.','',
       '## Acceptance results','']
rows=[]
for name,s in cells.items():
    p=s['primary'];late=s['controls']['continued-plastic']['gate11'];q=late['frozenMetrics'];n=p['negative'][0]
    rows.append([name,f"{len(p['population']['excitatory'])}/{len(p['population']['inhibitory'])}",f"{s['stopping']['epoch']}/{s['stopping']['reached']}",
        f"{p['coreSizes']['A']}/{p['coreSizes']['B']}",fmt(p['specificity']),fmt(halfmin(p)),len(n['outsideDirectSet']),fmt(n['spilloverFractionOfSmallerCore']),medians(p),cap(p),
        fmt(halfmin(q)),fmt(q['negative'][0]['spilloverFractionOfSmallerCore']),'/'.join(fmt(late['drift'][c]) for c in ['A','B']),flag(s['pass'])])
lines+=table(['Cell','Actual E/I','Stop/reached','E cores A/B','Inter-core J','Min half','C spill count','C spill fraction','Median A/B','Cap≥0.69 A/B','120 frozen min half','120 frozen spill','Drift A/B','Result'],rows)+['']
keys=[k for k,v in next(iter(cells.values()))['primary']['criteria'].items() if v['gated']]
lines+=table(['Cell',*keys,'Growth-off discrimination','Hebbian-off discrimination','Prune discrimination'],[[name,*[flag(s['primary']['criteria'][k]['pass']) for k in keys],*[flag(s['discrimination'][k]) for k in ['growthOff','hebbianOff','pruneFormed']]] for name,s in cells.items()])+['',
       'All gate failures remain failures. Cap fraction ≥0.69 is reported rather than gated; in the v1 comparison this is not its maximum-weight cap. Gate 10 requires median≥0.6; gate11 requires both frozen medians≥0.65 in addition to gates 2/4/8/9 and drift.','',
       '### Negative cue at both delays','']
rows=[]
for name,s in cells.items():
    for phase,p in [('stop',s['primary']),('120 frozen',s['controls']['continued-plastic']['gate11']['frozenMetrics'])]:
        for n in p['negative']: rows.append([name,phase,n['idleSeconds'],len(n['outsideDirectSet']),fmt(n['spilloverFractionOfSmallerCore']),fmt(n['A']['jaccard']),fmt(n['B']['jaccard']),n['readback']])
lines+=table(['Cell','Reference','Delay seconds','Spill count','Spill fraction','C-to-A J','C-to-B J','Readback'],rows)+['','### Gate 11 on frozen stopping cores','']
keys11=list(next(iter(cells.values()))['controls']['continued-plastic']['gate11']['components'])
rows=[]
for name,s in cells.items():
    for condition in ['continued-plastic','continued-hebbian-off']:
        p=s['controls'][condition];g=p['gate11']
        rows.append([name,condition,g['postStopEpochs'],*map(lambda k:flag(g['components'][k]),keys11),'/'.join(str(len(g['contemporaneousCores'][c])) for c in ['A','B']),medians(g['frozenMetrics'])])
lines+=table(['Cell','Continuation','Extra epochs',*keys11,'Contemporary E cores','Frozen medians'],rows)+['','## Basin and training curves','',f'![Basin curves]({link}/basin-curves.png)','',
       'Solid: trained at the selected stop. Dashed: untrained, against the same frozen stopping core. Lines average the two predeclared subset orders and both delays; shading gives their full range. At four bits these are the fixed even/odd halves: acceptance uses their minimum, not the plotted average. These sampled subsets do not exhaust the basin.','',f'![Training curves]({link}/training-curves.png)','',
       'Training curves use contemporaneous cores for the actual stopping rule. The dashed common v2 reference is the previously recorded 500-E run. Frozen-reference values for every checkpoint are also retained in curve.json.','']
for name,s in cells.items():
    lines += [f'### {name}: checkpoint record','']
    rows=[]
    for r in s['trainingCurve']:
        halves=['/'.join(fmt(next(v['completion'] for v in r['halfCompletions'][delay] if v['cue']==cue and v['half']==half)) for delay in ['0','60']) for cue in ['A','B'] for half in [0,1]]
        rows.append([r['epoch'],f"{r['coreSizes']['A']}/{r['coreSizes']['B']}",*halves,'/'.join(fmt(r['negative'][d]['fraction']) for d in ['0','60']),
            fmt(minimum(v['completion'] for d in ['0','60'] for v in r['frozen']['halfCompletions'][d])),'/'.join(fmt(r['frozen']['medianWeights'][c]) for c in ['A','B'])])
    lines+=table(['Epoch','E cores A/B','A even 0/60','A odd 0/60','B even 0/60','B odd 0/60','C spill 0/60','Frozen min half','Frozen medians'],rows)+['']
lines+=['## Inhibition measurements','',
       'Measurements cover each trial’s 50+J capture ticks. Charge means use **all E cells** as the denominator. Native refractory drops are reported separately and excluded from integrated charge. “Before afferent” uses strict physical message arrival time, not storage order; same-time arrivals do not qualify. “Integrated before” additionally requires that the inhibitory message was admitted by the membrane. This timestamp comparison can include messages consumed in the same discrete engine tick; it does not assert a separate earlier integration tick. Both delivered and membrane-integrated inhibition are reported. The effective-threshold proxy is raw excitation minus inhibition integrated during ticks [spike−9, spike], including spike-tick inputs; it is not a reconstructed leaky potential.','',
       f'![Inhibitory activity and primed-cell suppression]({link}/inhibition-measurements.png)','',
       'All per-trial E-cell charge ledgers, first arrival times, I spikes, primed IDs and per-E-spike ten-tick proxies are saved in inhibition-trials.json. The following averages cover the first and last ten epochs of the full 120-epoch primary trajectory.','']
rows=[]; observations={}
for name,s in cells.items():
    obs=read(study/'cases'/name/'controls/continued-plastic/inhibition-trials.json');observations[name]=obs
    for label,lo,hi in [('early',1,10),('stop last 10',max(1,s['stopping']['epoch']-9),s['stopping']['epoch']),('late',111,120)]:
        data=[r for r in obs if lo<=r['epoch']<=hi]
        mean=lambda values:sum(values)/len(values) if values else None
        integrated=sum(c['inhibitoryCharge'] for r in data for c in r['cells']);discarded=sum(c['discardedInhibition'] for r in data for c in r['cells'])
        rows.append([name,label,fmt(mean([len(r['inhibitoryCellsFiring']) for r in data])),fmt(mean([r['meanInhibitoryCharge'] for r in data])),
            fmt(mean([r['primed']['inhibitedBeforeFraction'] for r in data if r['primed']['inhibitedBeforeFraction'] is not None])),
            fmt(mean([r['primed']['integratedBeforeFraction'] for r in data if r['primed']['integratedBeforeFraction'] is not None])),fmt(mean([r['primed']['firedFraction'] for r in data if r['primed']['firedFraction'] is not None])),
            fmt(mean([p['net'] for r in data for p in r['effectiveThresholdProxy']])),fmt(discarded/(integrated+discarded) if integrated+discarded else None)])
lines+=table(['Cell','Epoch range','Mean I cells/trial','Mean I charge/E','One-hit inhibited before afferent','Integrated before afferent','One-hit fired fraction','Mean net10 at E spikes','I charge discarded fraction'],rows)+['','### Typed recurrent edges at every checkpoint','']
rows=[]
for name,s in cells.items():
    for r in s['trainingCurve']:
        for kind,d in r['edgesByType']['byType'].items():
            q=d['weights'];rows.append([name,r['epoch'],kind,d['count'],fmt(q['mean']),fmt(q['p25']),fmt(q['median']),fmt(q['p75']),fmt(q['max'])])
lines+=table(['Cell','Epoch','Type','Live edges','Mean magnitude','Q25','Median','Q75','Max'],rows)+['',
       'Every edge birth epoch and per-epoch type count is saved alongside the native lifecycle audit. Negative signed weights for I-source edges are reported in edgesByType; the table above reports magnitudes. E-only within-core measures remain distinct from the full physical-pool audit.','',
       '### I→E weights by target class','']
rows=[]
for name,s in cells.items():
    for phase,p in [('stop',s['primary']),('120',s['controls']['continued-plastic'])]:
        for group,d in p['edgesByType']['inhibitoryToExcitatoryTargets'].items():
            w=d['weights'];rows.append([name,phase,group,d['targetCount'],d['everFired'],w['count'],fmt(w['mean']),fmt(w['median']),fmt(w['p75'])])
lines+=table(['Cell','Epoch reference','Target class','E targets','Ever fired in A/B training','Incoming I edges','Mean magnitude','Median','Q75'],rows)+['',
       'Primed targets are the union of A/B one-hit sets; other targets exclude that union. These weight observations test the declared prediction without adding an acceptance criterion. Exact edge targets and per-trial E firing are retained for inspection.','',
       '## Recruitment partition at the stop','']
rows=[]
for name,s in cells.items():
    p=s['primary']
    for cue in ['A','B']:
        r=p['recruitment'][cue];split=r['neutralSplit'];rows.append([name,cue,len(p['directSets'][cue]),len(p['primedSets'][cue]),r['recruited'],r['otherCueDirect']['count'],len(split['ownCuePrimed']),len(split['otherCuePrimedOnly']),len(split['trulyNeutral'])])
lines+=table(['Cell','Core','Direct E','One-hit E','Outside own direct','Other-cue direct','Own-primed neutral','Other-primed-only neutral','Truly neutral'],rows)+['','## Controls','']
rows=[]
for name,s in cells.items():
    for condition,p in s['controls'].items():
        q=p['gate11']['frozenMetrics'] if condition.startswith('continued-') else p
        rows.append([name,condition,p['epoch'],fmt(halfmin(q)),fmt(q['specificity']),' / '.join(fmt(n['spilloverFractionOfSmallerCore']) for n in q['negative']),medians(q),flag(q['criteria']['9-pattern-completion']['pass']),flag(q['criteria']['10-potentiation']['pass'])])
lines+=table(['Cell','Condition','Epoch','Min half','Inter-core J','C spill 0/60','Medians','Gate9','Gate 10'],rows)+['','## Interpretation and next decision','',
       'No setting meets the declared specificity/containment and completion requirements together. The v2 20% condition reaches the half-cue stopping rule at epoch 50, with minimum completion 0.8244, but C spillover is 76 E cells (75.25% of its smaller core). Continued training increases frozen-reference spillover to 127.72%, with drift 0.5587/0.7207. Early completion is therefore not stable, contained memory. The 30% condition reduces inter-core overlap to 0.2947 but never reaches the completion rule (minimum 0.1695 at 120); its C spillover is 63 cells, exceeding the smaller core. The v1 comparison reaches 0.7792 minimum completion, and its untrained C is incorrectly read as A.','',
       'Native inhibitory activity and plasticity are present. In the final ten epochs before each selected stop, the two v2 conditions average 33.05/28.90 distinct I cells firing per trial. However, only 0.54%/0.83% of one-hit E cells admit an inhibitory message whose stored arrival time precedes their afferent (the timestamp definition above). About 49.4%/39.6% of incoming inhibitory charge is discarded during E refractoriness. I→E magnitudes are somewhat higher onto primed targets (means 0.4363/0.4329) than onto other targets (0.4190/0.4152), but their median remains 0.4. In the v1 comparison the corresponding means are 0.7435 versus 0.4101: the inhibitory plasticity mechanism is functioning, yet it does not prevent the observed false readback. These are timing and efficacy measurements, not proof that all inhibitory designs must fail.','',
       'The larger physical pool also dilutes afferents: direct E sets are 28/31 at 20% and 24/18 at 30%, while roughly 126–152 E cells remain one-hit primed per cue. Thus differences from the saved 500-E inhibition-off reference cannot be attributed solely to inhibitory strength. The declared size adjustment and common reference are reported without treating them as a matched-size causal comparison.','',
       '**Decision:** no seed-1 cell qualifies, so no confirmation seeds or additional fractions were run. Some individual metrics improve, but the tested native mechanism does not solve the joint stability problem; the “specificity/containment pass, completion fails” branch does not apply. The next stability experiment should be a separately declared Neuron fork adding input-proportional feedforward inhibition or a local k-winners rule, with the harness retained. This task does not create that fork or change the engine. The same post-result decision is appended to both requested plans. Stage 3 remains a separate readout experiment on the original Stage 1g memories.','',
       '## Reproduce and verify','', '```powershell','npm run demo:inhibitory','npm test','npm run verify',f'node scripts/verify-inhibitory.cjs outputs/inhibitory/{study.name} v2-f20-1','```','',
       'Exit 0 requires the declared diagnostic GO, exit 1 is scientific NO-GO, and exit 2 is an execution error. The verifier exits 0 when evidence agrees, including a correctly reported scientific failure. Timestamps, Node version and wall time live only in timing.json; summary.json is deterministic. Native snapshot restoration and compilation use the unchanged engine. Native reload annotates historical endpoint-placement telemetry; circuit identity tests compare every neuron/terminal state and compiled native bytes rather than treating that annotation as a circuit change.','',
       f"Validation: all 188 distinct tests passed (the 15 sandbox-blocked localhost tests passed on the permitted rerun). Independent verification replayed {validation['replayedCircuits']} saved circuits and {validation['nativeProbeResponses']} native probe responses across all three cells, including their controls and checkpoints. Every native source file is byte-identical; source verification checked 24 copied files and the copied UI module, with zero third-party runtime/UI dependencies. Per-cell audit results and validation.json accompany the evidence.",'']
(root/'docs/INHIBITORY_DIAGNOSTIC.md').write_text('\n'.join(lines),encoding='utf-8')
os.environ['MPLCONFIGDIR']=str(root.parent/'matplotlib-inhibitory')
import matplotlib
matplotlib.use('Agg');matplotlib.rcParams['svg.hashsalt']='neurosphere-inhibitory'
import matplotlib.pyplot as plt
names=list(cells);colors={'A':'#087f8c','B':'#9856a7'}
def save(fig,name):
    for ext in ['png','svg']:fig.savefig(study/(name+'.'+ext),dpi=160,facecolor='white',metadata={'Date':None} if ext=='svg' else {})
    svg=study/(name+'.svg');svg.write_text('\n'.join(line.rstrip() for line in svg.read_text(encoding='utf-8').splitlines())+'\n',encoding='utf-8',newline='\n')
    plt.close(fig)
def tidy(ax):ax.grid(alpha=.15);ax.spines[['top','right']].set_visible(False)
fig,axes=plt.subplots(len(names),1,figsize=(11,3.4*len(names)),squeeze=False,layout='constrained')
for name,ax in zip(names,axes[:,0]):
    for cue,color in colors.items():
        for key,style in [('trained','-'),('untrained','--')]:
            xs=[2,3,4,5,6,8];vals=[[r[key] for delay in ['0','60'] for r in cells[name]['primary']['basin'][delay] if r['cue']==cue and r['count']==n and r[key] is not None] for n in xs]
            ax.plot(xs,[sum(v)/len(v) if v else float('nan') for v in vals],style,color=color,label=cue+' '+key);ax.fill_between(xs,[min(v) if v else float('nan') for v in vals],[max(v) if v else float('nan') for v in vals],color=color,alpha=.1)
    ax.set(title=name,ylabel='E core completion',ylim=(-.03,1.04),xticks=xs);ax.axhline(.8,color='#777777',ls=':',lw=1);tidy(ax)
axes[0,0].legend(ncol=4,frameon=False);axes[-1,0].set_xlabel('Active bits / 8');fig.suptitle('Inhibitory population: sampled completion basin',fontweight='bold');save(fig,'basin-curves')
reference=read(study/'references/inhibition-off-1/primary/curve.json')
fig,axes=plt.subplots(len(names),3,figsize=(15,3.4*len(names)),squeeze=False,layout='constrained')
for name,axs in zip(names,axes):
    data=cells[name]['trainingCurve'];xs=[r['epoch'] for r in data]
    for rows,style,label in [(data,'-',name),(reference,'--','v2 reference')]:
        x=[r['epoch'] for r in rows]
        axs[0].plot(x,[minimum(h['completion'] for d in ['0','60'] for h in r['halfCompletions'][d]) for r in rows],style,label=label)
        axs[1].plot(x,[r['negative']['0']['fraction'] for r in rows],style)
        axs[2].plot(x,[r['coreSizes']['A'] for r in rows],style,color=colors['A']);axs[2].plot(x,[r['coreSizes']['B'] for r in rows],style,color=colors['B'])
    for ax in axs:ax.axvline(cells[name]['stopping']['epoch'],ls=':',color='#777777',lw=1);tidy(ax)
    axs[0].set(title=name,ylabel='Minimum half completion',ylim=(0,1.04));axs[0].axhline(.8,color='#777777',ls=':',lw=1);axs[0].legend(fontsize=8,frameon=False)
    axs[1].set(ylabel='C spill / smaller E core');axs[1].axhline(.25,color='#777777',ls=':',lw=1);axs[2].set(ylabel='Contemporary E core size')
for ax in axes[-1]:ax.set_xlabel('Formation epoch')
fig.suptitle('Inhibition: completion, containment and size',fontweight='bold');save(fig,'training-curves')
fig,axes=plt.subplots(len(names),3,figsize=(15,3.3*len(names)),squeeze=False,layout='constrained')
for name,axs in zip(names,axes):
    obs=observations[name]
    for cue,color in colors.items():
        data=[r for r in obs if r['cue']==cue];x=[r['epoch'] for r in data]
        axs[0].plot(x,[len(r['inhibitoryCellsFiring']) for r in data],color=color,label=cue)
        axs[1].plot(x,[r['meanInhibitoryCharge'] for r in data],color=color)
        axs[2].plot(x,[r['primed']['firedFraction'] for r in data],color=color,label=cue+' fired')
        axs[2].plot(x,[r['primed']['integratedBeforeFraction'] for r in data],color=color,ls='--',label=cue+' inhibited before')
    axs[0].set(title=name,ylabel='I cells firing / trial');axs[1].set(ylabel='Integrated inhibitory charge / E');axs[2].set(ylabel='One-hit E fraction',ylim=(-.03,1.04));axs[2].legend(fontsize=8,frameon=False,ncol=2)
    for ax in axs:tidy(ax)
for ax in axes[-1]:ax.set_xlabel('Formation epoch')
fig.suptitle('Native inhibitory activity and timing',fontweight='bold');save(fig,'inhibition-measurements')
print(root/'docs/INHIBITORY_DIAGNOSTIC.md')
