'use strict';

const { SpikingField, compileController, LockedController, inspectController } = require('..');

function runRelay() {
  const field = new SpikingField({ empty: true, config: { dimensions: 3 } });
  const input = field.addNeuron({ x: 80, y: 310, z: 310, drivePeriod: 1.8 });
  const relay = field.addNeuron({ x: 240, y: 310, z: 310 });
  const output = field.addNeuron({ x: 400, y: 310, z: 310, recordOutput: true });
  input.connect(relay, 0, 1.5);
  relay.connect(output, 0, 1.5);
  field.endpointPlacement = field.assessEndpointPlacement();
  field.metrics = [];
  field.logMetrics();
  field.lockCircuit('Hand-wired relay demonstration');

  const artifact = compileController(field, {
    name: 'NeuroSphere relay',
    io: { inputs: [{ name: 'signal', cells: [input.id] }], outputs: [{ name: 'response', cells: [output.id], mode: 'count' }] }
  });
  const spikes = [];
  const runtime = new LockedController(artifact, spike => spikes.push({ cell: spike.neuronId, time: spike.time }));
  runtime.io.pulse('signal', 1);
  runtime.advance(1);
  return { demonstration: 'Hand-wired three-cell relay; not a learned circuit', outputs: runtime.io.decode(), spikes, structure: inspectController(artifact) };
}

if (require.main === module) process.stdout.write(JSON.stringify(runRelay(), null, 2) + '\n');
module.exports = { runRelay };
