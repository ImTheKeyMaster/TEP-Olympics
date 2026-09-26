import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { collection, doc, initializeFirestore, onSnapshot, persistentLocalCache, persistentMultipleTabManager, serverTimestamp, setDoc, waitForPendingWrites, writeBatch } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

(() => {
  'use strict';
  const APP_VERSION = '14';
  const firebaseConfig = {
    apiKey: 'AIzaSyBae3zbFxXrNXIj5WSHA_aECq0y7T7M0v0',
    authDomain: 'tep-olympics.firebaseapp.com',
    projectId: 'tep-olympics',
    storageBucket: 'tep-olympics.firebasestorage.app',
    messagingSenderId: '999170332653',
    appId: '1:999170332653:web:3cebe0f44279b48f5f39e4'
  };
  const firebaseApp = initializeApp(firebaseConfig);
  const auth = getAuth(firebaseApp);
  const db = initializeFirestore(firebaseApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  const FALLBACK_ICON = 'icons/lamp.png';
  // Ordered so neighboring assignments are easy to distinguish. Every shade
  // meets WCAG AA for normal text on the leaderboard's light backgrounds.
  const TEAM_COLOR_PALETTE = [
    '#1d4ed8', '#b91c1c', '#047857', '#c2410c',
    '#7e22ce', '#0f766e', '#a21caf', '#8a5a00',
    '#be185d', '#1e3a8a', '#166534', '#9a3412',
    '#0e7490', '#4338ca', '#7f1d1d', '#0f6f72'
  ];
  const AVAILABLE_TEAM_ICONS = [
    { path: 'icons/lamp.png', label: 'Lamp' },
    { path: 'icons/Emeralds.png', label: 'Emeralds' },
    { path: 'icons/open-book.png', label: 'Open Book' },
    { path: 'icons/pearls.png', label: 'Pearls' },
    { path: 'icons/scroll.png', label: 'Scroll' },
    { path: 'icons/star.png', label: 'Star' },
    { path: 'icons/sword.png', label: 'Sword' },
    { path: 'icons/three-plumes.png', label: 'Three Plumes' },
    { path: 'icons/torch.png', label: 'Torch' }
  ];
  const $ = id => document.getElementById(id);
  let data = { maximumScore: 100, updatedAt: new Date().toISOString(), teams: [] };
  let pendingWorker = null, toastTimer, currentUser = null;
  let teamSnapshot = null, settingsSnapshot = null, unsubscribeTeams = null, unsubscribeSettings = null;
  let hasServerBackedSnapshot = false, fallbackLoadPromise = null, appliedDataFingerprint = '', adminRefreshPending = false;
  const teamRowElements = new Map();
  const revealState = {
    status: 'idle', generation: 0, displayedScores: new Map(),
    targetScores: new Map(), frame: 0, settledTeams: new Set(),
    highlightTimers: new Map(), highlightCooldowns: new Map(), reducedMotion: false,
    schedule: [], nextEvent: 0, teams: new Map(), settlingAt: 0, movementUntil: 0,
    nextEventAt: 0, finalizing: false, rowAnimations: new Set(), rowAnimationTimers: new Set(), pendingFrames: new Set()
  };

  function updateRevealButton() {
    const button=$('revealButton'), revealing=revealState.status==='revealing';
    button.textContent=revealState.status==='complete'?'Reset':revealing?'Revealing...':'Reveal';
    button.disabled=revealing;
    button.setAttribute('aria-label',revealState.status==='complete'?'Reset the public leaderboard':revealing?'Score reveal in progress':'Reveal the current team scores');
  }
  function queueRevealFrame(callback) {
    const frame=requestAnimationFrame(now=>{revealState.pendingFrames.delete(frame);callback(now)});
    revealState.pendingFrames.add(frame); return frame;
  }

  function nextTeamColor(teams) {
    const used=new Set(teams.map(team=>team.color).filter(color=>TEAM_COLOR_PALETTE.includes(color)));
    return TEAM_COLOR_PALETTE.find(color=>!used.has(color)) || '';
  }

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
      const requestedColor=typeof team.color==='string'?team.color.toLowerCase():'';
      const color=TEAM_COLOR_PALETTE.includes(requestedColor)&&!cleanTeams.some(item=>item.color===requestedColor)
        ? requestedColor
        : nextTeamColor(cleanTeams);
      if(!color)errors.push(`Team ${index + 1} cannot be assigned a unique color; the ${TEAM_COLOR_PALETTE.length}-team palette is full.`);
      cleanTeams.push({ id, name, iconUrl, score, color });
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
  function roundToPrecision(value,precision) { const scale=10**precision; return Math.round((value+Number.EPSILON)*scale)/scale; }

  function createLeaderboardRow(team,displayedScore=0) {
    const li=document.createElement('li'); li.className='team-row'; li.dataset.teamId=team.id; li.style.setProperty('--team-color',team.color);
    const content=document.createElement('div'); content.className='team-row-content';
    const medal=document.createElement('span'); medal.className='medal'; medal.hidden=true;
    const img=document.createElement('img'); img.className='team-icon'; img.alt=''; img.loading='lazy'; img.referrerPolicy='no-referrer'; img.src=safeIconUrl(team.iconUrl)||FALLBACK_ICON; img.addEventListener('error',()=>{if(!img.src.endsWith(FALLBACK_ICON))img.src=FALLBACK_ICON;},{once:true});
    const main=document.createElement('div'); main.className='team-main'; const name=document.createElement('div'); name.className='team-name'; name.textContent=team.name; name.title=team.name;
    const progress=document.createElement('div'); progress.className='progress'; progress.setAttribute('role','progressbar'); progress.setAttribute('aria-valuemin','0'); progress.setAttribute('aria-valuemax',String(data.maximumScore)); progress.style.setProperty('--hue',hashHue(team.id));
    const fill=document.createElement('div'); fill.className='progress-fill'; const score=document.createElement('span'); score.className='score-label'; progress.append(fill,score); main.append(name,progress); content.append(img,main,medal); li.append(content);
    const elements={team,row:li,content,medal,img,progress,fill,label:score}; teamRowElements.set(team.id,elements);
    updateTeamVisuals(team.id,displayedScore); return li;
  }
  function updateTeamMedal(teamId,index,show=false,animate=false) {
    const {medal}=teamRowElements.get(teamId), awarded=show&&index<3;
    medal.hidden=!awarded; medal.className='medal'+(awarded&&animate&&!revealState.reducedMotion?' is-medal-arriving':''); medal.textContent=awarded?['🥇','🥈','🥉'][index]:'';
    if(awarded)medal.setAttribute('aria-label',`${['Gold','Silver','Bronze'][index]} medal`);else medal.removeAttribute('aria-label');
  }
  function updateTeamVisuals(teamId,score,displayPrecision=null) {
    const elements=teamRowElements.get(teamId); if(!elements)return;
    const {team,progress,fill,label}=elements, displayedScore=displayPrecision===null?score:Number(score.toFixed(displayPrecision));
    const pct=data.maximumScore ? score/data.maximumScore*100 : 0, clamped=Math.min(100,Math.max(0,pct));
    label.textContent=`${formatNumber(displayedScore)} / ${formatNumber(data.maximumScore)}`; progress.setAttribute('aria-label',`${team.name}: ${formatNumber(displayedScore)} of ${formatNumber(data.maximumScore)} points, ${Math.round(pct)} percent`); progress.setAttribute('aria-valuenow',String(Math.min(score,data.maximumScore)));
    fill.style.setProperty('--progress',String(clamped/100));
  }

  function renderLeaderboard() {
    const list=$('leaderboard'); list.replaceChildren(); teamRowElements.clear();
    const teams=[...data.teams].sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
    revealState.displayedScores.clear(); revealState.targetScores.clear();
    teams.forEach((team,index)=>{revealState.displayedScores.set(team.id,0);revealState.targetScores.set(team.id,team.score);list.append(createLeaderboardRow(team))});
    $('emptyState').hidden=teams.length>0; $('teamCount').textContent=`${teams.length} ${teams.length===1?'team':'teams'}`; $('updatedAt').dateTime=data.updatedAt; $('updatedAt').textContent=formatDate(data.updatedAt);
  }

  function reorderRevealRows(teams,now=performance.now(),animate=false) {
    const list=$('leaderboard'), current=[...list.children].map(row=>row.dataset.teamId), next=teams.map(team=>team.id);
    if(current.every((id,index)=>id===next[index]))return {changed:false};
    const oldPositions=new Map(); if(animate&&!revealState.reducedMotion)current.forEach(id=>oldPositions.set(id,teamRowElements.get(id).row.getBoundingClientRect().top));
    teams.forEach(team=>list.append(teamRowElements.get(team.id).row));
    if(animate&&!revealState.reducedMotion){teams.forEach(team=>{const row=teamRowElements.get(team.id).row,delta=oldPositions.get(team.id)-row.getBoundingClientRect().top;if(delta){const duration=180,animation=row.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration,easing:'cubic-bezier(.2,.8,.2,1)'});revealState.rowAnimations.add(animation);let settled=false,fallback=0;const settle=()=>{if(settled)return;settled=true;revealState.rowAnimations.delete(animation);clearTimeout(fallback);revealState.rowAnimationTimers.delete(fallback)};animation.addEventListener('finish',settle,{once:true});animation.addEventListener('cancel',settle,{once:true});/* Some browsers omit Web Animation completion events; never let that stall Reveal. */fallback=setTimeout(settle,duration+50);revealState.rowAnimationTimers.add(fallback)}});revealState.movementUntil=now+190}
    return {changed:true,visualUntil:revealState.movementUntil};
  }
  const HIGHLIGHT_CLASSES=['is-score-settled','is-final-winner'];
  function clearTeamHighlight(teamId) {
    const timer=revealState.highlightTimers.get(teamId); if(timer)clearTimeout(timer);
    revealState.highlightTimers.delete(teamId); teamRowElements.get(teamId)?.content.classList.remove(...HIGHLIGHT_CLASSES);
  }
  function clearAllHighlights() {
    revealState.highlightTimers.forEach(timer=>clearTimeout(timer)); revealState.highlightTimers.clear();
    teamRowElements.forEach(({content})=>content.classList.remove(...HIGHLIGHT_CLASSES));
  }
  function highlightTeam(teamId,event,now=performance.now(),ignoreCooldown=false) {
    const durations={'score-settled':400,'final-winner':900};
    if(!ignoreCooldown&&now-(revealState.highlightCooldowns.get(teamId)??-Infinity)<600)return false;
    const content=teamRowElements.get(teamId)?.content; if(!content)return false;
    clearTeamHighlight(teamId); content.classList.add(`is-${event}`); revealState.highlightCooldowns.set(teamId,now);
    const generation=revealState.generation;
    const timer=setTimeout(()=>{if(generation!==revealState.generation)return;content.classList.remove(`is-${event}`);revealState.highlightTimers.delete(teamId)},durations[event]);
    revealState.highlightTimers.set(teamId,timer); return true;
  }
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  function createRevealSchedule(teams) {
    const highest=Math.max(0,...teams.map(team=>team.score)), events=[];
    teams.forEach(team=>{
      const target=team.score, precision=scorePrecision(target), scale=10**precision, units=Math.round(target*scale);
      if(units<=0)return;
      const normalized=highest?target/highest:0, weight=clamp(1.25-normalized*.65,.6,1.4);
      const desired=Math.round(clamp((54/Math.max(1,teams.length))*weight,7,16)), count=Math.min(units,desired);
      const openingCount=Math.min(count-1,1);
      const middleCount=Math.max(0,Math.round((count-1-openingCount)*.55));
      const phaseCounts=[openingCount,middleCount,count-1-openingCount-middleCount];
      const openingShare=.045+Math.random()*.045, middleShare=.43+Math.random()*.1;
      const phaseUnits=[Math.max(openingCount,Math.round(units*openingShare)),Math.max(middleCount,Math.round(units*middleShare))];
      if(phaseUnits[0]+phaseUnits[1]>units-phaseCounts[2]-1)phaseUnits[1]=Math.max(middleCount,units-phaseUnits[0]-phaseCounts[2]-1);
      phaseUnits.push(units-phaseUnits[0]-phaseUnits[1]-1);
      const firstUpdate=clamp(900+Math.random()*1450+normalized*120,900,2450);
      [[firstUpdate,2850],[3000,6500],[6650,9420]].forEach(([start,end],phase)=>{
        const n=phaseCounts[phase], budget=phaseUnits[phase]; if(!n)return;
        let allocated=0;
        for(let i=0;i<n;i++){
          const remaining=budget-allocated-(n-i-1), amount=i===n-1?budget-allocated:clamp(Math.round((budget-allocated)/(n-i)*(.7+Math.random()*.6)),1,remaining);
          allocated+=amount;
          const position=phase===0&&i===0?0:(i+(phase===0?0:1))/(n+(phase===0?0:1));
          const time=phase===0&&i===0?start:clamp(start+position*(end-start)+(Math.random()-.5)*120,start,end);
          events.push({time,teamId:team.id,amount:amount/scale});
        }
      });
      events.push({time:9200+Math.random()*320,teamId:team.id,amount:1/scale,final:true});
    });
    events.sort((a,b)=>a.time-b.time);
    let lastOpening=300; const lastTeamOpening=new Map();
    events.filter(event=>event.time<3000).forEach(event=>{
      event.time=Math.max(event.time,lastOpening+475+Math.random()*175,(lastTeamOpening.get(event.teamId)??-Infinity)+700);
      lastOpening=event.time; lastTeamOpening.set(event.teamId,event.time);
    });
    events.sort((a,b)=>a.time-b.time);
    let previousTime=0;
    return events.map((event,index)=>{
      const delay=index===0?event.time:clamp(event.time-previousTime,110,420);
      previousTime=event.time;
      return {...event,delay};
    });
  }
  function beginTeamIncrement(event,now) {
    const state=revealState.teams.get(event.teamId); if(!state)return;
    updateTeamScoreAnimation(event.teamId,now);
    state.committedScore=event.final?state.targetScore:Math.min(state.targetScore,state.committedScore+event.amount);
    state.animationStartScore=state.visualScore; state.animationEndScore=state.committedScore; state.animationStartTime=now;
    state.animationDuration=clamp(event.delay*.72,180,400);
  }
  function updateTeamScoreAnimation(teamId,now) {
    const state=revealState.teams.get(teamId); if(!state)return;
    const progress=clamp((now-state.animationStartTime)/Math.max(1,state.animationDuration),0,1), eased=1-(1-progress)**3;
    state.visualScore=Math.min(state.targetScore,state.animationStartScore+(state.animationEndScore-state.animationStartScore)*eased);
    const displayed=roundToPrecision(state.visualScore,state.precision); revealState.displayedScores.set(teamId,displayed); updateTeamVisuals(teamId,state.visualScore,state.precision);
    if(state.targetScore>0&&progress===1&&state.visualScore===state.targetScore&&!revealState.settledTeams.has(teamId)){revealState.settledTeams.add(teamId);highlightTeam(teamId,'score-settled',now)}
  }
  function scoreAnimationsFinished(now) {
    return [...revealState.teams.values()].every(state=>now>=state.animationStartTime+state.animationDuration);
  }
  function finishReveal(now) {
    data.teams.forEach(team=>{const state=revealState.teams.get(team.id);state.visualScore=state.committedScore=state.targetScore;revealState.displayedScores.set(team.id,state.targetScore);updateTeamVisuals(team.id,state.targetScore);teamRowElements.get(team.id).fill.style.removeProperty('will-change')});
    console.log('[Reveal] final scoring complete');
    clearAllHighlights(); console.log('[Reveal] starting final reorder'); reorderRevealRows(sortedTeams(team=>revealState.targetScores.get(team.id)),now,true); revealState.settlingAt=Math.max(now,revealState.movementUntil)+30;
  }
  function completeReveal(now) {
    if(revealState.rowAnimations.size){revealState.settlingAt=now+16;return}
    const finalTeams=sortedTeams(team=>revealState.targetScores.get(team.id));
    if(!revealState.finalizing){
      console.log('[Reveal] final reorder complete');
      finalTeams.forEach((team,index)=>updateTeamMedal(team.id,index,true,true));
      if(finalTeams[0])highlightTeam(finalTeams[0].id,'final-winner',now,true);
      console.log('[Reveal] medals applied');
      revealState.finalizing=true; revealState.settlingAt=now+900; return;
    }
    console.log('[Reveal] setting state complete');
    revealState.status='complete'; revealState.settlingAt=0; updateRevealButton(); console.log('[Reveal] button updated to Reset'); $('revealStatus').hidden=true;
    announce(finalTeams.length?`Score reveal complete. ${finalTeams[0].name} is in first place.`:'Score reveal complete.');
  }
  function resetRevealPresentation() {
    revealState.generation++; revealState.status='idle';
    clearAllHighlights(); cancelAnimationFrame(revealState.frame); revealState.pendingFrames.forEach(frame=>cancelAnimationFrame(frame)); revealState.pendingFrames.clear();
    revealState.rowAnimations.forEach(animation=>animation.cancel()); revealState.rowAnimations.clear(); revealState.rowAnimationTimers.forEach(timer=>clearTimeout(timer)); revealState.rowAnimationTimers.clear();
    teamRowElements.forEach(({row,content,fill,medal})=>{row.style.removeProperty('transform');content.style.removeProperty('transform');content.classList.remove(...HIGHLIGHT_CLASSES);fill.style.removeProperty('will-change');medal.classList.remove('is-medal-arriving')});
    revealState.schedule=[]; revealState.teams.clear(); revealState.settledTeams.clear(); revealState.highlightCooldowns.clear(); revealState.settlingAt=0; revealState.nextEventAt=0; revealState.nextEvent=0; revealState.finalizing=false; revealState.movementUntil=0;
    revealState.displayedScores.clear(); revealState.targetScores.clear(); $('revealStatus').hidden=true; renderLeaderboard(); updateRevealButton();
  }
  function cancelReveal() { resetRevealPresentation() }
  function revealFrame(now,generation) {
    if(revealState.status!=='revealing'||generation!==revealState.generation)return;
    if(revealState.settlingAt){
      if(now>=revealState.settlingAt)completeReveal(now);
      if(revealState.status==='revealing')revealState.frame=queueRevealFrame(time=>revealFrame(time,generation));
      return;
    }
    if(revealState.reducedMotion){
      data.teams.forEach(team=>{const state=revealState.teams.get(team.id);state.visualScore=state.committedScore=state.targetScore;revealState.displayedScores.set(team.id,state.targetScore);updateTeamVisuals(team.id,state.targetScore,state.precision)});
      finishReveal(now);
    }
    else {
      if(revealState.nextEvent<revealState.schedule.length&&now>=revealState.nextEventAt){
        beginTeamIncrement(revealState.schedule[revealState.nextEvent++],now);
        revealState.nextEventAt=revealState.nextEvent<revealState.schedule.length?now+revealState.schedule[revealState.nextEvent].delay:Infinity;
      }
      data.teams.forEach(team=>updateTeamScoreAnimation(team.id,now));
    }
    if(!revealState.reducedMotion&&revealState.nextEvent>=revealState.schedule.length&&scoreAnimationsFinished(now))finishReveal(now); if(revealState.status==='revealing')revealState.frame=queueRevealFrame(time=>revealFrame(time,generation));
  }
  function startReveal() {
    if(revealState.status!=='idle'||!data.teams.length)return; cancelAnimationFrame(revealState.frame);clearAllHighlights();revealState.generation++;const generation=revealState.generation;revealState.status='revealing';revealState.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
    revealState.nextEvent=0;revealState.settlingAt=0;revealState.movementUntil=0;revealState.nextEventAt=0;revealState.finalizing=false;revealState.displayedScores.clear();revealState.targetScores.clear();revealState.settledTeams.clear();revealState.highlightCooldowns.clear();revealState.teams.clear();
    data.teams.forEach(team=>{revealState.displayedScores.set(team.id,0);revealState.targetScores.set(team.id,team.score);revealState.teams.set(team.id,{visualScore:0,committedScore:0,targetScore:team.score,animationStartScore:0,animationEndScore:0,animationStartTime:0,animationDuration:1,precision:scorePrecision(team.score)});updateTeamVisuals(team.id,0);updateTeamMedal(team.id,0,false);if(!revealState.reducedMotion)teamRowElements.get(team.id).fill.style.willChange='transform'});
    const alphabetical=[...data.teams].sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));reorderRevealRows(alphabetical);clearAllHighlights();revealState.highlightCooldowns.clear();revealState.schedule=revealState.reducedMotion?[]:createRevealSchedule(data.teams);
    updateRevealButton();$('revealStatus').hidden=false;announce('Score reveal started.');
    queueRevealFrame(()=>queueRevealFrame(now=>{if(revealState.status==='revealing'&&generation===revealState.generation){revealState.nextEventAt=revealState.schedule.length?now+revealState.schedule[0].delay:now;revealState.frame=queueRevealFrame(time=>revealFrame(time,generation))}}));
  }
  function handleRevealButton() { if(revealState.status==='complete')resetRevealPresentation();else if(revealState.status==='idle')startReveal() }
  function adminHasUnsavedTeamEdits() { return Boolean(document.querySelector('#teamEditor .team-edit-card[data-dirty="true"]')); }
  function renderAdmin(force=false) {
    if(!force&&adminHasUnsavedTeamEdits()){adminRefreshPending=true;return}
    adminRefreshPending=false;
    $('maximumScore').value=data.maximumScore; const editor=$('teamEditor'); editor.replaceChildren();
    sortedTeams().forEach(team => editor.append(createTeamEditor(team)));
    if (!data.teams.length) { const p=document.createElement('p'); p.className='empty-state'; p.textContent='No teams. Add one to get started.'; editor.append(p); }
  }
  function createTeamEditor(team) {
    const card=document.createElement('form'); card.className='team-edit-card'; card.noValidate=true; card.dataset.id=team.id; card.dataset.color=team.color; card.dataset.order=String(data.teams.findIndex(item=>item.id===team.id)); card.dataset.dirty=team._isNew?'true':'false';
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
    minus.onclick=()=>{const n=Number(score.input.value); score.input.value=Number.isFinite(n)?Math.max(0,n-1):0;card.dataset.dirty='true'}; plus.onclick=()=>{const n=Number(score.input.value); score.input.value=Number.isFinite(n)?n+1:1;card.dataset.dirty='true'};
    grid.append(name.wrap,score.wrap); const actions=document.createElement('div'); actions.className='team-actions';
    const cancel=document.createElement('button'); cancel.type='button'; cancel.className='secondary'; cancel.textContent='Cancel'; cancel.onclick=()=>{if(team._isNew)data.teams=data.teams.filter(item=>item.id!==team.id);card.dataset.dirty='false';renderAdmin(true)}; const remove=document.createElement('button'); remove.type='button'; remove.className='danger'; remove.textContent='Remove'; remove.onclick=()=>removeTeam(team,card); const save=document.createElement('button'); save.type='submit'; save.className='primary'; save.textContent='Save changes'; actions.append(cancel,remove,save); card.append(grid,iconField,actions); card.addEventListener('input',()=>card.dataset.dirty='true'); card.addEventListener('change',()=>card.dataset.dirty='true'); card.addEventListener('submit',event=>saveTeam(event,team.id)); return card;
  }
  async function saveTeam(event,id) {
    event.preventDefault(); const form=event.currentTarget, button=form.querySelector('[type=submit]'); if(button.disabled)return; button.disabled=true;
    form.querySelectorAll('.field-error').forEach(e=>e.textContent=''); const name=form.querySelector('[data-field=name]').value.trim(), selectedIcon=form.querySelector('[data-field=builtInIcon]:checked'), customIcon=form.querySelector('[data-field=iconUrl]').value.trim(), iconUrl=normalizeIconUrl(selectedIcon?.value || customIcon), raw=form.querySelector('[data-field=score]').value, score=Number(raw); let valid=true;
    const error=(field,msg)=>{form.querySelector(`[data-error=${field}]`).textContent=msg;valid=false}; if(!name)error('name','A team name is required.'); if(data.teams.some(t=>t.id!==id&&t.name.toLowerCase()===name.toLowerCase()))error('name','Team names must be unique.'); if(raw.trim()===''||!Number.isFinite(score)||score<0)error('score','Enter a score of zero or greater.'); if(iconUrl&&!safeIconUrl(iconUrl))error('iconUrl','Use an http(s) URL or safe relative path.');
    if(!valid){announce('Please correct the highlighted fields.',true);button.disabled=false;return}
    const saved={name,icon:iconUrl,score,color:form.dataset.color,order:Number(form.dataset.order),updatedAt:serverTimestamp()};
    try { const succeeded=await commitWrite(()=>{const batch=writeBatch(db);batch.set(doc(db,'teams',id),saved);batch.set(doc(db,'settings','leaderboard'),{updatedAt:serverTimestamp()},{merge:true});return batch.commit()},'Team saved.'); if(succeeded){form.dataset.dirty='false';renderAdmin()} }
    finally { button.disabled=false; }
  }
  async function removeTeam(team,form) {
    if(await confirmAction('Remove team?',`Remove ${team.name} from the shared leaderboard?`)){const succeeded=await commitWrite(()=>{const batch=writeBatch(db);batch.delete(doc(db,'teams',team.id));batch.set(doc(db,'settings','leaderboard'),{updatedAt:serverTimestamp()},{merge:true});return batch.commit()},'Team removed.');if(succeeded){form.dataset.dirty='false';form.remove();renderAdmin()}}
  }
  function friendlyFirebaseError(error, action='save changes') {
    console.warn(`Firebase could not ${action}:`,error);
    if(error?.code==='permission-denied'||error?.code==='firestore/permission-denied')return 'Permission denied. Sign in with an authorized administrator account.';
    if(error?.code==='auth/invalid-credential'||error?.code==='auth/wrong-password'||error?.code==='auth/user-not-found')return 'The email or password is incorrect.';
    if(error?.code==='auth/invalid-email')return 'Enter a valid email address.';
    if(!navigator.onLine||error?.code==='unavailable'||error?.code==='firestore/unavailable')return 'You appear to be offline. Reconnect before saving changes.';
    return `Unable to ${action}. Please try again.`;
  }
  async function commitWrite(operation,message) {
    if(!currentUser){announce('Your session has ended. Sign in again.',true);route();return false}
    if(!navigator.onLine){announce('You are offline. No changes were submitted.',true);return false}
    try { await operation(); await waitForPendingWrites(db); announce(message); return true; }
    catch(error){announce(friendlyFirebaseError(error),true);return false}
  }
  function newId(){return crypto.randomUUID?.() || `team-${Date.now()}-${Math.random().toString(36).slice(2,9)}`}
  async function loadPublished() { const response=await fetch('data/teams.json',{cache:'no-cache'}); if(!response.ok)throw new Error('Published data unavailable'); const result=validateDocument(await response.json()); if(!result.valid)throw new Error(result.errors.join(' ')); return result.data; }
  function snapshotDate(value) { return value?.toDate?.().toISOString?.() || (typeof value==='string'?value:new Date().toISOString()); }
  function dataFingerprint(value) { return JSON.stringify({maximumScore:value.maximumScore,teams:value.teams}); }
  function firestoreSnapshotsAreEmptyCache() {
    return !hasServerBackedSnapshot&&teamSnapshot?.metadata.fromCache&&settingsSnapshot?.metadata.fromCache&&!teamSnapshot.size&&!settingsSnapshot.exists();
  }
  async function showPublishedFallback() {
    if(fallbackLoadPromise)return fallbackLoadPromise;
    fallbackLoadPromise=(async()=>{try{const published=await loadPublished();if(!firestoreSnapshotsAreEmptyCache())return;data=published;appliedDataFingerprint=dataFingerprint(published);if(revealState.status!=='idle')cancelReveal();else renderLeaderboard();if(currentUser&&location.hash==='#admin')renderAdmin();$('connectionStatus').textContent='Offline fallback'}catch(error){console.warn('Published fallback failed:',error)}})();
    try{await fallbackLoadPromise}finally{fallbackLoadPromise=null}
  }
  function applyRealtimeData() {
    if(!teamSnapshot||!settingsSnapshot)return;
    if(!teamSnapshot.metadata.fromCache||!settingsSnapshot.metadata.fromCache)hasServerBackedSnapshot=true;
    if(firestoreSnapshotsAreEmptyCache()){showPublishedFallback();return}
    const settings=settingsSnapshot.exists()?settingsSnapshot.data():{};
    const teams=teamSnapshot.docs.map((item,index)=>{const value=item.data();return {id:item.id,name:value.name,iconUrl:value.icon||'',score:value.score,color:value.color,order:Number.isFinite(value.order)?value.order:index}}).sort((a,b)=>a.order-b.order);
    const result=validateDocument({maximumScore:settings.maxScore??100,updatedAt:snapshotDate(settings.updatedAt),teams});
    if(!result.valid){console.warn('Ignoring invalid Firestore leaderboard:',result.errors);announce('Live leaderboard data is invalid. An administrator must correct it.',true);return}
    const fromCache=teamSnapshot.metadata.fromCache||settingsSnapshot.metadata.fromCache;
    $('connectionStatus').textContent=fromCache?'Offline cache':'Live';
    const fingerprint=dataFingerprint(result.data);
    if(fingerprint===appliedDataFingerprint)return;
    appliedDataFingerprint=fingerprint;data=result.data;
    if(revealState.status!=='idle')cancelReveal();else renderLeaderboard();
    if(currentUser&&location.hash==='#admin')renderAdmin();
  }
  function listenForLeaderboard() {
    unsubscribeTeams=onSnapshot(collection(db,'teams'),{includeMetadataChanges:true},snapshot=>{teamSnapshot=snapshot;applyRealtimeData()},error=>handleReadError(error));
    unsubscribeSettings=onSnapshot(doc(db,'settings','leaderboard'),{includeMetadataChanges:true},snapshot=>{settingsSnapshot=snapshot;applyRealtimeData()},error=>handleReadError(error));
  }
  async function handleReadError(error) {
    console.warn('Firestore listener failed:',error); announce('The live leaderboard is unavailable. Showing the last available data.',true);
    if(!data.teams.length)try{data=await loadPublished();renderLeaderboard()}catch(loadError){console.warn('Fallback data failed:',loadError)}
  }

  function route() { let name=location.hash.slice(1)||'leaderboard'; if(!['leaderboard','objectives','admin','about'].includes(name))name='leaderboard'; cancelReveal(); document.querySelectorAll('.screen').forEach(s=>s.hidden=true); if(name==='admin'){if(currentUser){$('adminScreen').hidden=false;renderAdmin(true)}else{$('loginScreen').hidden=false;setTimeout(()=>$('email').focus(),0)}}else $(name+'Screen').hidden=false; closeMenu(); window.scrollTo(0,0); }
  function openMenu(){ $('drawer').classList.add('open');$('drawer').setAttribute('aria-hidden','false');$('menuButton').setAttribute('aria-expanded','true');$('scrim').hidden=false;$('closeMenu').focus() }
  function closeMenu(){ $('drawer').classList.remove('open');$('drawer').setAttribute('aria-hidden','true');$('menuButton').setAttribute('aria-expanded','false');$('scrim').hidden=true }
  function confirmAction(title,message){return new Promise(resolve=>{const dialog=$('confirmDialog');$('dialogTitle').textContent=title;$('dialogMessage').textContent=message;dialog.showModal();dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true})})}

  function bindEvents(){
    addEventListener('hashchange',route);$('menuButton').onclick=openMenu;$('closeMenu').onclick=closeMenu;$('scrim').onclick=closeMenu;addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});$('revealButton').onclick=handleRevealButton;
    $('togglePassword').onclick=()=>{const p=$('password'),show=p.type==='password';p.type=show?'text':'password';$('togglePassword').textContent=show?'Hide':'Show';$('togglePassword').setAttribute('aria-label',show?'Hide password':'Show password')};
    $('loginForm').onsubmit=async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type=submit]');button.disabled=true;$('loginError').textContent='';try{await signInWithEmailAndPassword(auth,$('email').value.trim(),$('password').value);$('password').value='';announce('Signed in.')}catch(error){$('loginError').textContent=friendlyFirebaseError(error,'sign in');$('password').select()}finally{button.disabled=false}};
    $('logoutButton').onclick=async()=>{try{await signOut(auth);location.hash='leaderboard';announce('Logged out.')}catch(error){announce(friendlyFirebaseError(error,'log out'),true)}};
    $('maximumForm').onsubmit=async e=>{e.preventDefault();const raw=$('maximumScore').value,n=Number(raw);$('maximumError').textContent='';if(raw.trim()===''||!Number.isFinite(n)||n<=0){$('maximumError').textContent='Enter a number greater than zero.';announce('Maximum score is invalid.',true);return}await commitWrite(()=>setDoc(doc(db,'settings','leaderboard'),{maxScore:n,updatedAt:serverTimestamp(),schemaVersion:1},{merge:true}),'Maximum score updated.')};
    $('addTeam').onclick=()=>{const color=nextTeamColor(data.teams);if(!color){announce(`The ${TEAM_COLOR_PALETTE.length}-team color palette is full.`,true);return}const id=newId();data.teams.push({id,name:'New Team',iconUrl:AVAILABLE_TEAM_ICONS[0].path,score:0,color,_isNew:true});renderAdmin();const card=document.querySelector(`[data-id="${CSS.escape(id)}"]`);card.querySelector('[data-field=name]').select();card.scrollIntoView({behavior:'smooth',block:'center'})};
    addEventListener('online',()=>announce('Back online. Live updates resumed.'));addEventListener('offline',()=>announce('You are offline. Showing cached leaderboard data.',true));
    $('applyUpdate').onclick=()=>{pendingWorker?.postMessage('SKIP_WAITING')};
  }
  function registerServiceWorker(){if(!('serviceWorker'in navigator)||(location.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(location.hostname)))return;navigator.serviceWorker.register('service-worker.js',{updateViaCache:'none'}).then(reg=>{if(reg.waiting)showUpdate(reg.waiting);reg.addEventListener('updatefound',()=>{const worker=reg.installing;worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)showUpdate(worker)})});reg.update().catch(error=>console.warn('Service worker update check failed:',error))}).catch(error=>console.warn('Service worker registration failed:',error));navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload())}
  function showUpdate(worker){pendingWorker=worker;$('updateNotice').hidden=false}
  async function init(){console.log(`[TEP Olympics] App version ${APP_VERSION}`);bindEvents();renderLeaderboard();listenForLeaderboard();onAuthStateChanged(auth,user=>{currentUser=user;route()});route();announce('Scores are hidden. Activate Reveal to begin the score presentation.');registerServiceWorker()}
  init().catch(error=>{console.error(error);announce('The app encountered an unexpected error.',true)});
})();
