# Stage 1 v2 — the bounded scaffold (2026-11-01)

**For: Codex. Deliverable: v2 mode of the formation harness (`examples/formation.cjs` or a sibling
`examples/formation-v2.cjs`), tests, `docs/FORMATION_V2.md`, npm script `demo:formation:v2`.**
Read `docs/FORMATION_PLAN.md` (Stage 1g) and `docs/ASSOCIATION.md` (Stage 2 NO-GO) first.

## Why a new scaffold

Stage 2 isolated two facts about the Stage 1 scaffold that are really one fact:

1. **Weights are unbounded relative to threshold.** `maxWeight` 1.65 ≫ threshold 1.02, so with
   continued presentation every assembly acquires single edges that fire a cell alone. Forty extra
   epochs took C spillover to 38–84 % in every plastic condition; plasticity-off → zero change.
   Stage 1g's stop-at-criterion stepped off before the crash; it did not prevent it.
2. **`maxWeight` could not be lowered** because afferents at `w0` 1.1 must exceed threshold on a
   single hit (the ≤ 10 fan-out cap made two-hit coincidence impossible: 8 bits × 8 edges = 64
   endpoints over 500 cells) and are clamped to `maxWeight` on their first pairing.

v2 removes the premise of (2) so that (1) can be fixed in host configuration:

- **Feature groups.** Each of the 192 feature bits is represented by **g = 4 feature cells** (768
  feature cells + 500 pool = 1,268 ≤ 2,000). A cue's 8 bits now land ≈ 8·4·8 = 256 endpoints over
  the pool: Poisson λ ≈ 0.51 → ≈ 47 cells receive **≥ 2 coincident hits**, ≈ 150 receive one.
- **Two-of-N everywhere.** `w0 = maxWeight = 0.7` < threshold 1.02. A pool cell fires only from
  ≥ 2 coincident inputs (afferent or recurrent, any mix). No single edge can ever fire a cell.
  Afferents sit at the cap, so clamping is a no-op on them. Recurrent weights saturate at 0.7
  instead of running away; training can continue indefinitely.
- Consequences to expect: `directSet(cue)` is the ≥ 2-hit set (≈ 47 cells, ≈ 9 %); chance
  direct-set overlap between two cues falls to ≈ 4 cells; one-hit "primed" cells (≈ 150) fire
  when they also receive one recurrent input, so assemblies will include recruited primed cells
  and cores may be larger than the direct set; half a cue (4 bits) directly drives only ≈ 14
  cells, so **completion must come from multi-wave recurrence** and is the hard gate.

This is still host configuration: per-neuron `radius`, per-cell `threshold` untouched (1.02),
engine config keys `maxWeight`, `initialWeight`, `maxSynapses`; `src/neuron` byte-identical.

## Primary protocol (declared)

| item | value | reason |
|---|---|---|
| feature cells | 192 bits × g = 4, each on its own Fibonacci shell position at radius 300, permanent `radius` 600, `nextGrowthAt = 1e12` | spread positions give afferent-delay diversity for pairing |
| SpikeIO | one input port per bit driving its 4 cells (verify the port `cells` array pulses all; else 768 ports) | one pulse per bit per trial |
| seed projections | k = 8 per feature cell, weight `w0` = 0.7, separate seeded RNG | 256 endpoints per cue |
| pool | 500 cells, ball radius 120, `radius` 60 | as 1g |
| `maxWeight` | **0.7** | no single-edge firing; bounded growth |
| `initialWeight` | 0.4 | two fresh edges (0.8) cannot fire a cell; potentiation to cap takes ≈ 20 pairings |
| `maxSynapses` | **10** | 2-of-N completion needs within-core fan-in ≈ 5–6 |
| `leakRate` | default 1.4 | worst-case two hits 0.28 s apart: 0.7·e^(−0.39) + 0.7 = 1.17 > 1.02 ✓ |
| jitter J | **8 ticks** per bit (both cells of a bit share the bit's onset) | ≤ 8 keeps two-hit coincidence inside the leak window while preserving STDP pairing diversity |
| gap | 10 s | activity residue |
| decay | `weightDecay` 0, `unusedDecay` 0, `healthLoss` 0 | as 1c+ |
| competition | `competitionMargin` 1.0, `exploration` 0.1 | as 1e |
| inhibition | lateral 0.5 / 0.6 | as 1g |
| clock | arrival | as always |
| cues | ID-ordered pairwise-disjoint A, B, C | as 1c+ |
| training | train-to-criterion as 1g: checkpoints every 10 epochs, stop at first ≥ 30 with all four 4-of-8 half completions ≥ 0.8 at both delays; **max 120**; then **continue to 120** for the stability gate | |
| seeds | 1 2 3 | |

## Gates

Same numbering as Stage 1 so the two scaffolds compare line by line.

1. Stability — soft 0.7 gated, strict reported.
2. Specificity — inter-core Jaccard ≤ 0.2.
3. Size — 5 ≤ |core| ≤ 0.25·P (note cores may include primed recruits).
4. Negative cue — **absolute again**: C readback rejects; C-to-core Jaccard ≤ 0.25; C spillover
   outside `directSet(C)` ≤ 25 % of the smaller core. Bounded weights are supposed to make the
   absolute cap holdable; if they don't, that is the result.
7. Recurrent structure — within-core formed edges ≥ |core| and density ≥ 3× pool-wide.
8. Retention — 60 s locked silence.
9. Completion — 4-of-8 halves ≥ 0.8 at both delays with gain ≥ 0.25 over untrained on the same
   core. Also report the **basin curve**: completion vs cue fraction {2, 3, 4, 5, 6, 8}/8 bits,
   trained and untrained — this replaces the ignition fraction as the signature figure.
10. Potentiation — median surviving within-core formed weight ≥ `initialWeight + 0.2` (0.6);
    report quantiles and **cap fraction** (weight ≥ 0.69).
11. **Stability under continued training (new, gated).** At epoch 120 — i.e. after the stop,
    with plasticity still on — gates 2, 4, 8 and 9 still pass and the within-core median has
    saturated (≥ 0.65). This is the gate Stage 2 showed the old scaffold cannot pass; it is the
    point of v2. Report the full curve of completion, spillover and median weight from 10 to 120.
    **Reference set (clarified 2026-11-01):** all gate-11 quantities are measured against the
    **frozen stopping cores**, not cores recomputed at 120 — the gate is a claim that the memory
    formed at the stop persists, the same reasoning as `refA`/`refB` in Stage 2. Contemporaneous
    cores at 120 are reported alongside, and **drift** = Jaccard(frozen core, contemporaneous
    core at 120) ≥ 0.8 for both A and B is part of the gate, so a memory that "passes" only by
    migrating into different cells is caught.

Reported: 5 compactness, 6 neutral recruitment (now split: primed recruits vs truly neutral),
churn table, weight-vs-pairings table (1e audit), primed-set sizes, `directSet` overlaps.

## Controls (all seeds, all saved)

As 1g — `growth-off`, `hebbian-off`, `inhibition-off`, `shuffled`, `untrained`, `prune-formed`
(at the stop) — with the same required discriminations: growth-off and hebbian-off fail 9 and 10;
prune-formed drops every half below 0.6 from a higher value. Add **`continued-plastic`** as the
primary's own 120-epoch continuation (gate 11) and **`continued-hebbian-off`** (plasticity off
after the stop; structure may still grow) to attribute any late drift.

## Exit logic

GO iff all three seeds: reach criterion by 120; pass 1–4, 7–10 at the stop; pass 11 at 120;
and the three required control discriminations hold. Exit 1 NO-GO, 2 execution error.

## Predeclared diagnostic (seed 1, all controls, all cells saved)

g ∈ {3, 4} × `w0 = maxWeight` ∈ {0.6, 0.7}, four cells, primary = 4/0.7. One table: |directSet|,
|primed|, core sizes, stopping epoch, min half completion, C spillover at stop and at 120,
within-core median at stop and at 120, cap fraction, fan-in. Also one cell **`maxSynapses` 8**
at 4/0.7 to show the fan-in dependence. No cell replaces the primary.

## Expected failure patterns

- **Silence / tiny direct sets**: coincidence rate lower than the Poisson estimate (collisions,
  inhibition before the second hit). Check first-trial activation (target 6–12 % of pool).
  Lever: g 4 → 5 (960 + 500 = 1,460, still under cap).
- **Completion from 4 bits stalls below 0.8** while 6 bits completes: recurrence can't bootstrap
  from ≈ 14 seeds. The basin curve is the honest report; lever is fan-in (`maxSynapses` 10 → check
  within-core fan-in actually reached ≥ 5) or `initialWeight` 0.4 → 0.5.
- **Spillover still > 25 % at 120** with weights saturated: primed-cell cascades through chance
  overlap. Then bounding weights was necessary but not sufficient, and the remaining lever is
  sparser coding (g 4, k 6) or the pool-1000 axis. Report, don't tune.
- **Stability < 0.7** because jitter plus two-hit coincidence makes membership flicker: raise `w0`
  to 0.75 is *not* allowed in this run (it would be post-hoc); record it as the next declared cell.

## What a pass would mean

The Stage 1 claim, plus: the formed memories are **stable under continued learning** — no cell can
be fired by a single synapse, so neither chance overlap nor further training ignites an assembly,
and weights saturate rather than diverge. That is the property Stage 2 (association) and any
capacity work require. Stage 2 would then be retried on this scaffold with a **structural**
definition of association (≥ 2 A→B inputs per recruited B cell) and a declared displacement
setting so cross-core edges can actually form.

## What a fail would mean

If 11 fails with everything else passing, bounded weights alone do not make a single population
stable and the next lever is an inhibitory population or sparser codes. If 9 fails at 4-of-8 but
the basin curve is monotone and 6-of-8 passes, the memory is a working attractor with a smaller
basin than the old scaffold; report the basin and decide whether 4-of-8 was the right bar before
any retune. If the direct sets are too small to form anything, the fan-out cap has won again and
the honest path is a Neuron fork (raise the cap, or soft-bounded STDP) — a project-owner decision.
