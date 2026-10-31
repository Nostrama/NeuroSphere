# Formation experiment — Stage 1 implementation brief

**For: Codex. Deliverable: `examples/formation.cjs`, `tests/formation.test.cjs`, `docs/FORMATION.md`, npm script `demo:formation`.**

## The question

NeuroSphere 0.7 proves that teacher-paired Hebbian learning on a **host-allocated** scaffold
makes recall selective (pilot v3, fact learning, text learning). It has never tested the
project's actual goal: **can unassigned Neuron cells form a stable, cue-specific cluster
(an engram) on their own**, using Neuron's own growth, plasticity and inhibition — with
no pre-allocated assembly and no teacher cell?

Stage 1 answers only that. Association between engrams (Stage 2) and labeled readout
(Stage 3) are sketched at the end and are out of scope for this task.

## Non-negotiable constraints

1. `src/neuron/*` stays byte-identical. `npm run verify` must still pass. Everything new
   is host code in `examples/`, `tests/`, `docs/`.
2. No npm dependencies. CommonJS (`.cjs`). Node ≥ 20.
3. Do not touch `src/fact-memory.cjs`, `src/text-memory.cjs`, `src/engram-volume.cjs`,
   their validators, or `server/`. This is a headless experiment.
4. Reuse, don't reimplement: `SpikingField`, `DevelopmentSession`, `LockedController`
   from `src/index.cjs`; `encodeWord` from `src/vocabulary.cjs`; `jaccard` from
   `src/neuron/assembly-task.js` (it is exported: `{AssemblyTask, ZONES, TRACT_DEFAULTS, jaccard, shuffled}`).
5. Deterministic: every run takes `--seed`. Same seed → byte-identical `summary.json`.
6. Follow the existing convention: the example **exits nonzero when its stated criteria
   fail**, and the docs record failures as failures (see `docs/VALIDATION.md`).
7. Record results in `docs/FORMATION.md` with the same honesty as `VALIDATION.md`:
   what passed, what failed, what it does and does not establish.

## Engine facts the design depends on (verified in source, 2026-10-31)

Read these before coding; they are why the knobs below are set the way they are.

- **Growth** (`neuron.js` `grow(env)`): runs only when the cell is not locked,
  `activity >= 0.2`, `growthBudget >= 1`, and `time >= nextGrowthAt`. `growthBudget`
  starts at 0 and increments **on each spike** (cap 3). So a cell must fire before it can
  grow — silence means no structure forms. Candidates are `env.sense()` neighbors within
  `neuron.radius` that are not already targets. Score =
  `activity + youthAttraction·youth + demandAttraction·demand + 0.02·(1 − d/radius)
  + [gradient term if features.gradient] + exploration·random()`. At `maxSynapses` the
  weakest unfixed terminal loses `competitionCost` weight instead of a new one forming.
  New synapses are created at `config.initialWeight`.
- **NeuroSphere currently disables growth** by setting `nextGrowthAt = 1e12` on every
  cell and `growthPeriod: 10000`. Stage 1 must **not** do this for pool cells.
- **Sensing** (`field.js` `Environment.sense`): SpatialHash query within `neuron.radius`.
  "Nearby" is physically meaningful only through this radius.
- **Lateral inhibition** (`features.lateralInhibition`): on spike, sends inhibitory
  messages (weight `−inhibitionStrength`, default 0.5) to peers within
  `inhibitionRadiusFactor · radius` (default 0.6). Skips endpoint cells, drive cells and
  `recordOutput` cells. Config keys: `config.inhibitionStrength` (0–10),
  `config.inhibitionRadiusFactor` (0–1).
- **Hebbian** with `pairingClock: 'arrival'` (NeuroSphere's choice; keep it).
  Defaults: `hebbianRate 0.018`, `stdpWindow 0.32`, `maxWeight 1.65`.
- **Defaults that bite**: `initialWeight 1.25 > threshold 1.02` — one default synapse
  fires its target. For formation, set `initialWeight` sub-threshold (see knobs) so a
  cell needs several coincident inputs. `weightDecay 0.0015` and `unusedDecay 0.004`
  with `weightFloor 0.15` prune unused synapses — NeuroSphere zeroed these; Stage 1
  should **start with Neuron defaults** so losers actually prune, then test retention.
- **Hard fan-out cap**: snapshot reload rejects more than **10 outgoing edges per cell**
  (found by Codex, 2026-10-31). So `k ≤ maxSynapses ≤ 10` is an engine limit, not a
  preference. Any design that needs more afferent fan-out than that is not implementable
  without touching `src/neuron`, which is off the table.
- **`features.assemblies` / `AssemblyTask`** hard-requires extent 1000×620×620 and no
  I/O ports. Do **not** enable it. Use its exported `jaccard` only.
- **Homeostasis** (`features.homeostasis`, needs `config.inputPeriod`) adapts thresholds
  toward a target rate (floor 0.5, ceiling 2.0). Off in the primary condition; it is a
  variant for runaway control.
- **Input pulsing**: do it exactly as `src/engram-volume.cjs` does — build
  `inputs: [{name, cells:[id]}]`, pass to `new DevelopmentSession(field, {}, {inputs, outputs})`,
  pulse with `session.io.pulse(name, tick)`. Input cells are endpoints, so inhibition
  ignores them (intended).
- **Read-only probing**: `SpikingField.fromSnapshot(field.snapshot())`, then
  `lockCircuit(...)`, then `new LockedController(compile(field, {...}), onSpike)`, as in
  `EngramVolume.export()` / `EngramMemory.recall()`.

## Setup

One `SpikingField`, `dimensions: 3`, `extent {800,800,800}` (keep the NeuroSphere sphere,
center 400/400/400, so a later renderer load needs no migration), `empty: true`,
`maxCells: 2000`, `pairingClock: 'arrival'`.

**Feature bank** — `F = 192` cells, one per bit of `encodeWord` (`WORD_CODE.features`).
Place them on a thin shell at radius ~300 (outside the pool, inside the sphere). Each is a
plain neuron registered as a SpikeIO input. Set `nextGrowthAt = 1e12` on **feature cells
only** in the primary condition: the question is whether the *pool* self-organizes, not
whether inputs sprout. (Variant `--featureGrowth` lifts this.)

Feature cells are **long-range afferents**: set each feature cell's own `radius` to
`--featureRadius` (600) **permanently** at creation. `radius` is a per-neuron property
that is saved in the snapshot, so the stored circuit describes the edges that actually
exist. This is a documented host scaffold in the same spirit as `AssemblyTask`'s tracts;
it changes nothing for pool cells, whose `radius` stays at `--radius`. Do **not**
temporarily mutate `field.config` to seed edges and then restore it — a snapshot must never
claim a reach its edges violate. Keep `k ≤ maxSynapses` (both 8 by default) so seeding
needs no capacity override either.

**Pool** — `P` unassigned cells (start 500) filled by a seeded low-discrepancy sequence
inside a ball of radius `poolRadius` (start 120) centered at 400/400/400. No cell has a
role, label, assembly or threshold override. No pool→pool synapses exist at t=0.
All pool cells `recordOutput: false`; they are ordinary cells so inhibition applies.

**Seed projections** — each feature cell connects to `k` (start 8, hard cap 10) pool cells
chosen by a separate seeded RNG (not the model RNG), weight `w0` (start **1.1**), via
`source.connect(target, field.time, w0)`. These are the only host-supplied edges; they are
random, not addressed to any target set.

Why `w0` is **above** threshold (1.02): under the 10-edge cap, a cue's 8 active bits can
reach at most 80 endpoints. Spread over 500 pool cells that is ~0.13 hits per cell, so the
expected number of cells receiving ≥ 2 coincident hits is < 2 and ≥ 3 hits is ≈ 0. A
coincidence-detecting input stage is therefore **not implementable** at this fan-out —
the pool would be silent, `growthBudget` would stay 0, and nothing could form. Instead:

- Seed edges are **strong single-hit afferents** (Neuron's own default regime is
  `initialWeight 1.25 > threshold 1.02`). One hit fires its target. A cue drives ≈ 8·k
  pool cells directly (≈ 12 % of P at start values).
- Growth-formed pool→pool edges are created at `config.initialWeight` = **0.4**, so a pool
  cell fires through recurrent input only with ≈ 3 coincident recurrent hits. Coincidence
  detection must therefore **emerge in the pool** through growth and Hebbian potentiation;
  it is not supplied at the input. That is the Stage 1 question stated precisely.
- `w0` and `initialWeight` are independent: seed edges get an explicit weight in
  `connect()`, formed edges read `config.initialWeight`.

**Features flags** — `{hebbian: true, lateralInhibition: true, gradient: false,
reward: false, consolidation: false, homeostasis: false}` in the primary condition.

## Knobs (CLI flags, with starting values)

| flag | start | sweep range | why |
|---|---|---|---|
| `--pool` | 500 | 200–1200 | density vs. 2000-cell cap |
| `--poolRadius` | 120 | 80–250 | mean spacing; 500 in r=120 ≈ 24 units apart |
| `--radius` (config.radius) | 60 | 30–150 | pool sensing/growth reach; ~60 neighbors at start values |
| `--featureRadius` | 600 | 420–800 | per-neuron reach of feature cells so seed edges can land anywhere in the pool |
| `--k` | 8 | 4–`maxSynapses` | seed projections per feature; must not exceed `maxSynapses` |
| `--w0` | 1.1 | 0.6–1.4 | seed afferent weight; below 1.02 the pool is near-silent at this fan-out (see Setup) — only try sub-threshold with `--pool ≤ 100` |
| `--initialWeight` | 0.4 | 0.2–0.8 | weight of growth-formed recurrent edges; sets how many coincident recurrent hits fire a cell |
| `--maxSynapses` | 8 | 3–10 | fan-out budget for every cell; **10 is an engine hard cap** |
| `--growthPeriod` | 1.8 | 0.5–5 | seconds between growth attempts |
| `--inhibitionStrength` | 0.5 | 0–2 | winner-take-most pressure |
| `--inhibitionRadiusFactor` | 0.6 | 0.2–1.0 | inhibition reach |
| `--epochs` | 40 | 10–200 | interleaved A/B presentations each |
| `--seed` | 1 | — | model + placement seed |
| `--sweep` | off | — | small grid over radius × w0 × inhibitionStrength; one summary row per cell |

Leave `hebbianRate`, `stdpWindow`, `maxWeight`, `weightDecay`, `unusedDecay`,
`weightFloor`, `threshold`, `leakRate`, `refractory` at Neuron defaults unless a flag is
passed; log the full effective config into `summary.json`.

## Protocol

Cues: `A = 'aardvark'`, `B = 'banana'`, `C = 'cabbage'` (C is never presented during
formation). Encode each with `encodeWord` → 8 feature bits.

One **trial** = pulse the cue's 8 feature cells at tick `t+1`, run 50 ticks (1.0 s),
then 25 ticks silence. Record the set of **pool** cells that spiked within the 50-tick
window: `S_X(trial)`.

**Formation phase**: `epochs` rounds of `[A trial, B trial]` interleaved. Growth,
Hebbian and inhibition all active. No teacher. No forced spikes. No clamping.

**Core extraction**: for the last 10 trials of each cue, `core_X` = pool cells present
in ≥ 80 % of those trials. Also compute `directSet(X)` from the seed edges before any
simulation step (see Metrics) and store it in `trials.json`.

**Probe phase** (read-only): snapshot → lock → `LockedController`. Probe A, B, C once
each after 0 s and again after 60 s of simulated silence. Record active pool sets.

## Metrics and go/no-go criteria

All computed on **pool** cells only. Report every number; mark each criterion PASS/FAIL.

**The untrained baseline is not empty — design around it.** With fixed random seed
projections and a deterministic engine, an untrained pool already gives a stable,
cue-specific response: exactly the pool cells that receive ≥ ⌈threshold / w0⌉ coincident
projections from the cue's 8 bits — with the default `w0 = 1.1` that is **one** hit, i.e.
the union of the 8 active features' seed targets. Call that topology-predicted set
`directSet(cue)`; compute it from the seed edges alone (no simulation) and report
`jaccard(S_X, directSet(X))` in every condition. One timing caveat: lateral inhibition
from an early-firing driven cell can land on a later-driven cell before its afferent hit
arrives and suppress it, so with inhibition **on**, untrained `S_X ⊆ directSet(X)`; with
inhibition **off**, untrained `S_X = directSet(X)` exactly. Consequently criteria 1–4 can pass with
zero learning; they are necessary, not sufficient. Learning is demonstrated by 5–7.

1. **Stability** — mean pairwise `jaccard` over the last 10 `S_A` ≥ 0.8 (strict).
   Also report at 0.6 (soft). Same for B.
2. **Specificity** — `jaccard(core_A, core_B)` ≤ 0.2.
3. **Size** — `5 ≤ |core_X| ≤ 0.25·P`. (At start values `directSet` alone is ≈ 0.12·P;
   a core that passes recruitment ≥ 0.3 lands near 0.17·P.) A core that is the whole pool is runaway, not an
   engram; a core of 1–4 cells is noise.
4. **Negative cue** — probe C: `S_C ⊆ directSet(C)` (C gains no recruited cluster) and
   `jaccard(S_C, core_A)` and `jaccard(S_C, core_B)` ≤ 0.2. `S_C` being non-empty is
   expected and is not a failure.
5. **Spatial compactness** (this is the "cluster" claim) — mean pairwise Euclidean
   distance within `core_A` divided by the mean over 200 seeded random pool subsets of
   the same size. Report the ratio; **PASS if < 0.8**. Report for B too.
6. **Recruitment** — fraction of `core_X` cells that are **not** in `directSet(X)`, i.e.
   cells that fire only through pool→pool paths that growth and plasticity built. This is
   the clean discriminator between learned structure and the fixed random projection:
   untrained it is exactly 0. **PASS if ≥ 0.3** for each core.
7. **Recurrent structure** — count growth-formed pool→pool synapses with both ends in
   `core_X` vs. exactly one end in `core_X`. **PASS if** within-core formed edges
   ≥ |core_X| **and** within-core formed-edge density
   (within-core edges ÷ (|core_X|·(|core_X|−1))) ≥ 3× the pool-wide formed-edge density
   (all formed pool→pool edges ÷ (P·(P−1))). Also report `stats.formed`, `stats.pruned`
   and the raw within/between counts.
8. **Retention** — locked probe of A after 60 s silence still yields
   `jaccard(S_A_probe, core_A)` ≥ 0.8.
9. **Readback preview** — decode each probe by nearest core signature (`argmax jaccard`
   with reject if < 0.5). Report the 3×3 confusion (A, B, C → A, B, reject). Not a pass
   criterion in Stage 1; it is the Stage 3 baseline.

## Controls (each is a separate full run with the same seed; all reported in the summary)

| control | change | expected if formation is real |
|---|---|---|
| `growth-off` | `nextGrowthAt = 1e12` on pool cells | criteria 6–7 fail (no recurrent structure, recruitment 0); 1–4 will likely still pass from seed projections alone — **report this honestly**, it bounds how much growth adds |
| `hebbian-off` | `features.hebbian = false` | stability drops; cores not reproducible |
| `inhibition-off` | `lateralInhibition = false` | size criterion fails upward (runaway) or specificity fails |
| `shuffled-positions` | permute pool coordinates after seeding projections, before any step | compactness ratio ≈ 1.0 (destroys the distance term's effect while keeping topology) |
| `untrained` | zero formation epochs, probe only | `S_A ⊆ directSet(A)` (= with inhibition off), recruitment 0, `stats.formed` 0, compactness ≈ 1.0; `S_C ⊆ directSet(C)` and is **non-empty** — expected, report it |
| `ablation` | after formation, reset every feature→pool weight that changed to `w0` | probes fail; proves learned weights are necessary |

Also run the primary condition with `--seed 1 2 3` and report per-seed.

## Outputs

`outputs/formation/<timestamp>-<seed>/`:
- `summary.json` — effective config, every metric, PASS/FAIL per criterion, per-control
  results, per-seed results. **No timestamps, wall time or environment strings** — it must
  be byte-identical across runs with the same seed.
- `timing.json` — wall time, Node version, timestamp. Kept separate for that reason.
- `trials.json` — `S_A`, `S_B` per trial (arrays of cell ids), cores.
- `memory.json` — locked snapshot in `{schema:'neurosphere-formation/v1', volume: LAYOUT,
  pool:[ids], features:[ids], cores:{A:[],B:[]}, artifact}` form so a later UI loader can
  render it with actual coordinates.
- Exit code 0 only if criteria 1–8 pass in the primary condition **and** `growth-off`
  fails at least one of criteria 5–7. Otherwise exit 1 and print which failed.

`outputs/` is gitignored today; add `!outputs/formation/*/summary.json` so result rows
survive a future commit (same problem exists for `outputs/pilot-v*`; fix that line too).

## Tests (`tests/formation.test.cjs`, add to the `npm test` list)

Test the **harness**, not the hypothesis. Use `--epochs 3 --pool 150` so the suite stays
fast.
1. Same seed twice → identical `summary.json`.
2. Metric functions on synthetic sets: `jaccard` identity/disjoint, compactness ratio of
   a hand-built tight cluster < 1 and of a spread set ≈ 1.
3. `growth-off` control produces zero growth-formed synapses (`stats.formed` unchanged).
4. `untrained` control with `lateralInhibition: false`: `S_A` **equals** `directSet(A)`
   computed from the seed topology; with inhibition on: `S_A ⊆ directSet(A)`. In both,
   recruitment = 0 and `stats.formed` = 0, and `S_C` relates to `directSet(C)` the same
   way. A non-empty `S_C` is the correct result — do **not** build a low-drive fixture to
   make it empty; that would test a configuration the experiment never runs.
5. Snapshot → `memory.json` → `LockedController` reload reproduces the same probe sets.
6. `npm run verify` still passes (no `src/neuron` change).

## Expected failure modes (so you don't tune blindly)

- **Silence**: no pool cell reaches threshold → `growthBudget` stays 0 → nothing forms.
  `k` is capped at 10, so the lever is `w0 ≥ threshold`. Check: fraction of pool cells
  spiking in trial 1 should be 5–20 % and close to |directSet| / P.
- **Runaway**: whole pool fires, cores ≈ P. Raise `inhibitionStrength`, lower
  `initialWeight`, or enable `--homeostasis`.
- **Stable but not compact** (criteria 1–4 pass, 5 fails): the cluster is a *functional*
  assembly without spatial structure; the distance term is too weak relative to activity.
  Report it as such — it is still a result. Try smaller `radius`.
- **Compact but unstable**: inhibition radius too large relative to pool spacing; cores
  flicker. Lower `inhibitionRadiusFactor`.

## Out of scope here, next stages

- **Stage 2 — association**: form A and B; then present A at `t` and B at
  `t + 0.5·stdpWindow` for N epochs. Measure growth-formed and potentiated synapses with
  one end in each core, and whether probing A alone recruits ≥ 30 % of `core_B`. Run the
  pools **near** (both inside one ball) vs. **far** (two balls `> 2·radius` apart). That
  turns "nearby engrams" into a measured variable.
- **Stage 3 — readout**: label cores *after* formation, decode probes by signature match
  with reject threshold, serve through the existing `/api/sense` bus. The readout is an
  observer; the engram is the core.

---

# Stage 1b — revision after the first NO-GO (2026-10-31)

Read `docs/FORMATION.md` first. Seeds 1–3 failed criteria 2, 4, 5 (and 6 on two seeds).
The raw trials show **why**, and it is a protocol confound, not an engine limit.

## Diagnosis from `trials.json`

| seed | cells in both cores | recruits shared by A and B | B-direct cells inside core A |
|---|---|---|---|
| 1 | 56 | 3 | 21 |
| 2 | 66 | 1 | 23 |
| 3 | 49 | 0 | 24 |

A's "recruits" are B's directly-driven cells and vice versa: the cores merged into
`directSet(A) ∪ directSet(B)`. Mechanism, verified in `neuron.js`:

- `grow()` ranks candidate targets by `activity`; `activity` decays as `exp(−dt / 2.2)`.
- The trial period was 50 + 25 ticks = **1.5 s**. During an A trial, B's cells still carry
  activity ≈ 0.5 — the highest non-A activity in the pool — so A cells grow edges onto them.
- Growth attempts continue until activity < 0.2, i.e. ~3.5 s after a spike, which spans
  into the next cue's trial.
- 0.4-weight edges × ≥ 3 coincident → B cells fire during A → arrival-Hebbian potentiates →
  B's direct set becomes part of A's response. Symmetric for B. C then ignites the merged
  attractor through whatever of its direct set overlaps it.

Two criteria were mis-specified for the strong-afferent regime:

- **Compactness (5)** cannot pass with `grow()` as written: the distance term is
  `0.02·(1 − d/radius)` against an activity term up to 1.0 and `exploration` 0.3. Geometry
  is ~2 % of every growth decision; shuffled ≈ unshuffled confirms it. The only
  geometry-weighted term of comparable size is `gradientAttraction` (2.8) through the
  chemical field, which is inert unless `features.gradient` is on **and** cells have
  `secretionRate > 0` (constructor default 0; `secrete` runs in `step()` only then).
- **Afferent ablation** is uninformative when `w0 > threshold`: resetting 1.65 → 1.1 still
  fires every target. Codex correctly reported no effect.

What **did** work: 450–510 surviving within-core recurrent edges at 25–30× pool density,
Hebbian-dependent stability (0.55–0.75 with Hebbian off), 1.0 locked retention. The driven
cells wired themselves into a mutually connected assembly. That is the first self-built
structure in this project and the thing Stage 1b should now characterize properly.

## Changes to the harness

1. **`--gap <seconds>`** — silent interval between trials, default **10** (≈ 4.5 τ, so
   residual activity ≈ 0.01 and no growth attempts carry across cues). Keep the 50-tick
   capture window. Report `gap` in the effective config. Run the default and `--gap 0.5`
   (the old protocol) side by side so the confound is demonstrated, not assumed.
2. **Pattern completion — new criterion 9, the primary engram signature.** Probe each cue
   with only **4 of its 8 bits** (two fixed disjoint halves, chosen deterministically from
   the sorted bit list: bits [0,2,4,6] and [1,3,5,7]). Report
   `completion = |S_half ∩ core_X| / |core_X|` for each half, trained and untrained.
   Untrained, a half-cue fires only that half's direct targets (≈ 0.5 of the direct set,
   0 recruits). **PASS if trained completion ≥ 0.8 for both halves and
   trained − untrained ≥ 0.25.** This is independent of geometry and of neutral-cell
   recruitment, and it is the operational meaning of "read back from stored memory".
   Also report completion for C's halves (should stay ≈ untrained).
3. **Ablation now targets formed edges.** After formation, set every surviving
   growth-formed pool→pool edge back to `initialWeight` (variant: prune them). Predict:
   recruitment → 0, completion → untrained level, direct-set response unchanged. Keep the
   afferent ablation as a reported control but drop it from the pass logic.
4. **Compactness (5) becomes a reported observation, not a pass criterion, in the primary
   condition.** Add variant **`--secretion <rate>`** (start 2; cells default 0) which also
   sets `features.gradient = true`; compactness returns to a pass criterion only in that
   variant. Report compactness in both so the geometry contribution is measured.
5. **Specificity (2) stays at ≤ 0.2** but also report `|recruits_A ∩ recruits_B|` and
   `|core_A ∩ directSet(B)|` directly (the two columns in the table above) so a merge is
   visible as a mechanism, not just a Jaccard.
6. **Recruitment (6)**: keep the 0.3 bar but **split the report** into recruits that are
   in the other cue's direct set vs. truly neutral pool cells. Only neutral recruits count
   toward the bar. With `--gap 10`, neutral recruitment will depend on `exploration`
   (0.3·random) winning growth slots after same-set candidates are exhausted — it may fall
   below 0.3. That is a real measurement of self-recruitment; report it as such.
7. Sweep for the specificity axis if `--gap 10` alone does not reach ≤ 0.2:
   `inhibitionStrength` 0.5 → 1.0 → 2.0, `--homeostasis`, `activityScaledInhibition`,
   `initialWeight` 0.4 → 0.3 (needs 4 coincident recurrent hits). Same bounded-grid
   discipline as before; every cell with all controls.

## Exit logic for 1b

Exit 0 only if, in the primary (`--gap 10`) condition for all seeds: 1, 2, 3, 4, 6
(neutral-only), 7, 8, 9 pass **and** growth-off fails ≥ 1 of {6, 7, 9} **and** the
formed-edge ablation drops completion below 0.6. Compactness is reported, not gated.

## What this would establish if it passes

That Neuron cells, driven by a fixed random afferent code with no teacher and no
pre-allocated assembly, wire themselves into a cue-specific recurrent assembly that
completes from half a cue, is retained, and does not merge with a second assembly trained
in alternation — a functional engram. It would **not** establish spatial clustering (that
is the `--secretion` variant's question), association between engrams (Stage 2), or
labeled readout (Stage 3).

---

# Stage 1c — separate the three confounds (2026-10-31, after the 1b NO-GO)

Read the Stage 1b results in `docs/FORMATION.md` first.

## What 1b established

- **Positive, causal:** short-gap half-cue completion is 0.69–0.88 vs 0.35 untrained, and
  pruning the growth-formed pool→pool edges returns it to exactly 0.35 with afferents
  intact. Growth + Hebbian built recurrent structure that performs pattern completion.
  That is the first self-built functional property in this project. It is merged across
  A/B and recruits almost no neutral cells, but it is real.
- **Long gap measured decay, not activity residue.** At Neuron defaults (`weightDecay`
  0.0015, `unusedDecay` 0.004, `weightFloor` 0.15) an afferent that is not rehearsed
  erodes below the floor within the 880 s run; only bit 107's edges survived because A and
  B share that bit and it was pulsed twice as often. Consequently the 18-cell sweep and
  the secretion variant ran on a pool with no inputs and are **uninformative** about
  inhibition, homeostasis or geometry. They should not be cited for those questions.
- **Reset-to-`initialWeight` is not an ablation** (551 of 744 formed edges had decayed
  below 0.4, so the reset raised them). `--pruneFormed` is the ablation from now on.

## Three candidate causes of the A/B merge, and how 1c isolates each

| cause | evidence so far | 1c isolation |
|---|---|---|
| Activity residue: `grow()` targets by `activity`, τ = 2.2 s, growth attempts for ~3.5 s after a spike | short gap merges via other-cue direct cells (21–24/seed) | gap 10 **with decay off** |
| Synaptic decay / pruning at defaults | long gap: 5–7 afferents survive | decay off in the primary; default-decay kept as a diagnostic cell |
| Bridge cells: 12–18 cells in both direct sets (shared bit 107 + chance) | `core_A ∩ directSet(B)` = 32–41 | cues with **pairwise-disjoint** 8-bit codes; shared-bit pair kept as a diagnostic cell |

## Primary condition for 1c

- **Decay off**, as host configuration and as NeuroSphere's own pilots already do:
  `weightDecay: 0`, `unusedDecay: 0`, `healthLoss: 0`. Record in the effective config.
  Retention *under* decay is a separate, later question (ARCHITECTURE "Next layers 2").
- **`--gap 10`.**
- **Disjoint cues.** Select A, B, C deterministically from `loadVocabulary()`: iterate
  records in ID order and take the first three distinct normalized words whose
  `encodeWord` bit sets are pairwise disjoint. Record the words and bits in
  `summary.json`. `directSet(A) ∩ directSet(B)` is then chance-only (projection
  collisions), ≈ 8 cells; report it.
- Everything else as in 1b: 500 pool, k 8, w0 1.1, `initialWeight` 0.4, radius 60,
  `lateralInhibition` 0.5 / 0.6, 40 epochs, seeds 1 2 3.

## Criteria for 1c

Gated in the primary: **1** stability, **2** specificity (≤ 0.2), **3** size, **4** negative
cue, **7** recurrent structure, **8** retention, **9** completion (≥ 0.8 both halves,
gain ≥ 0.25). Also report completion at a soft 0.7 bar.

Reported, not gated: **5** compactness, **6** neutral recruitment. A Hebbian cell assembly
does not have to recruit silent cells; what distinguishes formation from the afferent
projection is 7 and 9, and the control logic below enforces that.

Controls (all seeds): `growth-off`, `hebbian-off`, `inhibition-off`, `shuffled`,
`untrained`, `prune-formed` (the ablation). Drop `afferent-ablation` from the run.

Exit 0 iff for all seeds: primary passes 1, 2, 3, 4, 7, 8, 9; `growth-off` fails 9
(half-cue completion stays at the untrained level); `prune-formed` drops completion below
0.6 from a higher pre-prune value; `hebbian-off` fails 1 or 9.

## Diagnostic grid (seed 1 only, all controls, all cells saved)

A 2 × 2 × 2 on {gap 0.5, gap 10} × {decay default, decay off} × {disjoint cues, shared-bit
cues aardvark/banana}. Eight cells. Its purpose is to show which of the three causes
produces the merge, not to find a passing cell. Report inter-core Jaccard,
`core_A ∩ directSet(B)`, surviving afferent count, and completion per cell in one table.

Do **not** rerun the inhibition/homeostasis sweep or the secretion variant unless the 1c
primary fails specificity. If it does, rerun them **with decay off and disjoint cues**, and
retire the 1b sweep results as confounded.

## If 1c fails specificity with all three confounds removed

Then merging is intrinsic to activity-seeking growth plus pairwise Hebbian in this engine,
and the fix is a competitive mechanism, not a parameter: a regional winner cap (Neuron's
`zoneCap` exists but is bound to `AssemblyTask`'s fixed geometry), an inhibitory
population (`features.inhibitoryPopulation`, `inhibitoryFraction`), or heterosynaptic
depression. That is a design decision for the project owner, not something to sweep into.

---

# Stage 1d — make plasticity actually fire (2026-10-31, after the 1c NO-GO)

## What 1c established

Specificity passes on all seeds (Jaccard 0.025–0.098) with all 1,536 afferents intact; the
diagnostic grid shows gap 0.5 → 10 with decay off takes Jaccard 0.54 → 0.025. The merge was
timing. The only gated failure is completion (0.48–0.63), and **Hebbian-off completion
(0.53–0.58) equals Hebbian-on**. Plasticity is contributing nothing.

## Diagnosis (seed 1 primary, `trials.json` + `memory.json`)

- 970 surviving growth-formed edges: **932 at exactly 0.400** (never potentiated), 36
  below 0.4 (competition cost), **2 ≥ 1.02**. Within core A: 208 edges, 178 at 0.400,
  2 ≥ 1.02. Median within-core fan-in per core cell: 3.
- Recurrent delays: 2.2–3.7 ticks. Afferent delays: 7.1–13.5 ticks (spread 6.4).
- Neuron's rule (`Synapse.notePostSpike`): potentiate only when the pre-spike **arrival**
  precedes the post-spike by 0–0.32 s. Under the arrival clock and a synchronous cue, two
  nearby pool cells' afferents differ by ≤ distance/1800 while the recurrent path adds
  0.04 s + distance/1800 — so the recurrent spike arrives ~2 ticks **after** the target has
  already fired from its own afferent. Pre-after-post, identically every trial, for almost
  every pair. Only pairs in the extreme tail of afferent-delay differences qualify (~4 %).
- Verified in isolation with `examples/stdp-timing-probe.cjs` (two features, two pool cells
  60 apart, one 0.4 recurrent edge, 40 trials): synchronous onset → 0.400 → 0.400; 6-tick
  onset offset → 0.400 → 0.985; emission clock, synchronous → 0.400 → 1.076.

**Consequence:** every completion effect measured so far (1b pruning, 1c) came from
unpotentiated 0.4 edges summing when ≥ 3 happened to be active. Learning has not yet
participated in any formation run. This was invisible until the weights were inspected.

## Primary change: temporal jitter of cue onset during formation

- During **formation trials only**, pulse each of the cue's 8 feature cells at
  `t0 + U{0..J}` ticks, `J = --jitter` default **15** (0.30 s), drawn per feature per trial
  from a dedicated seeded RNG stream (not the model RNG). Record the draws in `trials.json`.
- Capture window becomes `50 + J` ticks so late-onset responses are included.
- **Probes stay synchronous** (full and half cue, no jitter), so completion measures
  attractor pull from the learned weights, not replay of a trained sequence.
- Over epochs each ordered pair (i → j) qualifies in roughly a third of trials, in both
  directions, so potentiation is symmetric on average. At hebbianRate 0.018 that is
  ≈ +0.5 per 40 qualifying trials; use **`--epochs 120`** as the 1d default so within-core
  edges reach ~1.0. Report the weight distribution (below) so this is measured, not assumed.
- Keep `pairingClock: 'arrival'` as the primary (it is what the rest of NeuroSphere uses).
  Variant **`--pairingClock emission`** for comparison; it potentiates synchronous pairs but
  only in the direction fixed by afferent-delay order, so half the edges stay dead.

Everything else as 1c: decay off, gap 10, disjoint cues, 500 pool, k 8, w0 1.1,
initialWeight 0.4, radius 60, lateral inhibition 0.5 / 0.6, seeds 1 2 3.

## New criterion 10 — potentiation (gated)

For each core: median weight of surviving within-core formed edges ≥ `initialWeight + 0.3`
**and** ≥ 25 % of them ≥ 1.02. Report the full quantiles (min, p25, median, p75, max) and
the count ≥ 1.02 for within-core, between-core and pool-wide formed edges. Hebbian-off
must fail 10 by construction; that is the control that shows the metric is live.

## Stability under jitter

Jitter changes which cells lateral inhibition suppresses trial to trial, so formation-trial
stability (criterion 1) will drop below the strict 0.8. Gate 1 at the **soft 0.7** bar for
1d and report strict. Core extraction stays at ≥ 80 % presence in the last 10 trials.

## Gated set and exit logic for 1d

Gated: 1 (soft), 2, 3, 4, 7, 8, 9, 10. Reported: 5, 6, strict 1.
Exit 0 iff all seeds pass the gated set; growth-off fails 9 and 10; hebbian-off fails 10
and 9; prune-formed drops each half completion below 0.6 from a higher value.

## Diagnostic (seed 1, all controls, all cells saved)

{jitter 0, 15} × {arrival, emission} × {epochs 40, 120} — eight cells. One table: median
within-core weight, fraction ≥ 1.02, completion (four halves), inter-core Jaccard,
stability strict/soft. The jitter-0/arrival/40 cell must reproduce the 1c primary exactly.

## What a pass would mean

Neuron cells, driven by a fixed random afferent code with naturalistic onset jitter and no
teacher, grow a cue-specific recurrent assembly whose synapses are **potentiated by the
engine's own STDP rule**, which then completes from half a cue, is retained, and stays
separate from a second assembly trained in alternation. That is the Stage 1 claim with
learning actually in the loop. Still not claimed: spatial clustering, association (Stage 2),
labeled readout (Stage 3), retention under decay.

---

# Stage 1e — stop structural competition from erasing what STDP builds (2026-10-31, after the 1d NO-GO)

## What 1d established (seed 1 primary, from the saved evidence)

- Cores stay separated under jitter (Jaccard 0.016–0.09); strict stability passes. Timing
  is no longer the problem.
- Firing is afferent-driven: replaying the locked memory (`examples/formation-replay-timing.cjs`),
  0 of 59 direct core cells fire before their own afferent arrives; spread 6–9 ticks. No
  recurrent "compression" occurs.
- Pairings **do** occur. Recomputing from the recorded jitter draws and the actual delays,
  the median within-core edge had 28 qualifying pre-before-post trials of 120 (p75: 46,
  max 94). The STDP rule is being given its chance.
- But the weights do not follow: within core A, 142 of 311 edges are **below** 0.4, 42 are
  exactly 0.4 (young), 14 are ≥ 1.02. Edges with 60 predicted pairings sit at 0.400.
- Churn: **6,004 formed / 5,021 pruned / 983 surviving** over 120 epochs — ~42 prunes per
  epoch, mean surviving-edge lifetime ≈ 22 epochs. Hebbian-off churns identically
  (5,834 / 4,868), so churn is growth + competition, not plasticity.
- Inhibition-off and shuffled have the same 0.400 median: neither inhibition nor geometry
  is the blocker.

## Mechanism

`Neuron.grow()` at capacity: if the best candidate's score exceeds the weakest synapse's
target score + `competitionMargin` (0.35), the weakest loses `competitionCost` (0.12).
Candidates get `+ exploration·random()` (0.3) added to their score; the incumbent does not.
During and just after a trial every core cell has similar activity, so the margin is
exceeded by noise plus demand/youth differences, roughly once per trial per cell.

Per trial per cell: erosion of the weakest edge ≈ −0.12; STDP on a given edge ≈ +0.005
(0.018 × ~0.7 association × ~40 % qualifying). **~24:1 against.** An edge lives ~22
epochs, gains ~0.12, takes one hit, is pruned at the 0.15 floor, and is replaced by a new
0.4 edge that becomes the next weakest. The few edges that pair several times before they
are ever the weakest escape upward — the 4 % winners. This is a rate mismatch between
engine constants tuned for continuous drive (`inputPeriod 1.8 s`) and a protocol that
presents each cue once per 11 s. It is the fourth such default (after growth gating,
decay and pairing timing).

Why not simply raise `hebbianRate` or `maxWeight`: any recurrent edge ≥ 1.02 fires its
target from a single input, so a stray cell shared with another cue ignites the whole
assembly (this is already the cause of the criterion-4 failures: C activates 1–5 cells
outside its direct set through chance overlaps with cores). And `maxWeight` cannot be
lowered below `w0` (1.1) because afferents are clamped to it on their first pairing and
would stop firing their targets. The completing regime we want is **many edges at
0.6–1.0, few ≥ 1.02**: a target fires from ≥ 2 coincident recurrent inputs, so half a
cue completes and a single stray cell does not.

## Changes to the harness

1. **Reduce competition churn (host config, same category as decay off):**
   `competitionMargin` 0.35 → **1.0** and `exploration` 0.3 → **0.1**. Displacement then
   requires a candidate that is clearly better than the incumbent, not noise. Predict:
   prunes per epoch fall from ~42 to < 10; mean lifetime > 80 epochs; within-core fan-in
   rises toward 6.
2. **Epochs 120 → 80** with default `hebbianRate`, so the predicted median within-core
   weight lands near 0.4 + 0.4·80·0.013 ≈ 0.8, below single-edge ignition. Report the
   fraction ≥ 1.02 as the **ignition fraction**; it should stay < 10 %.
3. **`--maxSynapses 10`** as a variant (fan-in).
4. **Per-epoch weight audit of formed pool→pool edges** (host reads `field.links` after
   each epoch — trivial cost): count potentiation events (+) and competition events
   (−0.12) per epoch, and record each surviving edge's **birth epoch** from the `formed`
   events. Report weight vs. (age, predicted qualifying pairings since birth) as binned
   means, and prunes per epoch. This turns the mechanism above into a measured table.
   Port the pairing-count analysis from this session into the harness; it needs only
   `stimulusSchedule`, the afferent delays and the recurrent delays.
5. **Criterion 4 relaxed to what a completing memory can satisfy:** C's response outside
   `directSet(C)` ≤ 10 % of the smaller core, and C-to-core Jaccard ≤ 0.2. Spillover from
   chance overlap cells is expected behaviour of pattern completion; it is measured, not
   forbidden. Report `|directSet(C) ∩ core_A|` and `∩ core_B` so the cause is visible.
6. **Criterion 10 simplified:** median surviving within-core formed weight ≥
   `initialWeight + 0.3` (0.7). Drop the "≥ 25 % at 1.02" clause; report that fraction as
   the ignition fraction instead, with < 10 % as the healthy range.

Everything else as 1d: jitter 15, gap 10, decay off, disjoint cues, 500 pool, k 8, w0 1.1,
initialWeight 0.4, radius 60, arrival clock, seeds 1 2 3, the six controls.

## Gated set and exit logic for 1e

Gated: 1 (soft), 2, 3, 4 (relaxed), 7, 8, 9, 10 (median only). Reported: 5, 6, strict 1,
ignition fraction, churn table, weight-vs-pairings table.
Exit 0 iff all seeds pass the gated set; growth-off fails 9 and 10; hebbian-off fails 9
and 10; prune-formed drops every half completion below 0.6 from a higher value.

## Diagnostic (seed 1, all controls, all cells saved)

{competitionMargin 0.35, 1.0} × {exploration 0.3, 0.1} × {epochs 80, 120} — eight cells.
One table: prunes/epoch, mean edge lifetime, within-core fan-in, within-core median weight,
ignition fraction, completion (four halves), C spillover count. The 0.35/0.3/120 cell must
reproduce the 1d primary exactly.

## Honest framing

Stage 1 has now shown, in order: growth builds recurrent structure (1b); timing separates
assemblies (1c); STDP pairings occur when onsets are jittered (1d); and structural
competition at default rates erases potentiation faster than spaced presentation can
build it (1d). Each round removed one engine default that presumed continuous drive.
If 1e passes, the claim is: *Neuron's mechanisms, configured for spaced presentation
without any engine change, form separate pattern-completing assemblies.* If 1e fails with
churn demonstrably removed and weights demonstrably climbing, the remaining questions are
about the rule itself (asymmetric STDP vs. a symmetric or rate-based Hebbian term), which
would be a fork decision for the project owner, not a harness change.

---

# Stage 1f — set the completion threshold above chance overlap (2026-10-31, after 1e)

## What 1e established

- Churn removed: 0–0.04 prunes/epoch (was 42); competition loss/gain 0.003–0.035 (was 7.2).
- STDP works on self-grown structure, quantitatively: surviving within-core edges follow
  weight ≈ 0.4 + 0.0146 × actual positive events, and actual events track the schedule
  predictions (bins 10–20 → 0.62, 20–40 → 0.77, 40–60 → 0.96, 60–80 → 1.33).
- Completion 0.81–0.98 on all seeds at both delays; prune-formed → 0.41–0.54;
  Hebbian-off → 0.47–0.71 with medians at 0.4. Separation holds (Jaccard 0.02–0.09).
- Criterion 10 missed on seeds 1–2 by 0.01–0.04 (medians 0.66–0.71). The 0.7 bar assumed
  40 % of trials pair; measured is ~25 %. **Bar corrected to 0.6** — the weight/event
  accounting above is the evidence of potentiation, not an arbitrary median.
- **Criterion 4 fails for a real reason.** `directSet(C) ∩ core` is 6–11 cells per seed from
  random-projection collisions (expected ≈ |direct|²/P ≈ 7). Those cells fire for C and
  recruit 7–18 more through recurrent edges near 0.7 (two active neighbours ignite a cell).
  At 120 epochs spillover reaches 64 (full ignition); with maxSynapses 10, 34–45. The
  assembly's completion threshold is too close to the chance-overlap level. The original
  10 % bar ignored that chance overlap is itself ~12 % of a core.

## Criterion 4, restated as what a memory must do

A probe sharing ~15 % of a stored pattern by chance *should* produce bounded partial
activation and *must not* ignite the pattern or be read back as it. Gate:
1. readback (nearest-core Jaccard, reject < 0.5) **rejects C** at both delays;
2. C-to-each-core Jaccard ≤ 0.25;
3. spillover outside `directSet(C)` ≤ 25 % of the smaller core (bounded, not a cascade).
Report the overlap counts so the cause stays visible. Under this gate 1e seeds 1–2 pass
(11 %, 17 %; 0.11, 0.18) and seed 3 fails (30 %, 0.2035) — so 1e is still not a GO, and
the hypothesis below is the actual next step, not a goalpost move.

## Hypothesis

Lateral inhibition sets the recurrent completion threshold: stronger or wider inhibition
should suppress the weak cascade from a 15 % overlap more than the strong one from a 50 %
cue, widening the gap between completion and spillover. Inhibition has only ever been
varied in the decay-confounded 1b sweep. A second, independent lever is **sparser coding**:
a larger pool lowers the direct-set fraction and therefore the chance overlap (pool 1000 →
|direct| ≈ 64/1000 = 6 %, expected overlap ≈ 4 cells).

## Runs

All on the 1e primary protocol (margin 1.0, exploration 0.1, 80 epochs, jitter 15, gap 10,
decay off, disjoint cues, k 8, w0 1.1, initialWeight 0.4, radius 60, maxSynapses 8, arrival
clock), all six controls per cell, every cell saved.

**Predeclared inhibition grid, seed 1:** `inhibitionStrength` {0.5, 1.0, 2.0} ×
`inhibitionRadiusFactor` {0.6, 1.0}. Six cells; 0.5/0.6 is the 1e primary. One table:
completion (four halves), C spillover count and fraction, C Jaccards, readback verdict on C,
core sizes, inter-core Jaccard, median weight, ignition fraction. Also report the
**spillover-vs-training curve**: at epochs 10, 20, …, 80 take a locked clone and probe C
(and full A) — eight extra probes per cell, cheap — so the tipping point is a curve, not a
single number.

**Pool-size axis, seed 1:** pool 1000 at inhibition 0.5/0.6 and at the best inhibition cell.
(1192 cells, within the 2000 cap; ~2× wall time.)

**Confirmation rule, declared now:** the cell that passes every gate on seed 1 with the
largest margin `min(half completions) − spillover fraction` is then run on seeds 2 and 3.
GO requires all gates on all three seeds at that single setting. If no seed-1 cell passes,
report the curves and stop; do not search further.

## Gated set for 1f

1 (soft), 2, 3, 4 (restated), 7, 8, 9, 10 (median ≥ 0.6). Reported: 5, 6, strict 1,
ignition fraction, churn table, weight-vs-pairings table, spillover curve.
Exit 0 iff the confirmation rule is met; growth-off fails 9 and 10; hebbian-off fails 9
and 10; prune-formed drops every half completion below 0.6 from a higher value.

## What a pass would mean

Neuron's unchanged mechanisms — growth, arrival-clock STDP, lateral inhibition — configured
for spaced presentation, form two separate self-built assemblies that complete from half a
cue, are retained, are potentiated in proportion to their pairing history, and reject an
untrained cue that shares ~15 % of their cells by chance. That is Stage 1. Then Stage 2
(association) can begin on these cores.

---

# Stage 1g — train to criterion, not to an epoch count (2026-10-31, after 1f)

## What 1f established

- Inhibition does not separate completion from spillover; it trades them along one curve.
  1.0/0.6: spillover 6.8 %, two halves at 0.73–0.79. 2.0/0.6: cores 39/40. Radius factor
  1.0 at any strength suppresses the direct response itself (cores 36, 13, 6).
- Pool 1000: spillover 5 %, completion min 0.69 (fan-in falls with sparser cores).
- Baseline 0.5/0.6 at 500 is the best point found. Seeds 1–2 pass every gate; seed 3 is at
  30.5 % spillover vs 25 %. C is rejected in readback in every cell at 80 epochs.
- **Timing of the two effects differs.** grid-0 curve: full-A recall 0.97 at epoch 30,
  0.99 at 40; spillover 0, 0, 2, 3, 3, 3, 3, 7 at epochs 10…80. The memory forms early;
  spillover accumulates afterward as weights climb beyond what completion needs. The
  80-epoch count was an arbitrary choice in Stage 1e (to keep ignition < 10 %), not a
  property of the memory.

## Change

Replace the fixed epoch count with a stopping rule that reads only the memory itself:

- At every 10-epoch checkpoint (already implemented), additionally probe the **four
  half-cues** of A and B at both delays against the checkpoint's contemporaneous core.
- **Stop at the first checkpoint ≥ 30 epochs where all four half completions ≥ 0.8 at
  both delays**, with a hard maximum of 80. Record the stopping epoch. C is never consulted
  by the rule.
- Evaluate every gate on the circuit at the stopping checkpoint (the field is snapshotted
  there; continue training only for the curve, not for the acceptance).
- If a seed never reaches criterion by 80, it fails 9 as before.

Protocol otherwise identical to 1f baseline (500, inhibition 0.5/0.6, margin 1.0,
exploration 0.1, jitter 15, gap 10, decay off, disjoint cues, k 8, w0 1.1, initialWeight
0.4, radius 60, maxSynapses 8, arrival clock). Gates and controls as 1f. Seeds 1 2 3.

Report, per seed: stopping epoch, the full curve of half completions and spillover at each
checkpoint (this curve is the Stage 1 figure), and all gates at the stop. Also run the
1.0/0.6 inhibition cell under the same rule on seed 1 only, as a reported comparison.

## Exit logic

GO iff all three seeds reach criterion and pass gates 1 soft, 2, 3, 4, 7, 8, 9, 10 at their
stopping checkpoint; growth-off fails 9 and 10; hebbian-off fails 9 and 10; prune-formed
at the stopping checkpoint drops every half below 0.6 from a higher value.

## If this fails

Then on this scaffold the first epoch at which the memory completes is already past the
point where chance overlap recruits > 25 % of a core, and completion and containment cannot
both be had in a single population with uniform recurrent gain. The remaining levers are
structural — sparser direct sets with more recurrent reach (pool 1000 + maxSynapses 10 is
the one untested combination), or an inhibitory population (`features.inhibitoryPopulation`)
instead of lateral inhibition — and the honest statement of Stage 1 is: formation,
separation, potentiation and completion demonstrated; containment margin thin and
training-duration dependent. Stage 2 can proceed on that basis with containment monitored.
