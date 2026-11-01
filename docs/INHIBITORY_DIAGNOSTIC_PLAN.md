# Inhibitory-population diagnostic — last in-engine lever for stability (2026-11-01)

**For: Codex. Deliverable: a `--inhibitoryPopulation` mode of the v2 formation harness, tests,
`docs/INHIBITORY_DIAGNOSTIC.md`.** Read `docs/FORMATION_V2.md` first. This is a **diagnostic**,
not a new stage: it tests one mechanism the engine already has and nothing in NeuroSphere has
ever exercised. It feeds a fork-or-not decision.

## Why

v1 (single-hit afferents, unbounded weights) failed by runaway: continued training produced
single edges that fire cells alone. v2 (two-hit afferents, `maxWeight = w0 = 0.7`) failed by
priming: ≈ 150 one-hit cells per cue sit one recurrent input below threshold and get recruited,
so cores balloon to 2.5× their direct sets and overlap at Jaccard 0.40–0.50. With a uniform
static threshold T, afferent weight w and recurrent cap m, the requirements 2w ≥ T, w + m < T,
2m ≥ T are jointly impossible — priming cannot be configured away. Both scaffolds lack
**input-scaled inhibition**: something that raises a cell's effective threshold where drive is
high. Lateral inhibition (post-spike, fixed) only trades completion for containment (1f).

`features.inhibitoryPopulation` is the engine's own candidate for this. Verified in source:
- Set at construction (or feature patch at time 0); forces `lateralInhibition = false`.
- A seeded fraction (`config.inhibitoryFraction`, default 0.2) of ordinary cells is marked
  inhibitory at `addNeuron`; endpoints, drive and `recordOutput` cells are excluded.
- Synapses from inhibitory cells deliver `−weight` (`Synapse.deliver`), flagged
  `synapticInhibition`. They form by the same growth rule and **potentiate by the same STDP
  rule** (magnitude), so I→E inhibition strengthens onto cells that fire after the I cell — a
  self-limiting loop: the more a cell fires after local inhibition, the more it is inhibited.
- Inhibitory cells receive seed afferents by chance like any pool cell → feedforward inhibition
  driven by the cue itself; E→I growth adds recurrent inhibition.

## Design

The **v2 primary** scaffold unchanged (g = 4 feature groups, `w0 = maxWeight = 0.7`,
`initialWeight` 0.4, `maxSynapses` 10, jitter 8, gap 10, decay off, margin 1.0 / exploration
0.1, arrival clock, disjoint cues, train-to-criterion then continue to 120), with:

- `features.inhibitoryPopulation = true` (lateral inhibition therefore off).
- Pool total sized so the **excitatory** count stays ≈ 500: `P = round(500 / (1 − f))`.
  Record the actual E/I split (the assignment is seeded, not exact).
- Cells: `inhibitoryFraction` **f ∈ {0.2, 0.3}**, seed 1. Also one cell `f = 0.2` with the
  Stage 1 **v1** scaffold (single-hit, unbounded) for comparison — if inhibition alone could
  have fixed v1, that matters for the fork decision.
- All v2 gates (1–4, 7–11) evaluated on **excitatory cells only**: direct sets, primed sets,
  cores, spillover, readback, completion, potentiation, drift. Inhibitory cells are reported
  separately and never count as core members or spillover.
- All v2 controls plus `inhibition-off` meaning `inhibitoryPopulation` off (the v2 primary) —
  i.e. the v2 result is this diagnostic's control.

## Inhibition-specific measurements

- Counts and weight quantiles of E→I, I→E, I→I surviving edges at each checkpoint; births per
  epoch by type.
- Per trial: number of I cells firing; mean inhibitory charge received per E cell; fraction of
  **primed** E cells (one hit) that received inhibition before their afferent arrival vs. that
  fired. This is the direct test of "input-scaled inhibition suppresses priming".
- Effective-threshold proxy: for each firing E cell, total excitatory minus inhibitory charge in
  the 10 ticks before its spike.
- Recruitment partition as in v2 (own-primed / other-primed / neutral).

## Confirmation rule (declared)

If a seed-1 cell passes every v2 gate including 11, run that exact setting on seeds 2 and 3;
GO requires all three. If no cell passes, stop and report. No other settings.

## Predictions, stated before running

- Cores shrink toward direct sets; inter-core Jaccard falls below 0.2; C spillover falls.
- Completion from 4 bits is at risk: feedforward inhibition suppresses the same marginal cells
  recurrence needs. If specificity passes but completion drops, report the basin curve — a
  separated memory with a smaller basin is a result, not a tuning prompt.
- I→E weights should grow fastest onto the most-recruited (primed) E cells.
- Early epochs look like v2 (I cells sparse and weak); divergence appears as E→I edges form.

## What the outcome decides

- **Passes all gates on three seeds:** stability is achievable in the unchanged engine; adopt
  this scaffold for Stage 2 (association) and Stage 3.
- **Specificity/containment pass, completion fails:** the engine has the right mechanism but the
  wrong balance; one more declared cell varying `inhibitoryFraction` is defensible, then fork.
- **No improvement over v2:** the fork is the path — add feedforward (input-proportional)
  inhibition or a per-neighbourhood k-winners rule to Neuron on a NeuroSphere branch, with the
  harness unchanged. Record that decision in both plan files.
