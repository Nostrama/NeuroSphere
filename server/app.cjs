'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { loadVocabulary } = require('../src/index.cjs');
const { validateMemory, summary, scene } = require('./model-view.cjs');
const {TextMemory,tokenize,SCHEMA:TEXT_SCHEMA,LIMITS:TEXT_LIMITS}=require('../src/text-memory.cjs');
const textView=require('./text-view.cjs');
const {FactMemory,SCHEMA:FACT_SCHEMA,LIMITS:FACT_LIMITS}=require('../src/fact-memory.cjs');
const {parseFact}=require('../src/fact-language.cjs');
const factView=require('./fact-view.cjs');
const ROOT = path.resolve(__dirname, '..');
const MAX_BODY = 8 * 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/volume.js', ['volume.js', 'text/javascript']],
  ['/morphology.js', ['morphology.js','text/javascript']], ['/dashboard.js', ['dashboard.js','text/javascript']],
  ['/telemetry-model.mjs', ['telemetry-model.mjs','text/javascript']], ['/upstream/neuron-volume.js', ['upstream/neuron-volume.js','text/javascript']],
  ['/style.css', ['style.css', 'text/css']], ['/icon.svg', ['icon.svg', 'image/svg+xml']]
]);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

function createApp({ dataDir = path.join(ROOT, 'outputs/ui'), demoPath = path.join(ROOT, 'outputs/pilot-v3/engram-memory.json') } = {}) {
  const vocabulary = loadVocabulary();
  const runs = new Map();
  let active = null, demo = null, job = null, trainer = null, textMemory=null, factMemory=null;
  const textFile=path.join(dataDir,'text-workspace.json');
  const factFile=path.join(dataDir,'fact-workspace.json');
  const recallWorkers = new Set();
  const compactRecord = record => ({ id: record.id, word: record.word, sense: record.sense, gloss: record.gloss, domainId: record.domainId, branchId: record.branchId });
  const records = vocabulary.records.map(compactRecord);
  const domains = Object.entries(vocabulary.domains).map(([id, domain]) => ({ id, name: domain.name, count: records.filter(record => record.domainId === id).length }));

  if (fs.existsSync(demoPath)) {
    try {
      const memory = validateMemory(JSON.parse(fs.readFileSync(demoPath, 'utf8')), vocabulary);
      demo = { memory, summary: summary(memory, vocabulary, { id: 'demo', name: '18-word pilot', origin: 'Saved demo', createdAt: '2026-10-31', evaluation: { exact: 18, total: 18, scope: 'Saved development pilot; exact recall of taught words.' } }) };
      active = demo;
    } catch (error) { process.stderr.write('Saved demo could not be loaded: ' + error.message + '\n'); }
  }
  if (fs.existsSync(dataDir)) {
    for (const directory of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^run-[0-9a-f-]+$/.test(directory.name)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dataDir, directory.name, 'summary.json'), 'utf8'));
        if (record.id === directory.name && typeof record.name === 'string') runs.set(record.id, record);
      } catch { /* An interrupted save is not a complete memory. */ }
    }
  }
  if(fs.existsSync(textFile)){
    // A damaged checkpoint must never be silently replaced by an empty workspace.
    try{textMemory=new TextMemory(JSON.parse(fs.readFileSync(textFile,'utf8')));active={kind:'text',summary:textView.summary(textMemory)};}
    catch(error){throw new Error('Text workspace could not be restored: '+error.message);}
  }
  if(fs.existsSync(factFile)){
    try{factMemory=new FactMemory(JSON.parse(fs.readFileSync(factFile,'utf8')));active={kind:'facts',summary:factView.summary(factMemory)};}
    catch(error){throw new Error('Fact workspace could not be restored: '+error.message);}
  }
  function saveText(value,evaluation=null,archive=false){
    const candidate=new TextMemory(value);fs.mkdirSync(dataDir,{recursive:true});
    const temporary=textFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify(candidate.checkpoint()));
    if(fs.existsSync(textFile)){fs.copyFileSync(textFile,textFile+'.previous');if(archive)fs.copyFileSync(textFile,path.join(dataDir,'text-backup-'+Date.now()+'-'+randomUUID()+'.json'));}
    fs.renameSync(temporary,textFile);textMemory=candidate;
    active={kind:'text',summary:{...textView.summary(textMemory),evaluation}};return active.summary;
  }
  function textJob(body){
    assertIdle();if(recallWorkers.size)throw failure('Wait for the current response.',409);
    tokenize(body.question);tokenize(body.answer);const domainId=body.domainId??'005';if(!/^00[1-9]$/.test(domainId))throw failure('Choose a known domain.');
    const current={id:randomUUID(),kind:'text',status:'running',stage:'training',epoch:0,total:TEXT_LIMITS.rounds,startedAt:Date.now()};job=current;
    const worker=new Worker(path.join(__dirname,'text-worker.cjs'),{workerData:{action:'teach',checkpoint:textMemory?.checkpoint()??null,question:body.question,answer:body.answer,domainId}});trainer=worker;
    const fail=error=>{if(current.status==='running'){Object.assign(current,{status:'failed',error:error.message});trainer=null;}};
    worker.on('message',message=>{if(current.status!=='running')return;if(message.type==='progress')Object.assign(current,message);else if(message.type==='error')fail(new Error(message.error));else if(message.type==='complete'){try{const record=saveText(message.checkpoint,message.evaluation);Object.assign(current,{status:'complete',stage:'complete',memory:record,elapsedMs:Date.now()-current.startedAt});trainer=null;}catch(error){fail(error);}}});
    worker.on('error',fail);worker.on('exit',code=>{if(current.status==='running')fail(new Error('Text teaching stopped unexpectedly ('+code+').'));if(trainer===worker)trainer=null;});return{...current};
  }
  function senseText(body){
    if(recallWorkers.size)throw failure('A response is already running.',409);tokenize(body.word);
    const checkpoint=textMemory.checkpoint();return new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'text-worker.cjs'),{workerData:{action:'sense',checkpoint,word:body.word}});recallWorkers.add(worker);let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);recallWorkers.delete(worker);worker.terminate();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(failure('Text response timed out.',503)),30000);
      worker.on('message',message=>{if(message.type==='error')finish(failure(message.error));else if(message.type==='complete')finish(null,{...message.result,memoryId:'text',channel:'sense',input:{name:'Sense Input',tokens:message.result.inputTokens,domains:message.result.routedDomains.length},output:{name:'Output',status:message.result.status,text:message.result.response}});});worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!settled)finish(failure('Text response stopped ('+code+').',503));});
    });
  }
  function saveFact(value,evaluation=null,archive=false){
    const candidate=new FactMemory(value);fs.mkdirSync(dataDir,{recursive:true});
    const temporary=factFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify(candidate.checkpoint()));
    if(fs.existsSync(factFile)){fs.copyFileSync(factFile,factFile+'.previous');if(archive)fs.copyFileSync(factFile,path.join(dataDir,'fact-backup-'+Date.now()+'-'+randomUUID()+'.json'));}
    fs.renameSync(temporary,factFile);factMemory=candidate;
    active={kind:'facts',summary:{...factView.summary(factMemory),evaluation}};return active.summary;
  }
  function factJob(body){
    assertIdle();if(recallWorkers.size)throw failure('Wait for the current response.',409);
    parseFact(body.statement);const domainId=body.domainId??'007';if(!/^00[1-9]$/.test(domainId))throw failure('Choose a known domain.');
    const current={id:randomUUID(),kind:'facts',status:'running',stage:'training',epoch:0,total:FACT_LIMITS.rounds,startedAt:Date.now()};job=current;
    const worker=new Worker(path.join(__dirname,'fact-worker.cjs'),{workerData:{action:'teach',checkpoint:factMemory?.checkpoint()??null,statement:body.statement,domainId}});trainer=worker;
    const fail=error=>{if(current.status==='running'){Object.assign(current,{status:'failed',error:error.message});trainer=null;}};
    worker.on('message',message=>{if(current.status!=='running')return;if(message.type==='progress')Object.assign(current,message);else if(message.type==='error')fail(new Error(message.error));else if(message.type==='complete'){try{const record=saveFact(message.checkpoint,message.evaluation);Object.assign(current,{status:'complete',stage:'complete',memory:record,elapsedMs:Date.now()-current.startedAt});trainer=null;}catch(error){fail(error);}}});
    worker.on('error',fail);worker.on('exit',code=>{if(current.status==='running')fail(new Error('Fact teaching stopped unexpectedly ('+code+').'));if(trainer===worker)trainer=null;});return{...current};
  }
  function senseFact(body){
    if(recallWorkers.size)throw failure('A response is already running.',409);if(typeof body.word!=='string'||!body.word.trim()||body.word.length>200)throw failure('Use 1–200 characters.');
    const checkpoint=factMemory.checkpoint();return new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'fact-worker.cjs'),{workerData:{action:'sense',checkpoint,word:body.word}});recallWorkers.add(worker);let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);recallWorkers.delete(worker);worker.terminate();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(failure('Fact response timed out.',503)),30000);
      worker.on('message',message=>{if(message.type==='error')finish(failure(message.error));else if(message.type==='complete')finish(null,{...message.result,memoryId:'facts',channel:'sense',input:{name:'Sense Input',tokens:message.result.inputTokens,domains:message.result.routedDomains.length},output:{name:'Output',status:message.result.status,text:message.result.response}});});worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!settled)finish(failure('Fact response stopped ('+code+').',503));});
    });
  }
  function persist(memory, name, origin, evaluation = null) {
    const id = 'run-' + randomUUID();
    const record = summary(memory, vocabulary, { id, name, origin, createdAt: new Date().toISOString(), evaluation });
    const directory = path.join(dataDir, id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'memory.json'), JSON.stringify(memory));
    fs.writeFileSync(path.join(directory, 'summary.json.tmp'), JSON.stringify(record));
    fs.renameSync(path.join(directory, 'summary.json.tmp'), path.join(directory, 'summary.json'));
    runs.set(id, record);
    return { memory, summary: record };
  }
  function assertIdle() { if (job?.status === 'running') throw failure('Wait for training to finish, or cancel it first.', 409); }
  function listRuns() { return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async function readJSON(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw failure('Send JSON data.', 415);
    let length = 0; const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BODY) throw failure('The file is too large. Use a memory smaller than 8 MB.', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks)); } catch { throw failure('The JSON file could not be read.'); }
  }
  function startTraining(body) {
    assertIdle();
    const { conceptIds, epochs = 24, seed = 1 } = body;
    if (!Array.isArray(conceptIds) || !conceptIds.length || conceptIds.length > 72 || new Set(conceptIds).size !== conceptIds.length) throw failure('Choose 1–72 distinct word meanings.');
    if (!Number.isInteger(epochs) || epochs < 1 || epochs > 100) throw failure('Training rounds must be between 1 and 100.');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw failure('Seed must be an unsigned 32-bit integer.');
    const counts = new Map();
    for (const id of conceptIds) { const record = vocabulary.get(id); const count = (counts.get(record.domainId) ?? 0) + 1; counts.set(record.domainId, count); if (count > 8) throw failure('Choose at most eight meanings in each domain.'); }
    job = { id: randomUUID(), status: 'running', stage: 'training', epoch: 0, total: epochs, words: conceptIds.length, startedAt: Date.now() };
    const current = job;
    trainer = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: { action: 'train', conceptIds, epochs, seed } });
    const currentWorker = trainer;
    const fail = error => { if (current.status === 'running') { Object.assign(current, { status: 'failed', error: error.message ?? String(error) }); trainer = null; } };
    trainer.on('message', message => {
      if (current.status !== 'running') return;
      if (message.type === 'progress') Object.assign(current, message);
      else if (message.type === 'error') fail(new Error(message.error));
      else if (message.type === 'complete') {
        try {
          validateMemory(message.memory, vocabulary);
          const name = conceptIds.length + '-word memory';
          try { active = persist(message.memory, name, 'Training run', message.evaluation); }
          catch { active = { memory: message.memory, summary: summary(message.memory, vocabulary, { id: 'unsaved-' + current.id, name, origin: 'Unsaved training run', createdAt: new Date().toISOString(), evaluation: message.evaluation }) }; current.warning = 'Training finished, but the local save failed. Download this memory to keep it.'; }
          Object.assign(current, { status: 'complete', stage: 'complete', elapsedMs: Date.now() - current.startedAt, memory: active.summary });
          trainer = null;
        } catch (error) { fail(error); }
      }
    });
    trainer.on('error', fail);
    trainer.on('exit', code => { if (current.status === 'running') fail(new Error('Training ended before a complete memory was returned (' + code + ').')); if (trainer === currentWorker) trainer = null; });
    return { ...current };
  }
  async function recall(body) {
    if (!active||['text','facts'].includes(active.kind)) throw failure('Open a vocabulary memory for this endpoint; text uses Sense Input.', 409);
    if (recallWorkers.size) throw failure('A recall is already running. Try again in a moment.', 409);
    if (typeof body.word !== 'string' || !body.word.trim() || body.word.length > 200) throw failure('Enter a word or short phrase, up to 200 characters.');
    const domainId = body.domainId ?? null;
    if (domainId !== null && !active.memory.regions.some(region => region.domainId === domainId)) throw failure('This memory has no words in the selected domain.');
    const usedMemory = active;
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: { action: 'recall', memory: usedMemory.memory, word: body.word, domainId } });
      recallWorkers.add(worker);
      let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); recallWorkers.delete(worker); worker.terminate(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(failure('Recall took too long. Please try a smaller memory.', 503)), 30000);
      worker.on('message', message => {
        if (message.type === 'error') finish(failure(message.error));
        if (message.type === 'complete') {
          const matches = message.result.recalled.map(item => ({ ...item, ...compactRecord(vocabulary.get(item.conceptId)) }));
          finish(null, { ...message.result, matches, word: body.word, memoryId: usedMemory.summary.id });
        }
      });
      worker.on('error', error => finish(error));
      worker.on('exit', code => { if (!settled) finish(failure('Recall stopped unexpectedly (' + code + ').', 503)); });
    });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const port = server.address()?.port;
      const allowed = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
      if (!allowed.has(req.headers.host)) throw failure('Use the local NeuroSphere address.', 403);
      if (req.headers.origin && ![...allowed].some(host => req.headers.origin === 'http://' + host)) throw failure('This request came from another website.', 403);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [name, mime] = staticFiles.get(url.pathname);
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(path.join(ROOT, 'public', name))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { app: 'NeuroSphere', version: '0.7.0' });
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return send(res, 200, { domains, records, textAvailable:Boolean(textMemory),factAvailable:Boolean(factMemory), defaults: vocabulary.samplePerDomain(2).map(record => record.id), memory: active?.summary ?? null, runs: listRuns(), demoAvailable: Boolean(demo), job });
      if (req.method === 'GET' && url.pathname === '/api/scene') return send(res, 200, { memory: active?.summary ?? null, scene: active?.kind==='facts'?factView.scene(factMemory,vocabulary):active?.kind==='text'?textView.scene(textMemory,vocabulary):active?scene(active.memory,vocabulary):null, records:active?.kind==='facts'?factView.records(factMemory):active?.kind==='text'?textView.records(textMemory):[] });
      if(req.method==='GET'&&url.pathname==='/api/facts')return send(res,200,{memory:factMemory?factView.summary(factMemory):null,facts:factMemory?factView.facts(factMemory):[],history:factMemory?.history??[],limits:FACT_LIMITS});
      if(req.method==='GET'&&url.pathname==='/api/text')return send(res,200,{memory:textMemory?textView.summary(textMemory):null,lessons:textMemory?.lessons.map(({id,question,answer,domainId})=>({id,question,answer,domainId}))??[],limits:TEXT_LIMITS});
      if (req.method === 'GET' && url.pathname === '/api/job') return send(res, 200, { job });
      if (req.method === 'GET' && url.pathname === '/api/runs') return send(res, 200, { runs: [...(factMemory?[factView.summary(factMemory)]:[]),...(textMemory?[textView.summary(textMemory)]:[]),...listRuns()] });
      if (req.method === 'GET' && url.pathname === '/api/export') {
        if (!active) throw failure('There is no memory to download.', 409);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="neurosphere-memory.json"', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(active.kind==='facts'?factMemory.checkpoint():active.kind==='text'?textMemory.checkpoint():active.memory)); return;
      }
      if (req.method !== 'POST') throw failure('Not found.', 404);
      const body = await readJSON(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Expected a JSON object.');
      if(url.pathname==='/api/facts/open'){assertIdle();if(!factMemory)factMemory=new FactMemory();active={kind:'facts',summary:factView.summary(factMemory)};return send(res,200,{memory:active.summary});}
      if(url.pathname==='/api/facts/teach')return send(res,202,factJob(body));
      if(url.pathname==='/api/text/open'){assertIdle();if(!textMemory)textMemory=new TextMemory();active={kind:'text',summary:textView.summary(textMemory)};return send(res,200,{memory:active.summary});}
      if(url.pathname==='/api/text/teach')return send(res,202,textJob(body));
      if (url.pathname === '/api/train') return send(res, 202, startTraining(body));
      if (url.pathname === '/api/train/cancel') {
        if (job?.status === 'running') { job.status = 'cancelled'; job.stage = 'cancelled'; await trainer?.terminate(); trainer = null; }
        return send(res, 200, { job });
      }
      if (url.pathname === '/api/sense') {
        // One public sensory bus. Domain filtering belongs to the inspector;
        // it cannot silently suppress another domain's response to this cue.
        if(body.domainId!==undefined&&body.domainId!==null)throw failure('Sense Input addresses the whole volume.');
        if(active?.kind==='facts')return send(res,200,await senseFact(body));
        if(active?.kind==='text')return send(res,200,await senseText(body));
        const result=await recall({...body,domainId:null});
        return send(res,200,{...result,channel:'sense',input:{name:'Sense Input',features:result.inputBits.length,domains:result.routedDomains.length},output:{name:'Output',status:result.status,conceptIds:result.recalled.map(item=>item.conceptId)}});
      }
      if (url.pathname === '/api/recall') return send(res, 200, await recall(body));
      if (url.pathname === '/api/load') {
        assertIdle();
        if(body.id==='facts'&&factMemory)active={kind:'facts',summary:factView.summary(factMemory)};
        else if(body.id==='text'&&textMemory)active={kind:'text',summary:textView.summary(textMemory)};
        else if (body.id === 'demo' && demo) active = demo;
        else if (typeof body.id === 'string' && runs.has(body.id)) {
          const memory = validateMemory(JSON.parse(fs.readFileSync(path.join(dataDir, body.id, 'memory.json'), 'utf8')), vocabulary);
          active = { memory, summary: runs.get(body.id) };
        } else throw failure('That saved memory was not found.', 404);
        return send(res, 200, { memory: active.summary });
      }
      if (url.pathname === '/api/import') {
        assertIdle();
        if(body.memory?.schema===FACT_SCHEMA){const record=saveFact(body.memory,null,true);return send(res,200,{memory:record});}
        if(body.memory?.schema===TEXT_SCHEMA){const record=saveText(body.memory,null,true);return send(res,200,{memory:record});}
        const memory = validateMemory(body.memory, vocabulary);
        const name = typeof body.name === 'string' ? body.name.replace(/[\r\n\u0000-\u001f]/g, '').slice(0, 80).trim() : 'Imported memory';
        active = persist(memory, name || 'Imported memory', 'Imported memory');
        return send(res, 200, { memory: active.summary });
      }
      throw failure('Not found.', 404);
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 400, { error: error.message || 'The request could not be completed.' });
      else res.end();
    }
  });
  return { server, close: async () => { await trainer?.terminate(); await Promise.all([...recallWorkers].map(worker => worker.terminate())); if (server.listening) await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createApp };
