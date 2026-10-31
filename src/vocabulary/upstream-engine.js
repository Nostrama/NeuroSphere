(function(root){
 'use strict';
 const normalize=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();
 const words=s=>normalize(s).split(/\s+/).filter(Boolean);
 const contains=(text,phrase)=>(' '+text+' ').includes(' '+normalize(phrase)+' ');
 const unique=values=>[...new Set(values)];
 const emptyContext=()=>({lastId:null,subjectIds:[],lastIntent:null,lastOutcome:null,pending:null,turns:0,history:[]});
 function intentDefaults(){return {
  define:{id:'101',label:'Define',phrases:['define','definition','meaning of','what does','what is','what are','tell me about']},
  associate:{id:'102',label:'Associate',phrases:['related','associated','associations','association','connections','connection','connected','similar','neighbors','neighbours']},
  compare:{id:'103',label:'Compare',phrases:['compare','comparison','difference','differences','different','differ','same','versus','vs','contrast','distinguish']},
  correct:{id:'104',label:'Correct',phrases:['i meant','i mean','correction','instead of','replace']},
  clarify:{id:'105',label:'Clarify',phrases:['clarify','explain that','explain it','what do you mean','what does that mean','more clearly']}
 };}
 function upgrade(m){
  if(m?.version!==1&&m?.version!==2)throw Error('Expected a version 1 or 2 concept brain.');
  if(m.version===1){
   m.version=2;m.intents=intentDefaults();m.context={...emptyContext(),...m.context,subjectIds:m.context?.lastId?[m.context.lastId]:[],lastIntent:m.context?.lastId?'define':null,pending:null};
   m.comparisons=[];
   const note=(a,b,text,as='primary',bs='primary')=>{const left=m.concepts?.find(c=>c.word===a&&c.sense===as),right=m.concepts?.find(c=>c.word===b&&c.sense===bs);if(left&&right)m.comparisons.push({ids:[left.id,right.id],text});};
   note('abate','abolish','Abate means making something less strong; abolish means putting an end to it. A reduction is different from an ending.');
   note('ability','able','Ability names the capacity itself. Able describes someone or something that has that capacity.');
   note('abandon','abdicate','Abandon has the broader sense of giving up or leaving. Abdicate specifically concerns giving up a throne, duty, or right.');
   note('abbot','abbess','Both are community leaders: an abbot heads a community of monks, while an abbess heads a community of nuns.');
   note('abhor','abhorrence','Abhor is the action of detesting; abhorrence names the feeling of disgust or detestation.');
   note('abacus','abacus','These are two meanings of the same spelling: a calculating frame and an architectural slab. They are stored at separate addresses.','primary','architecture');
  }
  return m;
 }
 function validate(m){
  if(!m||m.version!==2||!Array.isArray(m.concepts)||m.concepts.length<1||m.concepts.length>10000)throw Error('Expected a version 2 concept brain with 1–10,000 concepts.');
  if(!m.domains||!m.context||!m.templates||!m.settings||!m.intents||!Array.isArray(m.comparisons))throw Error('Missing knowledge, intent rules, settings, or context.');
  const ids=new Set(),intentNames=Object.keys(intentDefaults());
  for(const c of m.concepts){
   if(!c||!/^\d{3}-\d{3}-\d{3}$/.test(c.id)||ids.has(c.id))throw Error('Each concept needs a unique 000-000-000 address.');ids.add(c.id);
   if(![c.word,c.gloss,c.sense,c.source].every(v=>typeof v==='string')||!Array.isArray(c.cues)||!c.cues.every(v=>typeof v==='string')||!Array.isArray(c.links))throw Error('Invalid concept fields.');
   if(c.cueWeights&&Object.values(c.cueWeights).some(w=>!Number.isFinite(w)||w<0||w>3.4))throw Error('Invalid cue weight.');
   const [d,b]=c.id.split('-');if(typeof m.domains[d]?.name!=='string'||typeof m.domains[d]?.branches?.[b]!=='string')throw Error('Address has no matching domain and branch.');
  }
  for(const c of m.concepts)for(const e of c.links)if(!e||!ids.has(e.to)||!Number.isFinite(e.weight)||e.weight<0||e.weight>1||typeof e.relation!=='string')throw Error('Invalid association: target must exist and weight must be 0–1.');
  for(const k of ['threshold','propagation','treeBoost','contextBoost'])if(!Number.isFinite(m.settings[k])||m.settings[k]<0||m.settings[k]>20)throw Error('Invalid scoring setting.');
  for(const k of ['unknown','greeting','negated','noContext'])if(typeof m.templates[k]!=='string')throw Error('Invalid response template.');
  for(const name of intentNames){const rule=m.intents[name];if(!rule||!/^\d{3}$/.test(rule.id)||typeof rule.label!=='string'||!Array.isArray(rule.phrases)||!rule.phrases.every(p=>typeof p==='string'&&p.trim()))throw Error('Invalid intent rules.');}
  for(const note of m.comparisons)if(!note||!Array.isArray(note.ids)||note.ids.length!==2||!note.ids.every(id=>ids.has(id))||typeof note.text!=='string')throw Error('Invalid comparison note.');
  const ctx=m.context;
  if(ctx.lastId!==null&&!ids.has(ctx.lastId))throw Error('Unknown context address.');
  if(!Array.isArray(ctx.subjectIds)||ctx.subjectIds.length>4||!ctx.subjectIds.every(id=>ids.has(id)))throw Error('Invalid conversation subjects.');
  if(ctx.lastIntent!==null&&!intentNames.includes(ctx.lastIntent))throw Error('Invalid previous intent.');
  if(!Number.isInteger(ctx.turns)||ctx.turns<0||!Array.isArray(ctx.history)||ctx.history.length>12)throw Error('Invalid conversation state.');
  if(ctx.pending!==null){const p=ctx.pending;if(!p||!['sense','subject','intent','correction'].includes(p.type)||!Array.isArray(p.slots)||p.slots.length>4||!p.slots.every(s=>s&&Array.isArray(s.ids)&&s.ids.every(id=>ids.has(id))&&typeof s.label==='string')||!intentNames.includes(p.action)||!intentNames.includes(p.turnIntent)||typeof p.reason!=='string'||typeof p.contextUsed!=='boolean')throw Error('Invalid pending clarification.');
   if(p.replaceIn&&(!Array.isArray(p.replaceIn)||!p.replaceIn.every(id=>ids.has(id))))throw Error('Invalid correction context.');
   if(p.replaceIndex!==undefined&&p.replaceIndex!==null&&(!Number.isInteger(p.replaceIndex)||p.replaceIndex<0||p.replaceIndex>=(p.replaceIn?.length||0)))throw Error('Invalid correction target.');
  }
  return m;
 }
 function mergeVocabulary(m,seed){
  validate(m);validate(seed);
  const existing=new Map(m.concepts.map(c=>[c.id,c]));
  // Refuse address collisions before changing anything. User weights, wording,
  // intent rules, and dialogue state are otherwise retained.
  for(const c of seed.concepts){const prior=existing.get(c.id);if(prior&&(normalize(prior.word)!==normalize(c.word)||prior.sense!==c.sense))throw Error(`Vocabulary address ${c.id} belongs to a different meaning in this imported string.`);}
  const addedIds=new Set(seed.concepts.filter(c=>!existing.has(c.id)).map(c=>c.id));
  for(const [id,domain] of Object.entries(seed.domains)){
   if(!m.domains[id])m.domains[id]=JSON.parse(JSON.stringify(domain));
   else for(const [branch,name] of Object.entries(domain.branches))if(!m.domains[id].branches[branch])m.domains[id].branches[branch]=name;
  }
  for(const c of seed.concepts){
   const prior=existing.get(c.id);
   if(!prior)m.concepts.push(JSON.parse(JSON.stringify(c)));
   else {for(const link of c.links)if(addedIds.has(link.to)&&!prior.links.some(e=>e.to===link.to))prior.links.push({...link});
    for(const field of ['sourceKey','entryHeadword','sourceLines','origin','categoryBasis','cueWeights'])if(prior[field]===undefined&&c[field]!==undefined)prior[field]=JSON.parse(JSON.stringify(c[field]));
   }
  }
  for(const note of seed.comparisons)if(!m.comparisons.some(n=>[...n.ids].sort().join('|')===[...note.ids].sort().join('|')))m.comparisons.push(JSON.parse(JSON.stringify(note)));
  m.vocabularyRevision=Math.max(m.vocabularyRevision||1,seed.vocabularyRevision||1);
  m.selection=seed.selection;
  if(seed.corpus)m.corpus=JSON.parse(JSON.stringify(seed.corpus));
  m.notes=seed.notes;
  m.templates.unknown=m.templates.unknown.replace(/\b\d+-word vocabulary\b/g,'current vocabulary');
  return validate(m);
 }
 function create(encoded){
  // The sole authoritative mutable bot state. Parsed structures are temporary.
  let brain=JSON.stringify(validate(upgrade(JSON.parse(encoded))));
  const snapshot=()=>JSON.parse(brain);
  function decode(input){
   input=String(input).trim();
   if(!input)return {kind:'empty',reply:'Enter a word, description, or request.',ranked:[],tokens:[],subjectIds:[],choices:[]};
   if(input.length>1500)throw Error('Please keep each message under 1,500 characters.');
   const m=snapshot(),ctx=m.context,text=normalize(input),byId=new Map(m.concepts.map(c=>[c.id,c]));
   let ranked=[],plan=null,result=null;
   const has=(intent,t=text)=>m.intents[intent].phrases.some(p=>contains(t,p));
   const refs=/\b(that|it|this|those|these|them|both|previous|two)\b/.test(text);
   let negative=/\b(not|never|no|dont|isnt|arent|cant|cannot|wont)\b/.test(text);
   const quotedRequest=/\b(?:dont|do not|never) (?:define|compare|explain|show|find|list|clarify)\b/.test(text);
   let unsupported=/\b(translate|translation|pronounce|pronunciation|compose|write|recommend|advise|calculate)\b/.test(text);
   function rank(query){
    // "about" is now a vocabulary entry, but also part of request wording.
    // Remove that grammatical occurrence only; "define about" still names it.
    let normalized=normalize(query).replace(/\b(?:tell me(?: more)?|tell us|talk|what|how|more|information) about\b/g,' ');
    if(m.intents.clarify.phrases.some(p=>normalize(p)===normalize(query)))normalized='';
    const addressList=query.match(/\b\d{3}-\d{3}-\d{3}\b/g)||[];
    let requested=normalized.match(/^(?:please )?(?:define|definition of|meaning of|what is|what are|what does|explain|a word for|word for|a word meaning)\s+(.+)$/)?.[1];
    if(requested&&/^(?:please )?what does\b/.test(normalized))requested=requested.replace(/ mean$/,'');
    let target=(requested||normalized).trim();
    if(requested&&m.concepts.some(c=>normalize(c.word)===target.replace(/^an? /,'')))target=target.replace(/^an? /,'');
    const literalTarget=m.concepts.some(c=>normalize(c.word)===target&&!/^[-]|[-]$/.test(c.word));
    if(requested)normalized=target;
    if(!literalTarget)normalized=normalized.replace(/\b(?:how are|what are|what is|are|compare|comparison|contrast|difference between|differences between|the same|different|related to|related|associated with|associations|association|connections|connected|clarify|explain that|explain it|more clearly|those two)\b/g,' ');
    const grammatical=new Set(['a','an','and','are','as','at','all','any','am','about','after','again','also','another','around','away','answer','ask','association','associations','associated','anything','anyone','anybody','along','already','always','almost','although']);
    const quoted=[...query.matchAll(/["“]([^"”]+)["”]/g)].map(x=>x[1].toLowerCase());
    const rawTarget=query.trim().replace(/^(?:please )?(?:define|definition of|meaning of|what is|what are|what does|explain|tell me about)\s+/i,'').replace(/\s+mean[?.!]*$/i,match=>/^(?:please )?what does\b/i.test(query)?'':match).replace(/^["“]|["”]$/g,'').trim();
    const fold=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    let literalWords=m.concepts.filter(c=>fold(c.word)===fold(rawTarget));
    if(!literalWords.length)literalWords=m.concepts.filter(c=>fold(c.word)===fold(rawTarget.replace(/[?.!]+$/,'')));
    const matches=m.concepts.filter(c=>{
     if(literalWords.length)return literalWords.includes(c);
     if(/^[-]|[-]$/.test(c.word))return query.trim().toLowerCase()===c.word||quoted.includes(c.word)||new RegExp('(?:^|\\s)'+c.word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[\\s?.!])','i').test(query)&&/\b(?:define|meaning|prefix|suffix)\b/i.test(query);
     const word=normalize(c.word);
     return contains(normalized,word)&&(!grammatical.has(word)||target===word||quoted.some(q=>normalize(q)===word));
    });
    const explicit=matches.filter(c=>!matches.some(other=>normalize(other.word)!==normalize(c.word)&&contains(normalize(other.word),c.word)&&normalize(other.word).length>normalize(c.word).length));
    const explicitIds=new Set(explicit.map(c=>c.id));
    const scores=m.concepts.map(c=>{
     const reasons=[];let direct=0;
     if(addressList.includes(c.id)){direct+=100;reasons.push({label:'Exact numerical address',points:100});}
     if(explicitIds.has(c.id)){direct+=8;reasons.push({label:`Word match: ${c.word}`,points:8});}
     for(const cue of c.cues)if(contains(normalized,cue)){const points=c.cueWeights?.[cue]??(normalize(cue).includes(' ')?3.4:2.6);direct+=points;reasons.push({label:`${c.origin==='imported'?'Dictionary term':'Phrase'}: ${cue}`,points});}
     if(c.sense==='architecture'&&contains(normalized,'architectural')){direct+=3.4;reasons.push({label:'Architectural sense qualifier',points:3.4});}
     return {id:c.id,word:c.word,sense:c.sense,gloss:c.gloss,score:direct,direct,reasons};
    });
    const index=new Map(scores.map(c=>[c.id,c]));
    for(const seed of scores.filter(c=>c.direct>0))for(const edge of byId.get(seed.id).links){if(edge.weight===0)continue;const target=index.get(edge.to),points=Math.min(seed.direct,8)*edge.weight*m.settings.propagation;target.score+=points;target.reasons.push({label:`${edge.relation} from ${seed.word} × ${edge.weight.toFixed(2)}`,points});}
    const branchCounts=new Map();for(const c of scores)if(c.direct>0)branchCounts.set(c.id.slice(0,7),(branchCounts.get(c.id.slice(0,7))||0)+1);
    for(const c of scores){
     if(c.direct>0&&ctx.subjectIds.includes(c.id)){c.score+=m.settings.contextBoost;c.reasons.push({label:'Recent conversation subject',points:m.settings.contextBoost});}
     if(c.direct>0&&branchCounts.get(c.id.slice(0,7))>1){c.score+=m.settings.treeBoost;c.reasons.push({label:'Shared tree branch',points:m.settings.treeBoost});}
    }
    scores.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
    return {scores:scores.filter(c=>c.score>0),explicit,addressList};
   }
   function chooseSense(candidates,scores){
    if(candidates.length<2)return candidates.map(c=>c.id);
    const ordered=candidates.map(c=>scores.find(s=>s.id===c.id)).filter(Boolean).sort((a,b)=>b.score-a.score);
    // Weak graph/context boosts cannot settle distinct meanings by themselves.
    if(ordered[0]&&(!ordered[1]||ordered[0].direct-ordered[1].direct>=1))return [ordered[0].id];
    return candidates.map(c=>c.id);
   }
   function resolve(query){
    const found=rank(query);const slots=[];
    if(found.addressList.length){for(const id of unique(found.addressList))slots.push({ids:byId.has(id)?[id]:[],label:id});}
    else if(found.explicit.length){
     const headwords=unique(found.explicit.map(c=>c.word)).sort((a,b)=>(' '+normalize(query)+' ').indexOf(' '+normalize(a)+' ')-(' '+normalize(query)+' ').indexOf(' '+normalize(b)+' '));
     for(const word of headwords)slots.push({ids:chooseSense(found.explicit.filter(c=>c.word===word),found.scores),label:word});
    }else{
     const direct=found.scores.filter(c=>c.direct>0&&c.score>=m.settings.threshold);
     if(direct.length){const contenders=direct.filter(c=>direct[0].score-c.score<.65);slots.push({ids:contenders.map(c=>c.id),label:query});}
    }
    return {slots,scores:found.scores};
   }
   const found=resolve(input);ranked=found.scores;
   const previousSlots=()=>ctx.subjectIds.map(id=>({ids:[id],label:byId.get(id).word}));
   const copySlots=slots=>slots.map(s=>({ids:[...s.ids],label:s.label}));
   const choicesFor=ids=>ids.map((id,i)=>({label:`${i+1}. ${byId.get(id).word} · ${byId.get(id).gloss}`,input:id}));
   function finish(kind,reply,info={}){
    result={kind,reply,selectedId:null,subjectIds:[],related:[],choices:[],ranked:ranked.slice(0,6),tokens:words(input),intent:plan?.turnIntent||'clarify',action:plan?.action||null,intentReason:plan?.reason||'No supported request pattern was established.',contextUsed:plan?.contextUsed||false,...info};
    result.intentId=m.intents[result.intent]?.id||null;return result;
   }
   function pause(type,reply,options=[],kind='clarification'){
    plan.type=type;ctx.pending=plan;
    return finish(kind,reply,{choices:options,subjectIds:plan.slots.filter(s=>s.ids.length===1).flatMap(s=>s.ids),...(type==='intent'?{intent:'clarify',action:null,intentReason:'Concepts matched, but the requested operation is unclear.'}:{})});
   }
   function linked(c){return c.links.filter(e=>e.weight>0).map(e=>({...e,word:byId.get(e.to).word,gloss:byId.get(e.to).gloss})).sort((a,b)=>b.weight-a.weight||a.word.localeCompare(b.word));}
   function compare(ids){
    const [a,b]=ids.map(id=>byId.get(id));
    if(a.id===b.id)return `Both references point to the same stored meaning: ${a.word} (${a.id}).\n${a.gloss}`;
    const shared=a.id.slice(0,7)===b.id.slice(0,7)?`${m.domains[a.id.slice(0,3)].name} / ${m.domains[a.id.slice(0,3)].branches[a.id.slice(4,7)]}`:a.id.slice(0,3)===b.id.slice(0,3)?m.domains[a.id.slice(0,3)].name:null;
    const edge=a.links.find(e=>e.to===b.id&&e.weight>0),note=m.comparisons.find(n=>n.ids.includes(a.id)&&n.ids.includes(b.id));
    return `${a.word} — ${a.gloss}\n${b.word} — ${b.gloss}\n\n`+(note?note.text+'\n':'')+(shared?`Shared category: ${shared}.\n`:'They occupy different domains in this experimental tree.\n')+(edge?`Stored connection: ${edge.relation} (weight ${edge.weight.toFixed(2)}).`:'No direct weighted connection has been assigned between these meanings.');
   }
   function execute(){
    if(plan.slots.length>4){ctx.pending=null;return finish('clarification','Please narrow this request to one or two subjects.');}
    if(plan.type==='intent')return pause('intent','I found the subject, but the requested action is unclear. Would you like a definition, associations, or a comparison?',[
     {label:'Define',input:'define'},{label:'Show associations',input:'show associations'},{label:'Compare',input:'compare'}],plan.slots.length>1?'multiple':'clarification');
    if(plan.action==='compare'&&plan.slots.length>2)return pause('subject','Please choose exactly two meanings to compare. Name both words or use their numerical addresses.');
    if(!plan.slots.length)plan.slots.push({ids:[],label:''});
    if(plan.action==='compare'&&plan.slots.length<2)plan.slots.push({ids:[],label:''});
    const missing=plan.slots.findIndex(s=>s.ids.length===0);
    if(missing>=0){const label=plan.slots[missing].label;
     return pause('subject',(label?`I could not resolve “${label}” in this vocabulary. `:'')+(plan.action==='compare'?`Which ${missing===0?'first':'second'} word should I compare?`:'Choose a word first, or give a description from the vocabulary.'));}
    const ambiguous=plan.slots.find(s=>s.ids.length>1);
    if(ambiguous)return pause('sense',`Which meaning do you intend for “${ambiguous.label}”? Choose an option, enter its address, or add a clue:\n`+ambiguous.ids.map((id,i)=>`${i+1}. ${id} — ${byId.get(id).gloss}`).join('\n'),choicesFor(ambiguous.ids),'ambiguous');
    let ids=plan.slots.map(s=>s.ids[0]),action=plan.action,prefix='';
    if(action==='correct'){
     if(ids.length!==1)return pause('subject','Please name one replacement meaning.');
     if(plan.replaceIn?.length>1&&plan.replaceIndex===null)return pause('correction',`Which previous subject should “${byId.get(ids[0]).word}” replace?`,choicesFor(plan.replaceIn));
     if(plan.replaceIn?.length){const replaced=[...plan.replaceIn],index=plan.replaceIndex??0,old=byId.get(replaced[index]);replaced[index]=ids[0];prefix=`Updated the subject: ${old.word} → ${byId.get(ids[0]).word}.\n\n`;ids=replaced;}else prefix=`I’ll use “${byId.get(ids[0]).word}” as the subject.\n\n`;
     action=ids.length===2&&plan.resumeAction==='compare'?'compare':plan.resumeAction==='associate'?'associate':'define';
    }
    if(action==='clarify')action=ids.length===2?'compare':plan.resumeAction==='associate'?'associate':'define';
    let reply,related=[];
    if(action==='compare'){reply=compare(ids);}
    else if(action==='associate'){reply=ids.map(id=>{const c=byId.get(id),links=linked(c);if(ids.length===1)related=links;return `Connections from “${c.word}” (${c.id}):\n`+(links.length?links.slice(0,5).map(e=>`${e.word} · ${e.weight.toFixed(2)} · ${e.relation}`).join('\n'):'No active cross-concept links have been assigned yet.');}).join('\n\n');}
    else{reply=ids.map(id=>{const c=byId.get(id),links=linked(c);if(ids.length===1)related=links;return `${c.word} — ${c.gloss}`+(links.length?'\nRelated: '+links.slice(0,3).map(e=>e.word).join(', ')+'.':'');}).join('\n\n');}
    ctx.subjectIds=ids;ctx.lastId=ids[ids.length-1];ctx.lastIntent=action;ctx.pending=null;
    const kind=plan.turnIntent==='correct'?'corrected':action==='compare'?'comparison':'match';
    return finish(kind,prefix+reply,{selectedId:ids[0],subjectIds:ids,related,action});
   }
   function pickOption(ids){
    const ordinal=text.match(/^(?:the |option |number )?(first|second|third|fourth|1|2|3|4)(?: one| meaning| option)?$/);
    if(ordinal){const n=({first:0,second:1,third:2,fourth:3,'1':0,'2':1,'3':2,'4':3})[ordinal[1]];return ids[n]||null;}
    const direct=ranked.filter(c=>ids.includes(c.id)&&c.direct>0).sort((a,b)=>b.direct-a.direct);
    if(direct[0]&&(!direct[1]||direct[0].direct-direct[1].direct>=1))return direct[0].id;
    return null;
   }
   const correctionMatch=text.match(/\b(?:i meant|i mean|correction)\s+(.+)$/);
   const replaceMatch=text.match(/\breplace (.+?) with (.+)$/);
   const notButMatch=text.match(/^(?:no )?not (.+?) but (.+)$/);
   const isCorrection=!!(correctionMatch||replaceMatch||notButMatch);
   const comparison=has('compare')||(has('associate')&&found.slots.length>=2);
   let definitionTarget=text.match(/^(?:please )?(?:define|definition of|meaning of|what is|what are|what does|explain|tell me about) (.+)$/)?.[1];
   if(definitionTarget&&/^(?:please )?what does\b/.test(text))definitionTarget=definitionTarget.replace(/ mean$/,'');
   const literalDefinition=definitionTarget&&m.concepts.some(c=>normalize(c.word)===definitionTarget.replace(/^an? /,''));
   const bareHeadword=m.concepts.some(c=>normalize(c.word)===text);
   if(bareHeadword||literalDefinition){unsupported=false;negative=false;}
   const explicitIntent=isCorrection?'correct':literalDefinition?'define':bareHeadword?null:comparison?'compare':has('associate')?'associate':has('clarify')?'clarify':has('define')||/^explain\b/.test(text)||/\b(?:word for|word meaning|word means)\b/.test(text)?'define':null;
   // Resolve pending slots before new requests, unless the topic/action changes.
   if(ctx.pending&&!quotedRequest&&!unsupported&&(!negative||isCorrection)){
    const p=ctx.pending;
    if(p.type==='sense'){
     const slot=p.slots.find(s=>s.ids.length>1),chosen=slot&&pickOption(slot.ids);
     if(chosen&&(!explicitIntent||explicitIntent==='clarify'||isCorrection)){
      plan={...p,slots:copySlots(p.slots),type:null,turnIntent:'clarify',reason:'A meaning choice completed the pending request.',contextUsed:true};plan.slots.find(s=>s.ids.length>1).ids=[chosen];execute();
     }else if((!explicitIntent||isCorrection)&&(!found.slots.length||(found.slots.length===1&&found.slots[0].ids.some(id=>slot.ids.includes(id))))){plan=p;execute();}
    }else if(p.type==='correction'){
     const chosen=pickOption(p.replaceIn);
     if(chosen&&(!explicitIntent||isCorrection)){plan={...p,type:null,turnIntent:'correct',replaceIndex:p.replaceIn.indexOf(chosen),reason:'The clarification identified which previous subject to replace.',contextUsed:true};execute();}
    }else if(p.type==='intent'&&['define','associate','compare'].includes(explicitIntent)&&!found.slots.length){plan={...p,type:null,action:explicitIntent,turnIntent:explicitIntent,reason:'The requested action was selected for the pending subjects.',contextUsed:true};execute();}
    else if(p.type==='subject'&&found.slots.length===1&&!explicitIntent&&p.slots.some(s=>!s.ids.length)){
     plan={...p,slots:copySlots(p.slots),type:null,turnIntent:'clarify',reason:'A subject was supplied to finish the pending request.',contextUsed:true};plan.slots[plan.slots.findIndex(s=>!s.ids.length)]=found.slots[0];execute();
    }
   }
   if(!result){
    plan={action:explicitIntent||'define',turnIntent:explicitIntent||'define',slots:copySlots(found.slots),type:null,reason:explicitIntent?`Recognized the ${explicitIntent} request.`:'A word or description defaults to a definition lookup.',contextUsed:false};
    if(/^(hi|hello|hey|good morning)[!. ]*$/i.test(input)){finish('greeting','Hello. I can define words, follow associations, compare meanings, and use your corrections. Try “Are abate and abolish the same?”',{intent:'greeting',action:null,intentReason:'Matched a greeting.'});}
    else if(quotedRequest){ctx.pending=null;finish('negation','I will not perform that request. Tell me which action you would like instead.',{action:null});}
    else if(isCorrection){
     let replacement,oldText='';
     if(replaceMatch){oldText=replaceMatch[1];replacement=replaceMatch[2];}
     else if(notButMatch){oldText=notButMatch[1];replacement=notButMatch[2];}
     else {replacement=correctionMatch[1];const split=replacement.match(/^(.+?) (?:not|instead of) (.+)$/);if(split){replacement=split[1];oldText=split[2];}else{const before=text.slice(0,correctionMatch.index),old=before.match(/\b(?:dont mean|do not mean|not) (.+)$/);if(old)oldText=old[1];}}
     const corrected=resolve(replacement);ranked=corrected.scores;
     plan.slots=corrected.slots.length?corrected.slots:[{ids:[],label:replacement}];plan.replaceIn=[...ctx.subjectIds];plan.replaceIndex=ctx.subjectIds.length===1?0:null;plan.resumeAction=ctx.lastIntent;plan.contextUsed=ctx.subjectIds.length>0;
     if(oldText){const oldIds=resolve(oldText).slots.flatMap(s=>s.ids),index=ctx.subjectIds.findIndex(id=>oldIds.includes(id));if(index>=0)plan.replaceIndex=index;}
     plan.reason='A correction pattern identifies a replacement subject; the previous action is retained when possible.';execute();
    }else if(negative&&explicitIntent!=='define'&&explicitIntent!=='compare'){
     if(ctx.pending)finish('negation','I cannot reliably choose a meaning from that negation. Please name the subject or meaning you do want; the unfinished request is still saved.',{action:null});
     else finish('negation',m.templates.negated,{action:null});
    }
    else if(unsupported){
     ctx.pending=null;finish('unsupported','That action is outside this experiment. I can define, associate, compare, correct a subject, or clarify a previous answer.',{intent:'clarify',action:null,intentReason:'The requested action is outside the five supported operations.'});
    }else{
     if(plan.action==='compare'){
      // Split explicit pairs so an unknown half cannot be filled by old context.
      const pair=input.match(/\b(?:compare|contrast)\s+(.+?)\s+(?:and|with|to|versus|vs\.?)[ ]+(.+?)[?.!]*$/i)||input.match(/\b(?:difference(?:s)?|relationship) between\s+(.+?)\s+and\s+(.+?)[?.!]*$/i)||input.match(/\b(?:are|is)\s+(.+?)\s+and\s+(.+?)\s+(?:the same|different|related|similar)\b/i);
      if(pair){plan.slots=[pair[1],pair[2]].flatMap(part=>{if(/^(that|it|this)$/i.test(part.trim())&&ctx.subjectIds.length===1){plan.contextUsed=true;return previousSlots();}const r=resolve(part);return r.slots.length?r.slots:[{ids:[],label:part.trim()}];});}
      else if(!plan.slots.length&&refs&&ctx.subjectIds.length===2){plan.slots=previousSlots();plan.contextUsed=true;plan.reason='The comparison refers to the two previous conversation subjects.';}
      else if(!plan.slots.length&&refs&&ctx.subjectIds.length===1){plan.slots=previousSlots();plan.contextUsed=true;}
     }else if((refs||plan.action==='clarify')&&!plan.slots.length&&ctx.subjectIds.length){
      if(['unknown','negation','unsupported'].includes(ctx.lastOutcome)){ctx.pending=null;finish('clarification','My previous reply did not resolve a supported request. Please name the word and the action you want.',{action:null,contextUsed:false});}
      else if(ctx.subjectIds.length>1&&/\b(that|it|this)\b/.test(text)&&plan.action!=='clarify'){
       plan.slots=[{ids:[...ctx.subjectIds],label:'the previous subject'}];plan.contextUsed=true;plan.reason='A singular reference could mean either previous subject.';
      }else {plan.slots=previousSlots();plan.contextUsed=true;plan.resumeAction=ctx.lastIntent;plan.reason='The request refers to the previous conversation subject'+(plan.slots.length>1?'s.':'.');}
     }
     if(!result){
      if(!explicitIntent&&found.slots.length&&((found.slots.length>1)||/\b(i|im|you|we|they|my|want|thinking|feel)\b/.test(text))){plan.type='intent';execute();}
      else if(!plan.slots.length&&!explicitIntent){ctx.pending=null;finish('unknown',m.templates.unknown,{action:null});}
      else if(found.slots.some(s=>!s.ids.length)&&!explicitIntent){ctx.pending=null;finish('unknown',`There is no concept at ${found.slots.find(s=>!s.ids.length).label} in this vocabulary.`,{action:null});}
      else execute();
     }
    }
   }
   ctx.turns++;ctx.lastOutcome=result.kind;
   ctx.history.push({input,kind:result.kind,reply:result.reply,intent:result.intent,action:result.action,subjectIds:result.subjectIds,choices:result.choices});ctx.history=ctx.history.slice(-12);
   brain=JSON.stringify(m);return {...result,turn:ctx.turns};
  }
  function setWeight(from,to,weight){
   weight=Number(weight);if(!Number.isFinite(weight)||weight<0||weight>1)throw Error('Weight must be between 0 and 1.');
   const m=snapshot(),a=m.concepts.find(c=>c.id===from),b=m.concepts.find(c=>c.id===to),edge=a?.links.find(e=>e.to===to);if(!edge)throw Error('Association not found.');
   edge.weight=weight;const reverse=b?.links.find(e=>e.to===from);if(reverse)reverse.weight=weight;brain=JSON.stringify(m);
  }
  return {decode,snapshot,getString:()=>brain,setWeight,replace(encoded,vocabularySeed){let candidate=validate(upgrade(JSON.parse(encoded)));if(vocabularySeed)candidate=mergeVocabulary(candidate,validate(upgrade(JSON.parse(vocabularySeed))));brain=JSON.stringify(candidate);},clearConversation(){const m=snapshot();m.context=emptyContext();brain=JSON.stringify(m);}};
 }
 const api={create,normalize,validate,upgrade,mergeVocabulary};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ConceptEngine=api;
})(typeof globalThis!=='undefined'?globalThis:this);
