# Word-driven neuronal volume

Version 0.7 adds a shared-concept fact network with color, location and category
bindings, bidirectional recall and explicit corrections. See `FACT_LEARNING.md`
for the neural mechanism, host-supplied grammar/scaffold and retention controls.

Version 0.6 adds a separately selectable persistent text workspace. Its ordered
token encoding, supervised plasticity, response readout, checkpoint protocol and
limits are described in `TEXT_LEARNING.md`. The following sections describe the
original vocabulary pilot, which remains available unchanged as a memory type.

## Intended direction

Words and meanings arrive from a-concept-lab. A neuron volume develops retained
activation patterns associated with those records. Domain membership preserves
isolated associations; future processing should operate through those learned
patterns. Source metadata remains available to audit what was taught.

## Current vertical slice

1. The vocabulary adapter validates the complete A-section with its original
   engine. It preserves the authored domain/branch assignments and separate IDs
   for homographs. Some imported records contain unsplit senses; categories
   supplied by rules are not newly verified by NeuroSphere.
2. Enrollment selects concept IDs. All neurons occupy one spherical volume
   (radius 400, center 400/400/400) in an 800 × 800 × 800 SpikingField. A
   deterministic low-discrepancy sequence fills its interior out to radius 360.
   Every domain spans the common space; there are no separate spatial zones.
   Domain IDs remain logical memberships and synapses remain domain-local.
   Placement consumes no model RNG draws and does not encode semantic distance.
3. Each domain has 192 shared input cells. Normalized spelling deterministically
   activates eight cells using SHA-256 sampling. This can encode unseen strings
   without consulting the corpus, but does not represent meaning or similarity.
4. Each enrolled concept receives a three-cell assembly. All regional feature
   cells project weakly to its leading cell. The assembly's two internal relay
   connections are supplied as a scaffold. The initial feature weights cannot
   complete an assembly in the tested controls.
5. During teaching, the feature pattern fires and an external teacher forces the
   intended leading cell shortly afterward. Neuron's arrival-based Hebbian rule
   changes the feature-to-assembly weights. Labels select the teacher only;
   labels are not passed into a neuron's update rule.
6. Export locks a copied circuit. Recall starts a clean LockedController,
   supplies only the spelling code, and measures which assembly cells spike.
   Three active members identify a completed assembly. No dictionary matching,
   nearest-record lookup, or source-word comparison occurs during this decision.
7. Assembly IDs map to original concept IDs. Recovering a gloss is currently a
   separate reference-data operation, not a demonstrated neural reconstruction.

## Experimental choices

`src/domain-layout.cjs` owns placement and containment validation. New exports
carry a `neurosphere-shared-volume/v2` descriptor with `placement: interleaved`.
Legacy and v1 compartment memories migrate in memory, changing only coordinates,
region bounds and volume metadata. Neuron IDs/state, weights, delays, bindings
and I/O remain unchanged. Original saved files are not rewritten. Existing v2
layouts are validated and retained. Imports reject escaped cells, invalid bounds,
and cross-domain connections.

New circuits establish the existing calibrated scaffold first, then distribute
the actual field neurons before learning starts. Transmission delays retain the
scaffold's original calibration; they are not recalculated from new Euclidean
distance. Autonomous growth and spatial inhibition remain disabled in this pilot.
This preserves the timing of teaching signals and existing memories. It is a
logical neural circuit placed in shared space, not physical axon conduction.

`POST /api/sense` accepts one word cue, encodes it, and addresses every enrolled
domain's feature bank. It rejects domain overrides. One Output aggregates all
measured completed engrams and preserves unknown/ambiguous outcomes. The original
scoped `/api/recall` and headless API remain available for isolation experiments.
Scene `ports.sense` and `ports.output` expose the bus memberships and opposite
volume endpoints. These external buses are adapters, not new simulated neurons
or extra synapses. The output is measured activity, not dictionary matching.

The viewer projects actual model coordinates and only one outer shell. Inspect
filters domain visibility, neuron choices and charts; it never changes Sense
Input routing. Output stays visible when inspection changes. Both I/O controls
move with the expanded viewer, so there is only one sensory form. The cutaway
clips model Z only for rendering. Per-neuron membrane samples are read after
each controller tick during passive replay; synaptic travel markers use observed
emission times and stored delays. Neither observer changes the controller state.

The pilot keeps the original Neuron runtime bytes intact and uses explicit host
configuration: 20 ms ticks, radius 150, eight outgoing synapses per cell, weak
input weights 0.02, weight floor 0.001, decay 0.0001, unused decay 0, and cell
mortality 0. Leading assembly cells use a fixed threshold of 1.6 to require
more coincident learned features; relay members retain Neuron's default.
Autonomous growth is postponed to simulated time 10,000 s; the
training API caps the experiment below that time. It uses 24 epochs by default.
Domains are taught in parallel; words within a domain alternate in 2 s slots.
Consolidation K is available in the original core but is not the pilot's storage
mechanism. The exported memory uses the stronger explicit circuit lock.

At the current maximum, nine regions with 192 feature cells and eight three-cell
assemblies each contain 1,944 cells, below Neuron's 2,000-cell capacity. This is
a capacity bound, not demonstrated accurate recall at maximum enrollment.

## Controls and failure interpretation

- Untrained network: same assigned topology and labels, no teaching.
- Learning-disabled network: same cues and teacher schedule, Hebbian updates off.
- Weight ablation: learned input weights reset while all concept labels remain.
- Negative cues: strings not taught to the enrolled assemblies.
- Domain mismatch: a cue sent to another enrolled region.
- Persistence: JSON round trip, silent locked execution and repeated probes.

These controls distinguish a synaptic effect from label lookup. They do not
establish general intelligence, semantic knowledge, biological plausibility,
independent generalization, or permanent learning. Failed developmental runs
remain in `outputs/` alongside revised runs.

## Next layers

1. **Memory specificity and capacity:** freeze a larger balanced enrollment,
   negative set and decision rule before measuring errors. Measure collision
   rates, interference, homograph ambiguity and partial/noisy-cue behavior.
2. **Retention while learning:** test new words against old words without a
   whole-volume lock. Compare rehearsal, selective consolidation and a shadow
   candidate write gate. AIS and RGB supply design precedents, not drop-in
   implementations of this spiking model.
3. **Meaning-bearing engrams:** choose an explicit code for properties and
   relations, teach those codes through spikes, and require recovery without
   consulting dictionary glosses. Stable concept IDs alone are insufficient.
4. **Domain processing:** add measured within-domain relations and explicit
   cross-domain communication. Evaluate routing against an all-domain baseline;
   do not assume geometric grouping improves accuracy.
5. **Scaling:** compare sparse routing, multiple volumes and optional native
   Neuron execution only after correctness and retention criteria are fixed.
6. **UI:** expose actual neuron activity and evidence after the headless model
   is stable. No renderer is included now.
