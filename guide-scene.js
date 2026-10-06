const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function measuredRadius(samples, position) {
  if (!samples?.length) return .65;
  let left = 0;
  let right = samples.length - 1;
  if (position <= samples[left][0]) return clamp(samples[left][1], 0, 1);
  if (position >= samples[right][0]) return clamp(samples[right][1], 0, 1);
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (samples[middle][0] <= position) left = middle;
    else right = middle;
  }
  const amount = (position - samples[left][0]) / (samples[right][0] - samples[left][0]);
  return clamp(samples[left][1] + (samples[right][1] - samples[left][1]) * amount, 0, 1);
}

/** Deterministic scene state. All timing comes from the media, never wall time. */
export function getGuideFrame(guide, inputPosition) {
  const positionMs = clamp(Number.isFinite(inputPosition) ? Math.round(inputPosition * 1000) : 0, 0, guide.durationMs);
  const position = positionMs / 1000;
  const round = guide.rounds.find(item => positionMs >= item.startMs && positionMs < item.endMs);
  const segment = guide.breathingSegments.find(item => item.round === round?.number);
  const cue = guide.cues.findLast(item => positionMs >= item.startMs && positionMs < item.endMs);
  const countdown = guide.cues.findLast(item => item.kind === 'countdown' && positionMs >= item.startMs && positionMs < item.endMs);
  const frame = { position, positionMs, round: round?.number ?? null, phase: 'intro', direction: 'still', count: null, radius: .65, label: 'Welkom', value: 'Adem.', foot: 'Kom bij jezelf', instruction: 'Neem de tijd om te landen.', caption: 'Ga comfortabel zitten of liggen.' };
  if (positionMs >= guide.durationMs) {
    Object.assign(frame, { phase: 'complete', label: 'Vijf rondes', value: 'Rust.', foot: 'Neem dit moment mee', instruction: 'Adem weer op je eigen ritme.', caption: 'Blijf nog even zitten of liggen en kom rustig bij.' });
  } else if (positionMs >= guide.recoveryStartMs) {
    Object.assign(frame, { phase: 'closing', label: 'Rustig afronden', value: 'Rust.', foot: 'Neem dit moment mee', instruction: 'Adem weer op je eigen ritme.', caption: 'Blijf nog even zitten of liggen en kom rustig bij.' });
  } else if (segment && positionMs >= segment.startMs && positionMs < segment.endMs) {
    const cycle = segment.cycles.find(item => positionMs >= item.startMs && positionMs < item.endMs);
    if (cycle) {
      const inhale = positionMs < cycle.peakMs;
      Object.assign(frame, { phase: 'breathe', direction: inhale ? 'in' : 'out', count: cycle.number, radius: measuredRadius(segment.visualSamples, positionMs), label: 'Ademteug', value: String(cycle.number).padStart(2, '0'), foot: `van ${segment.count}`, instruction: inhale ? 'Adem in.' : 'Laat los.', caption: 'Volg het ritme zonder te forceren.' });
    }
  } else if (segment && positionMs >= segment.endMs && positionMs < segment.retentionStartMs) {
    Object.assign(frame, { phase: 'settle', radius: .46, label: 'Laat rustig los', value: 'Rust.', foot: 'Maak je uitademing af', instruction: 'Laat je laatste adem rustig los.', caption: 'Zo begint het stille moment.' });
  } else if (segment && positionMs >= segment.retentionStartMs && positionMs < segment.retentionEndMs) {
    const remainingMs = segment.retentionEndMs - positionMs;
    const seconds = Math.ceil(remainingMs / 1000);
    const spoken = countdown ? countdown.text.replace(/\.$/, '') : null;
    Object.assign(frame, { phase: 'hold', radius: .46, label: countdown ? 'Aftellen' : 'Rust in de stilte', value: spoken || `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`, remainingMs, foot: countdown ? 'volg de stem' : 'tot de hersteladem', instruction: countdown ? `${spoken}…` : 'Laat je adem even rusten.', caption: 'Adem eerder in zodra je lichaam dat vraagt.' });
  } else if (segment && positionMs >= segment.recoveryStartMs && positionMs < segment.recoveryEndMs) {
    Object.assign(frame, { phase: 'recovery', radius: .85, label: 'Herstelademhaling', value: '00:00', remainingMs: 0, foot: 'Volg je eigen lichaam', instruction: 'Een rustige hersteladem.', caption: 'Volg de gesproken begeleiding zonder te forceren.' });
    if (Number.isFinite(segment.recoveryHoldStartMs)) {
      const holding = positionMs >= segment.recoveryHoldStartMs;
      const remainingMs = Math.max(0, segment.recoveryHoldEndMs - positionMs);
      const amount = clamp((positionMs - segment.recoveryStartMs) / (segment.recoveryHoldStartMs - segment.recoveryStartMs), 0, 1);
      const spoken = countdown ? countdown.text.replace(/\.$/, '') : null;
      Object.assign(frame, spoken ? { direction: 'still', label: 'Aftellen', value: spoken, remainingMs, foot: 'volg de stem', instruction: `${spoken}…` } : holding ? { direction: 'still', label: 'Rustig vasthouden', value: `00:${String(Math.ceil(remainingMs / 1000)).padStart(2, '0')}`, remainingMs, foot: 'tot het loslaten', instruction: 'Houd deze adem rustig vast.' } : { direction: 'in', radius: .46 + .39 * amount, label: 'Hersteladem', value: 'Adem in.', foot: 'Neem een rustige adem', instruction: 'Adem rustig in.' });
    }
  } else if (round) {
    Object.assign(frame, { phase: 'rest', radius: .6, label: `Ronde ${round.number}`, value: 'Adem.', foot: 'Op jouw tempo', instruction: 'Neem een rustig moment.', caption: 'Volg de gesproken begeleiding.' });
  }
  if (cue) frame.caption = cue.text;
  return frame;
}

export class GuideScene {
  constructor({ guide, root, audio, media }) {
    this.guide = guide;
    this.root = root;
    this.media = media;
    this.audio = audio;
    this.enabled = true;
    this.raf = 0;
    this.snapshot = media.getSnapshot();
    this.elements = Object.fromEntries(['round-label', 'orb-label', 'orb-value', 'orb-foot', 'phase', 'caption', 'start'].map(name => [name, root.querySelector(`#guide-${name}`)]));
    this.elements.count = document.createElement('p');
    this.elements.count.className = 'guide-breath-count';
    this.elements.count.hidden = true;
    this.elements.phase.before(this.elements.count);
    this.onChange = event => { this.snapshot = event.detail || media.getSnapshot(); this.render(this.snapshot.video.position); this.schedule(); };
    this.onVisibility = () => { this.render(this.media.getGuidePosition()); this.schedule(); };
    media.addEventListener('change', this.onChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.render(0);
  }
  setEnabled(enabled) { this.enabled = Boolean(enabled); this.render(this.media.getGuidePosition()); this.schedule(); }
  getState() { return getGuideFrame(this.guide, this.media.getGuidePosition()); }
  render(position) {
    const frame = getGuideFrame(this.guide, position);
    const playing = this.snapshot.video.state === 'playing';
    const text = { 'round-label': frame.round ? `Ronde ${frame.round} van 5` : frame.phase === 'complete' ? 'Rustig afronden' : '5 rondes · op jouw tempo', 'orb-label': frame.label, 'orb-value': frame.value, 'orb-foot': frame.foot, phase: frame.instruction, caption: frame.caption };
    for (const [name, value] of Object.entries(text)) if (this.elements[name].textContent !== value) this.elements[name].textContent = value;
    this.root.dataset.phase = frame.phase;
    this.root.dataset.direction = frame.direction;
    this.root.dataset.playing = String(playing);
    this.root.dataset.round = String(frame.round || 0);
    this.root.dataset.breath = String(frame.count || 0);
    this.root.dataset.position = frame.position.toFixed(3);
    this.root.dataset.started = String(frame.position > 0 || playing);
    this.elements.start.hidden = frame.position > 0 || playing;
    this.elements.count.hidden = frame.phase !== 'breathe';
    if (frame.count !== null) {
      const countText = `Ademteug ${String(frame.count).padStart(2, '0')} van 30`;
      if (this.elements.count.textContent !== countText) this.elements.count.textContent = countText;
    }
    // A source radius of .09 must remain .09, not be flattened into a large
    // minimum disc. Text outside the moving circle remains fully readable.
    const scale = this.enabled && ['breathe', 'recovery'].includes(frame.phase) ? frame.radius : .88;
    this.root.style.setProperty('--guide-scale', String(scale));
    this.root.style.setProperty('--guide-turn', '0deg');
    this.root.style.setProperty('--guide-drift', '0px');
  }
  schedule() {
    const playing = this.snapshot.video.state === 'playing';
    if (!playing || document.hidden) { cancelAnimationFrame(this.raf); this.raf = 0; return; }
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      // The native media element is the sole visual clock. Reading currentTime
      // directly avoids extra engine snapshots and keeps every frame locked to audio.
      const position = Number(this.audio?.currentTime);
      this.render(Number.isFinite(position) ? position : this.media.getGuidePosition());
      this.schedule();
    };
    this.raf = requestAnimationFrame(tick);
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.media.removeEventListener('change', this.onChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
