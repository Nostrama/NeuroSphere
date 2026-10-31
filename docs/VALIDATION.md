# Validation — 31 October 2026

Environment: Windows, Node.js 24.16.0. No packages installed or remote API calls
used for the tests or experiments.

## Code and extraction

- 66 automated tests passed; none failed, skipped or cancelled.
- 53 inherited Neuron assertions/tests cover spiking, local sensing, chemistry,
  exact historical behavior, populations, development, digital I/O, locking and
  checkpoints. Only their import paths changed.
- Four new package/example tests verify headless loading, a real three-cell
  relay, exact development continuation and scheduled locking.
- Nine vocabulary/engram tests cover corpus preservation, deterministic input
  coding, acquisition controls, teacher-free recall, domain routing, weight
  ablation, serialization, homographs and rejected malformed inputs.
- `npm run verify` matches all 24 copied files to their manifest hashes and
  checks the 15 runtime files for unresolved local imports, UI references and
  third-party dependencies. Original copied runtime bytes are unchanged.

## Developmental word-memory runs

All three pilots use the same 18 enrolled words (two per supplied domain),
24 epochs, 96 simulated training seconds, and eight untrained probe strings.
The initial code and experiment were revised using these results, so these are
development checks, **not an untouched evaluation set**.

**Pilot v1 — failed.** Eight active bits in 64 feature cells per domain; generic
leading-cell threshold. Exact unambiguous recall was 3/18 and 4/8 untrained probes
activated assemblies. The target assembly could be active while competing
assemblies also fired, so that does not count as exact recall. Untrained,
learning-disabled and ablated controls each scored 0/18.

**Pilot v2 — failed its negative-cue criterion.** Increasing feature space to
192 cells retained the same eight active bits. Exact recall improved to 18/18,
but one of eight untrained probes (`water`) activated an enrolled assembly.

**Pilot v3 — passes this development fixture.** The 192-feature code plus a
fixed leading-cell threshold of 1.6 produced:

- 18/18 exact, unambiguous recalls after teaching.
- 0/18 before teaching.
- 0/18 with Hebbian updates disabled.
- 0/18 after learned input weights were reset, with all labels unchanged.
- 0/8 false recalls on the specified untrained probes.
- 18/18 exact recalls after JSON serialization/restoration.
- The first taught word still recalled after 60 simulated seconds of silence
  in the locked circuit.

The volume contains 1,782 cells and 3,492 synapses across nine regions. The entire
reference corpus contains 1,826 concept records, but only 18 were trained in
this demonstration. The configured upper limit of 72 engrams has not been
validated for accurate recall.

Saved evidence is in `outputs/pilot-v1`, `outputs/pilot-v2` and `outputs/pilot-v3`.
Earlier source snapshots accompany v1/v2; v3 records current source hashes.
`outputs/pilot` retains the initial raw run. It is not the current model.

## What this establishes and what it does not

The controls support a causal contribution from learned synaptic weights to
exact-word assembly activation in this small scaffold. Dictionary labels alone
cannot reproduce recall after weight ablation. The inference artifact contains
concept IDs, neurons and weights, without the words or glosses themselves.

The study does not establish semantic understanding, storage of complete
definitions in neural activity, autonomous category learning, partial-cue
generalization, robustness to all unfamiliar inputs, or retention during
continued learning. Domain layout and assembly membership are assigned, and
retention after export is enforced by a whole-circuit lock. Those are explicit
engineering choices, not demonstrations of biological engrams.

Other repositories' tests, native acceleration and original scientific batches
were not rerun. Their recorded findings remain attributed to their own sources.
