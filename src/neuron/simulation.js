// Stable browser/CommonJS entry point. Dynamics live in neuron.js and field.js.
(function (root) {
  "use strict";
  const engine = typeof module !== "undefined" && module.exports ? require("./field.js") : root.SpikingSimulation;
  const api = { ...engine, NeuralField: engine.SpikingField };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NeuronSimulation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
