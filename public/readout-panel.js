const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const signed=value=>(value>=0?'+':'')+value.toFixed(3);

export class ReadoutPanel {
  constructor({open,probe,inspect}) {
    this.inspect=inspect;this.available=true;this.mode='full';
    $('readout-button').addEventListener('click',()=>open(Number($('readout-seed').value)));
    $('readout-seed').addEventListener('change',()=>open(Number($('readout-seed').value)));
    for(const button of document.querySelectorAll('[data-readout-word]'))button.addEventListener('click',()=>{
      $('recall-word').value=this.memory.cues[button.dataset.readoutWord];this.mode='full';probe();
    });
    for(const button of document.querySelectorAll('[data-probe-mode]'))button.addEventListener('click',()=>{
      this.mode=button.dataset.probeMode;
      if(this.mode==='untrained')$('recall-word').value=this.memory.cues.C;
      probe();
    });
    $('recall-word').addEventListener('input',()=>{this.mode='full';this.sync(this.busy);});
  }
  setCatalog(value){this.available=value.available;$('readout-button').title=value.available?'Explore the three confirmed learned circuits':value.message;this.sync(this.busy);}
  setMemory(memory){
    this.memory=memory?.kind==='readout'?memory:null;this.result=null;this.mode='full';
    const active=Boolean(this.memory);
    for(const id of ['readout-learning','readout-probes','readout-legend','readout-rail'])$(id).hidden=!active;
    $('readout-shortcuts').replaceChildren();
    $('standard-legend').hidden=active;$('readout-button').setAttribute('aria-pressed',String(active));
    $('volume-panel').classList.toggle('readout-mode',active);
    $('metric-domain-label').textContent=active?'VOLUME':'DOMAINS';
    $('sense-description').textContent=active?'Input features → self-formed memory → learned output':'One cue → all enrolled domains';
    for(const option of document.querySelectorAll('[data-readout-links]')){option.disabled=!active;option.hidden=!active;}
    if(!active){$('readout-cells').replaceChildren();return;}
    $('readout-seed').value=memory.seed;
    for(const cue of ['A','B']){
      const info=memory.outputs[cue],button=el('button','readout-shortcut',info.name);
      button.type='button';button.dataset.outputCue=cue;button.dataset.neuronId=info.id;
      button.title='Inspect '+info.name+' · '+info.word;button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed','false');
      button.addEventListener('click',()=>this.inspect(info.id));$('readout-shortcuts').append(button);
    }
    $('readout-proof').textContent='3 seeds confirmed · R1–R4 + all controls pass';
    $('readout-origin').textContent='Formation '+memory.formationEpoch+' rounds · Readout '+memory.epochs+' rounds';
    for(const button of document.querySelectorAll('[data-readout-word]'))button.textContent=button.dataset.readoutWord+' · '+memory.cues[button.dataset.readoutWord];
    $('readout-note').textContent='Two frozen reference memories. Select a learned word, then send all eight features or either fixed four-feature half.';
    this.cards();this.sync(this.busy);
  }
  sync(busy=false){
    this.busy=busy;const active=Boolean(this.memory),word=$('recall-word').value.trim().toLowerCase();
    $('readout-button').disabled=busy||!this.available;
    $('readout-seed').disabled=busy;$('readout-delay').disabled=busy;
    for(const button of document.querySelectorAll('[data-readout-word]'))button.disabled=busy||!active;
    for(const button of document.querySelectorAll('[data-probe-mode]')){
      const mode=button.dataset.probeMode;
      button.disabled=busy||!active||(mode.startsWith('half-')&&![this.memory?.cues.A,this.memory?.cues.B].includes(word));
      button.setAttribute('aria-pressed',String(mode===this.mode));
    }
  }
  request(){return this.memory?{mode:this.mode,idleSeconds:Number($('readout-delay').value)}:{};}
  cards(){
    $('readout-cells').replaceChildren();if(!this.memory)return;
    for(const cue of ['A','B']){
      const info=this.memory.outputs[cue],measurement=this.result?.outputs[cue],card=el('button','readout-cell');card.type='button';card.dataset.outputCue=cue;
      card.setAttribute('aria-label','Inspect '+info.name+' for '+info.word);card.addEventListener('click',()=>this.inspect(info.id));
      const head=el('span','readout-cell-head');head.append(el('strong','',info.name),el('span','',measurement?(measurement.fired?'FIRED':'SILENT'):'INSPECT'));
      card.append(head,el('span','readout-word',info.word));
      card.append(el('span','readout-detail',measurement?measurement.coreCellsFired+' / '+info.coreSize+' core cells active':'Reference core · '+info.coreSize+' cells'));
      const bar=el('span','readout-meter'),fill=el('i');fill.style.width=(measurement?100*measurement.coreCellsFired/info.coreSize:0)+'%';bar.append(fill);card.append(bar);
      card.append(el('span','readout-detail','Threshold '+info.threshold.toFixed(3)+(measurement?' · Peak margin '+signed(measurement.peakMargin):'')));
      card.append(el('span','readout-detail',measurement?.fired?'First spike '+measurement.spikeTimes[0].toFixed(2)+' s · '+measurement.latencyTicks[0]+' ticks':'First natural training spike · round '+this.memory.naturalEpochs[cue]));
      $('readout-cells').append(card);
    }
  }
  render(result,area){
    this.result=result;this.cards();
    $('output-status').textContent=result.readoutStatus==='silent'?'NO RESPONSE':result.readoutStatus==='ambiguous'?'MULTIPLE OUTPUTS':'LEARNED OUTPUT';
    area.append(el('div','result-badge '+result.status,result.matches.length?'Measured output-neuron firing':'Neither output neuron fired'));
    area.append(el('h3','result-word',result.response||'No response'));
    for(const match of result.matches)area.append(el('p','result-domain',match.name+' · '+match.spikeTimes[0].toFixed(2)+' s · '+match.coreCellsFired+'/'+match.coreSize+' core cells'));
    const mode={full:'Full cue','half-1':'Half 1','half-2':'Half 2',untrained:'Untrained cue'}[result.mode];
    area.append(el('p','response-evidence',mode+' · '+result.inputBits.length+'/8 features · '+(result.idleSeconds?'after 60 s':'immediate')));
    area.append(el('p','readout-codebook','Word label from the firing cell’s vocabulary ID.'));
    $('readout-note').textContent='Sent bits '+result.inputBits.join(', ')+' · '+result.trace.length+' measured spikes. Scrub the timeline or inspect an output below.';
  }
  select(id){for(const button of $('readout-shortcuts').children)button.setAttribute('aria-pressed',String(Number(button.dataset.neuronId)===id));}
  frame(time){if(!this.result)return;for(const card of [...$('readout-cells').children,...$('readout-shortcuts').children]){const o=this.result.outputs[card.dataset.outputCue];card.classList.toggle('firing',o.spikeTimes.some(t=>time>=t&&time-t<.06));}}
}
