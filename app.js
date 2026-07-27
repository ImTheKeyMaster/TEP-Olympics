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
    highlightTimers: new Map(), highlightCooldowns: new Map(), reducedMotion: false,
    schedule: [], nextEvent: 0, teams: new Map(), settlingAt: 0, movementUntil: 0,
    racePhase: 'scoring', pauseUntil: 0, pauseCooldownUntil: -Infinity
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
  function roundToPrecision(value,precision) { const scale=10**precision; return Math.round((value+Number.EPSILON)*scale)/scale; }

  function createLeaderboardRow(team,index,displayedScore=0) {
    const li=document.createElement('li'); li.className='team-row'; li.dataset.teamId=team.id;
    const content=document.createElement('div'); content.className='team-row-content';
    const rank=document.createElement('span'); rank.className='rank';
    const img=document.createElement('img'); img.className='team-icon'; img.alt=''; img.loading='lazy'; img.referrerPolicy='no-referrer'; img.src=safeIconUrl(team.iconUrl)||FALLBACK_ICON; img.addEventListener('error',()=>{if(!img.src.endsWith(FALLBACK_ICON))img.src=FALLBACK_ICON;},{once:true});
    const main=document.createElement('div'); main.className='team-main'; const name=document.createElement('div'); name.className='team-name'; name.textContent=team.name; name.title=team.name;
    const progress=document.createElement('div'); progress.className='progress'; progress.setAttribute('role','progressbar'); progress.setAttribute('aria-valuemin','0'); progress.setAttribute('aria-valuemax',String(data.maximumScore)); progress.style.setProperty('--hue',hashHue(team.id));
    const fill=document.createElement('div'); fill.className='progress-fill'; const score=document.createElement('span'); score.className='score-label'; progress.append(fill,score); main.append(name,progress); content.append(rank,img,main); li.append(content);
    const elements={team,row:li,content,rank,img,progress,fill,label:score}; teamRowElements.set(team.id,elements);
    updateTeamVisuals(team.id,displayedScore); updateTeamRank(team.id,index,false); return li;
  }
  function updateTeamRank(teamId,index,showMedals=!revealState.active,animateMedal=false) {
    const {rank}=teamRowElements.get(teamId), medal=showMedals&&index<3; rank.className='rank'+(medal?' medal':'')+(medal&&animateMedal&&!revealState.reducedMotion?' is-medal-arriving':''); rank.textContent=medal?['🥇','🥈','🥉'][index]:String(index+1); rank.setAttribute('aria-label',`Rank ${index+1}`);
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
    teams.forEach((team,index)=>{revealState.displayedScores.set(team.id,0);revealState.targetScores.set(team.id,team.score);list.append(createLeaderboardRow(team,index))});
    $('emptyState').hidden=teams.length>0; $('teamCount').textContent=`${teams.length} ${teams.length===1?'team':'teams'}`; $('updatedAt').dateTime=data.updatedAt; $('updatedAt').textContent=formatDate(data.updatedAt);
  }

  function reorderRevealRows(teams,now=performance.now()) {
    if(!revealState.reducedMotion&&now<revealState.movementUntil)return {changed:false,newLeader:false};
    const list=$('leaderboard'), current=[...list.children].map(row=>row.dataset.teamId), next=teams.map(team=>team.id);
    if(current.every((id,index)=>id===next[index]))return {changed:false,newLeader:false};
    const newLeader=current[0]!==next[0];
    const oldRanks=new Map(current.map((id,index)=>[id,index])), newRanks=new Map(next.map((id,index)=>[id,index]));
    const oldPositions=new Map(); if(!revealState.reducedMotion)current.forEach(id=>oldPositions.set(id,teamRowElements.get(id).row.getBoundingClientRect().top));
    teams.forEach((team,index)=>{list.append(teamRowElements.get(team.id).row);updateTeamRank(team.id,index,false)});
    if(!revealState.reducedMotion){teams.forEach(team=>{const row=teamRowElements.get(team.id).row,delta=oldPositions.get(team.id)-row.getBoundingClientRect().top;if(delta)row.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'})});revealState.movementUntil=now+190}
    const gains=teams.map(team=>({id:team.id,from:oldRanks.get(team.id),to:newRanks.get(team.id)})).filter(move=>move.from>move.to);
    const prioritized=gains.sort((a,b)=>(a.to===0?-1:0)-(b.to===0?-1:0)||(b.from-b.to)-(a.from-a.to)||a.to-b.to);
    prioritized.some(move=>highlightTeam(move.id,move.to===0?'first-place':'rank-gain',now));
    return {changed:true,newLeader};
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
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  function createRevealSchedule(teams,duration) {
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
      events.push({time:duration-220+Math.random()*100,teamId:team.id,amount:1/scale,final:true});
    });
    events.sort((a,b)=>a.time-b.time);
    let lastOpening=300; const lastTeamOpening=new Map();
    events.filter(event=>event.time<3000).forEach(event=>{
      event.time=Math.max(event.time,lastOpening+475+Math.random()*175,(lastTeamOpening.get(event.teamId)??-Infinity)+700);
      lastOpening=event.time; lastTeamOpening.set(event.teamId,event.time);
    });
    return events.sort((a,b)=>a.time-b.time);
  }
  function beginTeamIncrement(event,now) {
    const state=revealState.teams.get(event.teamId); if(!state)return;
    updateTeamScoreAnimation(event.teamId,now);
    state.committedScore=event.final?state.targetScore:Math.min(state.targetScore,state.committedScore+event.amount);
    state.animationStartScore=state.visualScore; state.animationEndScore=state.committedScore; state.animationStartTime=now;
    state.animationDuration=clamp((event.time-state.lastEventTime)*.72,180,400); state.lastEventTime=event.time;
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
  function compressRemainingSchedule(elapsed) {
    const remaining=revealState.schedule.slice(revealState.nextEvent); if(!remaining.length)return;
    const oldStart=Math.min(...remaining.map(event=>event.time)), oldEnd=Math.max(...remaining.map(event=>event.time));
    const newStart=elapsed+80, newEnd=Math.max(newStart,revealState.duration-220), span=Math.max(1,oldEnd-oldStart);
    remaining.forEach(event=>{event.time=newStart+(event.time-oldStart)/span*(newEnd-newStart)});
  }
  function finishReveal(now) {
    data.teams.forEach(team=>{const state=revealState.teams.get(team.id);state.visualScore=state.committedScore=state.targetScore;revealState.displayedScores.set(team.id,state.targetScore);updateTeamVisuals(team.id,state.targetScore);teamRowElements.get(team.id).fill.style.removeProperty('will-change')});
    reorderRevealRows(sortedTeams(team=>revealState.targetScores.get(team.id)),now); clearAllHighlights(); revealState.settlingAt=now+220;
  }
  function completeReveal(now) {
    const finalTeams=sortedTeams(team=>revealState.targetScores.get(team.id)); finalTeams.forEach((team,index)=>updateTeamRank(team.id,index,true,true));
    if(finalTeams[0])highlightTeam(finalTeams[0].id,'final-winner',now,true);
    revealState.active=false; revealState.settlingAt=0; $('revealButton').disabled=false; $('revealButton').textContent='Reveal'; $('revealStatus').hidden=true;
    announce(finalTeams.length?`Score reveal complete. ${finalTeams[0].name} is in first place.`:'Score reveal complete.');
  }
  function cancelReveal() {
    clearAllHighlights(); cancelAnimationFrame(revealState.frame); revealState.schedule=[]; revealState.teams.clear(); revealState.settlingAt=0; revealState.racePhase='scoring'; revealState.pauseUntil=0; revealState.pauseCooldownUntil=-Infinity;
    revealState.active=false; revealState.displayedScores.clear(); revealState.targetScores.clear(); revealState.movementUntil=0; $('revealButton').disabled=false; $('revealButton').textContent='Reveal'; $('revealStatus').hidden=true; renderLeaderboard();
  }
  function revealFrame(now) {
    if(!revealState.active)return;
    if(revealState.settlingAt){if(now>=revealState.settlingAt)completeReveal(now);else revealState.frame=requestAnimationFrame(revealFrame);return}
    const elapsed=now-revealState.startedAt;
    if(revealState.reducedMotion){const progress=clamp(elapsed/revealState.duration,0,1);data.teams.forEach(team=>{const state=revealState.teams.get(team.id);state.visualScore=state.targetScore*(1-(1-progress)**3);const displayed=roundToPrecision(state.visualScore,state.precision);revealState.displayedScores.set(team.id,displayed);updateTeamVisuals(team.id,state.visualScore,state.precision)})}
    else {
      if(revealState.racePhase==='pause'&&now>=revealState.pauseUntil){compressRemainingSchedule(elapsed);revealState.racePhase='scoring'}
      if(revealState.racePhase==='scoring')while(revealState.nextEvent<revealState.schedule.length&&revealState.schedule[revealState.nextEvent].time<=elapsed)beginTeamIncrement(revealState.schedule[revealState.nextEvent++],now);
      data.teams.forEach(team=>updateTeamScoreAnimation(team.id,now));
      if(revealState.racePhase==='awaiting-reorder'&&scoreAnimationsFinished(now)){
        const change=reorderRevealRows(sortedTeams(team=>revealState.displayedScores.get(team.id)??0),now);
        if(change.changed){const canPause=now>=revealState.pauseCooldownUntil,pause=canPause?(change.newLeader?1500:1000):0;revealState.pauseUntil=revealState.movementUntil+pause;if(canPause)revealState.pauseCooldownUntil=revealState.pauseUntil+750;revealState.racePhase=pause?'pause':'scoring'}else revealState.racePhase='scoring';
      }
      const rankInterval=elapsed<3000?500:150;
      if(revealState.racePhase==='scoring'&&now-revealState.lastRankAt>=rankInterval){revealState.lastRankAt=now;const current=[...$('leaderboard').children].map(row=>row.dataset.teamId),next=sortedTeams(team=>revealState.displayedScores.get(team.id)??0).map(team=>team.id);if(current.some((id,index)=>id!==next[index]))revealState.racePhase='awaiting-reorder'}
    }
    if(elapsed>=revealState.duration&&revealState.racePhase==='scoring'&&scoreAnimationsFinished(now)&&now>=revealState.movementUntil)finishReveal(now); revealState.frame=requestAnimationFrame(revealFrame);
  }
  function startReveal() {
    if(revealState.active||!data.teams.length)return; cancelAnimationFrame(revealState.frame);clearAllHighlights();revealState.active=true;revealState.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const allZero=data.teams.every(team=>team.score===0);revealState.duration=revealState.reducedMotion?1000:(allZero?1200:10000);revealState.lastRankAt=-Infinity;revealState.nextEvent=0;revealState.settlingAt=0;revealState.movementUntil=0;revealState.racePhase='scoring';revealState.pauseUntil=0;revealState.pauseCooldownUntil=-Infinity;revealState.displayedScores.clear();revealState.targetScores.clear();revealState.settledTeams.clear();revealState.highlightCooldowns.clear();revealState.teams.clear();
    data.teams.forEach(team=>{revealState.displayedScores.set(team.id,0);revealState.targetScores.set(team.id,team.score);revealState.teams.set(team.id,{visualScore:0,committedScore:0,targetScore:team.score,animationStartScore:0,animationEndScore:0,animationStartTime:0,animationDuration:1,lastEventTime:0,precision:scorePrecision(team.score)});updateTeamVisuals(team.id,0);updateTeamRank(team.id,0,false);if(!revealState.reducedMotion)teamRowElements.get(team.id).fill.style.willChange='transform'});
    const alphabetical=[...data.teams].sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));reorderRevealRows(alphabetical);alphabetical.forEach((team,index)=>updateTeamRank(team.id,index,false));clearAllHighlights();revealState.highlightCooldowns.clear();revealState.schedule=revealState.reducedMotion?[]:createRevealSchedule(data.teams,revealState.duration);
    $('revealButton').disabled=true;$('revealButton').textContent='Revealing...';$('revealStatus').hidden=false;announce('Score reveal started.');
    requestAnimationFrame(()=>requestAnimationFrame(now=>{if(revealState.active){revealState.startedAt=now;revealState.frame=requestAnimationFrame(revealFrame)}}));
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
  function route() { let name=location.hash.slice(1)||'leaderboard'; if(!['leaderboard','admin','about'].includes(name))name='leaderboard'; cancelReveal(); document.querySelectorAll('.screen').forEach(s=>s.hidden=true); if(name==='admin'){if(authorized()){$('adminScreen').hidden=false;renderAdmin()}else{$('loginScreen').hidden=false;setTimeout(()=>$('password').focus(),0)}}else $(name+'Screen').hidden=false; closeMenu(); window.scrollTo(0,0); }
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
  async function init(){bindEvents();await loadData();renderLeaderboard();route();announce('Scores are hidden. Activate Reveal to begin the score presentation.');registerServiceWorker()}
  init().catch(error=>{console.error(error);announce('The app encountered an unexpected error.',true)});
})();
