# Readout — Stage 3 implementation brief (2026-11-01)

**For: Codex. Deliverable: `examples/readout.cjs` (+ study runner), `tests/readout.test.cjs`,
`docs/READOUT.md`, npm script `demo:readout`.** Read `docs/FORMATION_PLAN.md` Stage 1g and
`docs/ASSOCIATION_PLAN.md` "Starting state" first. Stage 3 starts from the 1g stopping state.

## The question

Stage 1g produced self-formed, pattern-completing assemblies. Version 0.7's fact/text memories
produced *readout* — labelled output neurons — but on host-wired assemblies. Stage 3 joins the
two: **can an output population learn, through the engine's own STDP under a teacher, to read a
self-formed engram and emit a labelled output when that engram is active — including when it was
activated by only part of its cue — while staying silent for an untrained cue, and without the
readout training altering the memories themselves?** This is the "input → stored memory →
translated output" third of the project goal. It does **not** depend on multi-memory stability
(the v2 / inhibitory track), which is why it can run now.

## Constraints (unchanged)

`src/neuron/*` byte-identical; no deps; deterministic; criteria declared here; failures
recorded. One phase-boundary configuration change is declared below and justified; nothing is
changed temporarily.

## Starting state

Reproduce the 1g formation for each seed to its stopping epoch (70 / 60 / 70) in an unlocked
field and assert byte-identity against the 1g evidence (exactly as Stage 2 did). Freeze
`refA`, `refB`. All memory-preservation checks use these.

## Readout apparatus

- Two **readout cells** `O_A`, `O_B`, `recordOutput: true` (so inhibition skips them and SpikeIO
  reports them), placed at the volume centre, `nextGrowthAt = 1e12`.
- **Projections**: every pool cell → `O_A` and → `O_B` at weight **0.02**. Dense, weak,
  unaddressed — identical in spirit to the 0.7 pilot's feature projections: learning, not the
  host, decides which inputs matter.
- **Capacity**: pool cells are at `maxSynapses` 8 after 1g. At the readout-phase boundary raise
  `config.maxSynapses` **permanently** to 10 and set `nextGrowthAt = 1e12` on all pool cells for
  the rest of the run. The two new slots can therefore be used **only** by the declared readout
  projections. Record both in the effective config; the snapshot carries 10. This is a phase
  change recorded in the artifact, not a temporary mutation.
- ~~Protect readout projections with `Synapse.fixScaffold`~~ **Corrected 2026-11-01 (Codex):**
  `fixScaffold` is the tract-scaffold API (0.3 floor in the depression path, tract-slot
  semantics) and cannot represent a fixed 0.02 projection. Use **ordinary native projections at
  0.02** within the permanent 10-edge capacity, and set **`weightFloor = 0` permanently at the
  readout phase boundary** together with the `maxSynapses` raise and the growth freeze — three
  recorded phase-boundary settings carried in the snapshot. With growth frozen and decay off,
  the floor change is inert for pool→pool edges; R4's exact-weight-equality check demonstrates
  that and stays strict.
- **Readout threshold**: per-cell host property (precedent: 0.7 pilot leading cells at 1.6).
  Set `O.threshold = 0.4 · |ref core| · maxWeight` per seed (≈ 0.4·60·1.65 ≈ 40) and record it.
  Meaning: the output fires when ≳ 40 % of a fully potentiated assembly is active. This is the
  readout's rejection criterion and plays the role the observer decoder's Jaccard-0.5 reject
  played. Chance-overlap spillover (3–7 cells in 1g) cannot reach it; a half-cue completing to
  ≥ 0.8 can.
- **Plasticity scope**: Hebbian enabled **only for `O_A`, `O_B` as post-synaptic cells**, via the
  per-cell `env.features.hebbian` override that `src/fact-memory.cjs` already uses. Pool→pool
  weights must not change during readout training (verified below).

## Readout training (supervised, teacher-forced — declared host scaffold)

One **readout epoch** = present A (full cue, jitter 15, as in 1g) and force an `O_A` spike at
`t0 + 24` ticks (after the assembly's first firing at 8–14 and its completion waves; arrival
clock: pool→O delays are 0.04 s + d/1800 with d ≤ ~400, so most core arrivals land inside the
0.32 s window before the teacher spike); 10 s gap; then the same for B with `O_B`. No forced
spikes anywhere else. C is never presented.

**Clarified 2026-11-01:** the teacher is the native `env.forcedSpike` at the declared tick; O
cells are **not clamped** and may fire naturally from their inputs. Once an O cell fires before
the teacher tick, the forced spike is vetoed by refractoriness — record every delivered teacher
spike and every veto per epoch, and report the first epoch at which each O cell fired naturally
before the teacher. That curve is the readout's own learning curve.

**Train to criterion**: every 10 readout epochs lock a clone and probe (synchronous, no teacher,
0 and 60 s): full A, full B, 4-of-8 halves of A and B, full C. Stop at the first checkpoint ≥ 20
where R1–R3 below all pass; max 80. Evaluate everything on that snapshot; continue to 80 for the
curve. Expected: `0.02 → ≥ 1.0` needs ≈ 55 causal pairings at `hebbianRate` 0.018, so the stop
should land around 50–70.

## Gates

- **R1 Accuracy**: full A → `O_A` fires and `O_B` silent; full B → `O_B` fires and `O_A` silent;
  both delays. Report latency (ticks from cue to O spike) and input margin (summed arriving
  potentiated weight vs threshold).
- **R2 Partial-cue readout**: each 4-of-8 half of A → `O_A` only; of B → `O_B` only; both
  delays. This is the engram doing the work: the readout sees the *completed* assembly.
- **R3 Rejection**: full C → neither fires, both delays. Report C's margin.
- **R4 Memory preservation**: at the readout stop, against frozen refs, 1g gates 2, 4, 8, 9 pass
  and every pool→pool weight is **unchanged** from the 1g stop (exact equality — plasticity was
  scoped to O cells and growth was off). Any change fails R4.
- **R5 Decoded output**: the harness maps a firing O cell to its concept ID and prints
  `vocabulary.get(id).word` — stated plainly in the report as a host codebook lookup, as 0.7's
  docs do. `node examples/readout.cjs --cue aardvark` prints the word, the O spike time, the
  margin, and the number of core cells that fired.

## Controls (all seeds, all saved)

| control | change | required |
|---|---|---|
| `readout-hebbian-off` | no plasticity on O cells during training | R1 fails: O never fires without the teacher |
| `prune-readout` | after the stop, prune every pool→O edge above 0.1 | R1 fails; pool dynamics unchanged |
| `swapped-teacher` | force `O_A` during B and `O_B` during A | readout follows the teacher: full B → `O_A`; shows O cells carry no cue identity of their own |
| `prune-formed` | prune grown pool→pool edges after the stop (1g ablation) | **R2 fails while R1 still passes** — partial-cue readout depends on completion; full-cue readout does not |
| `untrained-readout` | probes before any readout epoch | baseline: no O response |

## Exit logic

GO iff all three seeds reach criterion by 80 and pass R1–R4 at the stop, and all five controls
meet their required outcomes. Exit 1 NO-GO, 2 execution error.

## Reported

Weight distribution of pool→`O_A` inputs split by source class (refA core / refB core / other),
same for `O_B`; margin curves vs readout epoch for A, half-A, C; the full training curve. Also
the **selectivity index** `(w̄ from own core − w̄ from other core) / maxWeight`.

## Diagnostic (seed 1)

Teacher tick ∈ {16, 24, 32} × readout threshold factor ∈ {0.25, 0.4}; six cells, 24/0.4 primary.
Prediction: tick 16 misses late completion-wave arrivals (lower selectivity); factor 0.25 risks
C false positives if spillover grows.

## What a pass would mean

The full chain the project set out to test, on one unchanged engine with declared host
configuration: random input code → self-grown, STDP-potentiated assembly → completion from a
partial cue → a learned output neuron that names it, silent for an untrained cue, with the
memory untouched by readout training. Then the UI's Sense Input → Output path can be pointed at
this instead of the hand-wired fact network (a later, separate change).

## What a fail would mean

- R2 fails, R1 passes: half-cue completion at the 1g stop isn't reliable enough to clear the
  readout threshold; report completion vs margin and consider factor 0.3 as the next declared
  cell — not in this run.
- R3 fails: spillover cells carry enough potentiated weight; the threshold factor is too low
  for this scaffold's containment margin, which ties Stage 3 back to the stability track.
- R4 fails: plasticity leaked into the pool — a harness bug, fix before interpreting anything.


## Post-result decision (2026-11-01; acceptance rules unchanged)

The inhibitory diagnostic is NO-GO: none of the three seed-1 settings passes
all v2 gates including 11. No confirmation seeds or extra inhibitory fractions
were run. The v2 20% cell reaches half-cue criterion at epoch 50 but fails
specificity, size, containment, potentiation and continued stability. The 30% cell
reduces overlap but loses completion; its specificity/containment gates still
fail. The v1 comparison also fails specificity/containment and misreads C as A.
Some individual measurements improve, but no tested setting solves the joint
stability problem. The declared branch permitting one more fraction after
successful specificity/containment therefore does not apply.

For the next stability experiment, the path is a separately declared Neuron
fork with input-proportional feedforward inhibition or a per-neighbourhood
k-winners rule, retaining the harness. No such fork or engine modification is
part of this implementation. Inhibitory firing and plasticity were observed;
the report distinguishes late inhibition and refractory-discarded charge from
absence of inhibition. These results do not establish that every inhibitory
design fails.

Stage 3 remains independent and starts from the byte-identical original 1g
stops. Its primary is NO-GO: all three seeds fail R2 by epoch 80. Both predeclared
seed-1 cells at threshold factor 0.25 and teacher ticks 24/32 pass R1–R4 and all
five controls at epoch 70. These diagnostic successes do not replace the
primary or constitute three-seed confirmation. Native teacher delivery and
refractory vetoes are retained; no output clamp or threshold retuning was added.

See INHIBITORY_DIAGNOSTIC.md and READOUT.md for complete evidence. The original
preregistrations are archived byte-for-byte as source-plan.md in their study
directories, with the original hashes. This post-result note changes no gate,
setting, stopping rule or control from those runs.
