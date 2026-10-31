'use strict';

const { SpikingField, DevelopmentSession } = require('..');

function runGrowth() {
  const field = new SpikingField({
    seed: 7,
    population: 16,
    config: { dimensions: 3 },
    features: { hebbian: true, gradient: true, reward: false, consolidation: true }
  });
  const session = new DevelopmentSession(field, { lock: { kind: 'time', seconds: 10 } });
  for (let tick = 0; tick < 500; tick++) session.step();
  const saved = JSON.parse(JSON.stringify(session.checkpoint()));
  const restored = DevelopmentSession.restore(saved, SpikingField);
  return {
    demonstration: 'Short seeded development run; no task-learning claim',
    seed: field.seed,
    seconds: field.time,
    cells: field.neurons.length,
    synapses: field.links.length,
    circuitLocked: Boolean(field.circuitLock),
    checkpointRestoredExactly: JSON.stringify(restored.checkpoint()) === JSON.stringify(saved)
  };
}

if (require.main === module) process.stdout.write(JSON.stringify(runGrowth(), null, 2) + '\n');
module.exports = { runGrowth };
