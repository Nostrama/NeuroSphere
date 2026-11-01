# Association experiment — Stage 2 implementation brief

**For: Codex. Deliverable: `examples/association.cjs` (+ study runner), `tests/association.test.cjs`,
`docs/ASSOCIATION.md`, npm script `demo:association`. Read `docs/FORMATION_PLAN.md` Stage 1g and
`docs/FORMATION.md` first; Stage 2 starts from that exact state.**

## The question

Stage 1 showed that two assemblies, A and B, form separately in one pool and each completes from
half a cue. Stage 2 asks: **if A and B are presented in temporal sequence, do the engine's own
growth and STDP build a link between the two assemblies such that cueing A alone recruits B** —
and does that link have the properties the mechanism predicts (directional, causal through
cross-core edges, absent without pairing), without destroying either memory or containment?

This is the "link and associate with another engram" half of the project goal. Readout (Stage 3)
is still out of scope.

## Non-negotiable constraints (unchanged)

`src/neuron/*` byte-identical; `npm run verify` passes; no dependencies; CommonJS; deterministic
per seed; no temporary config mutation; failures recorded as failures; the plan's criteria are
declared here before any run and a cell that fails is reported, not re-tuned.

## Starting state: reproduce the Stage 1g stop

For each seed, rerun the 1g formation protocol deterministically to its recorded stopping epoch
(70 / 60 / 70 for seeds 1–3) in an **unlocked** field. Before any association trial, assert that
the cores, formed-edge set and weights are byte-identical to the 1g evidence for that seed
(`outputs/formation/2026-10-31T23-05-24-523Z-stage1g/cases/baseline-<seed>/`). Save these as
**reference cores** `refA`, `refB`; every Stage 2 metric is computed against them, not against
contemporaneous cores (which would merge by construction during paired trials). Also report
contemporaneous cores.

Stage 1 configuration carries over unchanged: pool 500, k 8, w0 1.1, initialWeight 0.4,
radius 60, maxSynapses 8, inhibition 0.5/0.6, competitionMargin 1.0, exploration 0.1, decay off,
gap 10 s, arrival clock, disjoint cues A / B / C.

## Engine facts the design depends on

- **Cross-core edges can only form where a cell has a free terminal.** At the 1g stop, core cells
  are near `maxSynapses` (≈ 8 outgoing: ≈ 5 within-core, the rest to neutral cells). With
  `competitionMargin` 1.0 an incumbent is displaced only if the candidate scores > incumbent + 1.0.
  During a paired trial a B cell has activity ≈ 1 while a neutral incumbent target has 0, so
  **edges to neutral cells are displaced (−0.12 per event → pruned at the 0.15 floor after three
  hits) and their slots are refilled with cross-core edges at 0.4.** Within-core incumbents
  (activity ≈ 1) are not displaced. Expect cross-core edge formation to ramp over several epochs.
- **STDP is directional.** With A leading B by Δ, A→B edges see pre-arrival before the B spike
  and potentiate; B→A edges see pre-arrival after the A spike and do not. Lag arithmetic for the
  chosen Δ is below. Prediction: **forward association forms; reverse does not** — unless the order
  is alternated (variant).
- **Recruitment is non-linear.** A B cell fires from A input when Σ(active A→B weights) ≥ 1.02,
  i.e. two edges at ≥ 0.6 or three at 0.4. Once ≥ ~50 % of refB fires, B's own within-core
  recurrence completes the rest (Stage 1 half-cue completion ≥ 0.8). So A-alone recruitment of B
  should jump from near-chance to near-complete over a few epochs, not grow smoothly.
- **Every extra epoch also raises within-core weights and therefore chance-overlap spillover.**
  Stage 1g showed the window between "formed" and "spillover > 25 %" is ~10 epochs on this
  scaffold. Stage 2 adds epochs. The controls below separate "association caused it" from "more
  training caused it", and the containment gate is defined with that in mind.

## Protocol

**Paired trial** (one per association epoch): pulse A's 8 bits at `t0 + U{0..J}` and B's 8 bits
at `t0 + Δ + U{0..J}` with **J = 5 ticks, Δ = 12 ticks (0.24 s)**; capture `50 + Δ + J` ticks;
then the 10 s gap. Jitter is reduced from 15 so that the A→B order is preserved on every trial.

Lag check (ticks): A direct cell fires at `jA + affA` (aff ∈ 7–13.5), B direct cell at
`12 + jB + affB`; A→B recurrent delay 2.2–3.7. Lag = `12 + (jB − jA) + (affB − affA) − d`
∈ ≈ [−2.5, 20.5], mostly inside the 0–16 tick STDP window → most A→B pairs qualify most trials.
B→A lag is ≈ −12 − … → never qualifies. Record the predicted qualifying count per cross-core edge
from the schedule exactly as the Stage 1e audit does.

**Associate to criterion.** Every 5 association epochs, lock a clone and probe **A alone**
(full cue, synchronous, 0 and 60 s). Stop at the first checkpoint ≥ 5 where forward recruitment
(below) ≥ 0.5 at both delays; maximum 40. The rule reads only the A→B probe. Evaluate every gate
on that snapshot; continue to 40 only for the curve. Controls run to the matched epoch count.

## Metrics (all against `refA`, `refB`; both delays)

1. **Forward recruitment** `fwd = |S(A alone) ∩ refB| / |refB|`. Baseline at the 1g stop is
   chance overlap (`|refA ∩ directSet(B)|`, 3–10 cells ≈ 5–15 %); record it per seed.
2. **Reverse recruitment** `rev = |S(B alone) ∩ refA| / |refA|`, with its own baseline.
3. **Self-integrity**: A and B half-cue completion against `refA`/`refB` ≥ 0.8 (the memories
   must survive being linked); A-alone and B-alone full-cue recall of their own core ≥ 0.9.
4. **Containment**, absolute: C readback rejects (nearest-ref-core Jaccard < 0.5); C-to-ref-core
   Jaccard ≤ 0.25. **Containment, relative**: C spillover outside `directSet(C)` ≤ unpaired
   control's spillover at the same epoch + 10 points of the smaller ref core. The absolute 25 %
   cap from Stage 1 is **reported**, not gated here, because training volume alone can exceed it
   (1g curves); the relative gate is what tests whether *association* costs containment.
5. **Cross-core structure**: counts and weight quantiles of surviving A→B and B→A edges, before
   association and at the stop; births per epoch; predicted-pairing counts; fraction ≥ 1.02.
   Prediction: A→B median rises well above 0.4, B→A stays ≈ 0.4 or below.
6. **Readback with association**: nearest-ref-core decoder on A-alone, B-alone, C. A-alone
   should still decode as A (its own core fires fully; B is recruited in addition). Report the
   top-two Jaccards. This is an observation feeding Stage 3, not a gate.

Reported, not gated: contemporaneous cores and their Jaccard; neutral recruitment; compactness
of the union; within-core medians and ignition fractions (drift); churn table as in 1e.

## Controls (all seeds unless marked; all saved)

| control | change | required outcome |
|---|---|---|
| `unpaired-continuation` | same number of extra epochs, but alternating single-cue A, B trials exactly as in 1g | `fwd` ≤ baseline + 0.15 — rules out "more training merges them" |
| `hebbian-off-association` | plasticity disabled for the association phase only (via the engine's recorded feature-change path, or the per-cell `env.features` override pattern `src/fact-memory.cjs` already uses — document which) | `fwd` ≤ baseline + 0.15 — edges may form but cannot carry the link |
| `prune-cross` | after the stop, natively prune every surviving growth-formed edge with one end in refA and the other in refB; keep everything else | `fwd` falls below 0.3 from its pre-prune value; A/B self-completion unchanged (± 0.05) |
| `reverse-order` (seed 1, reported) | B leads A by Δ | `rev` ≥ 0.5 and `fwd` ≤ baseline + 0.15 — the link follows the order, i.e. STDP directionality |
| `growth-off-association` (seed 1, reported) | `nextGrowthAt = 1e12` on pool cells at the stop; only pre-existing edges can potentiate | tells whether association needs new cross-core edges or only potentiation of the handful (≈ 10) already present |
| `untrained` | probes on the 1g stopping circuit before any association epoch | baselines for 1, 2 |

## Exit logic

GO iff, for all three seeds: the stopping rule is reached by 40; `fwd` ≥ 0.5 at both delays;
`rev` ≤ baseline + 0.15; self-integrity passes; both containment gates pass; and
`unpaired-continuation`, `hebbian-off-association` and `prune-cross` each meet their required
outcome. Exit 1 on scientific NO-GO, 2 on execution error. Reported controls never gate.

## Diagnostic (seed 1, all controls, all cells saved)

Δ ∈ {6, 12, 24} ticks × J ∈ {5, 15}. Six cells. One table: cross-core A→B / B→A median weight
and count at the stop, stopping epoch, `fwd`, `rev`, C spillover (absolute and vs unpaired),
A/B self-completion. Δ = 24 (0.48 s) exceeds the 0.32 s STDP window on most pairs and should
weaken association — that is the prediction to check. The 12/5 cell is the primary.

## Outputs

`outputs/association/<timestamp>-stage2/` with the same layout as the 1g study: `plan.json`
written before simulation, per-case `summary.json` (deterministic), `trials.json`,
`memory.json` (stopping snapshot, locked, `neurosphere-association/v1`: refs, cues, cross-core
edge list, native artifact), `controls.json`, `checkpoints.json`, `timing.json`. Curves figure:
`fwd`, `rev`, A/B self-completion and C spillover vs association epoch, one panel per seed,
with the unpaired control dashed on the same axes.

## Tests (`tests/association.test.cjs`, add to `npm test`)

Harness, not hypothesis: (1) reproduced 1g stop is byte-identical to the evidence for one seed
at a reduced fixture; (2) schedule produces A-before-B on every trial for J = 5, Δ = 12;
(3) cross-core edge classification against refs; (4) prune-cross removes exactly the cross-core
formed edges and nothing else; (5) same seed twice → identical summary; (6) stopping rule reads
only the A→B probe (feed it a mutated C result and assert no effect); (7) `npm run verify`.

## What a pass would mean

Two self-formed assemblies in the unchanged engine become linked by sequential presentation:
cueing A alone recruits B through cross-core edges that growth built and STDP potentiated in the
direction of presentation, the link disappears when those edges are pruned, does not form
without pairing or without plasticity, and neither memory nor containment is lost. That is
"engrams that link and associate" in the project's own terms. It would **not** show spatial
dependence (cores are interleaved; see Stage 2b), multi-link chains, or readout.

## What a fail would mean, by pattern

- `fwd` never reaches 0.5 but A→B edges are few: terminal capacity — slots are not being freed.
  Lever: measure displacement events; variant with `maxSynapses` 10 at the 1g stop only.
- A→B edges plentiful but weights ≈ 0.4: lag outside the window — check the predicted-pairing
  table; adjust Δ (the diagnostic covers this).
- `fwd` ≥ 0.5 but unpaired continuation also ≥ 0.5: the pool is merging from training volume;
  Stage 1's containment window is the binding limit and Stage 2 needs sparser coding first.
- Everything passes except relative containment: association costs containment — report the
  trade-off curve; that is a real property of the architecture.

## Stage 2b (later): "nearby" as a real variable

Place A's and B's afferent targets in two sub-balls separated by `s` (e.g. 0, 60, 120 units).
Because growth reaches only `radius` 60, association should be possible only when the balls
overlap within that radius — the first place in this project where physical distance would be
predicted to matter, and a direct test of the "nearby engrams" phrasing of the goal.
