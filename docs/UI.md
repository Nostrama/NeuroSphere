# Local memory workspace

Requires Node.js 20+. No npm dependencies, external fonts, account, or network
services are used. Start with `Start NeuroSphere.cmd` or `npm start`. The service
binds only to `127.0.0.1:4319`. For another port: `node server.cjs --port 4320`.

## Workflow

For reusable facts, choose **Fact learning → Teach a fact**. Teach `The lamp is
blue.` and ask `What color is the lamp?` or `Which object is blue?` in Sense Input.
**Facts & links** offers test buttons, clickable shared concepts, engram inspection
and corrections. Color, location and category statements are supported. A changed
value replaces only the same object/property/domain binding, with a correction
history. See `FACT_LEARNING.md` for exact patterns and the 32-fact/eight-per-domain
limits. A saved fact workspace takes startup priority; phrase and vocabulary
memories remain available in Saved memories.

For persistent question/response learning, choose **Text learning → Teach a
phrase**. Enter a question, expected response and domain, then **Teach and save**.
Enter the question into **Sense Input** and press **Send**. Earlier lessons remain
in the same text network. The new workspace autosaves and opens on restart.
**Lessons** lists examples; **Saved memories** switches back to vocabulary runs.
This first experiment learns taught wording, with 16 lessons and 8 words per
question/response. See `TEXT_LEARNING.md` for the mechanism and limitations.

The original vocabulary workflow remains available:

1. The saved 18-word development pilot is opened on startup. Enter `aardvark` in
   **Sense Input** and press **Send**, then try `banana`. **Output** shows a
   completed engram for the taught word and no complete memory for the unknown cue.
2. **Edit words** searches all 1,826 vocabulary meanings. Choose at most eight
   per domain, 72 total. Changes affect the next training run, not the open memory.
3. **Train selected words** builds a fresh circuit. Rounds and random seed are
   available under Training settings. Progress and cancellation remain available
   because simulation runs in a worker. Cancellation preserves the open memory.
4. Completed circuits are checked against taught words and saved to
   `outputs/ui/run-<id>/memory.json`, with metadata in `summary.json`.
5. **Saved memories** reopens a run or the original pilot. **Download** exports the
   open snapshot; **Open memory** validates and saves a compatible JSON snapshot.

The service has one shared active memory across its browser tabs. On restart it
opens the saved text workspace if present, otherwise the original pilot; saved
vocabulary runs remain available in Saved memories.

## Volume and recall

The canvas projects actual neuron coordinates inside one continuous spherical
volume. Each domain's neurons are spread throughout the same space. Domains are
logical memberships, with isolated learning, feature cells, assemblies and
synapses. **Sense Input** sends one encoded cue to every enrolled domain, and
**Output** reports all completed engrams, unknown cues or ambiguous responses.
These two bus endpoints are external adapters, not additional simulated neurons.

**Expand neural view (⛶)** opens one nearly full-window volume inspector; Escape
or **Exit** returns it to the console. Drag rotation is inverted by default;
**Invert drag** can switch it back. Scroll or use +/− to zoom up to 24×, Shift-drag
or right-drag to pan, and use reset to restore the camera. Keyboard controls are
arrows to rotate, Shift+arrows to pan, +/− to zoom, and 0 to reset.

Select an **Inspect** domain to highlight its neurons and filter the matrix and
telemetry. Other domains remain dimly visible. This never changes sensory routing
or removes the current Output response. **Cutaway** clips the volume along world Z to
expose the interior; it changes only the display. **Volume shell** toggles the
single outer outline. Connections can show strong weights (>0.1),
all synapses, or only the selected neuron's synapses.

Click a neuron or use the Neuron selector to inspect its base threshold, leak,
position, input/output counts, and strongest synapses with weights and delays.
Click a listed synapse to inspect the connected neuron. **Zoom to neuron** moves
the camera to it. Selecting an engram cell also fills in its word cue.

Send a cue through the single Sense Input line beneath the volume. Play/pause and the timeline
scrubber inspect the recorded trial at ⅛, ¼, or real-time speed. Text trials last
longer than the vocabulary pilot's one-second recording. The membrane
plot shows actual fixed-step samples, a dashed base threshold, and amber spike
times. White flashes show recent spikes; outlined cells have already fired in
that replay. Moving synapse markers use measured spike emission and stored
connection delays. This is an orthographic 3D projection, not a biological image.

Activity is a slowed replay of measured spikes, not a live training animation.
Reduced-motion preferences start on a still frame; Play remains available. Output reports complete, partial, or ambiguous assembly activity. Definitions
are explicitly labeled dictionary reference; the neurons do not generate them.
The training check measures exact recall on taught meanings, not generalization.
Current model limitations in the root README still apply.

## Neural console

The dark panel layout groups the neural volume, synaptic matrix, terminal,
learning controls, neuron inspector and three measured telemetry plots.
**Overview** frames all neurons and the two bus leads. **Cell view**
zooms to the selected neuron, or the first available engram cell. The console
starts with the whole volume visible. Cyan cells are inputs; amber cells belong to word engrams.

`public/upstream/neuron-volume.js` is copied byte for byte from Neuron.
`public/morphology.js` uses its deterministic 3D `neuronShape()` branches and
adapts Neuron's original `drawNeuron()` soma outline, shading and nucleus.
These illustrative shapes do not add synapses or change the simulation.
Exact source paths, commit and hashes are recorded in `docs/UI_SOURCE.json`.

The matrix shows actual edges within the selected domain: source neurons on
rows, targets on columns. Up to 128 bins per axis retain the greatest absolute
weight per bin. Empty bins remain empty; hover shows the signed weight and
connection count, and clicking a populated bin selects its target neuron.

Telemetry shows measured spike times, the selected neuron's sampled membrane
potential, and the scoped population mean including cells at rest. Potentials
use model units, not physical millivolts. Scrubbing the recorded
recall moves the cursors. Without a recording the panels show a placeholder.
The terminal records memory loads, observed training progress, recall outcomes
and spike times; it retains the latest 240 rows. Clear and Follow control the log.
No temperature, bandwidth or hardware signals are fabricated.

## Operations

`npm start` runs in the terminal; Ctrl+C stops it. The Windows launcher starts
Node hidden and reuses the service if it is already running. Logs and its PID
are written under `outputs/ui/`. Double-click **Stop NeuroSphere.cmd** to stop a
launcher-started server; it verifies the process belongs to this project before
stopping it. Saved runs are retained. Closing a browser tab alone does
not stop the server. Avoid stopping the server during training if you want that
run saved.

The HTTP service accepts only localhost Host/Origin values, serves an explicit
static-file allowlist, and accepts JSON requests up to 8 MB. This is a local
single-user tool, not a remotely deployable authenticated service. Import/export
accepts the existing locked controller format with the same vocabulary hash, or
a validated full plastic text checkpoint. Importing a text checkpoint archives
the previous text workspace before replacement.

## Validation

`npm test` includes HTTP-level tests for real recall and spike replay, worker
training and restore, cancellation, invalid imports, limits, and origin checks,
along with the existing engine and memory tests. `npm run verify` checks the
unchanged imported source hashes. Browser interaction checks cover the visible
workflow separately from those backend tests.

The 82-test vocabulary baseline covers legacy and v1 snapshot
recall/spike-time equivalence, interleaved containment, domain learning independence,
whole-volume sensory I/O, and recorded
membrane sample parity with the controller. All 24 copied-core/test hashes and the copied visual-source hash matched.
The earlier UI workflow checks remain covered by the HTTP suite. Browser checks
also cover the large viewer, domain focus, neuron inspection, timeline and
cutaway controls, the console telemetry, domain switching, responsive layout,
Sense Input with a different inspection domain, unknown output, and the same
single I/O form inside the expanded viewer.

Version 0.6 validation on 2026-10-31: all 96 tests passed. Fourteen new text tests
cover teacher necessity, measured output decoding, synaptic ablation, metadata
independence, word order, repeats, eight-word limits, domain isolation, checkpoint
validation, incremental retention, cancellation, restart and archived import.
Browser checks cover two taught phrases, unknown/reordered input, the shared bus
under a different inspection filter, expanded I/O and a 390-pixel teaching form.
