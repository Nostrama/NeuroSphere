'use strict';
const LAYOUT = Object.freeze({schema:'neurosphere-shared-volume/v2',center:Object.freeze({x:400,y:400,z:400}),radius:400,extent:Object.freeze({x:800,y:800,z:800}),isolation:'domain-local-synapses',placement:'interleaved'});
const LEGACY_SCHEMA='neurosphere-compartments/v1';
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function domainCenter(domainId) {
  const ordinal=Number(domainId)-1;
  if(!Number.isInteger(ordinal)||ordinal<0||ordinal>8)throw new Error('Unknown domain.');
  return ordinal===8?{...LAYOUT.center}:{x:400+(ordinal&1?160:-160),y:400+(ordinal&2?160:-160),z:400+(ordinal&4?160:-160)};
}
function radicalInverse(index,base){let value=0,fraction=1/base;while(index){value+=(index%base)*fraction;index=Math.floor(index/base);fraction/=base;}return value;}
// A deterministic, volume-filling sequence. Domain is a logical tag, not a
// spatial zone. Fixed address ranges keep positions independent of enrollment.
function sharedPosition(domainId,slot){
  domainCenter(domainId);
  if(!Number.isInteger(slot)||slot<0||slot>=216)throw new Error('Invalid neuron slot.');
  const index=(Number(domainId)-1)*216+slot+1;
  const radius=360*Math.cbrt(radicalInverse(index,2)),y=1-2*radicalInverse(index,3),angle=2*Math.PI*radicalInverse(index,5),ring=Math.sqrt(1-y*y);
  return{x:400+radius*ring*Math.cos(angle),y:400+radius*y,z:400+radius*ring*Math.sin(angle)};
}
function distributeNeurons(nodes,regions,bindings){
  const positions=new Map();
  for(const region of regions){
    region.featureCells.forEach((id,bit)=>positions.set(id,sharedPosition(region.domainId,bit)));
    bindings.filter(b=>b.domainId===region.domainId).forEach((binding,index)=>binding.assembly.forEach((id,member)=>positions.set(id,sharedPosition(region.domainId,192+index*3+member))));
    region.center={...LAYOUT.center};region.radius=LAYOUT.radius;
  }
  for(const node of nodes){const position=positions.get(node.id);if(!position)throw new Error('Unmapped neuron in shared volume.');Object.assign(node,position);}
}
function validateCompartments(memory){
  if(!memory.volume)return; // Original pre-volume snapshots remain readable.
  const v=memory.volume,shared=v.schema===LAYOUT.schema;
  if((!shared&&v.schema!==LEGACY_SCHEMA)||v.isolation!==LAYOUT.isolation||v.radius!==LAYOUT.radius||!['x','y','z'].every(axis=>v.center?.[axis]===LAYOUT.center[axis]&&memory.artifact.config.extent[axis]===LAYOUT.extent[axis])||(shared&&v.placement!=='interleaved'))throw new Error('Invalid shared volume.');
  const membership=new Map();
  for(const region of memory.regions){
    const center=shared?LAYOUT.center:domainCenter(region.domainId),radius=shared?LAYOUT.radius:100;
    if(!Number.isFinite(distance(region.center??{},center))||distance(region.center,center)>1e-8||region.radius!==radius)throw new Error('Invalid domain compartment metadata.');
    for(const id of region.featureCells)membership.set(id,region);
    for(const binding of memory.bindings.filter(b=>b.domainId===region.domainId))for(const id of binding.assembly)membership.set(id,region);
    if(!shared)for(const other of memory.regions)if(other!==region&&distance(region.center,other.center)<region.radius+other.radius)throw new Error('Domain compartments overlap.');
  }
  for(const node of memory.artifact.nodes){const region=membership.get(node.id);if(!region||!Number.isFinite(distance(node,region.center))||distance(node,region.center)>region.radius+1e-8)throw new Error('Neuron escaped the shared volume.');}
}
// Migration changes coordinates and layout metadata only. Stored weights,
// delays, neuron state, IDs and I/O remain untouched; originals stay on disk.
function compactMemory(saved){
  validateCompartments(saved);
  if(saved.volume?.schema===LAYOUT.schema)return saved;
  const memory=structuredClone(saved);
  for(const region of memory.regions)if(!region.center||!['x','y','z'].every(axis=>Number.isFinite(region.center[axis])))throw new Error('Missing domain coordinates.');
  distributeNeurons(memory.artifact.nodes,memory.regions,memory.bindings);
  memory.artifact.config.extent={...LAYOUT.extent};memory.volume=structuredClone(LAYOUT);validateCompartments(memory);return memory;
}
module.exports={LAYOUT,domainCenter,sharedPosition,distributeNeurons,compactMemory,validateCompartments};
