# Persistent text-learning experiment

NeuroSphere 0.6 adds supervised question/response lessons to the existing Neuron
engine. Select **Text learning**, then **Teach a phrase**. Enter a question, the
expected response and a domain. After teaching completes, send the question
through **Sense Input**. **Output** displays the words decoded from firing output
neurons, with each token's neuron ID and spike time in its tooltip.

Try `What color is the lamp?` → `blue`, then add
`What color is the cup?` → `red`. Both lessons remain available. Selecting a
lesson fills Sense Input. **Lessons** lists taught questions and responses.
The original dictionary pilot and vocabulary runs remain in **Saved memories**.

## What is learned

- Text is normalized to lowercase NFKC tokens. Punctuation is ignored; word
  order and repeated words are retained. Questions and responses each support
  1–8 tokens and at most 200 characters. The workspace supports 16 lessons.
- A deterministic spelling encoder activates eight of 64 feature cells per
  token. This is a sparse spelling code, not a semantic embedding. Each lesson
  receives its own input bank to stay within Neuron's ten outgoing terminals
  per cell. All enrolled banks receive the same Sense Input token stream.
- Tokens arrive in 240 ms slots. The host enables a detector for the current
  position. Each successful detector sends a real spike to a completion cell.
  An explicit end token requires the taught sequence length to match.
- During 32 supervised rounds, teacher spikes strengthen the active
  feature-to-detector connections and completion-to-output connections using
  Neuron's arrival-based Hebbian rule. The teacher, positional gating, thresholds,
  allocated topology and output delays are explicitly supplied by NeuroSphere.
- During recall, no teacher spikes occur. A read-only cloned circuit is driven
  with the token stream. If its completion cell and ordered output cells fire,
  their token labels decode the response. The final output cell is an end marker.
  Incomplete responses are not presented as answers. Multiple completed lessons
  produce an explicit ambiguous result.

The question/answer strings are retained as teaching records for the lesson list
and retention checks. Recall does not compare the cue with stored question text
or retrieve the answer string. Tests change those records without changing the
response and independently weaken the input and output synapses; either synaptic
ablation prevents the learned answer. The output token codebook is supplied at
enrollment: this is learned phrase association, not learned spelling generation.

## Persistence and isolation

New lessons allocate new cells in the same continuous volume. Learning is enabled
only for the new lesson's detectors and outputs. Weight decay and mortality are
disabled. Earlier synaptic weights remain unchanged; recall never modifies the
committed model. Each completed training job replays every taught question in its
own domain and checks the decoded response before saving. A failed or cancelled
job leaves the previous workspace intact.

`outputs/ui/text-workspace.json` holds a full plastic Neuron snapshot, lesson
membership and token labels. It is restored on startup. Saves replace the file
atomically after validation and retain the previous file as
`text-workspace.json.previous`. Export downloads the same portable checkpoint.
Opening a text checkpoint archives the previous workspace as
`text-backup-<timestamp>-<id>.json` before replacement. These backup files can be
restored with **Open**. Invalid imports leave the current workspace untouched.

Domain membership is independent of coordinates. The adapter rejects
cross-domain projections and filters Neuron's local sensing candidates by
membership. The same filter now also wraps the vocabulary training volume.
Sense Input still addresses all enrolled domains; the UI inspection filter does
not change routing. Identical cues taught differently in two domains produce
multiple responses on the shared bus, rather than choosing one silently.

## Experimental limits

This milestone learns explicitly taught phrasing. It does not yet extract facts
from prose, understand paraphrases, infer intent, remember conversation context,
compose novel answers, or learn language without supervision. Sparse token codes
can collide; rejection of every possible untaught phrase is not guaranteed.
The retention check covers taught examples, not generalization or biological
plausibility. The maximum lesson count is a capacity bound, not a demonstrated
accuracy guarantee for every set of 16 lessons.

Autonomous growth, pruning, regeneration, inhibition and homeostasis are not
enabled in the text experiment. The imported Neuron core still contains those
mechanisms unchanged. Enabling them requires separate lesion/recovery and
retention experiments; fresh population generation is not evidence of repair.
Topology and delays are currently scaffolded, not self-organized by geometry.

Text lessons and the locked vocabulary pilot are distinct selectable memory
types. They are not yet a jointly learned language network. The next integration
step is to test shared lexical representations and domain routing without losing
earlier lessons, followed by paraphrase and held-out question evaluations.

## Entry points

- `src/text-memory.cjs`: ordered encoding, teacher protocol, plastic snapshots,
  and spike-based text decoding; exported as `TextMemory` from `src/index.cjs`.
- `src/domain-policy.cjs`: membership-based sensing restriction.
- `server/text-worker.cjs`: isolated training/recall and retention checks.
- `server/text-view.cjs`: actual neuron coordinates, labels, weights and bus ports.
- `POST /api/text/open`, `POST /api/text/teach`, `GET /api/text`: workspace and lessons.
- `POST /api/sense`: whole-volume text recall when the text workspace is open.
- Existing `/api/job`, `/api/train/cancel`, `/api/export`, `/api/import` and
  `/api/load` also support the text workflow. The scoped `/api/recall` HTTP
  endpoint remains vocabulary-only; `TextMemory.recall(text,{domainId})` supports
  scoped headless experiments.

```js
const { TextMemory } = require('../src/index.cjs');
const memory = new TextMemory();
memory.teach('What color is the lamp?', 'blue', '005');
const restored = new TextMemory(JSON.parse(JSON.stringify(memory.checkpoint())));
restored.teach('What color is the cup?', 'red', '005');
console.log(restored.recall('What color is the lamp?').response); // blue
```
