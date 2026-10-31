/* Initial placement controls. Neuron dynamics and research defaults stay in the engine. */
(function (root) {
  "use strict";
  const { SpikingField, distance } = typeof module !== "undefined" && module.exports ? require("./simulation.js") : root.NeuronSimulation;
  const defaults = Object.freeze({ population: 95, minimumSpacing: 48, radius: 195, dimensions: 3, x: 1000, y: 620, z: 620 });
  const limits = Object.freeze({ population: 1000, gridSites: 500000 });
  function validate(settings) {
    const checks = [
      ["population", 0, limits.population, "Number of neurons"], ["minimumSpacing", 0, 300, "Minimum spacing"],
      ["radius", 25, 500, "Sensing radius"], ["dimensions", 2, 3, "Dimensions"],
      ...["x", "y", ...(settings.dimensions === 3 ? ["z"] : [])].map(axis => [axis, 100, 10000, axis.toUpperCase() + " size"])
    ];
    for (const [key, min, max, label] of checks) {
      if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max)
        throw new Error(label + " must be a whole number from " + min + " to " + max + ".");
    }
    const axes = settings.dimensions === 3 ? ["x", "y", "z"] : ["x", "y"];
    const gridSites = axes.reduce((product, axis) => product * (Math.ceil(settings[axis] / 25) + 1), 1);
    if (gridSites > limits.gridSites) throw new Error("This volume is too large for interactive playback (500,000 grid sites maximum). Reduce its dimensions.");
    if (settings.minimumSpacing >= settings.x * 0.84)
      throw new Error("The input and output would be closer than the requested spacing. Increase the width or reduce spacing.");
    return { ...settings };
  }
  function summary(settings) {
    validate(settings);
    const areaOrVolume = settings.x * settings.y * (settings.dimensions === 3 ? settings.z : 1);
    const unit = settings.dimensions === 3 ? 1000000 : 10000;
    const axes = settings.dimensions === 3 ? ["x", "y", "z"] : ["x", "y"];
    const gridSites = axes.reduce((product, axis) => product * (Math.ceil(settings[axis] / 25) + 1), 1);
    return { total: settings.population + 2, gridSites, density: settings.population * unit / areaOrVolume,
      densityUnit: settings.dimensions === 3 ? "ordinary cells / million u³" : "ordinary cells / 10,000 u²" };
  }
  function fromField(field) {
    const endpoints = field.config.io ? field.config.io.inputs.length + field.config.io.outputs.length : 2;
    return { population: Math.max(0, (field.metrics[0]?.population ?? field.neurons.length) - endpoints),
      minimumSpacing: field.config.placement?.minimumSpacing ?? 48, radius: field.config.radius,
      dimensions: field.config.dimensions, x: field.config.extent.x, y: field.config.extent.y, z: field.config.extent.z ?? 620 };
  }
  function create(settings, { seed = 1, features, config = {}, task } = {}) {
    settings = validate(settings);
    const axes = settings.dimensions === 3 ? ["x", "y", "z"] : ["x", "y"];
    const extent = Object.fromEntries(axes.map(axis => [axis, settings[axis]]));
    config = { ...config };
    const endpointCount = config.io ? config.io.inputs.length + config.io.outputs.length : 2;
    // Larger custom fields opt in; small/archived runs keep identical config bytes.
    if (settings.population + endpointCount > 150) config.maxCells = settings.population + endpointCount + 12;
    else delete config.maxCells;
    const field = new SpikingField({ empty: true, seed, features, ...(task ? {task} : {}), config: { ...config,
      dimensions: settings.dimensions, extent, radius: settings.radius,
      placement: { version: 1, minimumSpacing: settings.minimumSpacing, population: settings.population, attemptsPerCell: 3000 }
    } });
    const middle = Object.fromEntries(axes.map(axis => [axis, extent[axis] / 2]));
    if (field.config.io) field.placeEndpoints();
    else {
    field.addNeuron({ ...middle, x: extent.x * 0.08, drivePeriod: field.config.inputPeriod });
    field.addNeuron({ ...middle, x: extent.x * 0.92, recordOutput: true, secretionRate: 8 });
    }
    for (let index = 0; index < settings.population; index++) {
      let placed = false;
      for (let attempt = 0; attempt < field.config.placement.attemptsPerCell; attempt++) {
        // Retain the research layout's spawn margins and random draw order.
        const position = Object.fromEntries(axes.map(axis => {
          const scale = extent[axis] / (axis === "x" ? 1000 : 620);
          return [axis, (axis === "x" ? 150 : 55) * scale + field.rng.next() * (axis === "x" ? 700 : 510) * scale];
        }));
        if (field.neurons.every(cell => distance(cell, position) > settings.minimumSpacing)) {
          field.addNeuron(position); placed = true; break;
        }
      }
      if (!placed) throw new Error("Could place only " + index + " of " + settings.population + " neurons at " +
        settings.minimumSpacing + " u spacing for seed " + seed + ". Reduce the count or spacing, or enlarge the volume.");
    }
    // The empty constructor's observation must not become the initial population.
    field.metrics = [];
    field.assignInhibitoryPopulation();
    field.endpointPlacement = field.assessEndpointPlacement();
    field.logMetrics();
    return field;
  }
  function replay(field, seed = field.seed) {
    const settings = fromField(field);
    const task = field.task ? {task:{...field.task.config,patternSeed:(field.task.config.patternSeed + seed - field.seed) >>> 0}} : {};
    if (field.config.placement?.version === 1) return create(settings, { seed, features: { ...field.features }, config: field.config, ...task });
    // Historical snapshots keep their original placement algorithm and RNG sequence.
    return new SpikingField({ seed, population: settings.population, features: { ...field.features }, config: { ...field.config }, ...task });
  }
  function measuredSpacing(field) {
    let minimum = Infinity;
    for (let i = 0; i < field.neurons.length; i++) for (let j = i + 1; j < field.neurons.length; j++)
      minimum = Math.min(minimum, distance(field.neurons[i], field.neurons[j]));
    return Number.isFinite(minimum) ? minimum : null;
  }
  const api = { defaults, limits, validate, summary, fromField, create, replay, measuredSpacing };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NeuronPopulation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
