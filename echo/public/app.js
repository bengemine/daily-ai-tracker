const $ = selector => document.querySelector(selector);
const memory = $('#memory');
let csrf = '';
let filter = '';
let activeJob = null;
let pollTimer;
let clockTimer;
let previewState;
let statusBusy = false;
let recentLoaded = false;
let lastStatus;
const autoOpened = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url, data) {
  const response = await fetch(url, data === undefined ? { cache:'no-store' } : { method:'POST', headers:{'Content-Type':'application/json','X-Echo-Token':csrf}, body:JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

function notice(message, success = false) {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('success',success);
  $('#notice').hidden = !message;
}

function dateLabel(date) {
  if (!date) return 'DATE UNKNOWN';
  const parsed = new Date(date.slice(0,10) + 'T12:00:00');
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
}

async function status() {
  if (statusBusy) return;
  statusBusy = true;
  try {
    const result = await api('/api/status');
    csrf = result.token;
    lastStatus = result;
    const connected = result.auth.available;
    $('#connection').className = 'connection ' + (connected ? 'connected' : 'problem');
    $('#connection span').textContent = connected ? 'CODEX CONNECTED' : 'CODEX OFFLINE';
    $('#connection').title = result.auth.message;
    if (result.stats) {
      const count = Number(result.stats.sessions).toLocaleString();
      $('#archive-size').textContent = count + ' CONVERSATIONS · ONE WAY BACK';
      const agents = result.stats.agents?.length || 0;
      $('#index-status').textContent = result.index.running ? 'Refreshing archive…' : count + ' threads / ' + agents + ' agent sources';
      $('#refresh-archive').disabled = result.index.running;
      if (!recentLoaded) { recentLoaded = true; void loadRecent(); }
    } else {
      $('#archive-size').textContent = result.index.running ? 'BUILDING YOUR MEMORY ARCHIVE' : 'ARCHIVE NOT READY';
      $('#index-status').textContent = result.index.running ? 'Reading ' + result.index.files + ' files…' : (result.index.error || 'Waiting for the archive');
    }
    if (result.index.error && !activeJob) notice('Archive refresh failed. ' + result.index.error);
  } catch {
    $('#connection').className = 'connection problem';
    $('#connection span').textContent = 'RECONNECTING';
    $('#index-status').textContent = 'Local service is unavailable. Open the Echo shortcut to start it.';
  } finally { statusBusy = false; }
}

async function loadRecent() {
  try {
    const recent = (await api('/api/recent')).slice(0,3);
    const list = $('#recent-list');
    list.replaceChildren();
    if (!recent.length) { list.append(element('p','muted','No saved conversations yet.')); return; }
    for (const item of recent) {
      const button = element('button','recent-item');
      const meta = element('span','recent-meta');
      meta.append(element('i','agent-dot'),element('span','',item.agent),element('span','recent-date',dateLabel(item.date)));
      button.append(meta,element('span','recent-title',item.title));
      button.title = 'Find and reopen: ' + item.title;
      button.addEventListener('click',() => {
        if (activeJob) return;
        memory.value = 'Find the conversation with session ID ' + item.session_id + ': ' + item.title;
        setFilter('');
        $('#search-form').requestSubmit();
      });
      list.append(button);
    }
  } catch { recentLoaded = false; }
}

function setFilter(value) {
  filter = value;
  for (const button of document.querySelectorAll('[data-filter]')) {
    const active = button.dataset.filter === filter;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  }
}

function setBusy(busy) {
  $('#search-button').disabled = busy;
  memory.disabled = busy;
  for (const button of document.querySelectorAll('[data-filter], .recent-item')) button.disabled = busy;
  document.body.classList.toggle('is-searching',busy);
  $('#progress').hidden = !busy;
  $('#field-caption').textContent = busy ? 'FOLLOWING YOUR SIGNAL' : 'PAST → PRESENT';
  if (!busy) { clearTimeout(pollTimer); clearInterval(clockTimer); }
}

async function startSearch(event) {
  event.preventDefault();
  if (activeJob) return;
  const query = memory.value.trim();
  if (query.length < 3) { notice('Give Echo a little more to go on—at least three characters.'); memory.focus(); return; }
  if (!csrf) await status();
  notice('');
  $('#results').hidden = true;
  document.body.classList.remove('has-results');
  setBusy(true);
  $('#progress-message').textContent = 'Preparing your search…';
  $('#progress-phase').textContent = 'FOLLOWING THE SIGNAL';
  $('#progress-detail').textContent = 'Your existing Codex login · no API key';
  $('#elapsed').textContent = '00:00';
  try {
    const result = await api('/api/search',{query,filter});
    activeJob = result.id;
    sessionStorage.setItem('echo-active-search',activeJob);
    startClock(Date.now());
    void poll(activeJob);
  } catch (error) { activeJob = null; setBusy(false); notice(error.message); }
}

function startClock(start) {
  clearInterval(clockTimer);
  const tick = () => {
    const seconds = Math.max(0,Math.floor((Date.now()-start)/1000));
    $('#elapsed').textContent = String(Math.floor(seconds/60)).padStart(2,'0') + ':' + String(seconds%60).padStart(2,'0');
  };
  tick(); clockTimer = setInterval(tick,1000);
}

async function poll(id) {
  try {
    const job = await api('/api/search/' + id);
    if (id !== activeJob) return;
    $('#progress-message').textContent = job.message;
    $('#progress-phase').textContent = job.phase === 'reading' ? 'LOOKING CLOSER' : job.phase === 'verifying' ? 'CHECKING THE CONNECTION' : 'FOLLOWING THE SIGNAL';
    $('#progress-detail').textContent = job.steps ? job.steps + ' investigation steps · Codex is reading your archive' : 'Your existing Codex login · no API key';
    if (job.finished) {
      activeJob = null;
      sessionStorage.removeItem('echo-active-search');
      setBusy(false);
      if (job.phase === 'done') await renderResults(job);
      else notice(job.message);
      return;
    }
    pollTimer = setTimeout(() => void poll(id),1100);
  } catch (error) {
    if (id !== activeJob) return;
    if (/no longer available/.test(error.message)) {
      activeJob=null; sessionStorage.removeItem('echo-active-search'); setBusy(false); notice(error.message);
    } else {
      $('#progress-message').textContent = 'Reconnecting to the local finder…';
      pollTimer=setTimeout(() => void poll(id),3000);
    }
  }
}

async function resume(jobId, item, button, automatic = false) {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Opening Herdr tab…';
  notice((automatic ? 'One clear match. ' : '') + 'Opening the original conversation in Herdr…');
  try {
    const result = await api('/api/search/' + jobId + '/resume',{sessionKey:item.sessionKey});
    button.textContent = 'Herdr tab opened ✓';
    button.classList.add('match-opened');
    notice((result.reused ? 'This conversation was already open. Its tab is selected in Herdr, in the “' : 'Your ' + result.agent + ' conversation is open in Herdr, in the “') + result.workspace + '” workspace.\n' + (result.needsInput ? 'Check the tab for startup or sign-in prompts.' : result.shown ? 'Continue there when you are ready.' : 'Switch to Herdr to continue.'),true);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Try opening again ↗';
    notice(error.message);
  }
}

async function startFromSummary(jobId, item, button) {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Opening new Claude chat…';
  notice('Starting a new Claude chat with the saved summary…');
  try {
    const result = await api('/api/search/' + jobId + '/handoff',{sessionKey:item.sessionKey});
    button.textContent = 'New Claude chat opened ✓';
    button.classList.add('match-opened');
    notice('A new Claude chat is open in Herdr, in the “' + result.workspace + '” workspace. It has the saved summary.\n' + (result.needsInput ? 'Check the tab for startup or sign-in prompts.' : result.shown ? 'Continue there when you are ready.' : 'Switch to Herdr to continue.'),true);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Try starting again ↗';
    notice(error.message);
  }
}

async function renderResults(job) {
  document.body.classList.add('has-results');
  const result = job.result;
  const count = result.matches.length;
  $('#results').hidden = false;
  $('#results-eyebrow').textContent = count ? (result.autoResume ? 'ONE CLEAR MATCH' : 'SIGNALS FOUND') : 'STILL OUT THERE';
  $('#results-title').textContent = count === 1 ? 'Does this take you back?' : count > 1 ? 'Which thread feels familiar?' : 'Nothing certain. Yet.';
  $('#match-count').textContent = count ? String(count).padStart(2,'0') + ' / ' + (count === 1 ? 'MATCH' : 'MATCHES') : '';
  $('#results-explanation').textContent = result.explanation;
  $('#match-list').replaceChildren();
  $('#no-match').hidden = count > 0;
  $('#followup-question').textContent = result.question || 'Do you remember a project, a date, or something the agent suggested?';
  let firstButton;
  for (const [index,item] of result.matches.entries()) {
    const card = element('article','match-card');
    card.append(element('div','match-number',String(index+1).padStart(2,'0')));
    const main = element('div','match-main');
    const meta = element('div','match-meta');
    meta.append(element('span','',item.agent),element('span','',dateLabel(item.date)),element('span','',item.confidence === 'high' ? 'STRONG MATCH' : 'POSSIBLE MATCH'));
    main.append(meta,element('h3','',item.title),element('p','match-reason',item.reason),element('p','match-evidence','“' + item.evidence + '”'));
    main.append(element('div','match-path',item.resume.cwd || item.project));
    card.append(main);
    const actions = element('div','match-actions');
    if (item.resume.available) {
      const button = element('button','resume-button','Resume conversation ↗');
      button.addEventListener('click',() => void resume(job.id,item,button));
      actions.append(button);
      if (index === 0) firstButton=button;
    } else actions.append(element('p','unavailable',item.resume.reason));
    if (item.handoff?.available) {
      const fresh = element('button','resume-button handoff-button','New Claude chat from summary ↗');
      fresh.title = 'Start a fresh Claude chat that gets only the saved summary. Uses much less of your usage limit than resuming a long chat.';
      fresh.addEventListener('click',() => void startFromSummary(job.id,item,fresh));
      actions.append(fresh);
    } else if (item.handoff) actions.append(element('p','unavailable',item.handoff.reason));
    const preview = element('button','text-button','Read saved conversation');
    preview.addEventListener('click',() => void showPreview(job.id,item));
    actions.append(preview);
    card.append(actions);
    $('#match-list').append(card);
  }
  if (result.autoResume && $('#auto-resume').checked && firstButton && !autoOpened.has(job.id)) {
    autoOpened.add(job.id);
    await resume(job.id,result.matches[0],firstButton,true);
  }
}

async function showPreview(jobId,item) {
  previewState={jobId,item,offset:0};
  $('#preview-title').textContent=item.title;
  $('#preview-meta').textContent=item.agent + ' · ' + dateLabel(item.date) + ' · ' + item.session_id;
  $('#preview-content').textContent='Loading saved dialogue…';
  $('#more-preview').hidden=true;
  $('#preview-dialog').showModal();
  await loadPreview(false);
}

async function loadPreview(append) {
  const current=previewState;
  $('#more-preview').disabled=true;
  try {
    const result=await api('/api/search/' + current.jobId + '/preview',{sessionKey:current.item.sessionKey,offset:current.offset});
    if (previewState!==current) return;
    $('#preview-content').textContent=(append ? $('#preview-content').textContent : '') + result.text;
    current.offset=result.nextOffset;
    $('#more-preview').hidden=result.nextOffset===null;
  } catch (error) { $('#preview-content').textContent=error.message; }
  finally { $('#more-preview').disabled=false; }
}

$('#search-form').addEventListener('submit',startSearch);
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click',() => setFilter(button.dataset.filter));
memory.addEventListener('keydown',event => { if (event.key==='Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#search-form').requestSubmit(); } });
document.addEventListener('keydown',event => { if ((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='k') { event.preventDefault(); memory.focus(); } });
$('#focus-search').addEventListener('click',() => memory.focus());
$('#add-clue').addEventListener('click',() => { memory.focus(); memory.setSelectionRange(memory.value.length,memory.value.length); });
$('#cancel-search').addEventListener('click',async () => {
  if (!activeJob) return;
  try {
    await api('/api/search/' + activeJob + '/cancel',{});
    activeJob=null; sessionStorage.removeItem('echo-active-search'); setBusy(false); notice('Search cancelled. Your clue is still here.'); memory.focus();
  } catch (error) { notice(error.message); }
});
$('#refresh-archive').addEventListener('click',async () => {
  try { $('#refresh-archive').disabled=true; await api('/api/refresh',{}); recentLoaded=false; await status(); }
  catch (error) { notice(error.message); $('#refresh-archive').disabled=false; }
});
$('#close-preview').addEventListener('click',() => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('click',event => { if (event.target===$('#preview-dialog')) { const r=event.target.getBoundingClientRect(); if (event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) event.target.close(); } });
$('#more-preview').addEventListener('click',() => void loadPreview(true));
$('#auto-resume').checked=localStorage.getItem('echo-auto-resume')!=='false';
$('#auto-resume').addEventListener('change',() => localStorage.setItem('echo-auto-resume',String($('#auto-resume').checked)));
function theme(value) {
  document.documentElement.dataset.theme=value;
  $('#theme-button').setAttribute('aria-label','Switch to ' + (value==='dark' ? 'light' : 'dark') + ' theme');
  localStorage.setItem('echo-theme',value);
}
theme(localStorage.getItem('echo-theme')==='light' ? 'light' : 'dark');
$('#theme-button').addEventListener('click',() => theme(document.documentElement.dataset.theme==='dark' ? 'light' : 'dark'));

function memoryField() {
  const canvas=$('#memory-field');
  const ctx=canvas.getContext('2d');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0;
  let last=0;
  function draw(time) {
    requestAnimationFrame(draw);
    if (document.hidden || time-last<45 || (reduced.matches && frame>0)) return;
    last=time; frame++;
    const box=canvas.getBoundingClientRect();
    const ratio=Math.min(devicePixelRatio||1,2);
    if (canvas.width!==Math.round(box.width*ratio)||canvas.height!==Math.round(box.height*ratio)) { canvas.width=Math.round(box.width*ratio); canvas.height=Math.round(box.height*ratio); }
    ctx.setTransform(ratio,0,0,ratio,0,0);
    const w=box.width,h=box.height;
    ctx.clearRect(0,0,w,h);
    const radius=Math.min(w*.38,h*.40),cx=w/2,cy=h/2;
    const light=document.documentElement.dataset.theme==='light';
    const spin=reduced.matches ? .4 : time*.000025;
    const scanning=document.body.classList.contains('is-searching');
    const project=(x,y,z) => {
      const a=spin+.55,b=.48;
      const rx=x*Math.cos(a)+z*Math.sin(a),rz=-x*Math.sin(a)+z*Math.cos(a);
      const ry=y*Math.cos(b)-rz*Math.sin(b),depth=y*Math.sin(b)+rz*Math.cos(b);
      const scale=3.7/(3.7-depth*.25);
      return [cx+rx*radius*scale,cy+ry*radius*scale,depth];
    };
    const stroke=(points,color,width=1) => {
      ctx.beginPath();points.forEach((p,i) => { if (!i) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); });ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
    };
    for(let ring=0;ring<13;ring++) {
      const latitude=(ring/12-.5)*Math.PI;
      const points=[];
      for(let i=0;i<=100;i++){const a=i/100*Math.PI*2;points.push(project(Math.cos(latitude)*Math.cos(a),Math.sin(latitude),Math.cos(latitude)*Math.sin(a)));}
      stroke(points,light ? 'rgba(92,105,94,.19)' : 'rgba(167,183,166,.16)',.65);
    }
    for(let ring=0;ring<14;ring++) {
      const longitude=ring/14*Math.PI*2;
      const points=[];
      for(let i=0;i<=90;i++){const a=i/90*Math.PI*2;points.push(project(Math.cos(a)*Math.cos(longitude),Math.sin(a),Math.cos(a)*Math.sin(longitude)));}
      stroke(points,light ? 'rgba(92,105,94,.16)' : 'rgba(167,183,166,.11)',.65);
    }
    for(let ring=0;ring<3;ring++) {
      const points=[];
      const tilt=ring*.75+.2;
      for(let i=0;i<=160;i++){const a=i/160*Math.PI*2;points.push(project(1.15*Math.cos(a),Math.sin(a)*Math.sin(tilt)*1.15,Math.sin(a)*Math.cos(tilt)*1.15));}
      stroke(points,light ? 'rgba(150,82,31,.32)' : 'rgba(232,184,118,.3)',.75);
      const a=(scanning ? time*.0003 : time*.00004)+ring*2.1;
      const p=project(1.15*Math.cos(a),Math.sin(a)*Math.sin(tilt)*1.15,Math.sin(a)*Math.cos(tilt)*1.15);
      ctx.beginPath();ctx.arc(p[0],p[1],ring===0?3:2,0,Math.PI*2);ctx.fillStyle=light?'#96521f':'#e8b876';ctx.shadowColor='#e8b876';ctx.shadowBlur=10;ctx.fill();ctx.shadowBlur=0;
      if(ring===0&&h>220){stroke([p,[p[0]+24,p[1]-18],[p[0]+64,p[1]-18]],light?'#96521f77':'#e8b87666',.7);ctx.font='7px Plex,monospace';ctx.fillStyle=light?'#5c6c6c':'#889595';ctx.fillText('A THREAD',p[0]+29,p[1]-23);}
    }
    for(let i=0;i<40;i++){
      const a=i*2.39996,y=1-2*(i+.5)/40,r=Math.sqrt(1-y*y),p=project(r*Math.cos(a),y,r*Math.sin(a));
      if(p[2]<0) continue;
      ctx.fillStyle=light?'rgba(80,100,88,.5)':'rgba(211,227,206,.5)';ctx.fillRect(p[0],p[1],1.5,1.5);
    }
  }
  requestAnimationFrame(draw);
  reduced.addEventListener('change',() => {frame=0;});
  $('#theme-button').addEventListener('click',() => {frame=0;});
  new ResizeObserver(() => {frame=0;}).observe(canvas);
}
memoryField();
void (async () => {
  await status();
  const saved=sessionStorage.getItem('echo-active-search');
  if(saved){
    try {
      const job=await api('/api/search/'+saved);
      memory.value=job.query;
      if(job.finished){sessionStorage.removeItem('echo-active-search');if(job.result) await renderResults(job);}
      else {activeJob=saved;setBusy(true);startClock(job.startedAt);void poll(saved);}
    }catch{sessionStorage.removeItem('echo-active-search');}
  }
})();
setInterval(() => void status(),10000);
