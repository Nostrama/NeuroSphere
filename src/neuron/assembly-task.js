(function(root) {
  'use strict';
  const {distance,positionOf,Synapse} = typeof module!=='undefined'&&module.exports ? require('./neuron.js') : root.NeuronCore;
  const {SpatialHash} = typeof module!=='undefined'&&module.exports ? require('./spatial.js') : root.NeuronSpatial;
  const ZONES=Object.freeze([{name:'A',min:60,max:440},{name:'B',min:560,max:940}]);
  const TRACT_DEFAULTS=Object.freeze({count:2,reach:Math.hypot(880,620,620)});
  // A developmental wiring prior. This separate stream cannot perturb layout
  // or local growth randomness, and provenance never enters neuronal rules.
  function placeTracts(field,task) {
    const reach=field.config.tractReach??TRACT_DEFAULTS.reach;
    if(!Number.isFinite(reach)||reach<=0||field.config.maxSynapses<2)throw new Error('Invalid tract reach or synapse capacity.');
    let state=(field.seed^0x9c000001)>>>0;
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const pools=task.zones.A.map(id=>({source:field.getNeuron(id),targets:task.zones.B.map(id=>field.getNeuron(id)).filter(target=>distance(field.getNeuron(id),target)<=reach)}));
    if(pools.some(p=>p.targets.length<2))throw new Error('Every A cell needs two distinct tract targets within the configured reach.');
    for(const {source,targets}of pools)for(let n=0;n<2;n++){
      const target=targets.splice(Math.floor(random()*targets.length),1)[0];
      const synapse=new Synapse(source.id+'/s'+source.nextSynapseId++,source,target,field.config,0);
      synapse.tract=true;
      if(field.features.persistentTracts){source.tractSlotCapacity=2;synapse.tractSlot=n;task.axons.slots.push({sourceId:source.id,slot:n,synapseId:synapse.id,lastTargetId:target.id,readyTick:null});}
      if(field.features.tractsFixed)synapse.fixScaffold(source);
      source.synapses.push(synapse);field.observe({type:'formed',synapse:synapse.toJSON()});
    }
    if(field.features.persistentTracts)task.axons.rng=state;
  }
  function jaccard(a,b) { if(!a.length||!b.length)return 0;const right=new Set(b);return a.filter(id=>right.has(id)).length/new Set([...a,...b]).size; }
  function shuffled(ids,seed) {let state=(seed^0x90000001)>>>0;const result=[...ids];for(let i=result.length-1;i>0;i--){state=(Math.imul(state,1664525)+1013904223)>>>0;const j=Math.floor(state/4294967296*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;}
  // External stimulation plus passive readouts. Only the explicitly nonlocal
  // cap passes a regional decision to cells; membership never enters localView.
  class AssemblyTask {
    constructor(field) {
      if(field.config.dimensions!==3 || field.config.dt!==.02 || field.config.io || field.task ||
        JSON.stringify(field.config.extent)!==JSON.stringify({x:1000,y:620,z:620}))throw new Error('Assemblies require the registered 3D volume, 20-ms ticks and no I/O ports.');
      this.k=field.config.zoneCapK??20;
      if(!Number.isInteger(this.k)||this.k<1||this.k>400)throw new Error('Invalid regional cap.');
      this.zones={A:[],B:[]};this.stimuli={S1:[],S2:[]};this.presentations=[];this.spikes=[];this.tickCounts=[];
      this.current=null;this.latest={};this.reference=null;this.associationStart=null;
      this.clamped=new Set();this.pulsed=new Set();this.blocked=new Set();
      if(field.config.assemblyZones){
        const z=field.config.assemblyZones;
        if(!Array.isArray(z)||z.length!==2||z.some((r,i)=>r.name!==['A','B'][i]||!Number.isFinite(r.min)||!Number.isFinite(r.max)||r.min<0||r.max>1000||r.max<=r.min)||z[0].max>=z[1].min)throw new Error('Invalid assembly zone bounds.');
        this.bounds=z.map(r=>({...r}));
      }
      if(field.features.persistentTracts)this.axons={rng:null,slots:[],retargetings:[]};
      this.revised=Boolean(field.features.windowCap||field.features.distributedAttractant);
      if(field.features.windowCap){
        const window=field.config.zoneCapWindow??.2;
        if(!Number.isFinite(window)||window<=0||Math.abs(window/field.config.dt-Math.round(window/field.config.dt))>1e-9)throw new Error('Window cap requires a positive whole number of ticks.');
        this.windowTicks=Math.round(window/field.config.dt);this.windowMembers={A:new Map(),B:new Map()};this.capEvents=[];
      }
      if(this.revised)this.firstBActivity=null;
    }
    zoneOf(id) { return this.zones.A.includes(id)?'A':this.zones.B.includes(id)?'B':null; }
    place(field) {
      if(field.neurons.length)throw new Error('Assembly placement needs an empty field.');
      const spatial=new SpatialHash();
      for(const zone of this.bounds??ZONES) for(let i=0;i<150;i++) {
        let position,placed=false;
        for(let attempt=0;attempt<10000;attempt++) {
          position={x:zone.min+field.rng.next()*(zone.max-zone.min),y:field.rng.next()*620,z:field.rng.next()*620};
          if(!spatial.query(position,48).length){placed=true;break;}
        }
        if(!placed)throw new Error('Could not place the registered spaced assembly population.');
        const cell=field.addNeuron(position);if(field.features.distributedAttractant&&zone.name==='B')cell.secretionRate=8/150;
        this.zones[zone.name].push(cell.id);spatial.update(field.neurons);
      }
      const order=shuffled(this.zones.A,field.seed);this.stimuli={S1:order.slice(0,20),S2:order.slice(20,40)};
      this.positions=field.neurons.map(c=>({id:c.id,...positionOf(c),zone:this.zoneOf(c.id)}));
      if(field.features.tracts)placeTracts(field,this);
    }
    presentation(index) {
      const start=index*25;
      if(index<48)return {index,start,phase:'grow',stimulus:index%2?'S2':'S1',half:false};
      if(index<60){const i=(index-48)%6;return {index,start,phase:'test',stimulus:i%2?'S2':'S1',half:i===2||i===3};}
      if(this.associationStart!==null && start>=this.associationStart) {
        const i=(start-this.associationStart)/25;
        if(i<12)return {index,start,phase:'association',stimulus:'both',half:false};
        if(i<18)return {index,start,phase:'association-test',stimulus:i%2?'S2':'S1',half:false};
      }
      return null;
    }
    prepareTick(field) {
      if(this.axons)this.replaceTracts(field);
      const offset=(field.tick-1)%1250,index=Math.floor((field.tick-1)/1250);
      if(offset===0) {
        const schedule=this.presentation(index);
        this.current=schedule?{...schedule,a:[],b:[],cueSpikes:0,spikesA:0,spikesB:0}:null;
        if(this.current&&this.revised)this.current.cap={A:{candidates:0,blocked:0},B:{candidates:0,blocked:0}};
      }
      this.clamped.clear();this.pulsed.clear();this.blocked.clear();
      if(this.current && offset<1000) {
        const ids=this.current.stimulus==='both'?[...this.stimuli.S1,...this.stimuli.S2]:this.stimuli[this.current.stimulus].slice(0,this.current.half?10:20);
        for(const id of ids){this.clamped.add(id);if(offset%90===0)this.pulsed.add(id);}
      }
      this.currentTick=[field.tick,0,0,0,0,0,0,0,0];
      if(field.features.gradient&&!field.features.distributedAttractant)field.chemical.deposit({x:750,y:310,z:310},8*field.config.dt);
      if(this.windowMembers)for(const members of Object.values(this.windowMembers))for(const [id,tick]of members)if(tick<=field.tick-this.windowTicks)members.delete(id);
      if(field.features.zoneCap||field.features.windowCap) for(const [zi,zone]of ['A','B'].entries()) {
        const candidates=field.neurons.filter(c=>c.alive&&this.zoneOf(c.id)===zone&&!this.clamped.has(c.id)&&field.time>=c.refractoryUntil)
          .map(c=>({cell:c,...c.previewThreshold(field.config.dt,field.time)})).filter(c=>c.potential>=c.threshold)
          .sort((a,b)=>b.potential-a.potential||a.cell.id-b.cell.id);
        this.currentTick[5+zi]=candidates.length;
        if(field.features.windowCap){
          const admitted=new Set(this.windowMembers[zone].keys());
          for(const {cell}of candidates){
            if(field.features.zoneCap&&!admitted.has(cell.id)&&admitted.size>=this.k)this.blocked.add(cell.id);
            else admitted.add(cell.id);
          }
          if(candidates.length)this.capEvents.push([field.tick,zi,candidates.map(c=>[c.cell.id,c.potential])]);
          this.currentTick[7+zi]=candidates.filter(c=>this.blocked.has(c.cell.id)).length;
        }else{
          this.currentTick[7+zi]=Math.max(0,candidates.length-this.k);
          for(const candidate of candidates.slice(this.k))this.blocked.add(candidate.cell.id);
        }
      }
    }
    noteSpike(field,spike) {
      const zone=this.zoneOf(spike.neuronId),cue=this.pulsed.has(spike.neuronId);
      if(!zone)throw new Error('Unzoned assembly spike.');
      this.spikes.push([field.tick,spike.neuronId,cue?1:0]);
      if(this.windowMembers&&!cue)this.windowMembers[zone].set(spike.neuronId,field.tick);
      if(this.revised&&zone==='B'&&this.firstBActivity===null)this.firstBActivity=field.time;
      this.currentTick[(cue?3:1)+(zone==='B'?1:0)]++;
      const offset=(field.tick-1)%1250+1;
      if(this.current&&offset<=1000) {
        this.current['spikes'+zone]++;if(cue)this.current.cueSpikes++;
        if(offset>750){const set=this.current[zone.toLowerCase()];if(!set.includes(spike.neuronId))set.push(spike.neuronId);}
      }
    }
    notePruned(field,id) {
      if(!this.axons)return;
      const slot=this.axons.slots.find(s=>s.synapseId===id);
      if(slot){slot.synapseId=null;slot.readyTick=field.tick+500;}
    }
    replaceTracts(field) {
      if(field.features.tractsFixed||field.circuitLock)return;
      for(const slot of this.axons.slots){
        if(slot.synapseId!==null||slot.readyTick===null||slot.readyTick>field.tick)continue;
        const source=field.getNeuron(slot.sourceId);if(!source?.alive)continue;
        const occupied=new Set(source.synapses.filter(s=>s.active&&s.tract).map(s=>s.targetId));
        const eligible=this.zones.B.filter(id=>id!==slot.lastTargetId&&!occupied.has(id)&&field.getNeuron(id)?.alive);
        if(!eligible.length)continue;
        const rngBefore=this.axons.rng;this.axons.rng=(Math.imul(this.axons.rng,1664525)+1013904223)>>>0;
        const target=field.getNeuron(eligible[Math.floor(this.axons.rng/4294967296*eligible.length)]);
        const synapse=new Synapse(source.id+'/s'+source.nextSynapseId++,source,target,field.config,field.time);
        synapse.tract=true;synapse.tractSlot=slot.slot;source.synapses.push(synapse);
        const event={tick:field.tick,time:field.time,sourceId:source.id,slot:slot.slot,previousTargetId:slot.lastTargetId,targetId:target.id,synapseId:synapse.id,prunedTick:slot.readyTick-500,rngBefore,eligible};
        slot.synapseId=synapse.id;slot.lastTargetId=target.id;slot.readyTick=null;
        this.axons.retargetings.push(event);field.observe({type:'formed',synapse:synapse.toJSON()});field.observe({type:'tract-retarget',...event});
      }
    }
    locks(field) {
      const links=field.links.filter(s=>s.active&&s.consolidated),counts={A:0,B:0,AtoB:0,BtoA:0};
      for(const s of links){const a=this.zoneOf(s.sourceId),b=this.zoneOf(s.targetId);if(a)counts[a]++;if(a&&b&&a!==b)counts[a+'to'+b]++;}
      return counts;
    }
    finishTick(field) {
      if(field.features.zoneCap&&(this.currentTick[1]>this.k||this.currentTick[2]>this.k))throw new Error('Regional cap exceeded.');
      if(this.windowMembers){
        this.currentTick.push(this.windowMembers.A.size,this.windowMembers.B.size);
        if(field.features.zoneCap&&Object.values(this.windowMembers).some(m=>m.size>this.k))throw new Error('Window membership cap exceeded.');
      }
      if(this.current&&this.revised&&(field.tick-1)%1250<1000)for(const [zi,z]of ['A','B'].entries()){
        this.current.cap[z].candidates+=this.currentTick[5+zi];this.current.cap[z].blocked+=this.currentTick[7+zi];
      }
      this.tickCounts.push(this.currentTick);
      if(this.current&&(field.tick-1)%1250+1===1000) {
        const row={...this.current,end:field.time,a:[...this.current.a].sort((a,b)=>a-b),b:[...this.current.b].sort((a,b)=>a-b),locks:this.locks(field)};
        if(this.revised){
          for(const z of ['A','B'])row.cap[z].fraction=row.cap[z].candidates?row.cap[z].blocked/row.cap[z].candidates:0;
          row.centroidB=row.b.length?Object.fromEntries(['x','y','z'].map(axis=>[axis,row.b.reduce((sum,id)=>sum+this.positions.find(p=>p.id===id)[axis],0)/row.b.length])):null;
          row.liveSources=field.neurons.filter(c=>c.alive&&c.secretionRate>0).length;
        }
        row.stability=!row.half&&row.stimulus!=='both'&&this.latest[row.stimulus]?jaccard(row.b,this.latest[row.stimulus].b):null;
        row.completion=row.half&&this.reference?jaccard(row.b,this.reference[row.stimulus].b):null;
        this.presentations.push(row);
        if(!row.half&&row.stimulus!=='both')this.latest[row.stimulus]=row;
      }
      if(field.tick===60000)this.reference=JSON.parse(JSON.stringify(this.latest));
    }
    measure(field) {return {assembly:{phase:this.current?.phase??'complete',stimulus:this.current?.stimulus??null,half:this.current?.half??false,
      a:this.current?.a.length??0,b:this.current?.b.length??0,locks:this.locks(field),cap:field.features.zoneCap?this.k:null,
      ...(this.revised?{firstBActivity:this.firstBActivity,distributedAttractant:Boolean(field.features.distributedAttractant),liveSources:field.neurons.filter(c=>c.secretionRate>0).length}:{}),
      ...(this.windowMembers?{window:this.windowTicks*field.config.dt,occupancy:{A:this.windowMembers.A.size,B:this.windowMembers.B.size}}:{})}};}
    toJSON() {return JSON.parse(JSON.stringify({k:this.k,zones:this.zones,stimuli:this.stimuli,positions:this.positions,presentations:this.presentations,
      spikes:this.spikes,tickCounts:this.tickCounts,current:this.current,latest:this.latest,reference:this.reference,associationStart:this.associationStart,
      ...(this.bounds?{bounds:this.bounds}:{}),...(this.axons?{axons:this.axons}:{}),
      ...(this.revised?{firstBActivity:this.firstBActivity}:{}),...(this.windowMembers?{windowTicks:this.windowTicks,windowMembers:{A:[...this.windowMembers.A],B:[...this.windowMembers.B]},capEvents:this.capEvents}:{})}));}
    static fromJSON(saved,field) {
      const task=new AssemblyTask(field),ids=new Set([...field.neurons,...field.archive].map(c=>c.id));
      if(!saved||saved.k!==task.k||!Array.isArray(saved.positions)||saved.positions.length!==300||
        !['A','B'].every(z=>Array.isArray(saved.zones?.[z])&&saved.zones[z].length===150)||
        new Set([...saved.zones.A,...saved.zones.B]).size!==300||saved.positions.some(p=>!ids.has(p.id)||!saved.zones[p.zone]?.includes(p.id)))throw new Error('Invalid assembly population.');
      const ordered=shuffled(saved.zones.A,field.seed);
      if(JSON.stringify(saved.stimuli)!==JSON.stringify({S1:ordered.slice(0,20),S2:ordered.slice(20,40)}))throw new Error('Invalid assembly stimulus selection.');
      if(!Array.isArray(saved.tickCounts)||saved.tickCounts.length!==field.tick||!Array.isArray(saved.spikes)||!Array.isArray(saved.presentations))throw new Error('Invalid assembly history.');
      for(const key of ['zones','stimuli','positions','presentations','spikes','tickCounts','current','latest','reference','associationStart'])task[key]=saved[key];
      if(JSON.stringify(saved.bounds)!==JSON.stringify(task.bounds))throw new Error('Invalid saved zone bounds.');
      if(task.bounds&&task.positions.some(p=>{const b=task.bounds.find(z=>z.name===p.zone);return p.x<b.min||p.x>b.max;}))throw new Error('Position outside assembly zone.');
      if(task.axons){
        const a=saved.axons;
        if(!a||!Number.isInteger(a.rng)||a.rng<0||a.rng>4294967295||!Array.isArray(a.slots)||a.slots.length!==300||!Array.isArray(a.retargetings))throw new Error('Invalid persistent axon state.');
        a.slots.forEach((s,i)=>{
          if(s.sourceId!==task.zones.A[Math.floor(i/2)]||s.slot!==i%2||!task.zones.B.includes(s.lastTargetId))throw new Error('Invalid tract slot identity.');
          const source=field.getNeuron(s.sourceId)??(field.features.tractsFixed?field.archive.find(c=>c.id===s.sourceId):null),edge=source?.synapses.find(e=>e.id===s.synapseId);
          if(source?.alive&&source.tractSlotCapacity!==2)throw new Error('Invalid tract slot capacity.');
          if(s.synapseId!==null){if(!edge?.active||edge.tractSlot!==s.slot||edge.targetId!==s.lastTargetId||s.readyTick!==null)throw new Error('Invalid occupied tract slot.');}
          else if(!Number.isInteger(s.readyTick)||s.readyTick<500||s.readyTick>field.tick+500)throw new Error('Invalid tract cooldown.');
        });
        if(field.features.tractsFixed&&(a.retargetings.length||a.slots.some(s=>s.synapseId===null||s.readyTick!==null)))throw new Error("Invalid fixed scaffold turnover.");
        task.axons=JSON.parse(JSON.stringify(a));
      }else if(saved.axons!==undefined)throw new Error('Unexpected persistent axon state.');
      if(task.revised){if(saved.firstBActivity!==null&&(!Number.isFinite(saved.firstBActivity)||saved.firstBActivity<0||saved.firstBActivity>field.time))throw new Error('Invalid first B activity.');task.firstBActivity=saved.firstBActivity;}
      if(task.windowMembers){
        if(saved.windowTicks!==task.windowTicks||!Array.isArray(saved.capEvents))throw new Error('Invalid window cap history.');
        for(const z of ['A','B']){
          const entries=saved.windowMembers?.[z];
          if(!Array.isArray(entries)||new Set(entries.map(e=>e[0])).size!==entries.length||entries.some(e=>e.length!==2||!saved.zones[z].includes(e[0])||!Number.isInteger(e[1])||e[1]>field.tick||e[1]<=field.tick-task.windowTicks))throw new Error('Invalid window membership.');
          if(field.features.zoneCap&&entries.length>task.k)throw new Error('Window membership exceeds cap.');
          task.windowMembers[z]=new Map(entries);
        }
        task.capEvents=saved.capEvents;
      }
      return task;
    }
  }
  const api={AssemblyTask,ZONES,TRACT_DEFAULTS,jaccard,shuffled};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.NeuronAssemblies=api;
})(typeof globalThis!=='undefined'?globalThis:this);
