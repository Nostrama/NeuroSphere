# Reuse scan — 31 October 2026

The scan inventoried **70 pre-existing folders** under Desktop/Projects and all
**17 repositories** visible through the connected Nostrama GitHub account.
The local count includes the old project catalog and the credentials folder.
NeuroSphere itself is excluded. `SCAN_COVERAGE.json` records every entry, current
file counts, documents inspected and the reuse decision.

Scope: filename/manifests/README triage across all entries, followed by source
inspection of the relevant processing candidates. This is not an exhaustive
code audit or fresh validation of every other project's historical claims.
The September catalog supplied context for older document-only projects; current
file inventories were collected separately. Credentials, environment secrets,
dependency folders, personal logs and runtime datasets were not imported.

## Copied now

**Neuron** (`21e548692d4c8b062ee2330ecbcbf8f3c7b7c45c`): neuron and synapse rules,
field scheduling, chemical diffusion, spatial indexing, population setup,
logic/assembly apparatus needed by the field, spike I/O, development plans,
locked controller and presets. All 11 runtime modules are byte-identical.
Four regression-test files retain their assertions with import paths relocated.
Seven historical source files serve as their comparison oracles. Renderers,
HTTP servers, scientific batch runners, native builds and large result archives
are excluded from this initial package.

**a-concept-lab** (`0b59bc069b0a1d41921cd3ac3455ff503973503c`): the complete
`brain.json` vocabulary and `engine.js` for existing validation/normalization.
The original symbolic decoder remains in that unchanged source file but is not
used by engram recall. The new sparse encoder, domain-volume apparatus and
control experiments are NeuroSphere code. Definitions remain source records;
only the tested word-to-assembly associations are learned here.

## Strong candidates for later stages

**neuromind-concept:** stable IDs, separate meanings, relation types, provenance,
schema validation and state identity hashing in `engine.js`, `dictionary.cjs`,
`registry.json` and the migration scripts. It is a newer symbolic representation
of the same dictionary line. Use it for a deliberate schema migration, not as a
second uncoordinated vocabulary or evidence of learned neuron memory. The user
selected a-concept-lab as the current vocabulary source.

**AIS / Seed:** `seed/writegate.py`, `seed/lock.py`, `seed/library_gate.py` and
`seed/relations.py` offer shadow-copy admission, preservation checks and explicit
relations. The implementation is Python/NumPy and shared-weight recognition,
not Neuron's local spike dynamics. Reuse the control contract when testing new
engram admission; direct insertion would require an adapter or a tested port.

**Dynamic Neuron Architecture:** `spatial-memory.js`, `numbers-engine.js`,
`domain-engine.js` and the experiment protocols offer spatial metadata and
retrieval comparisons. The current source README explicitly rejects repair
promotion and reports failures of retrieval filtering on its fixtures. Its
number/prototype representations do not substitute for spiking engrams. Treat
those negative findings as constraints when proposing domain filtering.

**Husk Lab (GitHub):** `public/knowledge.js`, `public/intent-learning.js`,
`public/intent-model.js`, `public/injection-router.js` and the routing evaluation
code offer validation, explicit train/test separation and inspectable routing.
These are lexical/classifier components in ESM. They are candidates for input
and evaluation adapters, not memory stored in the neuronal volume. Its research
protocols have their own source instructions and must be read before modification.

**ModelLab:** `public/core/engine.js`, `public/core/study.js` and
`public/core/report-validation.js` offer deterministic comparisons, replay,
held-out splits and report validation. Prefer those evaluation patterns before
adding new learned mechanisms. Provider-based authoring and its credentials are
outside this foundation.

**RGB Concept / Real Sensor Lab:** checkpoint copying, rollback, explicit
observation-before-label ordering and failure controls are useful precedents.
`rgb-concept/FINDINGS.md` records failed geometry/trust/mixture directions and
conditional successes on distinct synthetic regimes. Real Sensor Lab reports
no benefit for its primary time-routing comparison. Do not carry those mechanisms
over as already established improvements for NeuroSphere. RGB contains copies
of the standalone sensor and volumetric projects, so avoid importing both copies.

**Volumetric Branching:** `learning-engine.source.js`, saved-state schemas and
`verification/v2-engines.js` offer portable route-memory and training protocols.
The learning source depends on several globals from its symbolic solver. Extract
and test those dependencies only if a future explicit routing task needs them.

**Neuron native development:** the C++ library already implements much of the
spiking dynamics, but it uses Node-API bindings, compiler tooling and source-pinned
compatibility gates. The source documentation reports mixed workload performance.
Keep it as an optional later backend rather than add an unverified binary now.

## Lower-priority or incompatible candidates

**Concept Model / Path Allocation Volume:** `core.js` requires Three.js and
models geometric route search rather than this neuron's learning rule.
**Sphere Model, dot-cube and nn-designer-v2:** substantial logic is embedded in
HTML. They require a separate extraction effort; their search/program/MLP models
are not drop-in spiking modules. No UI bundle was copied.

**AIMTS / Sandbox:** graph contracts and manifests are useful when NeuroSphere
needs configurable pipelines. AIMTS's inspected contract engine reads browser
globals and targets training-graph compilation. That architecture is premature
for the initial headless memory experiment.

**System Combiner:** its Python SQLite queue and worker protocol may help future
multi-process experiments; its current workloads are not neural execution.
**Systemscape / NovixSuite:** queueing, seed/replay and experiment workers are
potential infrastructure references, but their workshop/business simulation
engines are unrelated to neuron dynamics.

**Byte Encryption / Cube Encoder / Color encoding / Noise Stack / VSA Test:**
storage codecs, inverse transforms and symbolic/vector research do not directly
implement the requested memory. Preserve their task-specific limitations.
**DSRA, Chimera, AI reference folders and Storage Capacity:** useful conceptual
documents, without a directly reusable implementation of this spiking core.

The remaining application, business, game, hardware-interface, visualization,
provider-orchestration and empty folders have no immediate processing dependency
needed here. Each is recorded individually in the coverage JSON. Microsolve and
Othezen's GitHub repositories are README-only; SPA and IT Command Center provide
API/command application infrastructure, not the neuron foundation.
