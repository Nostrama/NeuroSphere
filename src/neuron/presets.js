(function(root) {
  'use strict';
  // Named opt-in configuration. Engine DEFAULTS and ordinary A–D runs do not read it.
  const S = Object.freeze({population:95,
    config:Object.freeze({dimensions:3,extent:Object.freeze({x:1000,y:620,z:620}),inhibitionStrength:.3,inhibitionRadiusFactor:.8}),
    features:Object.freeze({hebbian:true,reward:false,gradient:true,consolidation:true,lateralInhibition:true})});
  function preset(name,seed=1) {
    if(name!=='S')throw new Error('Unknown preset: '+name);
    return {seed,population:S.population,config:{...S.config,extent:{...S.config.extent}},features:{...S.features}};
  }
  const api={S,preset};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.NeuronPresets=api;
})(typeof globalThis!=='undefined'?globalThis:this);
