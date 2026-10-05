import { MediaEngine } from './media.js';
import { SceneMotion } from './motion.js';
import { icon } from './icons.js';
import { TRACKS, SOURCE_NOTE } from './tracks.js';
import { ROUND_TIMELINE, getRoundProgress } from './rounds.js';
import { GUIDE } from './guide-manifest.js';
import { GuideScene, getGuideFrame } from './guide-scene.js';
import { createSessionRecovery, planRecovery } from './session-recovery.js';
import { createSessionDiagnostics } from './session-diagnostics.js';
import { RELEASE, TIMELINE_HASH, COMPATIBLE_RELEASES } from './session-version.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const preferenceKey = 'breathe-preferences-v2';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const activeStates = new Set(['playing', 'loading', 'buffering']);
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem(preferenceKey) || '{}') || {}; } catch { /* Optional persistence. */ }
let motionEnabled = preferences.motion !== false;
let lastNotice = '';
let selectionIntent = 0;
let previousFocus;
let lastSnapshot;
let dockMinimized = preferences.dockMinimized === true;
let clockFrame = 0;

function setText(selector, value) {
  const element = typeof selector === 'string' ? $(selector) : selector;
  if (element && element.textContent !== value) element.textContent = value;
}
function setIcon(element, name) {
  if (!element || element.dataset.renderedIcon === name) return;
  element.innerHTML = icon(name);
  element.dataset.renderedIcon = name;
}
function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach(element => setIcon(element, ({ clock: 'timer', 'arrow-down': 'arrow-right' })[element.dataset.icon] || element.dataset.icon));
}
function formatTime(value, unknown = false) {
  if (!Number.isFinite(value) || (unknown && value <= 0)) return '--:--';
  const seconds = Math.max(0, Math.floor(value));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function showNotice(message) {
  if (!message) return;
  setText('#notice-text', message);
  $('#notice').hidden = false;
}
function run(action) {
  try { Promise.resolve(action()).catch(error => showNotice(error?.message || 'Dit lukte nog niet. Probeer het opnieuw.')); }
  catch (error) { showNotice(error?.message || 'Dit lukte nog niet. Probeer het opnieuw.'); }
}
function buildRounds() {
  $('#round-list').innerHTML = ROUND_TIMELINE.map(round => `<li class="round-item" data-round="${round.number}" data-status="upcoming"><div class="round-orb" role="progressbar" aria-label="Ronde ${round.number}: voortgang van de begeleiding" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="round-liquid"></span><span class="round-marker">${round.number}</span></div><div class="round-copy"><strong>Ronde ${round.number}</strong><small>${formatTime(round.startMs / 1000)} – ${formatTime(round.endMs / 1000)}</small></div></li>`).join('');
}
function buildTracks() {
  $('#sound-grid').innerHTML = TRACKS.map(track => `<article class="sound-card" data-track="${escape(track.id)}" data-selected="false" data-playing="false" style="--track-color:${escape(track.color || '#60746d')};--track-wash:${escape(track.wash || '#e5e8e1')}"><div class="sound-visual"><img class="sound-image" src="${escape(track.image)}" alt="Stemvork bij ${escape(track.title)}" loading="lazy"><canvas class="sound-canvas" data-track-canvas="${escape(track.id)}" aria-hidden="true"></canvas><button class="sound-select" data-select-track="${escape(track.id)}" aria-label="Kies ${escape(track.title)} zonder af te spelen" aria-pressed="false" ${track.available === false ? 'disabled' : ''}><span class="track-label">${escape(track.frequency || track.label || 'Stemvork')}</span><span class="track-selected-mark" data-icon="check"></span></button></div><div class="sound-info"><div class="sound-copy"><h3>${escape(track.title)}</h3><p>${escape(track.subtitle || track.label || '')}</p></div><button class="icon-button sound-play" data-track-play="${escape(track.id)}" aria-label="${escape(track.title)} afspelen" ${track.available === false ? 'disabled' : ''}><span data-icon="play"></span></button></div>${track.sourceUrl ? `<a class="sound-source" href="${escape(track.sourceUrl)}" target="_blank" rel="noopener noreferrer">Oorspronkelijke klank <span data-icon="arrow-up-right"></span></a>` : `<span class="sound-source">${track.available === false ? 'Klank nog niet beschikbaar' : 'Jouw bronopname'}</span>`}</article>`).join('');
  if (SOURCE_NOTE) {
    const note = document.createElement('p');
    note.className = 'sound-source-note';
    note.textContent = SOURCE_NOTE;
    $('.sound-footnote').after(note);
  }
}
buildRounds();
buildTracks();
hydrateIcons();

const media = new MediaEngine({ tracks: TRACKS, guide: GUIDE, guideElement: $('#guide-media'), guideSourceURL: GUIDE.fallbackMediaSrc });
const motion = new SceneMotion({ cards: $$('.sound-card'), tracks: TRACKS, media });
const guideScene = new GuideScene({ guide: GUIDE, root: $('#guide-stage'), audio: $('#guide-media'), media });
let sessionStorage;
try { sessionStorage = localStorage; } catch { /* Recovery reports unavailable storage. */ }
const recoveryContext = { guide: GUIDE, release: RELEASE, timelineHash: TIMELINE_HASH, compatibleReleases: COMPATIBLE_RELEASES };
const recovery = createSessionRecovery({ ...recoveryContext, storage: sessionStorage });
let diagnosticStorage;
try { diagnosticStorage = window.sessionStorage; } catch { /* In-memory evidence remains available. */ }
const diagnostics = createSessionDiagnostics({ media, release: RELEASE, timelineHash: TIMELINE_HASH, storage: diagnosticStorage });
let pendingRecovery = recovery.load();
let captureEnabled = false;
let checkpointTransition = '';
let checkpointTimer = 0;
window.breathe = { media, guideScene, recovery, diagnostics };

function showRecovery() {
  const pending = !['empty', 'completed', 'storage-error'].includes(pendingRecovery.status);
  $('#session-recovery').hidden = !pending;
  document.body.dataset.recovery = pending ? 'pending' : 'none';
  if (!pending) return;
  const checkpoint = pendingRecovery.checkpoint;
  setText('#recovery-kicker', pendingRecovery.memoryOnly ? 'Je sessie is onderbroken' : 'Je sessie is bewaard');
  setText('#recovery-position', checkpoint ? `${pendingRecovery.memoryOnly ? 'Gepauzeerd' : 'Bewaard'}: ${checkpoint.round ? `ronde ${checkpoint.round} · ` : ''}${formatTime(checkpoint.positionMs / 1000)}` : 'De opgeslagen sessie kan niet worden gelezen.');
  setText('#recovery-message', pendingRecovery.plan?.message || 'Begin rustig met een nieuwe sessie.');
  const plan = pendingRecovery.plan;
  setText('#recovery-resume', plan?.kind === 'restart-round' ? `Begin ronde ${plan.round} opnieuw` : plan?.kind === 'resume-cycle' ? 'Hervat bij een hele ademteug' : plan?.kind === 'resume-closing' ? 'Hervat de afronding' : 'Begin de sessie opnieuw');
}
function claimSession() {
  const result = recovery.claim({ explicit: true });
  captureEnabled = result.status === 'claimed';
  if (captureEnabled) scheduleCheckpoint();
  if (!captureEnabled) showNotice(result.status === 'storage-error' ? 'Je browser kan de sessie niet bewaren. Afspelen blijft mogelijk.' : 'Deze sessie kan hier niet worden bewaard. Een ander tabblad beheert de bewaarde positie.');
}
function scheduleCheckpoint(delay = 5000) {
  clearTimeout(checkpointTimer);
  checkpointTimer = setTimeout(() => captureSession(), delay);
}
function captureSession(reason = 'interval') {
  diagnostics.capture();
  if (!captureEnabled) return;
  const snapshot = media.getSnapshot();
  const positionMs = Math.round(media.getGuidePosition() * 1000);
  if (snapshot.video.state === 'ended' && positionMs >= GUIDE.durationMs) {
    const cleared = recovery.clear({ reason: 'complete', positionMs });
    if (cleared.status === 'storage-error') showNotice('Je sessie is afgerond, maar je browser kon de bewaarde positie niet wissen. Na herladen kan die opnieuw verschijnen.');
    captureEnabled = false;
    clearTimeout(checkpointTimer);
    return;
  }
  const result = recovery.save({ positionMs, intent: activeStates.has(snapshot.video.state) ? 'playing' : 'paused', gains: snapshot.guideGains }, { reason, meaningful: true });
  scheduleCheckpoint(result.status === 'throttled' ? Math.max(50, 5000 - (Date.now() - recovery.getStatus().lastWriteAt)) : 5000);
  if (result.status === 'storage-error') showNotice('Je browser kan de sessie niet bewaren. Na herladen kun je de positie niet herstellen.');
}
function resetGuide() {
  captureEnabled = false;
  clearTimeout(checkpointTimer);
  const claimed = recovery.claim({ explicit: true });
  const cleared = claimed.status === 'claimed' ? recovery.clear({ reason: 'reset' }) : claimed;
  if (cleared.status !== 'cleared') showNotice('De bewaarde positie kon niet worden gewist. Na herladen kan je browser die opnieuw tonen.');
  pendingRecovery = { status: 'empty' };
  showRecovery();
  media.stop('video');
}
showRecovery();
if (pendingRecovery.status === 'storage-error') showNotice('Je browser kan de sessie niet bewaren. Afspelen blijft mogelijk.');

function offerInterruptedRecovery(event) {
  if (!event.detail?.kinds?.includes('video')) return;
  // The engine has already cancelled all pending playback. Save the stopped
  // position, then require a fresh choice through the existing safe planner.
  captureSession('pause');
  const snapshot = media.getSnapshot();
  const positionMs = Math.min(GUIDE.durationMs, Math.max(0, Math.round(media.getGuidePosition() * 1000)));
  const frame = getGuideFrame(GUIDE, positionMs / 1000);
  const checkpoint = { schema: 1, sessionId: diagnostics.documentId, release: RELEASE, timelineHash: TIMELINE_HASH,
    durationMs: GUIDE.durationMs, positionMs, phase: frame.phase, round: frame.round,
    intent: 'paused', gains: snapshot.guideGains, savedAt: Date.now() };
  const saved = recovery.load();
  const persisted = saved.status === 'valid' && saved.checkpoint?.positionMs === positionMs;
  // In-memory recovery also works when storage fails or another tab owns it;
  // never offer another tab's checkpoint as this interruption's resume point.
  pendingRecovery = { status: positionMs === GUIDE.durationMs ? 'completed' : 'valid', checkpoint,
    plan: planRecovery(checkpoint, recoveryContext), memoryOnly: !persisted };
  captureEnabled = false;
  clearTimeout(checkpointTimer);
  showRecovery();
  render(snapshot);
}
media.addEventListener('interruption', offerInterruptedRecovery);

function savePreferences() {
  const snapshot = media.getSnapshot();
  try { localStorage.setItem(preferenceKey, JSON.stringify({ motion: motionEnabled, loop: snapshot.audio.loop, videoVolume: 1, audioVolume: snapshot.audio.volume, guideGains: snapshot.guideGains, dockMinimized })); }
  catch { /* Private browsing remains usable. */ }
}
function renderRounds(video) {
  const progress = getRoundProgress(video.position);
  setText('#round-count', `${progress.completedCount} / 5`);
  for (const round of progress.rounds) {
    const element = $(`.round-item[data-round="${round.number}"]`);
    const orb = $('.round-orb', element);
    const marker = $('.round-marker', element);
    element.dataset.status = round.status;
    element.style.setProperty('--fill', String(round.progress));
    const wave = (Number(video.position) || 0) * 1.8 + round.number;
    element.style.setProperty('--wave-x', `${Math.sin(wave) * 5}px`);
    element.style.setProperty('--wave-angle', `${Math.sin(wave * .6) * 19}deg`);
    orb.setAttribute('aria-valuenow', String(Math.round(round.progress * 100)));
    orb.setAttribute('aria-valuetext', round.status === 'complete' ? 'Voorbij in de begeleiding' : round.status === 'active' ? `${Math.round(round.progress * 100)} procent van ronde ${round.number}` : 'Nog niet bereikt');
    if (round.status === 'complete') setIcon(marker, 'check');
    else {
      setText(marker, String(round.number));
      delete marker.dataset.renderedIcon;
    }
  }
  const summary = progress.phase === 'intro' ? video.state === 'playing' ? 'Neem even de tijd om te landen.' : 'Begin met de introductie.' : ['closing', 'complete'].includes(progress.phase) ? 'Vijf rondes voorbij. Kom rustig bij.' : video.state === 'paused' ? `Ronde ${progress.currentRound} · gepauzeerd` : video.state === 'buffering' ? `Ronde ${progress.currentRound} · even laden` : `Ronde ${progress.currentRound} · volg de begeleiding`;
  setText('#round-summary', summary);
}
function scheduleClock() {
  const active = lastSnapshot?.video.state === 'playing' && !document.hidden;
  if (!active) { cancelAnimationFrame(clockFrame); clockFrame = 0; return; }
  if (clockFrame) return;
  clockFrame = requestAnimationFrame(() => {
    clockFrame = 0;
    const video = { ...lastSnapshot.video, position: media.getGuidePosition() };
    renderRounds(video);
    const seek = $('#video-seek');
    if (!seek.dataset.scrubbing) {
      seek.value = String(video.position);
      seek.style.setProperty('--progress', `${Math.min(100, video.position / (GUIDE.durationMs / 1000) * 100)}%`);
      setText('#video-position', formatTime(video.position));
    }
    scheduleClock();
  });
}
function render(snapshot) {
  lastSnapshot = snapshot;
  const video = snapshot.video;
  const audio = snapshot.audio;
  const session = snapshot.session;
  const track = TRACKS.find(item => item.id === audio.trackId);
  const labels = { ready: 'Klaar wanneer jij dat bent', loading: 'Wordt klaargezet…', playing: 'Floris begeleidt je', paused: 'Gepauzeerd', buffering: 'Even laden…', ended: 'Begeleiding afgerond', error: 'Begeleiding kon niet starten' };
  setText('#video-status', labels[video.state] || 'Klaar wanneer jij dat bent');
  const audioLabels = { ready: 'Klaar om te luisteren', loading: 'Klank wordt klaargezet…', playing: 'Klank speelt', paused: 'Gepauzeerd', buffering: 'Even laden…', ended: 'Klank afgerond', error: 'Klank kon niet starten' };
  setText('#audio-status', audioLabels[audio.state] || 'Klaar om te luisteren');
  for (const kind of ['video', 'audio']) {
    const state = snapshot[kind];
    const playing = activeStates.has(state.state);
    $$(`[data-play="${kind}"]`).forEach(button => {
      setIcon($('[data-icon]', button), playing ? 'pause' : 'play');
      button.setAttribute('aria-label', `${kind === 'video' ? 'Begeleiding' : 'Klank'} ${playing ? 'pauzeren' : 'afspelen'}`);
      button.setAttribute('aria-pressed', String(playing));
      if (kind === 'audio') button.disabled = !track || track.available === false;
    });
    const duration = Number(state.duration) || (kind === 'video' ? GUIDE.durationMs / 1000 : Number(track?.duration) || 0);
    const position = Number(state.position) || 0;
    const seek = $(`#${kind}-seek`);
    seek.disabled = !(Number(state.duration) > 0) || (kind === 'video' && document.body.dataset.recovery === 'pending');
    seek.max = String(duration || 1);
    if (!seek.dataset.scrubbing) {
      seek.value = String(position);
      seek.style.setProperty('--progress', `${duration ? Math.min(100, position / duration * 100) : 0}%`);
      seek.setAttribute('aria-valuetext', `${formatTime(position)} van ${formatTime(duration, true)}`);
      setText(`#${kind}-position`, formatTime(position));
    }
    setText(`#${kind}-duration`, formatTime(duration, true));
    const volume = $(`#${kind}-volume`);
    if (Number.isFinite(state.volume) && document.activeElement !== volume) volume.value = String(state.volume);
    volume.style.setProperty('--progress', `${Number(volume.value) * 100}%`);
  }
  for (const channel of ['voice', 'breaths', 'music']) {
    const slider = $(`#guide-volume-${channel}`);
    const gain = snapshot.guideGains?.[channel] ?? 1;
    if (document.activeElement !== slider) slider.value = String(Math.round(gain * 100));
    slider.disabled = snapshot.guideMixerAvailable === false;
    slider.style.setProperty('--progress', `${Number(slider.value) / 2}%`);
    slider.setAttribute('aria-valuetext', `${Math.round(gain * 100)} procent`);
    setText(`#guide-value-${channel}`, `${Math.round(gain * 100)}%`);
  }
  setText('#guide-mixer-status', snapshot.guideMode === 'native-fallback' ? 'Deze browser speelt de vaste mix. Afzonderlijke kanaalregeling is hier niet beschikbaar.' : 'Stem, ademgeluiden en muziek afzonderlijk instellen.');
  $('#guide-mute')?.setAttribute('aria-pressed', String(video.muted));
  $('#guide-mute')?.setAttribute('aria-label', video.muted ? 'Begeleiding dempen uitzetten' : 'Begeleiding dempen');
  for (const card of $$('.sound-card')) {
    const selected = card.dataset.track === audio.trackId;
    const playing = selected && activeStates.has(audio.state);
    card.dataset.selected = String(selected);
    card.dataset.playing = String(playing);
    $('.sound-select', card).setAttribute('aria-pressed', String(selected));
    const button = $('.sound-play', card);
    setIcon($('[data-icon]', button), playing ? 'pause' : 'play');
    const cardTrack = TRACKS.find(item => item.id === card.dataset.track);
    button.setAttribute('aria-label', `${cardTrack?.title || 'Klank'} ${playing ? 'pauzeren' : 'afspelen'}`);
    button.setAttribute('aria-pressed', String(playing));
  }
  if (track) {
    setText('#dock-title', track.title);
    setText('#dock-kicker', track.frequency || 'Jouw klank');
    if ($('#dock-image').getAttribute('src') !== track.image) $('#dock-image').src = track.image;
  }
  $('#loop-toggle').setAttribute('aria-pressed', String(audio.loop));
  $('#loop-toggle').setAttribute('aria-label', audio.loop ? 'Herhalen uitzetten' : 'Herhalen aanzetten');
  $('#loop-toggle').title = audio.loop ? 'Herhalen aan' : 'Herhalen uit';
  $('#timer-toggle').setAttribute('aria-pressed', String(session.enabled));
  $('#timer-toggle').setAttribute('aria-label', `Klanktimer van 20 minuten ${session.enabled ? 'uitzetten' : 'aanzetten'}`);
  $('#timer-reset').hidden = !session.enabled;
  setText('#timer-value', formatTime(Math.ceil(session.remaining ?? 1200)));
  setText('#timer-label', !session.enabled ? 'Timer uit' : session.complete ? 'Afgerond' : audio.state === 'playing' ? 'Telt klank' : 'Gepauzeerd');
  renderRounds(video);
  scheduleClock();
  const notice = video.state === 'error' ? video.message || 'De begeleiding kon niet starten. Probeer opnieuw.' : audio.state === 'error' ? audio.message || 'De klank kon niet starten. Probeer opnieuw.' : video.message || audio.message || (session.complete ? 'Je klanksessie van 20 minuten is afgerond. Neem rustig de tijd.' : '');
  if (notice && notice !== lastNotice) showNotice(notice);
  lastNotice = notice;
}
media.addEventListener('change', event => {
  const snapshot = event.detail || media.getSnapshot();
  render(snapshot);
  const frame = getGuideFrame(GUIDE, snapshot.video.position);
  const transition = `${snapshot.video.state}:${frame.round}:${frame.phase}`;
  if (transition !== checkpointTransition) { checkpointTransition = transition; captureSession('transition'); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) captureSession('pause'); });
window.addEventListener('pagehide', () => captureSession('pause'));
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  // pagehide already captured an in-memory plan even if storage was unavailable.
  if (document.body.dataset.recovery === 'pending') return;
  captureEnabled = false;
  pendingRecovery = recovery.load();
  showRecovery();
  render(media.getSnapshot());
});

function toggle(kind) {
  if (kind === 'video') {
    if (document.body.dataset.recovery === 'pending') { $('#recovery-resume').focus(); return; }
    if (!activeStates.has(media.getSnapshot().video.state)) claimSession();
  }
  if (kind === 'audio' && media.getSnapshot().session.complete) media.resetSession();
  return media.toggle(kind);
}
async function chooseTrack(id, play = false) {
  const intent = ++selectionIntent;
  const track = TRACKS.find(item => item.id === id);
  if (!track || track.available === false) return;
  setDockMinimized(false);
  // A selection is silent even when the previous klank was playing.
  media.pause('audio');
  await media.selectTrack(id);
  if (intent !== selectionIntent) return;
  if (play) {
    if (media.getSnapshot().session.complete) media.resetSession();
    await media.play('audio');
  }
}
$('#guide-start').addEventListener('click', () => run(() => toggle('video')));
$$('[data-play]').forEach(button => button.addEventListener('click', () => run(() => toggle(button.dataset.play))));
$$('[data-restart]').forEach(button => button.addEventListener('click', () => run(() => button.dataset.restart === 'video' ? resetGuide() : media.restart(button.dataset.restart))));
$$('[data-stop]').forEach(button => button.addEventListener('click', () => run(() => button.dataset.stop === 'video' ? resetGuide() : media.stop(button.dataset.stop))));
$('#recovery-reset').addEventListener('click', resetGuide);
$('#recovery-diagnostics')?.addEventListener('click', () => run(() => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics.export(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `BREATHE-diagnose-${RELEASE}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));
$('#recovery-resume').addEventListener('click', () => run(() => {
  const plan = pendingRecovery.plan;
  const gains = pendingRecovery.checkpoint?.gains;
  const target = Number(plan?.targetPositionMs) || 0;
  pendingRecovery = { status: 'empty' };
  showRecovery();
  claimSession();
  if (gains) for (const channel of ['voice', 'breaths', 'music']) media.setGuideGain(channel, gains[channel]);
  media.seek('video', target / 1000);
  captureSession('seek');
  return media.play('video');
}));
$$('[data-select-track]').forEach(button => button.addEventListener('click', () => run(() => chooseTrack(button.dataset.selectTrack))));
$$('[data-track-play]').forEach(button => button.addEventListener('click', () => {
  const id = button.dataset.trackPlay;
  run(() => media.getSnapshot().audio.trackId === id ? toggle('audio') : chooseTrack(id, true));
}));
for (const kind of ['video', 'audio']) {
  const seek = $(`#${kind}-seek`);
  seek.addEventListener('input', () => {
    seek.dataset.scrubbing = 'true';
    setText(`#${kind}-position`, formatTime(Number(seek.value)));
    seek.style.setProperty('--progress', `${Number(seek.value) / Number(seek.max) * 100}%`);
  });
  seek.addEventListener('change', () => {
    const position = Number(seek.value);
    delete seek.dataset.scrubbing;
    run(() => {
      if (kind === 'video') {
        if (document.body.dataset.recovery === 'pending') return;
        claimSession();
      }
      media.seek(kind, position);
      if (kind === 'video') captureSession('seek');
    });
  });
  seek.addEventListener('blur', () => { delete seek.dataset.scrubbing; render(media.getSnapshot()); });
  const volume = $(`#${kind}-volume`);
  volume.addEventListener('input', () => media.setVolume(kind, Number(volume.value)));
  volume.addEventListener('change', savePreferences);
}
$('#loop-toggle').addEventListener('click', () => { media.setLoop(!media.getSnapshot().audio.loop); savePreferences(); });
$('#timer-toggle').addEventListener('click', () => { const session = media.getSnapshot().session; if (session.complete) media.resetSession(); media.setSessionEnabled(!session.enabled); });
$('#timer-reset').addEventListener('click', () => media.resetSession());
$('#notice-close').addEventListener('click', () => { $('#notice').hidden = true; });
for (const channel of ['voice', 'breaths', 'music']) {
  const slider = $(`#guide-volume-${channel}`);
  slider.addEventListener('input', () => media.setGuideGain(channel, Number(slider.value) / 100));
  slider.addEventListener('change', () => { savePreferences(); captureSession('pause'); });
}
$('#guide-mute')?.addEventListener('click', () => media.setGuideMuted(!media.getSnapshot().video.muted));
function setDockMinimized(value, focus = false) {
  dockMinimized = Boolean(value);
  $('#sound-dock').hidden = dockMinimized;
  $('#dock-reopen').hidden = !dockMinimized;
  $('#dock-reopen').setAttribute('aria-expanded', String(!dockMinimized));
  document.documentElement.style.setProperty('--dock-height', dockMinimized ? '0px' : `${Math.ceil($('#sound-dock').getBoundingClientRect().height) + 8}px`);
  if (focus) (dockMinimized ? $('#dock-reopen') : $('#dock-minimize')).focus();
  savePreferences();
}
$('#dock-minimize').addEventListener('click', () => setDockMinimized(true, true));
$('#dock-reopen').addEventListener('click', () => setDockMinimized(false, true));

function updateMotion() {
  const enabled = motionEnabled && !reducedMotion.matches;
  document.body.classList.toggle('motion-disabled', !enabled);
  motion.setEnabled(enabled);
  guideScene.setEnabled(enabled);
  $('#motion-toggle').setAttribute('aria-pressed', String(enabled));
  $('#motion-toggle').setAttribute('aria-label', enabled ? 'Beweging uitzetten' : 'Beweging aanzetten');
  $('#motion-toggle').title = reducedMotion.matches ? 'Verminder beweging staat aan op je apparaat' : enabled ? 'Beweging aan' : 'Beweging uit';
}
$('#motion-toggle').addEventListener('click', () => { motionEnabled = !motionEnabled; updateMotion(); savePreferences(); });
reducedMotion.addEventListener('change', updateMotion);
const dialog = $('#help-dialog');
function openHelp() { previousFocus = document.activeElement; dialog.showModal(); }
$('#help-open').addEventListener('click', openHelp);
$('#footer-help').addEventListener('click', openHelp);
$('#help-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => previousFocus?.focus());
dialog.addEventListener('click', event => { const bounds = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close(); });

media.setVolume('video', 1);
for (const channel of ['voice', 'breaths', 'music']) {
  const legacy = Number.isFinite(preferences.videoVolume) ? Math.min(1, Math.max(0, preferences.videoVolume)) : 1;
  media.setGuideGain(channel, Number.isFinite(preferences.guideGains?.[channel]) ? preferences.guideGains[channel] : legacy);
}
media.setVolume('audio', Number.isFinite(preferences.audioVolume) ? preferences.audioVolume : .7);
media.setLoop(preferences.loop !== false);
updateMotion();
render(media.getSnapshot());
run(() => media.initGuide());
const dockObserver = new ResizeObserver(() => document.documentElement.style.setProperty('--dock-height', dockMinimized ? '0px' : `${Math.ceil($('#sound-dock').getBoundingClientRect().height) + 8}px`));
dockObserver.observe($('#sound-dock'));
setDockMinimized(dockMinimized);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* Online playback still works. */ });
}
