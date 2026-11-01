import {drawMorphology} from './morphology.js';
import {potentialSeries} from './telemetry-model.mjs';
export class VolumeView {
  constructor(canvas,{onHover=()=>{},onSelect=()=>{},onReplay=()=>{},onFrame=()=>{}}={}) {
    Object.assign(this,{canvas,ctx:canvas.getContext('2d'),onHover,onSelect,onReplay,onFrame,domain:'',connections:true,boundaries:true,edgeMode:'learned',inverted:true,cut:1,selectedId:null,points:[],time:0,speed:.125,trace:[],samples:[],playing:false,frame:null});
    this.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;this.reset();
    new ResizeObserver(()=>this.draw()).observe(canvas);
    canvas.addEventListener('contextmenu',event=>event.preventDefault());
    canvas.addEventListener('pointerdown',event=>{this.drag={x:event.clientX,y:event.clientY,distance:0,pan:event.shiftKey||event.button===2};canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener('pointermove',event=>{
      if(this.drag){const dx=event.clientX-this.drag.x,dy=event.clientY-this.drag.y;this.drag.distance+=Math.abs(dx)+Math.abs(dy);const direction=this.inverted?-1:1;
        if(this.drag.pan){this.pan.x+=dx;this.pan.y+=dy;}else{this.yaw+=direction*dx*.008;this.pitch=Math.max(-1.45,Math.min(1.45,this.pitch+direction*dy*.006));}
        this.drag.x=event.clientX;this.drag.y=event.clientY;this.onHover(null);this.draw();
      }else{const hit=this.hit(event);this.onHover(hit?.node??null,event.offsetX,event.offsetY);canvas.style.cursor=hit?'pointer':'grab';}
    });
    canvas.addEventListener('pointerup',event=>{if(this.drag?.distance<5){const hit=this.hit(event);this.select(hit?.node.id??null);}this.drag=null;});
    canvas.addEventListener('pointercancel',()=>{this.drag=null;});canvas.addEventListener('pointerleave',()=>this.onHover(null));
    canvas.addEventListener('wheel',event=>{event.preventDefault();this.zoom(Math.exp(-event.deltaY*.0015));},{passive:false});
    canvas.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(event.key))return;event.preventDefault();
      if(event.shiftKey){if(event.key==='ArrowLeft')this.pan.x-=20;if(event.key==='ArrowRight')this.pan.x+=20;if(event.key==='ArrowUp')this.pan.y-=20;if(event.key==='ArrowDown')this.pan.y+=20;}
      else{if(event.key==='ArrowLeft')this.yaw-=.12;if(event.key==='ArrowRight')this.yaw+=.12;if(event.key==='ArrowUp')this.pitch=Math.max(-1.45,this.pitch-.12);if(event.key==='ArrowDown')this.pitch=Math.min(1.45,this.pitch+.12);}
      if(event.key==='+'||event.key==='=')this.zoom(1.2);if(event.key==='-')this.zoom(1/1.2);if(event.key==='0')this.reset();this.draw();
    });
  }
  hit(event){return this.outputLabels?.find(p=>event.offsetX>=p.x&&event.offsetX<=p.x+62&&event.offsetY>=p.y&&event.offsetY<=p.y+22)??this.points.filter(p=>Math.hypot(p.x-event.offsetX,p.y-event.offsetY)<Math.max(6,p.radius+3)).sort((a,b)=>b.z-a.z)[0];}
  setScene(scene){this.scene=scene;this.nodesById=new Map((scene?.nodes??[]).map(n=>[n.id,n]));this.edgesBySource=new Map();for(const edge of scene?.edges??[]){if(!this.edgesBySource.has(edge.source))this.edgesBySource.set(edge.source,[]);this.edgesBySource.get(edge.source).push(edge);}this.selectedId=null;this.clearActivity();this.reset();}
  setDomain(domain){this.domain=domain;this.selectedId=null;this.onSelect(null);this.draw();}
  focusDomain(){this.target={...(this.scene?.volume?.center??{x:400,y:400,z:400})};this.magnification=1;this.pan={x:0,y:0};this.draw();}
  focusSelected(){const node=this.nodesById?.get(this.selectedId);if(node){this.target={x:node.x,y:node.y,z:node.z};this.magnification=8;this.pan={x:0,y:0};this.draw();}}
  cellView(){const node=this.nodesById?.get(this.selectedId)||this.scene?.nodes.find(n=>n.role==='memory'&&(!this.domain||n.domainId===this.domain));if(!node)return;this.select(node.id);this.focusSelected();}
  select(id){this.selectedId=id;this.onSelect(this.nodesById?.get(id)??null);this.draw();}
  setConnections(value){this.connections=value;this.draw();}
  reset(){this.yaw=-.48;this.pitch=.23;this.magnification=1;this.pan={x:0,y:0};this.target={...(this.scene?.volume?.center??{x:400,y:400,z:400})};if(this.domain)this.focusDomain();else this.draw();}
  zoom(factor){this.magnification=Math.max(.5,Math.min(24,this.magnification*factor));this.draw();}
  stop(){cancelAnimationFrame(this.frame);this.frame=null;this.playing=false;}
  clearActivity(){this.stop();this.trace=[];this.samples=[];this.outputs=null;this.time=0;this.onFrame({time:0,playing:false,available:false});this.draw();}
  setActivity(result){this.stop();this.trace=result.trace;this.samples=result.samples??[];this.outputs=result.outputs??null;this.time=0;this.duration=result.seconds??1;if(this.reducedMotion)this.seek(this.duration);else this.play();}
  seek(time){this.stop();this.time=Math.max(0,Math.min(this.duration??1,time));this.onReplay('Recorded activity · '+this.time.toFixed(2)+' s');this.onFrame({time:this.time,playing:false,available:Boolean(this.samples.length)});this.draw();}
  play(trace){
    if(trace)this.trace=trace;if(!this.trace.length&&!this.samples.length)return;
    this.stop();if(this.time>=(this.duration??1))this.time=0;this.playing=true;this.started=performance.now();this.startTime=this.time;this.onReplay('Measured spikes · Slow replay');
    const animate=()=>{this.time=Math.min(this.duration??1,this.startTime+(performance.now()-this.started)/1000*this.speed);if(this.time>=(this.duration??1)){this.playing=false;this.onReplay('Replay complete · Recorded activity');}this.onFrame({time:this.time,playing:this.playing,available:true});this.draw();if(this.playing)this.frame=requestAnimationFrame(animate);};animate();
  }
  togglePlayback(){if(this.playing)this.seek(this.time);else this.play();}
  currentPotential(id){const node=this.nodesById?.get(id);return potentialSeries(this.samples,node,this.outputs).filter(p=>p.time<=this.time+1e-9).at(-1)?.value??node?.restLevel??0;}
  draw(){
    const {canvas,ctx}=this,w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
    const dpr=Math.min(devicePixelRatio||1,2);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);
    const bg=ctx.createRadialGradient(w*.5,h*.45,10,w*.5,h*.5,Math.max(w,h)*.8);bg.addColorStop(0,'#0d2732');bg.addColorStop(1,'#050f16');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    ctx.lineWidth=1;ctx.strokeStyle='#7da9bb0b';for(let x=0;x<w;x+=32){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=0;y<h;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    this.outputLabels=[];
    if(!this.scene){this.points=[];return;}
    const scale=Math.max(80,Math.min(w-60,h-70))/800*this.magnification;
    const project=node=>{const x=node.x-this.target.x,y=node.y-this.target.y,z=node.z-this.target.z;const rx=x*Math.cos(this.yaw)+z*Math.sin(this.yaw),rz=-x*Math.sin(this.yaw)+z*Math.cos(this.yaw),ry=y*Math.cos(this.pitch)-rz*Math.sin(this.pitch),depth=y*Math.sin(this.pitch)+rz*Math.cos(this.pitch);return{x:w/2+this.pan.x+rx*scale,y:h/2+this.pan.y+ry*scale,z:depth,node};};
    const cutZ=this.scene.volume.center.z-this.scene.volume.radius+2*this.scene.volume.radius*this.cut;
    const visible=node=>node.z<=cutZ+1e-8;
    const path=points=>{ctx.beginPath();points.forEach((point,index)=>{const p=project(point);index?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);});ctx.stroke();};
    const sphere=(center,radius,color,fill=false)=>{
      const p=project(center);if(fill){ctx.fillStyle=color+'09';ctx.beginPath();ctx.arc(p.x,p.y,radius*scale,0,Math.PI*2);ctx.fill();}
      ctx.strokeStyle=color+'55';ctx.lineWidth=.8;
      for(const plane of ['xy','xz','yz']){const points=[];for(let i=0;i<=72;i++){const angle=i/72*Math.PI*2,point={...center};point[plane[0]]+=Math.cos(angle)*radius;point[plane[1]]+=Math.sin(angle)*radius;points.push(point);}path(points);}
      ctx.strokeStyle=color+'25';ctx.beginPath();ctx.arc(p.x,p.y,radius*scale,0,Math.PI*2);ctx.stroke();
    };
    if(this.boundaries)sphere(this.scene.volume.center,this.scene.volume.radius,'#6eb4bf',true);
    // A world-Z cutaway hides geometry in front of this plane, including hit targets.
    if(this.cut<1){const c=this.scene.volume.center,r=this.scene.volume.radius,delta=cutZ-c.z;const radius=Math.sqrt(Math.max(0,r*r-delta*delta));const points=[];for(let i=0;i<=72;i++){const a=i/72*Math.PI*2;points.push({x:c.x+Math.cos(a)*radius,y:c.y+Math.sin(a)*radius,z:cutZ});}ctx.strokeStyle='#a9e1ff66';ctx.setLineDash([5,5]);path(points);ctx.setLineDash([]);}
    const points=this.scene.nodes.filter(visible).map(project),byId=new Map(points.map(p=>[p.node.id,p]));
    const latest=new Map();for(const event of this.trace)if(event.time<=this.time+1e-8)latest.set(event.neuronId,event.time);
    const connected=new Set([this.selectedId]);for(const edge of this.scene.edges)if((edge.source===this.selectedId||edge.target===this.selectedId)&&(this.edgeMode!=='learned'||edge.weight>.1)){connected.add(edge.source);connected.add(edge.target);}
    const showEdge=edge=>this.connections&&(this.edgeMode==='all'||(this.edgeMode==='selected'?(edge.source===this.selectedId||edge.target===this.selectedId):this.edgeMode==='formed'?edge.kind==='formed':this.edgeMode==='readout'?edge.kind==='readout':edge.weight>.1));
    if(this.connections)for(const edge of this.scene.edges){const a=byId.get(edge.source),b=byId.get(edge.target);if(!a||!b||!showEdge(edge))continue;const selected=edge.source===this.selectedId||edge.target===this.selectedId;ctx.globalAlpha=this.domain&&a.node.domainId!==this.domain ? .08 : this.selectedId&&!selected ? .12 : 1;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=selected?'#f5d394a0':edge.weight>.1?'#64ceb76b':'#618ca627';ctx.lineWidth=selected?1.2:.65;ctx.stroke();}ctx.globalAlpha=1;
    if(this.connections&&this.playing)for(const event of this.trace){for(const edge of this.edgesBySource.get(event.neuronId)??[]){const elapsed=this.time-event.time;if(elapsed<0||elapsed>edge.delay||!showEdge(edge))continue;const a=byId.get(edge.source),b=byId.get(edge.target);if(!a||!b||(this.domain&&a.node.domainId!==this.domain))continue;const t=elapsed/edge.delay;ctx.fillStyle='#cefff2';ctx.beginPath();ctx.arc(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,2,0,Math.PI*2);ctx.fill();}}
    this.points=[];
    for(const p of points.sort((a,b)=>a.z-b.z)){
      const focused=!this.domain||p.node.domainId===this.domain;const recent=latest.has(p.node.id)&&this.time-latest.get(p.node.id)<.055;const selected=p.node.id===this.selectedId;
      ctx.globalAlpha=focused?(this.selectedId&&!connected.has(p.node.id) ? .12 : 1):.08;
      if(p.x < -180 || p.x > w+180 || p.y < -180 || p.y > h+180)continue;
      p.radius=drawMorphology(ctx,p,project,scale,{active:recent,selected,observed:latest.has(p.node.id),emphasized:Boolean(this.selectedId&&connected.has(p.node.id))});
      if(focused&&p.x>=0&&p.x<=w&&p.y>=0&&p.y<=h)this.points.push(p);
    }ctx.globalAlpha=1;
    // Screen-space callouts distinguish co-located outputs without moving cells.
    const outputs=points.filter(p=>p.node.role==='output');
    for(const [index,p] of outputs.entries()){
      if(p.x<0||p.x>w||p.y<0||p.y>h)continue;
      const x=Math.max(6,Math.min(w-68,p.x+(index===0?-82:20))),y=Math.max(35,Math.min(h-60,p.y-55));
      const active=latest.has(p.node.id)&&this.time-latest.get(p.node.id)<.055,selected=p.node.id===this.selectedId;
      ctx.strokeStyle=active?'#e2fff3':selected?'#ffe2ac':'#bb9968';ctx.fillStyle='#10232e';ctx.lineWidth=selected?1.5:1;
      ctx.beginPath();ctx.moveTo(x+31,y+22);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.fillRect(x,y,62,22);ctx.strokeRect(x,y,62,22);
      ctx.fillStyle=active?'#e2fff3':'#f3c181';ctx.font='11px Consolas,monospace';ctx.textAlign='center';ctx.fillText(p.node.label.split(' · ')[0],x+31,y+15);
      this.outputLabels.push({x,y,node:p.node,radius:12,z:p.z});
    }
    ctx.textAlign='left';
    if(this.magnification<=1.6&&this.scene.ports){
      const center=project(this.scene.volume.center),radius=this.scene.volume.radius*scale;
      for(const [kind,left] of [['sense',true],['output',false]]){
        const port=this.scene.ports[kind],start=left?16:center.x+radius,end=left?center.x-radius:w-16,y=center.y;
        if(end<=start||y<40||y>h-35)continue;
        const fired=this.trace.some(event=>event.time<=this.time&&this.time-event.time<.055&&port.cellIds.includes(event.neuronId));
        ctx.strokeStyle=fired?'#d6fff1':left?'#4ec8ca':'#dcaa6d';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=fired?2:1;
        ctx.beginPath();ctx.moveTo(start,y);ctx.lineTo(end,y);ctx.lineTo(end-5,y-3);ctx.moveTo(end,y);ctx.lineTo(end-5,y+3);ctx.stroke();
        ctx.textAlign=left?'left':'right';ctx.font='9px Consolas,monospace';ctx.fillText(port.name.toUpperCase(),left?start:end,y-9);
        ctx.fillStyle='#4f8191';ctx.font='7px Consolas,monospace';ctx.fillText(left?'ENCODED CUE':'ENGRAM READOUT',left?start:end,y+13);
      }
    }
    ctx.textAlign='left';ctx.font='8px Consolas,monospace';ctx.fillStyle='#527e90';ctx.fillText(this.magnification.toFixed(1)+'× / '+this.points.length+' SOMAS IN VIEW',10,h-35);
  }
}
