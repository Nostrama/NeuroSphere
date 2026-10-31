// Exact Neuron neuronShape() is in upstream/neuron-volume.js. Soma drawing is
// adapted from Neuron/app.js drawNeuron; see docs/UI_SOURCE.json.
// Procedural anatomy is illustrative; it never adds simulation connections.
const shapes=new Map();
export function drawMorphology(ctx,p,project,scale,{active=false,selected=false,observed=false,emphasized=false}={}) {
  const node=p.node,isMemory=node.role==='memory';
  if(!shapes.has(node.id))shapes.set(node.id,globalThis.NeuronVolume.neuronShape(node.id));
  const shape=shapes.get(node.id),factor=emphasized?(isMemory?.75:.55):(isMemory?.40:.16),radius=Math.max(.8,(isMemory?7.5:6.5)*factor*scale);
  const color=active?'#d9fff6':isMemory?'#f4bd79':'#5dcfdf';
  if(scale>.65||selected){ctx.lineCap='round';for(const stem of shape.stems){
    ctx.strokeStyle=active?'#9df4e2':isMemory?'#bf884eaa':stem.kind==='axon'?'#6dbacb99':'#3b99b3aa';
    for(let i=1;i<stem.points.length;i++){
      const world=v=>({x:node.x+v[0]*factor,y:node.y-v[1]*factor,z:node.z+v[2]*factor});
      const a=project(world(stem.points[i-1])),b=project(world(stem.points[i]));ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineWidth=Math.max(.35,stem.radius*.65**(i-1)*factor*scale);ctx.stroke();
    }
  }}
  ctx.save();ctx.translate(p.x,p.y);
  if(radius>2){const glow=ctx.createRadialGradient(0,0,0,0,0,radius*3.2);glow.addColorStop(0,isMemory?'#f2ad5e66':'#3bc8e05c');glow.addColorStop(1,'#00000000');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(0,0,radius*3.2,0,Math.PI*2);ctx.fill();}
  const outline=Array.from({length:12},(_,i)=>{const angle=i*Math.PI/6,r=radius*(1+.16*Math.sin(angle*3+node.id));return[Math.cos(angle)*r,Math.sin(angle)*r*.9];});
  ctx.beginPath();ctx.moveTo((outline[11][0]+outline[0][0])/2,(outline[11][1]+outline[0][1])/2);
  for(let i=0;i<outline.length;i++){const a=outline[i],b=outline[(i+1)%outline.length];ctx.quadraticCurveTo(a[0],a[1],(a[0]+b[0])/2,(a[1]+b[1])/2);}ctx.closePath();
  const body=ctx.createRadialGradient(-radius*.3,-radius*.3,0,0,0,radius*1.2);body.addColorStop(0,active?'#f1fff6':isMemory?'#fff1ca':'#c1f9fb');body.addColorStop(.35,color);body.addColorStop(1,isMemory?'#945b2a':'#1a5f78');ctx.fillStyle=body;ctx.strokeStyle=active?'#e1fff3':color;ctx.lineWidth=.65;ctx.fill();ctx.stroke();
  ctx.beginPath();ctx.ellipse(0,0,radius*.43,radius*.37,node.id*.7,0,Math.PI*2);ctx.fillStyle=isMemory?'#9a672f':'#246278';ctx.fill();ctx.beginPath();ctx.arc(-radius*.12,-radius*.12,Math.max(.3,radius*.11),0,Math.PI*2);ctx.fillStyle='#e1fcf7bb';ctx.fill();
  if(selected||active||observed){ctx.beginPath();ctx.arc(0,0,radius+3,0,Math.PI*2);ctx.strokeStyle=selected?'#b9eaf9':active?'#edfff8':'#62bcba66';ctx.lineWidth=selected?1:.5;ctx.stroke();}
  if(selected&&radius>2){ctx.font='9px Consolas,monospace';ctx.fillStyle='#9bcbd7';ctx.fillText('#'+node.id,radius+8,-radius-4);}
  ctx.restore();return radius;
}
