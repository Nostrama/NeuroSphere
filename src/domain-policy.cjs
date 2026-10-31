'use strict';
// Logical membership remains separate from physical position in the shared volume.
function applyDomainPolicy(field,membership){
  const prior=field.env.forNeuron.bind(field.env);
  field.env.forNeuron=(cell,frame)=>{
    const env=prior(cell,frame),sense=env.sense;
    env.sense=()=>sense().filter(peer=>membership.has(cell.id)&&membership.get(cell.id)===membership.get(peer.id));
    return env;
  };
}
module.exports={applyDomainPolicy};
