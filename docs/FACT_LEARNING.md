# Shared concepts and fact engrams

Version 0.7 adds **Fact learning** beside the existing Text learning experiment.
It retains reusable color, location and category relationships in a continuous
Neuron volume. A small, explicit grammar turns statements and questions into
concept cues. No external model, service or package is required.

## Teach and test

Choose **Fact learning → Teach a fact**, enter one statement and select its
domain. The default is Objects & places. Example statements and questions:

- `The lamp is blue.` → `What color is the lamp?` / `Which object is blue?`
- `The cup is on the table.` → `Where is the cup?` / `Which object is on the table?`
- `The robin is a bird.` → `What is the robin?` / `Which object is a bird?`

Use the single **Sense Input** for questions. **Facts & links** offers **Ask
value**, **Find objects**, **Inspect engram**, and **Correct** for each fact.
Clicking a concept label selects its shared cue neuron; its tooltip identifies
the cue and readout cells. Inspect engram selects the forward relationship cell
and its actual stored synapses. The volume, weight matrix, spike raster and
membrane plots use model data. Replay is a recording of recall, not training.

Teach the same object/property in the same domain with a different value to
correct it: `The lamp is red.` replaces its blue color. A location or category
for the lamp is independent and remains intact. Duplicate facts reject without
changing the workspace. Correction history shows the latest 64 replacements.
Reverse questions may legitimately return several objects; conflicting forward
answers in different domains are reported explicitly rather than silently chosen.

## Controlled language boundary

The supported color names are red, orange, yellow, green, blue, purple, pink,
brown, black, white and gray/grey, optionally prefixed by light or dark.
Locations use **in, on, under, near** followed by a place. Categories use **a/an**
followed by a category name. Object/place/category names support up to three
space-separated words; the leading article is normalized away. Statements and
questions have a 200-character limit. Case, repeated spaces and trailing
sentence punctuation are normalized. One fact per statement is required.

Questions support the forms above, `Which objects are ...?`, and
`What kind/type of object/thing/animal is ...?`. Unsupported questions receive
pattern guidance. Supported questions with no measured answer return an unknown
result. Negation, multiple clauses, pronouns, causal questions, free paraphrases,
conversation context and inference across relationships are not implemented.
Synonyms and concept identities are supplied by normalization, not discovered.

## Neural mechanism and supplied structure

Each domain shares one four-cell assembly per normalized concept: a cue cell,
forward relay, reverse relay and readout cell. Relation concepts such as color
use their own namespace. Two fixed cue-to-relay projections distribute a cue;
these are host scaffolding. Domains reuse their own concept cells across facts,
but do not share cells or synapses with other domains.

Each fact has two relationship cells. The forward cell receives the subject and
relation relays and projects to the value readout. The reverse cell receives the
value and relation relays and projects to the subject readout. These six edges
start at weight 0.02. Thirty-two supervised rounds strengthen them through the
unchanged Neuron arrival-based Hebbian rule. Thresholds require both cues; an
untrained binding and a single matching cue cannot answer the tested controls.

The host supplies the topology, identity codebook, cue mapping, direction gate,
thresholds, fixed delays and teaching schedule. It forces the expected cells
during teaching. Only the new/corrected binding's gates and relevant readout
cells can learn, and teaching episodes clear prior spike-pair traces. Existing
weights remain unchanged. This is deliberately scaffolded association learning,
not autonomous language acquisition or self-organized relationship discovery.

During recall, the grammar identifies the cue concept, relation and direction.
It does not search fact records for an answer. A locked clone runs for 1.28
simulated seconds. Responses are labels of readout neurons that actually fired
through firing relationship cells; reverse results receive the simple article
`the` and multiple answers are joined with commas. A multiword concept is one
readout label, not a separately generated word sequence. Tests weaken learned
gate inputs, output projections and a shared cue relay independently; each
ablation prevents the affected answer.

Corrections explicitly retire the six projections of that binding, reuse its
relationship cells, and teach the replacement connections. Shared concept cells
remain available. This is a host-directed correction procedure, not a claim of
biological unlearning. Autonomous growth, pruning, repair, mortality, inhibition
and homeostasis remain disabled. The original Neuron source stays byte-identical.

## Retention, persistence and limits

Enrollment and training operate on a copy, including in the headless API. Before
the server commits a job, it checks every current fact in both directions within
its domain, including all objects expected in a reverse result. A failed or
cancelled job leaves the committed workspace intact. Recall never teaches.

The current bound is **32 facts total, eight per domain, 128 shared concept
assemblies including concepts retained after corrections**. Relay fan-out stays
within Neuron's ten outgoing terminals per cell. Eight facts sharing one value
are covered by a retention test; the global bound is a capacity limit, not an
accuracy guarantee for every possible dataset.

Full plastic state, concept identities, bindings and correction history save to
`outputs/ui/fact-workspace.json`. Saves use a temporary file and atomic rename;
the previous version remains in `fact-workspace.json.previous`. **Export** and
**Open** support portable validated checkpoints. Importing a fact checkpoint
archives the previous workspace as `fact-backup-<timestamp>-<id>.json`, which
can itself be opened to restore it. Invalid imports leave the active memory intact.

On startup the saved fact workspace opens if present, followed by the saved text
workspace or vocabulary pilot if no facts have been saved. The three experiments
remain separate memory types in **Saved memories**. Phrase lessons are preserved;
they are not automatically converted into facts, and their neurons are not yet
merged into the fact network. The dictionary corpus is also unchanged.

## Entry points and validation

- `src/fact-language.cjs`: bounded grammar and query examples.
- `src/fact-memory.cjs`: shared concepts, teaching, corrections and neural readout.
- `server/fact-worker.cjs`: worker execution and bidirectional retention gate.
- `server/fact-view.cjs`: actual neuron/edge scene and inspectable concept identities.
- `POST /api/facts/open`, `POST /api/facts/teach` with `{statement,domainId}`,
  `GET /api/facts`, and the existing `/api/sense`, `/api/job`, cancellation,
  export/import and saved-memory endpoints.

```js
const { FactMemory } = require('../src/index.cjs');
const memory = new FactMemory();
memory.teach('The lamp is blue.', '007');
memory.teach('The cup is blue.', '007');
console.log(memory.recall('Which objects are blue?').response); // the lamp, the cup
memory.teach('The lamp is red.', '007');
console.log(memory.recall('Which object is blue?').response); // the cup
```

The 109-test combined suite passed on 2026-10-31. New controls cover all three
relations, shared readouts, teacher necessity, synaptic ablation, unknown and
unsupported questions, corrections, prior-weight retention, eight-way fan-out,
domain conflicts, read-only recall, malformed checkpoints, cancellation,
restart/import and coexistence with saved phrase and vocabulary memories.
