import { VolumeView } from './volume.js';
import { Dashboard } from './dashboard.js';
import { ReadoutPanel } from './readout-panel.js';
import { potentialSeries } from './telemetry-model.mjs';
const $ = id => document.getElementById(id);
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
let data, memory, records = new Map(), domains = new Map(), selected = new Set(), draft = new Set(), scope = '', shown = 50;
let training = false, recalling = false, switching = false, pollTimer, lastTrace = [], toastTimer, handledJob;
let currentScene=null, inspectedNode=null, textLessons=[],lastResult=null;
const dashboard=new Dashboard(id=>view.select(id));
const view = new VolumeView($('volume'), {
  onHover(node, x, y) {
    const tooltip = $('node-tooltip'); tooltip.hidden = !node;
    if (!node) return;
    tooltip.textContent = node.label ?? (node.role === 'memory' ? (records.get(node.conceptId)?.word ?? 'Engram') + ' · cell ' + (node.member + 1) : 'Input neuron · feature ' + node.bit);
    tooltip.style.left = Math.min(x + 12, $('volume').clientWidth - 190) + 'px'; tooltip.style.top = Math.max(40, y - 30) + 'px';
  },
  onSelect(node) { inspectNode(node); },
  onReplay(text) { $('replay-label').textContent = text; },
  onFrame({time,playing,available}) {
    dashboard.frame(time);
    readoutPanel.frame(time);
    $('activity-time').disabled=!available;$('play-activity').disabled=!available;
    $('activity-time').value=Math.round(time/(view.duration??1)*1000);$('activity-clock').textContent=time.toFixed(2)+' / '+(view.duration??1).toFixed(2)+' s';
    $('play-activity').textContent=playing?'Ⅱ Pause':'▶ Play';$('play-activity').setAttribute('aria-label',playing?'Pause recorded activity':'Play recorded activity');
    if(inspectedNode) drawPotential();
  }
});
const readoutPanel=new ReadoutPanel({open:openReadout,probe:doRecall,inspect:id=>view.select(id)});
view.boundaries=true;
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = 'toast' + (error ? ' error' : ''); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 5000); }
async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'The request failed.'); return value;
}
function controls() {
  readoutPanel.sync(training||switching||recalling);
  for (const id of ['saved-button','import-button','edit-words','epochs','seed','text-button','teach-button','teach-submit','facts-button','fact-teach-button','fact-submit','facts-explore-button']) $(id).disabled = training || switching || recalling;
  $('train-button').disabled = training || switching || recalling || memory?.kind==='readout' || !selected.size;
  $('recall-word').disabled=memory?.kind==='readout'&&(recalling||switching);
  $('recall-submit').disabled = recalling || switching || !memory || (training&&['text','facts'].includes(memory?.kind));
  $('recall-submit').textContent = recalling ? 'Sensing…' : 'Send →';
  $('cancel-training').disabled = !training;
  $('download-button').hidden = !memory;
  document.querySelectorAll('[data-cue]').forEach(button => { button.disabled = $('recall-submit').disabled; });
}
function renderDomains() {
  $('domains').replaceChildren(); $('mobile-domain').replaceChildren();$('viewer-domain').replaceChildren();
  const shownDomains=memory?.kind==='readout'?[{id:'readout',name:'Shared memory pool'}]:data.domains;
  for (const domain of [{ id:'', name:memory?.kind==='readout'?'Whole circuit':'All domains' }, ...shownDomains]) {
    const count = (memory?.conceptIds ?? []).filter(id => !domain.id || records.get(id)?.domainId === domain.id).length;
    const button = element('button','domain-button'); button.setAttribute('aria-pressed', String(scope === domain.id));
    button.append(element('span','domain-dot'), element('span','',domain.name), element('span','count',String(count)));
    button.addEventListener('click', () => setScope(domain.id)); $('domains').append(button);
    const option = element('option','',domain.name); option.value = domain.id; $('mobile-domain').append(option);
    $('viewer-domain').append(option.cloneNode(true));
  }
  $('mobile-domain').value = scope; $('domain-total').textContent = data.domains.length;
  $('viewer-domain').value=scope;
}
function setScope(id) {
  dashboard.setDomain(id,domains.get(id)?.name);
  scope = id; view.setDomain(id); renderDomains(); renderSelection(); controls();
  const label = domains.get(id)?.name; $('volume-scope').textContent = label ? 'Inspecting: '+label : 'Single volume · all neurons';
  populateNeuronPicker();inspectNode(null);
  $('volume-caption').textContent = memory?.kind==='readout'?'Confirmed circuit · input features → memory assemblies → output cells':scope ? 'Inspection filter only · Sense Input still reaches all domains' : 'One volume · one Sense Input · one Output';
}
function renderSelection() {
  $('selection-count').textContent = selected.size;
  const pending = memory ? selected.size !== memory.conceptIds.length || memory.conceptIds.some(id => !selected.has(id)) : selected.size > 0;
  $('selection-note').textContent = pending ? 'Selection changed. Train to create a new memory.' : 'Choose up to eight meanings per domain. Each run starts a new memory.';
  $('selected-words').replaceChildren();
  const visible = [...selected].map(id => records.get(id)).filter(record => record && (!scope || record.domainId === scope));
  for (const record of visible) {
    const chip = element('button','word-chip'); chip.title = record.sense + ' · ' + domains.get(record.domainId)?.name; chip.append(element('i'), document.createTextNode(record.word));
    chip.addEventListener('click', () => { $('recall-word').value = record.word; $('recall-word').focus(); }); $('selected-words').append(chip);
  }
  if (!visible.length) $('selected-words').append(element('p','empty-message',scope ? 'No selected words in this domain. Use Edit words to add some.' : 'Choose words from the vocabulary to begin.'));
  controls();
}
function renderMemory() {
  const textMode=memory?.kind==='text',factMode=memory?.kind==='facts',readoutMode=memory?.kind==='readout';$('fact-learning').hidden=!factMode;$('facts-button').setAttribute('aria-pressed',String(factMode));$('text-learning').hidden=!textMode;$('vocabulary-learning').hidden=textMode||factMode||readoutMode;$('text-button').setAttribute('aria-pressed',String(textMode));
  readoutPanel.setMemory(memory);
  document.querySelector('.try-row').hidden=textMode||factMode||readoutMode;
  $('memory-name').textContent = memory?.name ?? 'No memory yet';
  $('memory-status').textContent = memory?.origin ?? 'Ready to begin';
  for (const [id,key] of [['metric-words','words'],['metric-domains','domains'],['metric-neurons','neurons'],['metric-rounds','epochs']]) $(id).textContent = memory?.[key]?.toLocaleString() ?? '—';
  $('volume-subtitle').textContent = memory ? memory.neurons.toLocaleString() + ' neurons · ' + memory.connections.toLocaleString() + ' synapses' : 'Actual neurons and stored connections';
  const evaluation = memory?.evaluation;
  $('evaluation-note').textContent = evaluation ? evaluation.exact + ' / ' + evaluation.total + ' taught meanings recalled exactly · Training-set check' : 'No recall evaluation recorded for this memory.';
  $('volume-empty').hidden = Boolean(memory?.neurons);$('volume-empty').textContent=factMode?'Teach a fact to build shared concept neurons.':textMode?'Teach a phrase to build the shared neural volume.':'Choose words and train a memory.'; renderDomains(); renderSelection();
}
async function refreshScene(resetSelection = true) {
  const value = await api('/api/scene');records=new Map(data.records.map(record=>[record.id,record]));for(const record of value.records??[])records.set(record.id,record); memory = value.memory;currentScene=value.scene; view.setScene(value.scene);dashboard.setScene(value.scene,memory);
  if(memory?.kind!=='readout'&&['formed','readout'].includes(view.edgeMode)){$('edge-mode').value='learned';view.edgeMode='learned';}
  if (resetSelection) selected = new Set(memory?.conceptIds ?? data.defaults);
  if(scope&&!currentScene?.regions.some(region=>region.domainId===scope))scope='';
  renderMemory(); setScope(scope); resetRecall();if(memory?.kind==='text')await refreshLessons();if(memory?.kind==='facts')await refreshFacts();
}
function resetRecall() {
  lastResult=null;
  view.clearActivity();
  lastTrace = []; $('replay-button').hidden = true;
  const idle = element('div','result-idle'); idle.append(element('span','idle-orbit','◎'),element('strong','', 'Awaiting Sense Input'),element('p','',memory?.kind==='facts'?'Teach a fact, then ask about it here.':memory?.kind==='text'?'Teach a phrase, then send its question here.':'Send a word to measure the network response.'));
  $('output-status').textContent='AWAITING INPUT';$('recall-result').replaceChildren(idle); $('replay-label').textContent = 'Inverted orbit · Shift-drag to pan';
}
function renderRecall(result) {
  lastResult=result;
  dashboard.setActivity(result);$('output-status').textContent=result.status==='recalled'?'ENGRAM RESPONSE':result.status==='ambiguous'?'MULTIPLE RESPONSES':result.status==='unsupported'?'UNSUPPORTED QUESTION':'NO MATCH';
  const area = $('recall-result'); area.replaceChildren();
  if(result.kind==='readout'){
    readoutPanel.render(result,area);
  }else if(result.kind==='text'||result.kind==='facts'){
    area.append(element('div','result-badge '+result.status,result.status==='recalled'?(result.kind==='facts'?'✓ Learned fact response':'✓ Learned text response'):result.status==='ambiguous'?'Multiple learned responses':result.status==='unsupported'?'Question pattern not supported':'No learned response'));
    if(result.status==='unknown')area.append(element('p','unknown-message',result.kind==='facts'?'I don’t know yet. No learned fact answered that question.':'I do not have a learned response for that phrasing.'));
    if(result.status==='unsupported')area.append(element('p','unknown-message','Try “What color is the lamp?”, “Where is the cup?”, or “What is the robin?”. See Facts & links for reverse questions.'));
    if(result.kind==='facts'&&result.status==='recalled')area.append(element('h3','result-word',result.response));
    for(const match of result.matches){const block=element('div','recall-match');if(result.kind!=='facts'||result.status!=='recalled')block.append(element('h3','result-word',match.word));block.append(element('p','result-domain',domains.get(match.domainId)?.name??'Text'));const tokens=element('div','decoded-tokens');for(const token of match.tokens){const chip=element('span','',token.text);chip.title='Output neuron #'+token.neuronId+' at '+token.time.toFixed(2)+' s';tokens.append(chip);}block.append(tokens);area.append(block);}
    area.append(element('p','response-evidence',(result.inputTokens?.length??0)+(result.kind==='facts'?' concept cues · ':' ordered input words · ')+result.trace.length+' measured spikes'));
  }else{
  area.append(element('div','result-badge ' + result.status,result.status === 'recalled' ? '✓ Memory recalled' : result.status === 'ambiguous' ? 'Multiple memories activated' : 'No complete memory'));
  if (result.status === 'unknown') {
    area.append(element('h3','result-word',result.word),element('p','unknown-message','No three-cell assembly completed for this cue. Try a taught word or train this meaning first.'));
    const partial = result.activated.filter(item => item.activeCells > 0);
    if (partial.length) area.append(element('p','result-domain',partial.length + ' assemblies showed partial activity.'));
  } else {
    if (result.matches.length > 1) area.append(element('p','unknown-message','The cue activated more than one meaning. Each domain response is listed below.'));
    for (const match of result.matches) {
      const block = element('div', result.matches.length > 1 ? 'recall-match' : '');
      block.append(element('h3','result-word',match.word), element('p','result-domain',domains.get(match.domainId)?.name + ' · ' + match.sense));
      const activation = element('div','activation-row'), cells = element('span','activation-cells');
      for (let index=0; index<match.assemblySize; index++) cells.append(element('i'));
      activation.append(cells,element('span','',match.activeCells + ' / ' + match.assemblySize + ' engram cells activated')); block.append(activation);
      block.append(element('div','reference-label','DICTIONARY REFERENCE'),element('p','result-gloss',match.gloss)); area.append(block);
    }
  }
  }
  if(!inspectedNode&&result.recalled.length){const id=result.kind==='readout'?result.recalled[0].id:result.kind==='facts'?result.recalled[0].gate:currentScene.concepts.find(c=>c.conceptId===result.recalled[0].conceptId)?.assembly[0];if(id&&(!scope||currentScene.nodes.find(n=>n.id===id)?.domainId===scope)){const cue=$('recall-word').value;view.select(id);$('recall-word').value=cue;}}
  lastTrace = result.trace; $('replay-button').hidden = !lastTrace.length; view.setActivity(result);
  if(inspectedNode){const word=$('recall-word').value;inspectNode(inspectedNode);$('recall-word').value=word;}
  $('volume-caption').textContent = result.trace.length + ' measured spikes · '+result.seconds.toFixed(2)+' seconds of simulated recall';
}
async function doRecall() {
  if (recalling || switching || !memory || training&&['text','facts'].includes(memory.kind)) return;
  const word = $('recall-word').value.trim(); if (!word) { $('recall-word').focus(); return; }
  recalling = true; controls();$('output-status').textContent='PROCESSING'; const memoryId = memory.id;
  try { const result = await api('/api/sense',{ word,...readoutPanel.request() }); if(memory?.id===memoryId&&result.memoryId===memoryId&&(!['text','facts'].includes(memory.kind)||memory.revision===result.revision))renderRecall(result);else{await refreshScene();toast('The active memory changed. Send the cue again.');} }
  catch (error) { $('output-status').textContent='INPUT FAILED';toast(error.message,true); }
  finally { recalling = false; controls(); }
}
function renderPicker() {
  const query = $('word-search').value.trim().toLowerCase(), domain = $('picker-domain').value;
  const filtered = data.records.filter(record => (!domain || record.domainId === domain) && (!query || [record.word,record.sense,record.gloss].join(' ').toLowerCase().includes(query)));
  const counts = new Map(); for (const id of draft) { const key = records.get(id)?.domainId; counts.set(key,(counts.get(key) ?? 0)+1); }
  $('word-list').replaceChildren(); $('picker-count').textContent = draft.size + ' selected · ' + filtered.length + ' matches';
  for (const record of filtered.slice(0,shown)) {
    const label = element('label','word-option'), check = element('input'); check.type='checkbox'; check.checked=draft.has(record.id); check.disabled=!check.checked&&(counts.get(record.domainId)??0)>=8;
    if (check.disabled) label.classList.add('disabled');
    const copy=element('div'); copy.append(element('strong','',record.word),document.createTextNode(' '),element('span','sense',record.sense),element('p','',record.gloss));
    check.addEventListener('change', () => { check.checked ? draft.add(record.id) : draft.delete(record.id); updatePickerChecks(); }); label.append(check,copy,element('span','domain-label',domains.get(record.domainId)?.name)); label.dataset.id=record.id; $('word-list').append(label);
  }
  if (!filtered.length) $('word-list').append(element('p','empty-message','No meanings match this search.'));
  $('more-words').hidden = filtered.length <= shown;
  function updatePickerChecks() {
    const nextCounts = new Map(); for (const id of draft) { const key=records.get(id)?.domainId; nextCounts.set(key,(nextCounts.get(key)??0)+1); }
    $('picker-count').textContent = draft.size + ' selected · ' + filtered.length + ' matches';
    $('word-list').querySelectorAll('.word-option').forEach(row => { const input=row.querySelector('input'), record=records.get(row.dataset.id); input.disabled=!input.checked&&(nextCounts.get(record.domainId)??0)>=8; row.classList.toggle('disabled',input.disabled); });
    $('picker-message').textContent=[...nextCounts.values()].some(count=>count>=8)?'A domain has reached its limit of 8 meanings.':'Up to 8 meanings per domain · 72 total';
  }
}
function showJob(job) {
  dashboard.job(job);
  training=job?.status==='running'; controls(); $('training-progress').hidden=!training;
  if (!training) return;
  const checking=job.stage==='checking';
  $('progress-label').textContent=checking?'Checking recall · '+(job.checked??0)+' / '+job.totalWords:'Training · round '+job.epoch+' / '+job.total;
  $('progress-bar').value=checking?90+10*(job.checked??0)/job.totalWords:90*job.epoch/job.total;
  $('progress-note').textContent=checking?'Testing the taught words without teaching signals.':'Strengthening connections. Your current memory is still available.';
}
async function pollJob() {
  clearTimeout(pollTimer);
  try {
    const {job}=await api('/api/job'); $('connection-status').textContent='Local engine ready'; showJob(job);
    if (job?.status==='running') { pollTimer=setTimeout(pollJob,700); return; }
    if (job && handledJob!==job.id) {
      handledJob=job.id;
      if (job.status==='complete') { await refreshScene(); toast(job.warning ?? (job.kind==='facts'?'Fact saved. Forward and reverse retention checks passed.':job.kind==='text'?'Lesson saved. Earlier lessons passed recall.':'Training complete. Your new memory is saved locally.'),Boolean(job.warning)); }
      else if (job.status==='failed') toast(job.error,true);
      else if (job.status==='cancelled') toast('Training cancelled. Your previous memory is still open.');
    }
  } catch (error) { $('connection-status').textContent='Connection interrupted'; toast('Could not check training. Reconnecting…',true); pollTimer=setTimeout(pollJob,2500); }
}
async function startTraining() {
  const epochs=Number($('epochs').value),seed=Number($('seed').value);
  if (!$('epochs').reportValidity() || !$('seed').reportValidity()) return;
  training=true; controls();
  try { const job=await api('/api/train',{ conceptIds:[...selected],epochs,seed }); showJob(job); pollJob(); }
  catch(error) { training=false; controls(); toast(error.message,true); }
}
async function openMemory(id) {
  switching=true; controls();
  try { await api('/api/load',{id}); await refreshScene(); if(memory?.kind==='readout')$('recall-word').value=memory.cues.A; $('saved-dialog').close(); toast('Memory opened.'); }
  catch(error) { toast(error.message,true); }
  finally { switching=false; controls(); }
}
async function openReadout(seed=1){
  if(training||switching||recalling)return;
  switching=true;controls();
  try{await api('/api/readout/open',{seed});await refreshScene();$('recall-word').value=memory.cues.A;readoutPanel.sync(true);toast('Learned memory ready · Seed '+seed);}
  catch(error){toast(error.message,true);}
  finally{switching=false;controls();}
}
async function showSaved() {
  try {
    const {runs}=await api('/api/runs'); $('saved-list').replaceChildren();
    const options=[...(data.readout?.cells??[]).map(cell=>({id:cell.id,kind:'readout',name:'Learned memory · Seed '+cell.seed,words:2,domains:1})),...(data.demoAvailable?[{id:'demo',name:'18-word pilot',words:18,domains:9,createdAt:'Original development memory'}]:[]),...runs];
    for(const run of options) {
      const row=element('div','saved-row'+(memory?.id===run.id?' active':'')),copy=element('div');
      copy.append(element('strong','',run.name),element('small','',run.kind==='readout'?'2 self-formed memories · confirmed readout · epoch 70':run.words+(run.kind==='facts'?' facts':run.kind==='text'?' lessons':' meanings')+' · '+run.domains+' domains · '+(['text','facts'].includes(run.kind)?'Autosaved · revision '+run.revision:run.id==='demo'?run.createdAt:new Date(run.createdAt).toLocaleString())));
      const button=element('button','button outline',memory?.id===run.id?'Open now':'Open'); button.disabled=memory?.id===run.id; button.addEventListener('click',()=>openMemory(run.id)); row.append(copy,button); $('saved-list').append(row);
    }
    if(!options.length) $('saved-list').append(element('p','empty-message','Completed training runs will appear here.'));
    $('saved-dialog').showModal();
  } catch(error) { toast(error.message,true); }
}
$('mobile-domain').addEventListener('change',event=>setScope(event.target.value));
$('viewer-domain').addEventListener('change',event=>setScope(event.target.value));
$('recall-form').addEventListener('submit',event=>{event.preventDefault();doRecall();});
document.querySelectorAll('[data-cue]').forEach(button=>button.addEventListener('click',()=>{$('recall-word').value=button.dataset.cue;doRecall();}));
$('reset-view').addEventListener('click',()=>view.reset());
$('zoom-in').addEventListener('click',()=>view.zoom(1.2)); $('zoom-out').addEventListener('click',()=>view.zoom(.8));
$('connections-button').addEventListener('click',()=>{const value=$('connections-button').getAttribute('aria-pressed')!=='true';$('connections-button').setAttribute('aria-pressed',String(value));view.setConnections(value);});
$('replay-button').addEventListener('click',()=>{view.seek(0);view.play();});
$('edit-words').addEventListener('click',()=>{draft=new Set(selected);shown=50;$('word-search').value='';$('picker-domain').value=scope;renderPicker();$('word-dialog').showModal();$('word-search').focus();});
$('word-search').addEventListener('input',()=>{shown=50;renderPicker();}); $('picker-domain').addEventListener('change',()=>{shown=50;renderPicker();});
$('more-words').addEventListener('click',()=>{shown+=50;renderPicker();});
$('use-starter').addEventListener('click',()=>{draft=new Set(data.defaults);renderPicker();}); $('clear-selection').addEventListener('click',()=>{draft.clear();renderPicker();});
$('apply-words').addEventListener('click',()=>{selected=new Set(draft);renderSelection();$('word-dialog').close();});
$('train-button').addEventListener('click',startTraining);
$('cancel-training').addEventListener('click',async()=>{try{$('cancel-training').disabled=true;await api('/api/train/cancel',{});pollJob();}catch(error){toast(error.message,true);controls();}});
$('saved-button').addEventListener('click',showSaved);
$('import-button').addEventListener('click',()=>$('import-file').click());
$('import-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  switching=true;controls();
  try {if(file.size>8*1024*1024)throw new Error('Choose a memory file smaller than 8 MB.');const imported=JSON.parse(await file.text());await api('/api/import',{memory:imported,name:file.name.replace(/\.json$/i,'')});await refreshScene();toast('Memory imported and saved locally.');}
  catch(error){toast(error.message,true);}finally{switching=false;controls();event.target.value='';}
});
$('help-button').addEventListener('click',()=>$('help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close();}}));
function populateNeuronPicker() {
  $('neuron-picker').replaceChildren();const blank=element('option','','Choose a neuron');blank.value='';$('neuron-picker').append(blank);
  for(const node of currentScene?.nodes??[]) {
    if(scope&&node.domainId!==scope)continue;
    const option=element('option','','#'+node.id+' · '+(node.label??(node.role==='memory'?(records.get(node.conceptId)?.word??'Engram')+' / cell '+(node.member+1):'Input '+node.bit)));option.value=node.id;$('neuron-picker').append(option);
  }
}
function inspectNode(node) {
  readoutPanel.select(node?.id??null);
  dashboard.setNeuron(node);
  inspectedNode=node;$('inspect-content').replaceChildren();$('inspect-dynamic').hidden=!node;$('focus-neuron').disabled=!node;$('clear-neuron').disabled=!node;$('neuron-picker').value=node?.id??'';
  $('inspect-title').textContent=node?'Neuron #'+node.id:scope?(domains.get(scope)?.name??'Domain'):'Shared volume';
  const stats=element('div','inspect-stats');
  const stat=(label,value)=>{const item=element('div');item.append(element('span','',label),element('strong','',String(value)));stats.append(item);};
  if(!node) {
    const nodes=(currentScene?.nodes??[]).filter(item=>!scope||item.domainId===scope),ids=new Set(nodes.map(item=>item.id));
    $('inspect-description').textContent='Click a neuron or choose one below. Scroll to zoom inside; Shift-drag to pan.';
    stat('Neurons',nodes.length.toLocaleString());stat('Synapses',(currentScene?.edges??[]).filter(edge=>ids.has(edge.source)).length.toLocaleString());
    if(memory?.kind==='readout'){stat('Reference memories',2);stat('Shared core cells',nodes.filter(n=>n.memberships?.length===2).length);}else{stat('Logical domains',scope?1:currentScene?.regions.length??0);stat('Cross-domain links',0);}
    $('inspect-content').append(stats,element('p','isolation-note',memory?.kind==='readout'?'One shared pool, two self-formed assemblies. Colors mark frozen reference membership. Both output cells occupy the circuit center; labels point to their actual position.':scope?'These neurons belong to one logical domain and are spread through the common volume. Sense Input reaches every domain.':'All neurons inhabit one continuous volume. Domains are logical memberships with isolated learning and recall, not separate spheres.'));
    return;
  }
  const record=records.get(node.conceptId),incoming=currentScene.edges.filter(edge=>edge.target===node.id),outgoing=currentScene.edges.filter(edge=>edge.source===node.id);
  $('inspect-description').textContent=(domains.get(node.domainId)?.name??'')+' · '+(node.label??(node.role==='memory'?'Engram cell '+(node.member+1)+' for “'+record?.word+'”':'Word feature '+node.bit));
  stat('Base threshold',node.threshold.toFixed(3));stat('Leak / second',node.leakRate.toFixed(2));stat('Inputs',incoming.length);stat('Outputs',outgoing.length);
  const measured=Object.values(lastResult?.outputs??{}).find(o=>o.id===node.id);
  if(measured){stat('Peak membrane margin',measured.peakMargin.toFixed(3));stat('Core cells active',measured.coreCellsFired+' / '+measured.coreSize);stat('First spike',measured.fired?measured.spikeTimes[0].toFixed(2)+' s':'Silent');}
  $('inspect-content').append(stats,element('p','','Position '+[node.x,node.y,node.z].map(n=>n.toFixed(1)).join(' / ')));
  const edges=[...incoming,...outgoing].sort((a,b)=>Math.abs(b.weight)-Math.abs(a.weight));
  if(edges.length){const list=element('div','synapse-list');list.append(element('h4','','Strongest synapses · '+Math.min(8,edges.length)+' / '+edges.length));for(const edge of edges.slice(0,8)){const other=edge.source===node.id?edge.target:edge.source,button=element('button');button.append(element('span','',(edge.source===node.id?'→ ':'← ')+'#'+other),element('span','',edge.weight.toFixed(3)+' · '+(edge.delay*1000).toFixed(0)+' ms'));button.title='Inspect neuron '+other+' · weight and transmission delay';button.addEventListener('click',()=>view.select(other));list.append(button);}$('inspect-content').append(list);}
  if(record&&memory?.kind!=='readout')$('recall-word').value=record.word;
  drawPotential();
}
function drawPotential() {
  if(!inspectedNode)return;
  $('potential-value').textContent=view.currentPotential(inspectedNode.id).toFixed(3);
  const canvas=$('membrane-plot'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,pad=14;
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#071923';ctx.fillRect(0,0,w,h);
  if(!view.samples.length){ctx.fillStyle='#7d929e';ctx.font='18px Segoe UI';ctx.fillText('Run recall to record this neuron',pad,h/2);return;}
  const values=potentialSeries(view.samples,inspectedNode,lastResult?.outputs);
  const top=Math.max(inspectedNode.threshold*1.2,...values.map(p=>p.value),.1),bottom=Math.min(0,...values.map(p=>p.value)),y=value=>h-pad-(value-bottom)/(top-bottom)*(h-pad*2),x=time=>pad+time/(view.duration??1)*(w-pad*2);
  ctx.strokeStyle='#a4b9c3';ctx.setLineDash([6,5]);ctx.beginPath();values.forEach((p,i)=>i?ctx.lineTo(x(p.time),y(p.threshold??inspectedNode.threshold)):ctx.moveTo(x(p.time),y(p.threshold??inspectedNode.threshold)));ctx.stroke();ctx.setLineDash([]);
  document.querySelector('.plot-note').textContent=inspectedNode.role==='output'?'Native pre-reset potential · dashed: effective threshold · amber: spikes':'Recorded samples · dashed: threshold · amber: spikes';
  ctx.strokeStyle='#61cbd0';ctx.lineWidth=2;ctx.beginPath();values.forEach((point,index)=>index?ctx.lineTo(x(point.time),y(point.value)):ctx.moveTo(x(point.time),y(point.value)));ctx.stroke();
  for(const event of view.trace.filter(event=>event.neuronId===inspectedNode.id)){ctx.strokeStyle='#d6a148';ctx.beginPath();ctx.moveTo(x(event.time),pad);ctx.lineTo(x(event.time),h-pad);ctx.stroke();}
  ctx.strokeStyle='#90bed0';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x(view.time),0);ctx.lineTo(x(view.time),h);ctx.stroke();
}
$('neuron-picker').addEventListener('change',event=>view.select(event.target.value?Number(event.target.value):null));
$('focus-neuron').addEventListener('click',()=>view.focusSelected());$('clear-neuron').addEventListener('click',()=>view.select(null));
$('focus-domain').addEventListener('click',()=>view.focusDomain());
$('edge-mode').addEventListener('change',event=>{view.edgeMode=event.target.value;view.draw();});
$('boundaries').addEventListener('change',event=>{view.boundaries=event.target.checked;view.draw();});
$('invert-drag').addEventListener('change',event=>{view.inverted=event.target.checked;});
$('cut-depth').addEventListener('input',event=>{view.cut=Number(event.target.value)/100;$('cut-label').textContent=event.target.value+'%';view.draw();});
$('activity-time').addEventListener('input',event=>view.seek(Number(event.target.value)/1000*(view.duration??1)));
$('play-activity').addEventListener('click',()=>view.togglePlayback());
$('replay-speed').addEventListener('change',event=>{const playing=view.playing;view.seek(view.time);view.speed=Number(event.target.value);if(playing)view.play();});
const volumeHome=document.createComment('Volume viewer home');$('volume-panel').before(volumeHome);
const inspector=document.querySelector('.neuron-inspector'),inspectorHome=document.createComment('Inspector home');inspector.before(inspectorHome);
$('overview-button').addEventListener('click',()=>{setScope('');view.boundaries=true;$('boundaries').checked=true;view.reset();});
$('detail-button').addEventListener('click',()=>{view.boundaries=true;$('boundaries').checked=false;view.cellView();});
$('expand-volume').addEventListener('click',()=>{
  if($('volume-dialog').open){$('volume-dialog').close();return;}
  $('volume-dialog').append($('volume-panel'));document.querySelector('.volume-body').append(inspector);$('expand-volume').textContent='↙ Exit';$('expand-volume').setAttribute('aria-expanded','true');$('volume-dialog').showModal();$('volume').focus();
});
$('volume-dialog').addEventListener('close',()=>{volumeHome.after($('volume-panel'));inspectorHome.after(inspector);$('expand-volume').textContent='⛶';$('expand-volume').setAttribute('aria-expanded','false');$('expand-volume').focus();});
async function refreshLessons(){
  const value=await api('/api/text');textLessons=value.lessons;$('text-count').textContent=textLessons.length;$('text-lessons').replaceChildren();$('lesson-list').replaceChildren();
  $('text-save-state').textContent=textLessons.length?'Saved on this computer · revision '+value.memory.revision:'Teach your first phrase to build the volume.';
  for(const lesson of textLessons){const button=element('button','lesson-row');button.append(element('strong','',lesson.question),element('span','',lesson.answer));button.addEventListener('click',()=>{$('recall-word').value=lesson.question;$('lessons-dialog').close();$('recall-word').focus();});$('lesson-list').append(button);const chip=element('button','word-chip',lesson.question);chip.addEventListener('click',()=>{$('recall-word').value=lesson.question;$('recall-word').focus();});$('text-lessons').append(chip);}
  if(!textLessons.length)$('lesson-list').append(element('p','empty-message','No phrases taught yet. Use Teach a phrase to begin.'));
}
$('text-button').addEventListener('click',async()=>{switching=true;controls();try{await api('/api/text/open',{});await refreshScene();}catch(error){toast(error.message,true);}finally{switching=false;controls();}});
$('teach-button').addEventListener('click',()=>{$('teach-dialog').showModal();$('teach-question').focus();});
$('lessons-button').addEventListener('click',async()=>{try{await refreshLessons();$('lessons-dialog').showModal();}catch(error){toast(error.message,true);}});
$('teach-example').addEventListener('click',()=>{$('teach-question').value='What color is the lamp?';$('teach-answer').value='blue';$('teach-domain').value='005';});
$('teach-form').addEventListener('submit',async event=>{event.preventDefault();training=true;controls();try{const job=await api('/api/text/teach',{question:$('teach-question').value,answer:$('teach-answer').value,domainId:$('teach-domain').value});$('teach-dialog').close();showJob(job);pollJob();}catch(error){training=false;controls();toast(error.message,true);}});

function cueFact(question) {
  $('facts-dialog').close();$('recall-word').value=question;$('recall-word').focus();doRecall();
}
async function refreshFacts(){
  const value=await api('/api/facts');$('fact-count').textContent=value.facts.length;$('fact-list').replaceChildren();$('fact-preview').replaceChildren();$('fact-history-list').replaceChildren();
  $('fact-save-state').textContent=value.facts.length?'Autosaved · revision '+value.memory.revision+' · '+value.memory.sharedConcepts+' shared concepts':'Teach your first fact to build shared concepts.';
  for(const fact of value.facts){
    const row=element('article','fact-card'),line=element('div','fact-chain');
    for(const [text,key] of [[fact.subject,fact.subjectKey],[fact.relation,fact.relationKey],[fact.object,fact.valueKey]]){
      const concept=currentScene.sharedConcepts.find(c=>c.key===key),button=element('button','concept-pill',text);
      button.title='Shared concept: cue #'+concept.cue+', readout #'+concept.readout;
      button.addEventListener('click',()=>{$('facts-dialog').close();setScope(fact.domainId);view.select(concept.cue);});line.append(button);
    }
    row.append(line,element('small','fact-domain-label',domains.get(fact.domainId)?.name??fact.domainId));
    const actions=element('div','fact-actions');
    for(const [label,question] of [['Ask value',fact.questions.forward],['Find objects',fact.questions.reverse]]){const button=element('button','',label);button.title=question;button.addEventListener('click',()=>cueFact(question));actions.append(button);}
    const inspect=element('button','','Inspect engram');inspect.addEventListener('click',()=>{$('facts-dialog').close();setScope(fact.domainId);view.select(fact.forward);$('edge-mode').value='selected';view.edgeMode='selected';view.focusSelected();});actions.append(inspect);
    const correct=element('button','','Correct');correct.addEventListener('click',()=>{$('facts-dialog').close();$('fact-statement').value=fact.statement;$('fact-domain').value=fact.domainId;$('fact-teach-dialog').showModal();$('fact-statement').focus();});actions.append(correct);row.append(actions);$('fact-list').append(row);
    const preview=element('button','fact-preview-row',fact.subject+' → '+fact.relation+' → '+fact.object);preview.title=fact.questions.forward;preview.addEventListener('click',()=>cueFact(fact.questions.forward));$('fact-preview').append(preview);
  }
  if(!value.facts.length)$('fact-list').append(element('p','empty-message','No facts yet. Teach a color, location, or category to begin.'));
  for(const item of [...value.history].reverse())$('fact-history-list').append(element('p','',item.subject+' · '+item.relation+': '+item.object+' → '+item.replacement+' · revision '+item.replacedAtRevision+' · '+(domains.get(item.domainId)?.name??item.domainId)));
  if(!value.history.length)$('fact-history-list').append(element('p','','No corrections yet.'));
}
$('facts-button').addEventListener('click',async()=>{switching=true;controls();try{await api('/api/facts/open',{});await refreshScene();}catch(error){toast(error.message,true);}finally{switching=false;controls();}});
$('fact-teach-button').addEventListener('click',()=>{$('fact-statement').value='';$('fact-teach-dialog').showModal();$('fact-statement').focus();});
$('facts-explore-button').addEventListener('click',async()=>{try{await refreshFacts();$('facts-dialog').showModal();}catch(error){toast(error.message,true);}});
document.querySelectorAll('[data-fact-example]').forEach(button=>button.addEventListener('click',()=>{$('fact-statement').value=button.dataset.factExample;$('fact-statement').focus();}));
$('fact-teach-form').addEventListener('submit',async event=>{event.preventDefault();training=true;controls();try{const job=await api('/api/facts/teach',{statement:$('fact-statement').value,domainId:$('fact-domain').value});$('fact-teach-dialog').close();showJob(job);pollJob();}catch(error){training=false;controls();toast(error.message,true);}});

async function boot() {
  try {
    data=await api('/api/bootstrap');data.readout=await api('/api/readout');readoutPanel.setCatalog(data.readout);records=new Map(data.records.map(record=>[record.id,record]));domains=new Map([...data.domains.map(domain=>[domain.id,domain]),['readout',{id:'readout',name:'Shared memory pool'}]]);
    $('picker-domain').replaceChildren();for(const domain of [{id:'',name:'All domains'},...data.domains]){const option=element('option','',domain.name);option.value=domain.id;$('picker-domain').append(option);}
    $('teach-domain').replaceChildren();for(const domain of data.domains){const option=element('option','',domain.name);option.value=domain.id;$('teach-domain').append(option);}$('teach-domain').value='005';
    $('fact-domain').replaceChildren();for(const domain of data.domains){const option=element('option','',domain.name);option.value=domain.id;$('fact-domain').append(option);}$('fact-domain').value='007';
    await refreshScene();$('connection-status').textContent='Local engine ready';dashboard.log('NEURON MORPHOLOGY','Original soma / axon / dendrite geometry loaded','success');view.reset();$('recall-word').value=currentScene?.concepts[0]?.word??'';controls();
    if(data.job?.status==='running'){showJob(data.job);pollJob();}else handledJob=data.job?.id;
  } catch(error) { $('connection-status').textContent='Unable to connect';$('memory-name').textContent='Start the local engine';toast(error.message+'. Refresh to reconnect.',true); }
}
boot();
