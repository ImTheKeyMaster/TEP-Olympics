(() => {
  'use strict';
  const STORAGE_KEY = 'tep-hunt-data-v1';
  const SESSION_KEY = 'tep-hunt-admin';
  const FALLBACK_ICON = 'icons/lamp.png';
  const AVAILABLE_TEAM_ICONS = [
    { path: 'icons/lamp.png', label: 'Lamp' },
    { path: 'icons/open-book.png', label: 'Open Book' },
    { path: 'icons/scroll.png', label: 'Scroll' },
    { path: 'icons/star.png', label: 'Star' },
    { path: 'icons/sword.png', label: 'Sword' },
    { path: 'icons/three-plumes.png', label: 'Three Plumes' },
    { path: 'icons/torch.png', label: 'Torch' }
  ];
  const $ = id => document.getElementById(id);
  let data = { maximumScore: 100, updatedAt: new Date().toISOString(), teams: [] };
  let deferredInstall = null, pendingWorker = null, toastTimer;
  const teamRowElements = new Map();
  const revealState = {
    active: false, startedAt: 0, duration: 10000, displayedScores: new Map(),
    targetScores: new Map(), frame: 0, lastRankAt: 0, settledTeams: new Set(),
    highlightTimers: new Map(), highlightCooldowns: new Map(), reducedMotion: false
  };

  function validateDocument(value) {
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['The JSON root must be an object.'] };
    const maximum = Number(value.maximumScore);
    if (!Number.isFinite(maximum) || maximum <= 0) errors.push('Maximum score must be greater than zero.');
    if (!Array.isArray(value.teams)) errors.push('Teams must be an array.');
    const names = new Set(), ids = new Set(), cleanTeams = [];
    if (Array.isArray(value.teams)) value.teams.forEach((team, index) => {
      if (!team || typeof team !== 'object') { errors.push(`Team ${index + 1} is invalid.`); return; }
      const name = typeof team.name === 'string' ? team.name.trim() : '';
      const id = typeof team.id === 'string' ? team.id.trim() : '';
      const score = Number(team.score);
      const iconUrl = normalizeIconUrl(typeof team.iconUrl === 'string' ? team.iconUrl.trim() : '');
      if (!id || ids.has(id)) errors.push(`Team ${index + 1} needs a unique ID.`); else ids.add(id);
      if (!name) errors.push(`Team ${index + 1} needs a name.`);
      else if (names.has(name.toLocaleLowerCase())) errors.push(`Team name “${name}” is duplicated.`); else names.add(name.toLocaleLowerCase());
      if (!Number.isFinite(score) || score < 0) errors.push(`Score for ${name || `team ${index + 1}`} must be zero or greater.`);
      if (iconUrl && !safeIconUrl(iconUrl)) errors.push(`Icon URL for ${name || `team ${index + 1}`} is unsafe.`);
      cleanTeams.push({ id, name, iconUrl, score });
    });
    const date = new Date(value.updatedAt);
    if (Number.isNaN(date.getTime())) errors.push('updatedAt must be a valid date.');
    return { valid: !errors.length, errors, data: { maximumScore: maximum, updatedAt: date.toISOString(), teams: cleanTeams } };
  }

  function safeIconUrl(value) {
    if (!value) return '';
    try { const u = new URL(value, document.baseURI); return ['http:', 'https:'].includes(u.protocol) ? value : ''; } catch { return ''; }
  }
  function normalizeIconUrl(value) {
    if (/^(?:\.\/)?icons\/default-team\.svg$/i.test(value)) return value.replace(/default-team\.svg$/i, 'lamp.png');
    return value.replace(/\.svg$/i, '.png');
  }
  function matchingBuiltInIcon(value) {
    if (!value) return '';
    try {
      const requested = new URL(value, document.baseURI).href;
      return AVAILABLE_TEAM_ICONS.find(icon => new URL(icon.path, document.baseURI).href === requested)?.path || '';
    } catch { return ''; }
  }
  function announce(message, error = false) { const toast=$('toast'); toast.textContent=message; toast.style.background=error?'#751b29':'#172a22'; toast.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.hidden=true,3500); }
  function hashHue(id) { let h=0; for (const c of id) h=(h*31+c.charCodeAt(0))%360; return (h%70)+255; }
  function formatNumber(n) { return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))); }
  function formatDate(iso) { const d=new Date(iso); return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
  function compareTeams(a,b,scoreFor=team=>team.score) { return scoreFor(b)-scoreFor(a) || a.name.localeCompare(b.name,undefined,{sensitivity:'base'}); }
  function sortedTeams(scoreFor) { return [...data.teams].sort((a,b)=>compareTeams(a,b,scoreFor)); }
  function scorePrecision(score) { const text=String(score).toLowerCase(); return text.includes('e-')?Number(text.split('e-')[1]):(text.split('.')[1]||'').length; }

  function createLeaderboardRow(team,index,displayedScore=team.score) {
    const li=document.createElement('li'); li.className='team-row'; li.dataset.teamId=team.id;
    const content=document.createElement('div'); content.className='team-row-content';
    const rank=document.createElement('span'); rank.className='rank';
    const img=document.createElement('img'); img.className='team-icon'; img.alt=''; img.loading='lazy'; img.referrerPolicy='no-referrer'; img.src=safeIconUrl(team.iconUrl)||FALLBACK_ICON; img.addEventListener('error',()=>{if(!img.src.endsWith(FALLBACK_ICON))img.src=FALLBACK_ICON;},{once:true});
    const main=document.createElement('div'); main.className='team-main'; const name=document.createElement('div'); name.className='team-name'; name.textContent=team.name; name.title=team.name;
    const progress=document.createElement('div'); progress.className='progress'; progress.setAttribute('role','progressbar'); progress.setAttribute('aria-valuemin','0'); progress.setAttribute('aria-valuemax',String(data.maximumScore)); progress.style.setProperty('--hue',hashHue(team.id));
    const fill=document.createElement('div'); fill.className='progress-fill'; const score=document.createElement('span'); score.className='score-label'; progress.append(fill,score); main.append(name,progress); content.append(rank,img,main); li.append(content);
    const elements={team,row:li,content,rank,img,progress,fill,label:score}; teamRowElements.set(team.id,elements);
    updateTeamVisuals(team.id,displayedScore); updateTeamRank(team.id,index); return li;
  }
  function updateTeamRank(teamId,index) {
    const {rank}=teamRowElements.get(teamId); rank.className='rank'+(index<3?' medal':''); rank.textContent=['🥇','🥈','🥉'][index] || String(index+1); rank.setAttribute('aria-label',`Rank ${index+1}`);
  }
  function updateTeamVisuals(teamId,score,displayPrecision=null) {
    const elements=teamRowElements.get(teamId); if(!elements)return;
    const {team,progress,fill,label}=elements, displayedScore=displayPrecision===null?score:Number(score.toFixed(displayPrecision));
    const pct=data.maximumScore ? score/data.maximumScore*100 : 0, clamped=Math.min(100,Math.max(0,pct));
    label.textContent=`${formatNumber(displayedScore)} / ${formatNumber(data.maximumScore)}`; progress.setAttribute('aria-label',`${team.name}: ${formatNumber(displayedScore)} of ${formatNumber(data.maximumScore)} points, ${Math.round(pct)} percent`); progress.setAttribute('aria-valuenow',String(Math.min(score,data.maximumScore)));
    fill.style.setProperty('--progress',String(clamped/100));
  }

  function renderLeaderboard() {
    const list=$('leaderboard'); list.replaceChildren(); teamRowElements.clear(); const teams=sortedTeams();
    teams.forEach((team,index)=>list.append(createLeaderboardRow(team,index)));
    $('emptyState').hidden=teams.length>0; $('teamCount').textContent=`${teams.length} ${teams.length===1?'team':'teams'}`; $('updatedAt').dateTime=data.updatedAt; $('updatedAt').textContent=formatDate(data.updatedAt);
  }

  function reorderRevealRows(teams,now=performance.now()) {
    const list=$('leaderboard'), current=[...list.children].map(row=>row.dataset.teamId), next=teams.map(team=>team.id);
    if(current.every((id,index)=>id===next[index]))return false;
    const oldRanks=new Map(current.map((id,index)=>[id,index])), newRanks=new Map(next.map((id,index)=>[id,index]));
    const oldPositions=new Map(); if(!revealState.reducedMotion)current.forEach(id=>oldPositions.set(id,teamRowElements.get(id).row.getBoundingClientRect().top));
    teams.forEach((team,index)=>{list.append(teamRowElements.get(team.id).row);updateTeamRank(team.id,index)});
    if(!revealState.reducedMotion)teams.forEach(team=>{const row=teamRowElements.get(team.id).row,delta=oldPositions.get(team.id)-row.getBoundingClientRect().top;if(delta)row.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'})});
    const gains=teams.map(team=>({id:team.id,from:oldRanks.get(team.id),to:newRanks.get(team.id)})).filter(move=>move.from>move.to);
    const prioritized=gains.sort((a,b)=>(a.to===0?-1:0)-(b.to===0?-1:0)||(b.from-b.to)-(a.from-a.to)||a.to-b.to);
    return prioritized.some(move=>highlightTeam(move.id,move.to===0?'first-place':'rank-gain',now));
  }
  const HIGHLIGHT_CLASSES=['is-rank-gain','is-first-place','is-score-settled','is-final-winner'];
  function clearTeamHighlight(teamId) {
    const timer=revealState.highlightTimers.get(teamId); if(timer)clearTimeout(timer);
    revealState.highlightTimers.delete(teamId); teamRowElements.get(teamId)?.content.classList.remove(...HIGHLIGHT_CLASSES);
  }
  function clearAllHighlights() {
    revealState.highlightTimers.forEach(timer=>clearTimeout(timer)); revealState.highlightTimers.clear();
    teamRowElements.forEach(({content})=>content.classList.remove(...HIGHLIGHT_CLASSES));
  }
  function highlightTeam(teamId,event,now=performance.now(),ignoreCooldown=false) {
    const durations={'rank-gain':500,'first-place':900,'score-settled':400,'final-winner':900};
    if(!ignoreCooldown&&now-(revealState.highlightCooldowns.get(teamId)??-Infinity)<600)return false;
    const content=teamRowElements.get(teamId)?.content; if(!content)return false;
    clearTeamHighlight(teamId); content.classList.add(`is-${event}`); revealState.highlightCooldowns.set(teamId,now);
    const timer=setTimeout(()=>{content.classList.remove(`is-${event}`);revealState.highlightTimers.delete(teamId)},durations[event]);
    revealState.highlightTimers.set(teamId,timer); return true;
  }
  function revealCurve(teamIndex,progress) {
    const count=Math.max(1,data.teams.length), delay=revealState.reducedMotion?0:(teamIndex/count)*.07;
    const local=Math.max(0,Math.min(1,(progress-delay)/(1-delay)));
    return local>=.985?1:1-Math.pow(1-local,3);
  }
  function finishReveal() {
    if(!revealState.active)return; cancelAnimationFrame(revealState.frame);
    data.teams.forEach(team=>{const score=revealState.targetScores.get(team.id);revealState.displayedScores.set(team.id,score);updateTeamVisuals(team.id,score);teamRowElements.get(team.id).fill.style.removeProperty('will-change')});
    const finalTeams=sortedTeams(team=>revealState.displayedScores.get(team.id)); reorderRevealRows(finalTeams); clearAllHighlights(); $('revealProgress').style.setProperty('--progress','1'); $('revealProgress').style.removeProperty('will-change');
    if(finalTeams[0])highlightTeam(finalTeams[0].id,'final-winner',performance.now(),true);
    revealState.active=false; $('revealButton').disabled=false; $('revealButton').textContent='Reveal'; $('revealStatus').hidden=true;
    announce(finalTeams.length?`Score reveal complete. ${finalTeams[0].name} is in first place.`:'Score reveal complete.');
  }
  function cancelReveal() {
    if(!revealState.active)return; cancelAnimationFrame(revealState.frame); revealState.active=false; clearAllHighlights();
    $('revealProgress').style.removeProperty('will-change'); $('revealButton').disabled=false; $('revealButton').textContent='Reveal'; $('revealStatus').hidden=true; renderLeaderboard();
  }
  function revealFrame(now) {
    if(!revealState.active)return; const elapsed=now-revealState.startedAt, progress=Math.min(1,elapsed/revealState.duration); $('revealProgress').style.setProperty('--progress',String(progress));
    const newlySettled=[]; data.teams.forEach((team,index)=>{const target=revealState.targetScores.get(team.id),score=Math.min(target,target*revealCurve(index,progress));revealState.displayedScores.set(team.id,score);updateTeamVisuals(team.id,score,Math.max(1,scorePrecision(target)));if(score===target&&!revealState.settledTeams.has(team.id)){revealState.settledTeams.add(team.id);newlySettled.push(team.id)}});
    let rankHighlighted=false;if(now-revealState.lastRankAt>=200){revealState.lastRankAt=now;rankHighlighted=reorderRevealRows(sortedTeams(item=>revealState.displayedScores.get(item.id)),now)}
    if(!rankHighlighted&&newlySettled.length)highlightTeam(newlySettled[0],'score-settled',now);
    if(progress===1)finishReveal();else revealState.frame=requestAnimationFrame(revealFrame);
  }
  function startReveal() {
    if(revealState.active||!data.teams.length)return; cancelAnimationFrame(revealState.frame);clearAllHighlights();revealState.active=true;revealState.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;revealState.duration=revealState.reducedMotion?1000:10000;revealState.startedAt=performance.now();revealState.lastRankAt=-Infinity;revealState.displayedScores.clear();revealState.targetScores.clear();revealState.settledTeams.clear();revealState.highlightCooldowns.clear();
    data.teams.forEach(team=>{revealState.displayedScores.set(team.id,0);revealState.targetScores.set(team.id,team.score);updateTeamVisuals(team.id,0);if(!revealState.reducedMotion)teamRowElements.get(team.id).fill.style.willChange='transform'});if(!revealState.reducedMotion)reorderRevealRows(sortedTeams(team=>revealState.displayedScores.get(team.id)));
    $('revealButton').disabled=true;$('revealButton').textContent='Revealing...';$('revealStatus').hidden=false;$('revealProgress').style.setProperty('--progress','0');$('revealProgress').style.willChange='transform';announce('Score reveal started.');revealState.frame=requestAnimationFrame(revealFrame);
  }
  function renderAdmin() {
    $('maximumScore').value=data.maximumScore; const editor=$('teamEditor'); editor.replaceChildren();
    sortedTeams().forEach(team => editor.append(createTeamEditor(team)));
    if (!data.teams.length) { const p=document.createElement('p'); p.className='empty-state'; p.textContent='No teams. Add one to get started.'; editor.append(p); }
  }
  function createTeamEditor(team) {
    const card=document.createElement('form'); card.className='team-edit-card'; card.noValidate=true; card.dataset.id=team.id;
    const grid=document.createElement('div'); grid.className='team-edit-grid';
    const field=(label,type,value,kind) => { const wrap=document.createElement('div'), lab=document.createElement('label'), input=document.createElement('input'), err=document.createElement('p'); lab.textContent=label; input.type=type; input.value=value; input.dataset.field=kind; input.id=`${kind}-${team.id}`; lab.htmlFor=input.id; err.className='field-error'; err.dataset.error=kind; wrap.append(lab,input,err); return {wrap,input}; };
    const name=field('Team name','text',team.name,'name'), score=field('Current score','number',team.score,'score'); score.input.min='0'; score.input.step='any';
    const iconField=document.createElement('fieldset'); iconField.className='team-icon-field';
    const iconLegend=document.createElement('legend'); iconLegend.textContent='Team Icon';
    const iconHelp=document.createElement('p'); iconHelp.className='field-help'; iconHelp.textContent='Choose a built-in icon, or use a custom URL below.';
    const iconGrid=document.createElement('div'); iconGrid.className='team-icon-grid';
    const selectedBuiltIn=matchingBuiltInIcon(team.iconUrl);
    AVAILABLE_TEAM_ICONS.forEach(icon => {
      const option=document.createElement('label'); option.className='team-icon-option';
      const radio=document.createElement('input'); radio.type='radio'; radio.name=`icon-${team.id}`; radio.value=icon.path; radio.dataset.field='builtInIcon'; radio.checked=icon.path===selectedBuiltIn;
      const preview=document.createElement('img'); preview.src=icon.path; preview.alt=`${icon.label} icon`; preview.loading='lazy'; preview.addEventListener('error',()=>{preview.src=FALLBACK_ICON},{once:true});
      const label=document.createElement('span'); label.textContent=icon.label;
      const check=document.createElement('span'); check.className='icon-check'; check.textContent='✓'; check.setAttribute('aria-hidden','true');
      option.append(radio,preview,label,check); iconGrid.append(option);
    });
    const custom=document.createElement('details'); custom.className='custom-icon'; custom.open=Boolean(team.iconUrl && !selectedBuiltIn);
    const customSummary=document.createElement('summary'); customSummary.textContent='Custom Icon URL';
    const customField=field('Custom icon URL','url',selectedBuiltIn?'':team.iconUrl,'iconUrl'); customField.input.placeholder='https://example.com/icon.png';
    custom.append(customSummary,customField.wrap); iconField.append(iconLegend,iconHelp,iconGrid,custom);
    iconGrid.addEventListener('change',event=>{if(event.target.matches('[data-field=builtInIcon]'))customField.input.value=''});
    customField.input.addEventListener('input',()=>{if(customField.input.value)iconGrid.querySelectorAll('input[type=radio]').forEach(radio=>radio.checked=false)});
    const scoreRow=document.createElement('div'); scoreRow.className='score-input'; const minus=document.createElement('button'); minus.type='button'; minus.textContent='−1'; minus.setAttribute('aria-label',`Subtract one point from ${team.name}`); const plus=document.createElement('button'); plus.type='button'; plus.textContent='+1'; plus.setAttribute('aria-label',`Add one point to ${team.name}`); score.input.parentNode?.removeChild(score.input); scoreRow.append(minus,score.input,plus); score.wrap.insertBefore(scoreRow,score.wrap.querySelector('.field-error'));
    minus.onclick=()=>{const n=Number(score.input.value); score.input.value=Number.isFinite(n)?Math.max(0,n-1):0}; plus.onclick=()=>{const n=Number(score.input.value); score.input.value=Number.isFinite(n)?n+1:1};
    grid.append(name.wrap,score.wrap); const actions=document.createElement('div'); actions.className='team-actions';
    const cancel=document.createElement('button'); cancel.type='button'; cancel.className='secondary'; cancel.textContent='Cancel'; cancel.onclick=()=>{if(team._isNew)data.teams=data.teams.filter(item=>item.id!==team.id);renderAdmin()}; const remove=document.createElement('button'); remove.type='button'; remove.className='danger'; remove.textContent='Remove'; remove.onclick=()=>removeTeam(team); const save=document.createElement('button'); save.type='submit'; save.className='primary'; save.textContent='Save changes'; actions.append(cancel,remove,save); card.append(grid,iconField,actions); card.addEventListener('submit',event=>saveTeam(event,team.id)); return card;
  }
  function saveTeam(event,id) {
    event.preventDefault(); const form=event.currentTarget, button=form.querySelector('[type=submit]'); if(button.disabled)return; button.disabled=true;
    form.querySelectorAll('.field-error').forEach(e=>e.textContent=''); const name=form.querySelector('[data-field=name]').value.trim(), selectedIcon=form.querySelector('[data-field=builtInIcon]:checked'), customIcon=form.querySelector('[data-field=iconUrl]').value.trim(), iconUrl=normalizeIconUrl(selectedIcon?.value || customIcon), raw=form.querySelector('[data-field=score]').value, score=Number(raw); let valid=true;
    const error=(field,msg)=>{form.querySelector(`[data-error=${field}]`).textContent=msg;valid=false}; if(!name)error('name','A team name is required.'); if(data.teams.some(t=>t.id!==id&&t.name.toLowerCase()===name.toLowerCase()))error('name','Team names must be unique.'); if(raw.trim()===''||!Number.isFinite(score)||score<0)error('score','Enter a score of zero or greater.'); if(iconUrl&&!safeIconUrl(iconUrl))error('iconUrl','Use an http(s) URL or safe relative path.');
    if(!valid){announce('Please correct the highlighted fields.',true);button.disabled=false;return} const team=data.teams.find(t=>t.id===id); Object.assign(team,{name,iconUrl,score}); delete team._isNew; persist('Team saved.'); button.disabled=false;
  }
  async function removeTeam(team) { if(await confirmAction('Remove team?',`Remove ${team.name} from this device's leaderboard?`)){data.teams=data.teams.filter(t=>t.id!==team.id);persist('Team removed.')} }
  function persist(message) { data.updatedAt=new Date().toISOString(); try { localStorage.setItem(STORAGE_KEY,JSON.stringify(data)); } catch(error) { console.warn('Local data could not be saved:',error); announce('Changes are visible, but could not be saved on this device.',true); renderLeaderboard(); renderAdmin(); return; } renderLeaderboard(); renderAdmin(); announce(message); }
  function newId(){return crypto.randomUUID?.() || `team-${Date.now()}-${Math.random().toString(36).slice(2,9)}`}
  async function loadPublished() { const response=await fetch('data/teams.json',{cache:'no-cache'}); if(!response.ok)throw new Error('Published data unavailable'); const result=validateDocument(await response.json()); if(!result.valid)throw new Error(result.errors.join(' ')); return result.data; }
  async function loadData() {
    let local = null;
    try { local=localStorage.getItem(STORAGE_KEY); } catch(error) { console.warn('Local data is unavailable:',error); }
    if(local) {
      try {
        const result=validateDocument(JSON.parse(local));
        if(result.valid){data=result.data;return}
        console.warn('Ignoring invalid local data:',result.errors);
      } catch(error) { console.warn('Ignoring malformed local data:',error); }
      try { localStorage.removeItem(STORAGE_KEY); } catch(error) { console.warn('Invalid local data could not be removed:',error); }
      announce('Saved data was invalid; using published data.',true);
    }
    try { data=await loadPublished(); }
    catch(error){console.warn(error);data={maximumScore:100,updatedAt:new Date().toISOString(),teams:[]};announce('Published data could not be loaded. Safe defaults are in use.',true)}
  }

  function authorized(){return sessionStorage.getItem(SESSION_KEY)==='yes'}
  // Client-side authentication only deters casual access; source inspection can reveal or bypass it.
  function passwordMatches(value){return value === ['T','a','u','b','o','y','s'].join('')}
  function route() { let name=location.hash.slice(1)||'leaderboard'; if(!['leaderboard','admin','about'].includes(name))name='leaderboard'; if(name!=='leaderboard')cancelReveal(); document.querySelectorAll('.screen').forEach(s=>s.hidden=true); if(name==='admin'){if(authorized()){$('adminScreen').hidden=false;renderAdmin()}else{$('loginScreen').hidden=false;setTimeout(()=>$('password').focus(),0)}}else $(name+'Screen').hidden=false; closeMenu(); window.scrollTo(0,0); }
  function openMenu(){ $('drawer').classList.add('open');$('drawer').setAttribute('aria-hidden','false');$('menuButton').setAttribute('aria-expanded','true');$('scrim').hidden=false;$('closeMenu').focus() }
  function closeMenu(){ $('drawer').classList.remove('open');$('drawer').setAttribute('aria-hidden','true');$('menuButton').setAttribute('aria-expanded','false');$('scrim').hidden=true }
  function confirmAction(title,message){return new Promise(resolve=>{const dialog=$('confirmDialog');$('dialogTitle').textContent=title;$('dialogMessage').textContent=message;dialog.showModal();dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true})})}
  function downloadJson(){const blob=new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='teams.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);announce('JSON exported.')}

  function bindEvents(){
    addEventListener('hashchange',route);$('menuButton').onclick=openMenu;$('closeMenu').onclick=closeMenu;$('scrim').onclick=closeMenu;addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});$('refreshButton').onclick=()=>location.reload();$('revealButton').onclick=startReveal;
    $('togglePassword').onclick=()=>{const p=$('password'),show=p.type==='password';p.type=show?'text':'password';$('togglePassword').textContent=show?'Hide':'Show';$('togglePassword').setAttribute('aria-label',show?'Hide password':'Show password')};
    $('loginForm').onsubmit=e=>{e.preventDefault();if(passwordMatches($('password').value)){sessionStorage.setItem(SESSION_KEY,'yes');$('password').value='';$('loginError').textContent='';route();announce('Signed in.')}else{$('loginError').textContent='Incorrect password. Please try again.';$('password').select()}};
    $('logoutButton').onclick=()=>{sessionStorage.removeItem(SESSION_KEY);location.hash='leaderboard';announce('Logged out.')};
    $('maximumForm').onsubmit=e=>{e.preventDefault();const raw=$('maximumScore').value,n=Number(raw);$('maximumError').textContent='';if(raw.trim()===''||!Number.isFinite(n)||n<=0){$('maximumError').textContent='Enter a number greater than zero.';announce('Maximum score is invalid.',true);return}data.maximumScore=n;persist('Maximum score updated.')};
    $('addTeam').onclick=()=>{const id=newId();data.teams.push({id,name:'New Team',iconUrl:AVAILABLE_TEAM_ICONS[0].path,score:0,_isNew:true});renderAdmin();const card=document.querySelector(`[data-id="${CSS.escape(id)}"]`);card.querySelector('[data-field=name]').select();card.scrollIntoView({behavior:'smooth',block:'center'})};
    $('exportJson').onclick=downloadJson;$('copyJson').onclick=async()=>{try{await navigator.clipboard.writeText(JSON.stringify(data,null,2)+'\n');announce('JSON copied to clipboard.')}catch{announce('Clipboard access was unavailable.',true)}};
    $('importJson').onclick=()=>$('importFile').click();$('importFile').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{const result=validateDocument(JSON.parse(await file.text()));if(!result.valid)throw new Error(result.errors.join(' '));if(await confirmAction('Import JSON?',`Replace local data with ${result.data.teams.length} teams and a maximum score of ${formatNumber(result.data.maximumScore)}?`)){data=result.data;persist('JSON imported.')}}catch(error){announce(`Import rejected: ${error.message}`,true)}};
    $('resetData').onclick=async()=>{if(await confirmAction('Reset local data?','Discard all edits on this device and reload the published teams.json?'))try{const fresh=await loadPublished();localStorage.removeItem(STORAGE_KEY);data=fresh;renderLeaderboard();renderAdmin();announce('Published data restored.')}catch{announce('Published data could not be loaded.',true)}};
    addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;$('installButton').hidden=false});$('installButton').onclick=async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$('installButton').hidden=true};addEventListener('appinstalled',()=>{$('installButton').hidden=true;announce('App installed.')});
    $('applyUpdate').onclick=()=>{pendingWorker?.postMessage('SKIP_WAITING')};
  }
  function registerServiceWorker(){if(!('serviceWorker'in navigator)||(location.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(location.hostname)))return;navigator.serviceWorker.register('service-worker.js').then(reg=>{if(reg.waiting)showUpdate(reg.waiting);reg.addEventListener('updatefound',()=>{const worker=reg.installing;worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)showUpdate(worker)})})}).catch(error=>console.warn('Service worker registration failed:',error));navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload())}
  function showUpdate(worker){pendingWorker=worker;$('updateNotice').hidden=false}
  async function init(){bindEvents();await loadData();renderLeaderboard();route();registerServiceWorker()}
  init().catch(error=>{console.error(error);announce('The app encountered an unexpected error.',true)});
})();
