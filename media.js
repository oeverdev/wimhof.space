/* Independent playback owners sharing one AudioContext and protected output. */
const SESSION_SECONDS = 1200;
const ACTIVE = new Set(['playing', 'loading', 'buffering']);
const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
const GUIDE_CHANNELS = ['voice', 'breaths', 'music'];
const aborted = () => Object.assign(new Error('Afgebroken'), { name: 'AbortError' });
const smoothGain = (param, value, context, seconds = .015) => {
  if (!param) return;
  const now = context.currentTime;
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
  else { param.cancelScheduledValues?.(now); param.setValueAtTime?.(param.value, now); }
  if (param.linearRampToValueAtTime) param.linearRampToValueAtTime(value, now + seconds);
  else param.value = value;
};

// One shared stereo lookahead limiter. All guide stems and the separate fork
// meet here. Its fixed 5 ms latency is included in the guide's display clock.
export const MASTER_WORKLET_SOURCE = `
class BreatheLimiter extends AudioWorkletProcessor {
  constructor() { super(); this.delay=Math.ceil(sampleRate*.005); this.size=this.delay+1; this.ring=[new Float32Array(this.size),new Float32Array(this.size)]; this.queueSize=this.delay+2; this.peakIndex=new Float64Array(this.queueSize); this.peakValue=new Float32Array(this.queueSize); this.head=0; this.tail=0; this.n=0; this.gain=1; this.target=1; this.remaining=0; this.release=1-Math.exp(-1/(sampleRate*.05)); }
  process(inputs,outputs) {
    const input=inputs[0]||[], output=outputs[0], frames=output[0]?.length||128, ceiling=.95;
    for(let i=0;i<frames;i++,this.n++) {
      const slot=this.n%this.size; let peak=0;
      for(let c=0;c<2;c++){const x=input[c]?.[i]??input[0]?.[i]??0; const safe=Number.isFinite(x)?x:0; this.ring[c][slot]=safe; peak=Math.max(peak,Math.abs(safe));}
      while(this.head!==this.tail&&this.peakIndex[this.head]<this.n-this.delay)this.head=(this.head+1)%this.queueSize;
      while(this.head!==this.tail){const previous=(this.tail+this.queueSize-1)%this.queueSize;if(this.peakValue[previous]>peak)break;this.tail=previous;}
      this.peakIndex[this.tail]=this.n;this.peakValue[this.tail]=peak;this.tail=(this.tail+1)%this.queueSize;
      const wanted=Math.min(1,ceiling/Math.max(ceiling,this.peakValue[this.head]||0));
      if(wanted<this.target){this.target=wanted;this.remaining=this.remaining?Math.min(this.remaining,this.delay):this.delay;}
      if(this.remaining>0){this.gain+=(this.target-this.gain)/this.remaining;this.remaining--;}
      else {this.target=wanted;this.gain+=(wanted-this.gain)*this.release;}
      const read=(this.n-this.delay+this.size)%this.size;
      let outgoing=0;for(let c=0;c<2;c++)outgoing=Math.max(outgoing,Math.abs(this.ring[c][read]));
      const gain=Math.min(this.gain,ceiling/Math.max(ceiling,outgoing));
      for(let c=0;c<output.length;c++)output[c][i]=this.n<this.delay?0:Math.max(-ceiling,Math.min(ceiling,this.ring[Math.min(c,1)][read]*gain));
    } return true;
  }
}
registerProcessor('breathe-master-limiter',BreatheLimiter);`;

/** Bounded rolling AudioBuffers, all scheduled against one AudioContext clock. */
class GuideTransport {
  constructor(owner, manifest) {
    this.owner = owner; this.manifest = manifest;
    this.cache = new Map(); this.loads = new Map(); this.prefetches = new Map(); this.nodes = new Set(); this.tails = new Set(); this.scheduled = new Set(); this.epoch = 0;
    this.position = 0; this.anchorPosition = 0; this.anchorTime = 0; this.until = 0; this.running = false;
    this.channels = manifest.audio;
  }
  validate() {
    if (!Number.isInteger(this.manifest.durationMs) || this.manifest.durationMs <= 0) throw new Error('De milliseconden-tijdlijn ontbreekt.');
    const first = this.channels.voice.chunks;
    if (!first?.length) throw new Error('De audioblokken ontbreken.');
    for (const channel of GUIDE_CHANNELS) {
      const chunks = this.channels[channel]?.chunks;
      if (!chunks || chunks.length !== first.length) throw new Error('De drie audiokanalen zijn niet uitgelijnd.');
      let end = 0;
      chunks.forEach((chunk, index) => {
        if (!Number.isInteger(chunk.startMs) || !Number.isInteger(chunk.endMs) || chunk.startMs !== end || chunk.endMs <= chunk.startMs || !chunk.src || chunk.startMs !== first[index].startMs || chunk.endMs !== first[index].endMs) throw new Error('Er zit een gat in de audiotijdlijn.');
        if ((chunk.offsetMs ?? 0) < 0) throw new Error('Ongeldige decoder-marge.');
        end = chunk.endMs;
      });
      if (end !== this.manifest.durationMs) throw new Error('De audiokanalen hebben een verschillende eindtijd.');
    }
  }
  index(position = this.now()) {
    const ms = Math.min(this.manifest.durationMs - .00001, position * 1000);
    return this.channels.voice.chunks.findIndex(c => ms >= c.startMs && ms < c.endMs);
  }
  now() {
    if (!this.running) return this.position;
    const clock = this.owner._context.currentTime - (this.owner._masterLatency || 0);
    return Math.min(this.until, this.manifest.durationMs / 1000, this.anchorPosition + Math.max(0, clock - this.anchorTime));
  }
  abortLoads() { ++this.epoch; for (const item of this.loads.values()) item.controller.abort(); this.loads.clear(); this.prefetches.clear(); }
  stopSources() {
    this.position = this.now(); this.running = false;
    const context = this.owner._context;
    const release = context?.state === 'running' && this.nodes.size > 0 ? .005 : 0;
    if (release) smoothGain(this.owner._guideGate?.gain, 0, context, release);
    for (const node of this.nodes) {
      if (release) { this.tails.add(node); try { node.stop(context.currentTime + release); } catch {} }
      else { node.onended = null; try { node.stop(); } catch {} node.disconnect(); }
    }
    this.nodes.clear(); this.scheduled.clear();
  }
  pause() { this.stopSources(); this.abortLoads(); }
  destroy() { this.pause(); for (const node of this.tails) { node.onended = null; try { node.stop(); } catch {} node.disconnect(); } this.tails.clear(); this.cache.clear(); }
  prune(index) {
    for (const key of this.cache.keys()) if (key !== index && key !== index + 1) this.cache.delete(key);
  }
  load(index) {
    if (index < 0 || index >= this.channels.voice.chunks.length) return Promise.resolve(null);
    if (this.cache.has(index)) return Promise.resolve(this.cache.get(index));
    if (this.loads.has(index)) return this.loads.get(index).promise;
    const controller = new AbortController(), epoch = this.epoch, item = { controller };
    item.promise = (async () => {
      const set = {};
      for (const channel of GUIDE_CHANNELS) {
        const chunk = this.channels[channel].chunks[index];
        const buffer = await this.owner._loadBuffer(new URL(chunk.src, import.meta.url), controller.signal, `guide:${channel}:${index}`);
        if (controller.signal.aborted || epoch !== this.epoch || this.owner._destroyed) throw Object.assign(new Error('Afgebroken'), { name: 'AbortError' });
        const needed = ((chunk.offsetMs ?? 0) + chunk.endMs - chunk.startMs) / 1000;
        if (!Number.isFinite(buffer.duration) || buffer.duration + 1 / buffer.sampleRate < needed) throw new Error('Een audioblok is korter dan zijn tijdlijn.');
        set[channel] = buffer;
      }
      this.cache.set(index, set); this.prune(this.index());
      return set;
    })().finally(() => { if (this.loads.get(index) === item) this.loads.delete(index); });
    this.loads.set(index, item); return item.promise;
  }
  graph() {
    const owner = this.owner, context = owner._ensureContext();
    if (!owner._stemBus) {
      owner._stemBus = context.createGain(); owner._guideGate = context.createGain();
      owner._stemBus.connect(owner._guideGate); owner._guideGate.connect(owner._masterInput);
      owner._stemGains = {};
      for (const channel of GUIDE_CHANNELS) {
        const gain = owner._stemGains[channel] = context.createGain();
        gain.gain.value = owner._guideGains[channel]; gain.connect(owner._stemBus);
      }
      owner._applyVideoSound();
    }
    return context;
  }
  schedule(index) {
    if (!this.running || this.scheduled.has(index) || !this.cache.has(index)) return;
    const chunk = this.channels.voice.chunks[index], context = this.owner._context;
    const start = Math.max(this.anchorPosition, chunk.startMs / 1000), end = chunk.endMs / 1000;
    if (end <= start) return;
    const when = this.anchorTime + start - this.anchorPosition;
    // Never jump over an unsounded interval after a delayed network/JS callback.
    if (when < context.currentTime - .001 && start > this.anchorPosition) return;
    const set = this.cache.get(index);
    const sourceEpoch = this.epoch;
    for (const channel of GUIDE_CHANNELS) {
      const part = this.channels[channel].chunks[index];
      const node = context.createBufferSource(); node.buffer = set[channel]; node.connect(this.owner._stemGains[channel]);
      node.onended = () => { this.nodes.delete(node); this.tails.delete(node); node.disconnect(); try { node.buffer = null; } catch {} this.owner._trace('source-ended', { source: `guide:${channel}:${index}`, epoch: sourceEpoch }); };
      node.start(when, (part.offsetMs ?? 0) / 1000 + start - part.startMs / 1000, end - start);
      this.nodes.add(node);
    }
    this.scheduled.add(index); this.until = Math.max(this.until, end);
    this.owner._trace('chunk-scheduled', { index, start, end, when, epoch: this.epoch });
  }
  async play() {
    const owner = this.owner;
    if (this.running && owner._context?.state === 'running' && owner._videoState === 'playing') return;
    const intent = ++owner._videoIntent;
    owner._videoDesired = true; owner._videoState = 'loading'; owner._messages.video = '';
    if (this.position >= owner._videoDuration) { owner._trace('reset', { reason: 'explicit-replay-after-end' }); this.position = 0; }
    this.stopSources(); this.prune(this.index());
    try {
      this.validate(); const context = this.graph();
      const resumed = context.resume(); // Synchronous user-gesture stack.
      owner._emit();
      const index = this.index();
      await Promise.all([resumed, owner._masterReady, this.load(index)]);
      if (owner._destroyed || intent !== owner._videoIntent || !owner._videoDesired) return;
      if (context.state !== 'running') throw Object.assign(new Error('Druk op afspelen om de audio te hervatten.'), { name: 'NotAllowedError' });
      this.anchorPosition = this.position; this.anchorTime = context.currentTime + .025;
      const gate = owner._guideGate.gain;
      if (gate.setValueAtTime && gate.linearRampToValueAtTime) {
        gate.cancelScheduledValues(this.anchorTime); gate.setValueAtTime(0, this.anchorTime); gate.linearRampToValueAtTime(1, this.anchorTime + .005);
      } else gate.value = 1;
      this.until = this.position; this.running = true;
      this.schedule(index); owner._videoState = 'playing'; owner._guideSeeking = false;
      this.prefetch(index + 1); owner._emit();
    } catch (error) {
      if (owner._destroyed || intent !== owner._videoIntent) return;
      owner._interrupt(error.name === 'NotAllowedError' ? 'guide-start-blocked' : 'guide-load-error', ['video']);
      owner._videoState = error.name === 'NotAllowedError' ? 'paused' : 'error';
      owner._messages.video = error.message || 'De audiokanalen konden niet starten.';
      if (error.name !== 'NotAllowedError' && error.name !== 'AbortError' && owner.guideSourceURL) owner._activateGuideFallback(error.message);
      owner._emit();
    }
  }
  prefetch(index) {
    if (this.prefetches.has(index) || this.scheduled.has(index) || index >= this.channels.voice.chunks.length) return;
    const epoch = this.epoch;
    const pending = this.load(index).then(() => {
      if (epoch !== this.epoch || !this.running) return;
      this.schedule(index);
    }).catch(error => {
      if (epoch === this.epoch && error.name !== 'AbortError') this.owner._messages.video = 'Het volgende audioblok wordt opnieuw geladen.';
    }).finally(() => { if (this.prefetches.get(index) === pending) this.prefetches.delete(index); });
    this.prefetches.set(index, pending);
  }
  update() {
    if (!this.running) return;
    const owner = this.owner, position = this.now();
    if (position >= owner._videoDuration) {
      this.stopSources(); this.position = owner._videoDuration;
      owner._videoDesired = false; owner._videoState = 'ended'; owner._trace('guide-complete', { reason: 'canonical-duration' }); return;
    }
    if (position >= this.until && owner._context.currentTime >= this.anchorTime + this.until - this.anchorPosition + (owner._masterLatency || 0)) {
      // A real audible gap requires a new choice; late downloads never restart
      // breathing or retention on their own.
      owner._interrupt('guide-underrun', ['video']);
      return;
    }
    const index = this.index(position); this.prune(index); this.prefetch(index + 1);
  }
  seek(seconds) {
    const owner = this.owner, resume = owner._videoDesired;
    ++owner._videoIntent; this.pause(); this.position = clamp(seconds, 0, owner._videoDuration);
    this.prune(this.index()); owner._guideSeeking = false;
    owner._videoState = this.position >= owner._videoDuration ? 'ended' : 'paused';
    owner._videoDesired = resume && this.position < owner._videoDuration;
    if (owner._videoDesired) { owner._guideSeeking = true; void this.play(); }
  }
}
export class MediaEngine extends EventTarget {
  constructor({ tracks = [], guide = null, guideElement = null, videoHostId = 'guide-media', guideSourceURL = '', trace = false } = {}) {
    super();
    this._guideManifest = guide;
    this._traceEnabled = Boolean(trace); this._traceRows = []; this._traceSequence = 0;
    this._engineId = globalThis.crypto?.randomUUID?.() || `media-${Date.now()}`;
    this._bufferJobs = []; this._bufferJob = null; this._decoding = 0;
    this._resourceStats = { peakDecoders: 0, peakQueued: 0, decoded: 0, aborted: 0 };
    this.videoHostId = videoHostId;
    this.guideSourceURL = guideSourceURL || guide?.fallbackMediaSrc || '';
    this._guideGains = { voice: 1, breaths: 1, music: 1 };
    this._guideTransport = guide?.audio && GUIDE_CHANNELS.every(channel => Array.isArray(guide.audio[channel]?.chunks)) ? new GuideTransport(this, guide) : null;
    this._guideMode = this._guideTransport ? 'stems' : 'native-fallback';
    this._providedGuide = guideElement;
    this._guideEvents = [];
    this._guidePendingPlays = new Set();
    this._nativeGuideVolume = 1;
    this._guideSeeking = false;
    this.tracks = tracks.filter(track => track?.id && track.playback && track.available !== false).map(track => ({ ...track }));
    this._tracks = new Map(this.tracks.map(track => [track.id, track]));
    this._trackId = this.tracks[0]?.id ?? null;
    this._positions = new Map();
    this._durations = new Map(this.tracks.map(track => [track.id,
      Number.isFinite(track.loopEnd) && track.loopEnd > (track.loopStart || 0)
        ? track.loopEnd - (track.loopStart || 0) : Math.max(0, Number(track.duration) || 0)]));
    this._buffers = new Map();
    this._loads = new Map();
    this._audioState = this._videoState = 'ready';
    this._audioIntent = this._videoIntent = 0;
    this._audioDesired = this._videoDesired = false;
    this._audioPosition = this._videoPosition = this._videoDuration = 0;
    if (this._guideTransport) this._videoDuration = guide.durationMs / 1000;
    this._audioVolume = this._videoVolume = 1;
    this._videoMuted = false;
    this._videoGeneration = 0;
    this._messages = { audio: '', video: '', session: '' };
    this.muted = false;
    this.loop = true;
    this.sessionEnabled = false;
    this.sessionElapsed = 0;
    this._sessionAnchor = null;
    this._destroyed = false;
    // Rotation/visibility changes never issue playback commands. A suspended
    // AudioContext freezes its clock; pagehide explicitly preserves both offsets.
    this._visibility = () => { this._trace('visibility', { hidden: Boolean(document.hidden) }); this._tick(); };
    this._pageHide = event => { this._trace('pagehide', { persisted: Boolean(event.persisted) }); this._interrupt('pagehide'); };
    document.addEventListener('visibilitychange', this._visibility);
    window.addEventListener('pagehide', this._pageHide);
    this._timer = setInterval(() => this._tick(), 100);
  }

  /** One uncancellable native decoder at a time, shared by guide and forks.
   * Queued jobs carry no fetched PCM/encoded bytes and abort before allocation. */
  _loadBuffer(url, signal, label) {
    if (this._destroyed || signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const job = { url, signal, label, resolve, reject };
      job.abort = () => {
        const index = this._bufferJobs.indexOf(job);
        if (index >= 0) { this._bufferJobs.splice(index, 1); signal.removeEventListener('abort', job.abort); this._resourceStats.aborted++; reject(aborted()); }
      };
      signal.addEventListener('abort', job.abort, { once: true });
      this._bufferJobs.push(job); this._resourceStats.peakQueued = Math.max(this._resourceStats.peakQueued, this._bufferJobs.length);
      void this._pumpBufferJobs();
    });
  }

  async _pumpBufferJobs() {
    if (this._bufferJob || this._destroyed || !this._bufferJobs.length) return;
    const job = this._bufferJob = this._bufferJobs.shift();
    const check = () => { if (this._destroyed || job.signal.aborted) throw aborted(); };
    try {
      check();
      const response = await fetch(job.url, { signal: job.signal });
      if (!response.ok) throw new Error('Deze opname kon niet worden geladen. Probeer opnieuw.');
      const bytes = await response.arrayBuffer(); check();
      this._decoding = 1; this._resourceStats.peakDecoders = Math.max(this._resourceStats.peakDecoders, this._decoding);
      this._trace('decode-start', { source: job.label });
      let buffer;
      try { buffer = await this._context.decodeAudioData(bytes); }
      finally { this._decoding = 0; }
      check(); this._resourceStats.decoded++; job.resolve(buffer);
    } catch (error) {
      if (error.name === 'AbortError') this._resourceStats.aborted++;
      this._trace('load-result', { source: job.label, code: error.name || 'Error' }); job.reject(error);
    } finally {
      job.signal.removeEventListener('abort', job.abort); this._bufferJob = null;
      void this._pumpBufferJobs();
    }
  }

  _abortAudioLoads(exceptId) {
    for (const [id, item] of this._loads) if (id !== exceptId) { item.controller.abort(); this._loads.delete(id); }
  }

  setTraceEnabled(enabled) { this._traceEnabled = Boolean(enabled); if (enabled) this._trace('trace-enabled'); }
  getTrace() { return this._traceRows.map(row => ({ ...row })); }
  getDiagnostics() {
    const guide = this._guideTransport, buffers = new Set(this._buffers.values());
    if (this._audioBuffer) buffers.add(this._audioBuffer);
    for (const set of guide?.cache.values() || []) for (const buffer of Object.values(set)) buffers.add(buffer);
    for (const node of [...(guide?.nodes || []), ...(guide?.tails || [])]) if (node.buffer) buffers.add(node.buffer);
    let retainedPCMBytes = 0;
    for (const buffer of buffers) retainedPCMBytes += (buffer.length || 0) * (buffer.numberOfChannels || 0) * 4;
    return { engineId: this._engineId, guideGeneration: this._videoIntent, audioGeneration: this._audioIntent, contextState: this._context?.state || 'uninitialized', guidePosition: this.getGuidePosition(), guideState: this._videoState, guideMode: this._guideMode, guideCacheSets: guide?.cache.size || 0, guideNodes: guide?.nodes.size || 0, guideTails: guide?.tails.size || 0, guideLoads: guide?.loads.size || 0, forkCacheBuffers: this._buffers.size, queuedLoads: this._bufferJobs.length, activeLoad: this._bufferJob?.label || null, activeDecoders: this._decoding, retainedPCMBytes, ...this._resourceStats };
  }
  _trace(event, detail = {}) {
    if (!this._traceEnabled) return;
    const position = this.getGuidePosition(), ms = Math.round(position * 1000), manifest = this._guideManifest;
    const round = manifest?.rounds?.find(item => ms >= item.startMs && ms < item.endMs);
    const segment = manifest?.breathingSegments?.find(item => item.round === round?.number);
    const phase = !round ? ms >= (manifest?.durationMs || Infinity) ? 'complete' : ms >= (manifest?.recoveryStartMs || Infinity) ? 'closing' : 'intro'
      : ms >= segment?.retentionStartMs && ms < segment?.retentionEndMs ? 'hold' : ms >= segment?.recoveryStartMs && ms < segment?.recoveryEndMs ? 'recovery' : ms >= segment?.startMs && ms < segment?.endMs ? 'breathe' : 'rest';
    this._traceRows.push({ sequence: ++this._traceSequence, at: Date.now(), engineId: this._engineId, event, position, round: round?.number || null, phase, state: this._videoState, context: this._context?.state || 'uninitialized', generation: this._videoIntent, ...detail });
    if (this._traceRows.length > 256) this._traceRows.shift();
  }

  _ensureContext() {
    if (this._context) return this._context;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('Deze browser ondersteunt de klankspeler niet.');
    const context = this._context = new AudioContext();
    this._analyser = context.createAnalyser();
    this._analyser.fftSize = 2048;
    this._samples = new Float32Array(this._analyser.fftSize);
    this._gain = context.createGain();
    this._gain.gain.value = this.muted ? 0 : this._audioVolume;
    this._analyser.connect(this._gain);
    this._masterInput = context.createGain();
    this._gain.connect(this._masterInput);
    this._masterReady = this._createMaster(context);
    let previousContextState = context.state;
    this._contextState = () => {
      if (this._destroyed) return;
      const changed = previousContextState !== context.state;
      previousContextState = context.state;
      this._trace('context-state', { context: context.state });
      // Initial suspended construction is normal. A later external transition
      // cancels even pending fetch/decode/play generations, not just live nodes.
      if (context.state !== 'running' && (changed || context.state === 'interrupted')) this._interrupt(`audio-context-${context.state}`);
      // Returning to running never restarts a stopped guide or fork source.
      this._emit();
    };
    context.addEventListener('statechange', this._contextState);
    return context;
  }

  async _createMaster(context) {
    if (context.audioWorklet && typeof AudioWorkletNode === 'function') {
      const url = URL.createObjectURL(new Blob([MASTER_WORKLET_SOURCE], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
        if (this._destroyed) return;
        this._masterNode = new AudioWorkletNode(context, 'breathe-master-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        this._masterInput.connect(this._masterNode); this._masterNode.connect(context.destination);
        this._masterLatency = Math.ceil(context.sampleRate * .005) / context.sampleRate;
        this._masterMode = 'lookahead-limiter';
        return;
      } catch { /* Older mobile browsers use the bounded native graph below. */ }
      finally { URL.revokeObjectURL(url); }
    }
    if (this._destroyed) return;
    const compressor = this._masterNode = context.createDynamicsCompressor();
    compressor.threshold.value = -1; compressor.knee.value = 0; compressor.ratio.value = 20;
    compressor.attack.value = .001; compressor.release.value = .05;
    const ceiling = this._masterCeiling = context.createWaveShaper();
    ceiling.curve = Float32Array.from({ length: 8193 }, (_, i) => Math.max(-.95, Math.min(.95, (i / 8192) * 2 - 1)));
    ceiling.oversample = '4x';
    this._masterInput.connect(compressor); compressor.connect(ceiling); ceiling.connect(context.destination);
    this._masterLatency = .006; this._masterMode = 'native-compressor-ceiling';
  }

  /** Optional preload: decode a recording without starting sound. */
  initAudio(id = this._trackId) {
    if (this._destroyed) return Promise.resolve();
    const track = this._tracks.get(id);
    if (!track) return Promise.reject(new Error('Kies eerst een klank.'));
    if (this._buffers.has(id)) {
      const buffer = this._buffers.get(id);
      this._buffers.delete(id);
      this._buffers.set(id, buffer);
      return Promise.resolve(buffer);
    }
    if (this._loads.has(id)) return this._loads.get(id).promise;
    const controller = new AbortController();
    const item = { controller };
    const promise = item.promise = (async () => {
      const context = this._ensureContext();
      const decoded = await this._loadBuffer(new URL(track.playback, import.meta.url), controller.signal, `fork:${id}`);
      if (this._destroyed || controller.signal.aborted) throw aborted();
      let buffer = decoded;
      if (Number.isFinite(track.loopStart) || Number.isFinite(track.loopEnd)) {
        const start = Math.round(clamp(track.loopStart, 0, decoded.duration) * decoded.sampleRate);
        const end = Math.min(decoded.length, Math.round(clamp(track.loopEnd ?? decoded.duration, 0, decoded.duration) * decoded.sampleRate));
        if (end <= start) throw new Error('Het gekozen fragment bevat geen afspeelbare klank.');
        buffer = context.createBuffer(decoded.numberOfChannels, end - start, decoded.sampleRate);
        // Sample-exact crop of the browser-decoded source; no gain analysis,
        // normalization, crossfade, synthesis, or additional lossy encoding.
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          buffer.copyToChannel(decoded.getChannelData(channel).subarray(start, end), channel);
        }
      }
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error('Deze opname bevat geen afspeelbare klank.');
      this._durations.set(id, buffer.duration);
      this._buffers.set(id, buffer);
      while (this._buffers.size > 2) this._buffers.delete([...this._buffers.keys()].find(key => key !== this._trackId));
      this._emit();
      return buffer;
    })().finally(() => { if (this._loads.get(id) === item) this._loads.delete(id); });
    this._loads.set(id, item);
    return promise;
  }

  play(kind) {
    if (this._destroyed) return Promise.resolve();
    this._trace('action', { action: 'play', kind });
    if (kind === 'audio') return this._playAudio();
    if (kind === 'video') return this._playVideo();
    return Promise.resolve();
  }

  async _playAudio() {
    if (this._source && this._context.state === 'running') return;
    if (this.sessionEnabled && this.sessionElapsed >= SESSION_SECONDS) {
      this._messages.session = 'Je klanksessie is afgerond. Zet de timer opnieuw om verder te gaan.';
      this._emit(); return;
    }
    const intent = ++this._audioIntent, trackId = this._trackId;
    this._audioDesired = true;
    this._audioState = 'loading';
    this._messages.audio = '';
    this._emit();
    try {
      // Resume inside the click stack, before fetch/decode/await on mobile.
      const context = this._ensureContext();
      const resumed = context.resume();
      const [buffer] = await Promise.all([this.initAudio(trackId), resumed, this._masterReady]);
      if (!this._currentAudio(intent, trackId)) return;
      if (context.state !== 'running') throw new Error('Druk nogmaals op afspelen om de klank te starten.');
      if (this._source) { this._audioState = 'playing'; this._emit(); return; }
      this._audioBuffer = buffer;
      this._audioPosition = clamp(this._audioPosition, 0, buffer.duration);
      if (this._audioPosition >= buffer.duration) this._audioPosition = 0;
      this._startAudio();
    } catch (error) {
      if (!this._currentAudio(intent, trackId)) return;
      this._interrupt('fork-load-error', ['audio']);
      this._audioState = 'error';
      this._messages.audio = error.message || 'Klank afspelen is niet gelukt.';
      this._emit();
    }
  }

  _currentAudio(intent, id) { return !this._destroyed && this._audioDesired && intent === this._audioIntent && id === this._trackId; }

  _audioNow() {
    if (!this._source || !this._audioBuffer) return this._audioPosition;
    const clock = Math.min(this._context.currentTime, this._sourceStopTime ?? Infinity);
    const position = this._audioPosition + Math.max(0, clock - this._audioStartTime);
    return this.loop ? position % this._audioBuffer.duration : Math.min(this._audioBuffer.duration, position);
  }

  _startAudio() {
    if (this._destroyed || !this._audioBuffer) return;
    const source = this._context.createBufferSource();
    source.buffer = this._audioBuffer;
    source.loop = this.loop;
    source.loopStart = 0;
    source.loopEnd = this._audioBuffer.duration;
    source.connect(this._analyser);
    this._audioStartTime = this._context.currentTime;
    this._sourceEndTime = this._audioStartTime + this._audioBuffer.duration - this._audioPosition;
    this._sourceStopTime = this.sessionEnabled ? this._audioStartTime + Math.max(0, SESSION_SECONDS - this.sessionElapsed) : Infinity;
    source.onended = () => {
      if (this._source !== source || this._destroyed) return;
      this._syncSession();
      const sessionComplete = this.sessionEnabled && this.sessionElapsed >= SESSION_SECONDS;
      const position = this._audioNow();
      this._sessionAnchor = null;
      this._source = null;
      source.disconnect();
      this._audioPosition = sessionComplete ? position : this._audioBuffer.duration;
      this._positions.set(this._trackId, this._audioPosition);
      this._audioDesired = false;
      this._audioState = 'ended';
      if (sessionComplete) this._messages.session = 'Je klanksessie van 20 minuten is afgerond.';
      this._emit();
    };
    source.start(0, this._audioPosition);
    this._source = source;
    this._audioState = this._context.state === 'running' ? 'playing' : 'buffering';
    this._sessionAnchor = this.sessionEnabled ? this._context.currentTime : null;
    // Native scheduling remains accurate when a background tab throttles JS.
    if (Number.isFinite(this._sourceStopTime)) source.stop(this._sourceStopTime);
    this._emit();
  }

  _stopAudio() {
    this._syncSession();
    this._sessionAnchor = null;
    this._audioPosition = this._audioNow();
    this._positions.set(this._trackId, this._audioPosition);
    if (!this._source) return;
    const source = this._source;
    this._source = null;
    source.onended = null;
    try { source.stop(); } catch { /* Already ended. */ }
    source.disconnect();
  }

  /** Stop external interruptions before notifying the app's explicit recovery UI. */
  _interrupt(reason, requestedKinds = ['video', 'audio']) {
    if (this._destroyed) return false;
    const active = {
      video: this._videoDesired || ACTIVE.has(this._videoState) || this._guideTransport?.running || Boolean(this._guide && !this._guide.paused && !this._guide.ended),
      audio: this._audioDesired || ACTIVE.has(this._audioState) || Boolean(this._source)
    };
    const kinds = [...new Set(requestedKinds)].filter(kind => active[kind]);
    if (!kinds.length) return false;
    const position = this.getGuidePosition();
    for (const kind of kinds) this.pause(kind);
    if (kinds.includes('video')) this._messages.video = 'De begeleiding is onderbroken. Adem rustig en kies bewust hoe je verdergaat.';
    if (kinds.includes('audio')) this._messages.audio = 'Klank is onderbroken. Druk op afspelen om verder te gaan.';
    const detail = { reason, kinds, position };
    this._trace('interruption', detail);
    this._emit();
    this.dispatchEvent(new CustomEvent('interruption', { detail }));
    return true;
  }

  pause(kind) {
    if (this._destroyed) return;
    this._trace('action', { action: 'pause', kind: kind || 'all' });
    if (!kind || kind === 'audio') {
      ++this._audioIntent;
      this._audioDesired = false;
      this._abortAudioLoads();
      this._stopAudio();
      this._audioState = 'paused';
      this._messages.audio = '';
    }
    if (!kind || kind === 'video') {
      ++this._videoIntent;
      this._videoDesired = false;
      this._readVideo();
      if (this._guideTransport) this._guideTransport.pause();
      else this._guide?.pause();
      this._guideSeeking = false;
      this._videoState = 'paused';
      this._messages.video = '';
    }
    this._emit();
  }

  toggle(kind) {
    if (!['audio', 'video'].includes(kind)) return;
    if (kind === 'audio' && this._source && this._context.state !== 'running') return this.play(kind);
    return ACTIVE.has(kind === 'audio' ? this._audioState : this._videoState) ? this.pause(kind) : this.play(kind);
  }

  selectTrack(id) {
    if (this._destroyed || !this._tracks.has(id) || id === this._trackId) return Promise.resolve();
    const keepPlaying = this._audioDesired;
    ++this._audioIntent;
    this._abortAudioLoads(id);
    this._stopAudio();
    this._audioDesired = false;
    this._trackId = id;
    this._audioBuffer = this._buffers.get(id);
    this._audioPosition = this._positions.get(id) || 0;
    this._audioState = 'ready';
    this._messages.audio = '';
    this._emit();
    return keepPlaying ? this.play('audio') : Promise.resolve();
  }

  seek(kind, seconds) {
    if (this._destroyed) return;
    this._trace('action', { action: 'seek', kind, target: Number(seconds) || 0 });
    if (kind === 'audio') {
      const wasPlaying = Boolean(this._source);
      this._stopAudio();
      const duration = this._durations.get(this._trackId) || Number.MAX_VALUE;
      this._audioPosition = clamp(seconds, 0, duration);
      this._positions.set(this._trackId, this._audioPosition);
      if (wasPlaying) {
        if (this._audioPosition >= duration && !this.loop) {
          this._audioDesired = false; this._audioState = 'ended';
        } else {
          if (this._audioPosition >= duration) this._audioPosition = 0;
          this._startAudio();
          if (this._context.state !== 'running') this._audioState = 'buffering';
        }
      } else if (this._audioState === 'ended') this._audioState = 'paused';
    } else if (kind === 'video') {
      if (this._guideTransport) { this._guideTransport.seek(seconds); this._emit(); return; }
      const target = clamp(seconds, 0, this._videoDuration || Number.MAX_VALUE);
      this._pendingVideoSeek = target;
      this._flushGuideSeek();
      if (this._videoState === 'ended') this._videoState = 'paused';
    }
    this._emit();
  }

  restart(kind) { this._trace('reset', { reason: 'explicit-restart', kind }); this.seek(kind, 0); }
  stop(kind) { this._trace('reset', { reason: 'explicit-stop', kind: kind || 'all' }); this.pause(kind); if (!kind || kind === 'video') this.seek('video', 0); if (!kind || kind === 'audio') this.seek('audio', 0); }

  setLoop(value) {
    if (this._destroyed || Boolean(value) === this.loop) return;
    this._syncSession();
    this._audioPosition = this._audioNow();
    this.loop = Boolean(value);
    if (this._context) {
      this._audioStartTime = this._context.currentTime;
      this._sourceEndTime = this._audioStartTime + (this._audioBuffer?.duration || 0) - this._audioPosition;
    }
    if (this._source) this._source.loop = this.loop;
    this._emit();
  }

  setMuted(value) {
    this.muted = Boolean(value);
    this._videoMuted = this.muted;
    if (this._gain) smoothGain(this._gain.gain, this.muted ? 0 : this._audioVolume, this._context);
    this._applyVideoSound({ volume: false });
    this._emit();
  }

  setGuideMuted(value) { this._videoMuted = Boolean(value); this._applyVideoSound({ volume: false }); this._emit(); }

  setGuideGain(channel, value) {
    if (!GUIDE_CHANNELS.includes(channel)) return;
    this._guideGains[channel] = clamp(value, 0, 2);
    if (this._stemGains?.[channel]) smoothGain(this._stemGains[channel].gain, this._guideGains[channel], this._context);
    this._emit();
  }

  setVolume(kind, value) {
    if (kind === 'audio') {
      this._audioVolume = clamp(value, 0, 1);
      if (this._gain) smoothGain(this._gain.gain, this.muted ? 0 : this._audioVolume, this._context);
    } else if (kind === 'video') { this._videoVolume = clamp(value, 0, 1); this._applyVideoSound({ mute: false }); }
    this._emit();
  }

  setSessionEnabled(value) {
    if (Boolean(value) === this.sessionEnabled) return;
    this._syncSession();
    const restartSource = Boolean(this._source);
    if (restartSource) this._stopAudio();
    this.sessionEnabled = Boolean(value);
    if (restartSource) this._startAudio();
    this._tick();
  }

  resetSession() {
    const restartSource = Boolean(this._source);
    if (restartSource) this._stopAudio();
    this.sessionElapsed = 0;
    this._messages.session = '';
    if (restartSource) this._startAudio();
    if (this._audioState === 'ended') this._audioState = 'paused';
    this._emit();
  }

  _syncSession() {
    if (this._sessionAnchor === null || !this._source) return;
    // A delayed onended callback must not count time after the true buffer end.
    const now = Math.min(this._context.currentTime, this._sourceStopTime ?? Infinity, this.loop ? Infinity : this._sourceEndTime);
    // Native onended/currentTime can differ from the scheduled deadline by a
    // floating rounding fraction. Allow at most one output sample, while the
    // earlier natural-buffer-end bound above still prevents false completion.
    const sampleTolerance = 1 / (this._context.sampleRate || 48000);
    this.sessionElapsed = this.sessionEnabled && Number.isFinite(this._sourceStopTime) && this._sourceStopTime - now <= sampleTolerance
      ? SESSION_SECONDS
      : Math.min(SESSION_SECONDS, this.sessionElapsed + Math.max(0, now - this._sessionAnchor));
    this._sessionAnchor = now;
  }

  /** Bind/preload the supplied native guide; this never generates or starts it. */
  initVideo() {
    if (this._destroyed) return Promise.resolve();
    try {
      if (this._guideTransport) { this._guideTransport.validate(); return Promise.resolve(); }
      return Promise.resolve(this._ensureGuide());
    }
    catch (error) {
      this._videoState = 'error';
      this._messages.video = error.message;
      this._emit();
      return Promise.reject(error);
    }
  }

  initGuide() { return this.initVideo(); }

  _activateGuideFallback(reason) {
    this._trace('fallback', { reason: 'stem-load-error' });
    const position = this._guideTransport?.now() ?? this._videoPosition;
    this._guideTransport?.destroy(); this._guideTransport = null; this._guideMode = 'native-fallback';
    this._pendingVideoSeek = position;
    this._videoDesired = false; this._videoState = 'paused';
    this._messages.video = 'De drie kanalen konden niet laden. De vaste audiomix is beschikbaar; afzonderlijke regelaars werken daarin niet. Druk op afspelen.';
    try { this._ensureGuide(); } catch { this._videoState = 'error'; this._messages.video = reason; }
  }

  _ensureGuide() {
    if (this._guide) return this._guide;
    const guide = this._providedGuide || document.getElementById(this.videoHostId);
    if (!guide || typeof guide.play !== 'function' || typeof guide.pause !== 'function') {
      throw new Error('De native begeleidingsspeler ontbreekt.');
    }
    const configured = this.guideSourceURL || guide.getAttribute?.('src') || guide.currentSrc || guide.querySelector?.('source[src]')?.getAttribute('src');
    if (!configured) throw new Error('Het definitieve begeleidingsbestand is nog niet beschikbaar.');
    this._guide = guide;
    const generation = ++this._videoGeneration;
    guide.preload = 'metadata';
    guide.playsInline = true;
    guide.setAttribute?.('playsinline', '');
    guide.loop = false;
    for (const name of ['loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'error', 'emptied', 'timeupdate', 'volumechange', 'ratechange']) {
      const listener = () => {
        if (!this._destroyed && this._guide === guide && generation === this._videoGeneration) this._onGuideEvent(name);
      };
      guide.addEventListener(name, listener);
      this._guideEvents.push([name, listener]);
    }
    this._applyVideoSound();
    if (this.guideSourceURL) {
      const source = new URL(this.guideSourceURL, import.meta.url).href;
      if (guide.src !== source) { guide.src = source; guide.load(); }
    }
    this._readVideo();
    this._flushGuideSeek();
    return guide;
  }

  _ensureGuideGraph(guide) {
    const context = this._ensureContext();
    if (this._guideSourceNode) return context;
    // Streaming media stays in the native element; only a small graph is made.
    // Never decode the full narration/video into an AudioBuffer.
    this._guideSourceNode = context.createMediaElementSource(guide);
    this._guideGain = context.createGain();
    this._guideSourceNode.connect(this._guideGain);
    this._guideGain.connect(this._masterInput);
    this._applyVideoSound();
    return context;
  }

  async _playVideo() {
    if (this._guideTransport) return this._guideTransport.play();
    if (this._videoState === 'playing' && !this._guide?.paused && this._context?.state === 'running') return;
    const intent = ++this._videoIntent;
    this._videoDesired = true;
    const replay = this._videoState === 'ended' || this._guide?.ended;
    this._videoState = 'loading';
    this._messages.video = '';
    this._emit();
    let guide;
    this._guidePendingPlays.add(intent);
    try {
      guide = this._ensureGuide();
      const context = this._ensureGuideGraph(guide);
      if (guide.error) {
        this._pendingVideoSeek = this._videoPosition;
        guide.load();
      }
      if (replay) { this._pendingVideoSeek = 0; this._flushGuideSeek(); }
      // Both calls must be made in the original click stack, before any await.
      const resumed = context.resume();
      const played = guide.play();
      await Promise.all([resumed, played, this._masterReady]);
      if (this._destroyed || intent !== this._videoIntent || !this._videoDesired) {
        if (!this._videoDesired || this._destroyed) guide.pause();
        return;
      }
      if (context.state !== 'running') {
        const error = new Error('Druk opnieuw op afspelen om het geluid van de begeleiding te starten.');
        error.name = 'NotAllowedError';
        throw error;
      }
      this._readVideo();
      this._videoState = guide.paused ? 'paused' : guide.seeking || guide.readyState < 3 ? 'buffering' : 'playing';
      this._emit();
    } catch (error) {
      if (this._destroyed || intent !== this._videoIntent) return;
      this._interrupt(error.name === 'NotAllowedError' ? 'guide-start-blocked' : 'native-play-error', ['video']);
      this._videoState = ['NotAllowedError', 'AbortError'].includes(error.name) ? 'paused' : 'error';
      this._messages.video = error.name === 'NotAllowedError'
        ? 'Druk op afspelen om de begeleiding met geluid te starten.'
        : error.name === 'AbortError' ? 'De begeleiding is gepauzeerd. Druk op afspelen om verder te gaan.'
        : error.message || 'De begeleiding kon niet starten.';
      this._emit();
    } finally { this._guidePendingPlays.delete(intent); }
  }

  _flushGuideSeek() {
    if (!this._guide || this._pendingVideoSeek === undefined || this._guide.readyState < 1) return;
    const target = clamp(this._pendingVideoSeek, 0, Number.isFinite(this._guide.duration) ? this._guide.duration : Number.MAX_VALUE);
    try {
      this._guide.currentTime = target;
      this._pendingVideoSeek = undefined;
      this._readVideo();
    } catch {
      // Some mobile decoders accept seeking only after metadata/canplay.
      // Keep only the newest target, and retry when either event arrives.
    }
  }

  _onGuideEvent(name) {
    const guide = this._guide;
    if (name === 'volumechange' && this._settingGuideSound) return;
    this._readVideo();
    if (['loadedmetadata', 'durationchange', 'canplay'].includes(name)) this._flushGuideSeek();
    if (name === 'play') {
      if (!this._videoDesired) { guide.pause(); return; }
      this._videoState = guide.readyState < 3 ? 'buffering' : 'loading';
      this._messages.video = '';
    } else if (name === 'playing') {
      if (!this._videoDesired) { guide.pause(); return; }
      if (this._guideGain && this._context.state !== 'running' && !this._guidePendingPlays.size) {
        this._interrupt('native-context-unavailable', ['video']);
      } else {
        this._videoState = this._guideGain && this._context.state !== 'running' ? 'loading' : 'playing';
        this._messages.video = '';
      }
    } else if (name === 'pause' && guide.paused && !guide.ended && this._videoState !== 'error') {
      if (this._videoDesired) this._interrupt('native-pause', ['video']);
      else { ++this._videoIntent; this._videoState = 'paused'; }
    } else if (name === 'waiting' || name === 'stalled') {
      if (!guide.paused && this._videoDesired && guide.readyState < 3) {
        // Initial loading and an explicit seek are allowed to prepare audio.
        // Buffered stalled events do not prove an audible interruption.
        if (!guide.seeking && this._videoState === 'playing') this._interrupt('native-starved', ['video']);
        else this._videoState = 'buffering';
      }
    } else if (name === 'seeking') {
      this._guideSeeking = true;
      if (!guide.paused) this._videoState = 'buffering';
    } else if (name === 'seeked' || name === 'canplay') {
      this._guideSeeking = Boolean(guide.seeking);
      if (guide.ended) this._videoState = 'ended';
      else if (!guide.paused && this._videoDesired) this._videoState = guide.readyState < 3 ? 'buffering' : 'playing';
      else if (name === 'seeked') this._videoState = 'paused';
    } else if (name === 'ended') {
      this._videoDesired = false;
      this._guideSeeking = false;
      this._videoState = 'ended';
    } else if (name === 'error') {
      this._interrupt('native-media-error', ['video']);
      this._videoState = 'error';
      this._messages.video = 'De begeleiding kon niet worden geladen (mediacode ' + (guide.error?.code || 'onbekend') + '). Probeer opnieuw.';
    } else if (name === 'emptied') {
      this._videoDuration = 0;
      this._videoState = this._videoDesired ? 'loading' : 'ready';
    } else if (name === 'loadstart' && this._videoDesired) this._videoState = 'loading';
    if (name === 'volumechange') {
      this._videoMuted = Boolean(guide.muted);
      if (!this._guideGain) this._videoVolume = clamp(guide.volume, 0, 1);
      if (this._guideGain) this._guideGain.gain.value = this._videoMuted ? 0 : this._videoVolume;
    }
    this._emit();
  }

  _applyVideoSound({ volume = true, mute = true } = {}) {
    if (this._guideTransport) {
      if (this._stemBus) smoothGain(this._stemBus.gain, this._videoMuted ? 0 : this._videoVolume, this._context);
      return;
    }
    if (!this._guide) return;
    this._settingGuideSound = true;
    try {
      // GainNode controls guide volume independently on mobile. Native volume
      // remains an additional observable factor when its own controls are used.
      if (volume) this._guide.volume = this._guideGain ? 1 : this._videoVolume;
      if (mute) this._guide.muted = this._videoMuted;
      if (this._guideGain) this._guideGain.gain.value = this._videoMuted ? 0 : this._videoVolume;
    } finally { this._settingGuideSound = false; }
    this._readVideo();
  }

  _readVideo() {
    if (this._guideTransport) { this._videoPosition = this._guideTransport.now(); return; }
    if (!this._guide) return;
    const guide = this._guide;
    const duration = Number(guide.duration), position = Number(guide.currentTime);
    if (Number.isFinite(duration) && duration > 0) this._videoDuration = duration;
    // The element is the only guide clock; no wall-time extrapolation.
    if (Number.isFinite(position)) this._videoPosition = Math.max(0, position);
    this._guideSeeking = Boolean(guide.seeking);
    this._nativeGuideVolume = Number.isFinite(guide.volume) ? clamp(guide.volume, 0, 1) : 1;
    this._videoMuted = Boolean(guide.muted);
  }

  _tick() {
    if (this._destroyed) return;
    this._guideTransport?.update();
    if (this._traceEnabled && Date.now() - (this._lastTraceHeartbeat || 0) >= 10000) { this._lastTraceHeartbeat = Date.now(); this._trace('heartbeat', { resources: this.getDiagnostics() }); }
    this._syncSession(); this._readVideo();
    if (this.sessionEnabled && this.sessionElapsed >= SESSION_SECONDS && this._audioDesired) {
      this.pause('audio'); this._audioState = 'ended'; this._messages.session = 'Je klanksessie van 20 minuten is afgerond.';
    }
    this._emit();
  }

  getAudioLevel() {
    if (!this._source || this._audioState !== 'playing' || this._context.state !== 'running' || this.muted) return 0;
    this._analyser.getFloatTimeDomainData(this._samples);
    let sum = 0;
    for (const value of this._samples) sum += value * value;
    return Math.sqrt(sum / this._samples.length) * this._audioVolume;
  }

  getSnapshot() {
    this._syncSession(); this._readVideo();
    return {
      video: { position: this._videoPosition, duration: this._videoDuration, state: this._videoState, volume: this._guideGain ? this._videoVolume * this._nativeGuideVolume : this._videoVolume, muted: this._videoMuted, seeking: this._guideSeeking, message: this._messages.video },
      audio: { trackId: this._trackId, position: this._audioNow(), duration: this._durations.get(this._trackId) || 0, state: this._audioState, loop: this.loop, level: this.getAudioLevel(), volume: this._audioVolume, message: this._messages.audio },
      muted: this.muted,
      guideGains: { ...this._guideGains },
      guideMode: this._guideMode,
      guideMixerAvailable: Boolean(this._guideTransport),
      masterMode: this._masterMode || 'pending',
      session: { enabled: this.sessionEnabled, elapsed: this.sessionElapsed, remaining: Math.max(0, SESSION_SECONDS - this.sessionElapsed), complete: this.sessionElapsed >= SESSION_SECONDS },
      message: this._messages.audio || this._messages.video || this._messages.session
    };
  }

  getGuidePosition() { this._readVideo(); return this._videoPosition; }

  sampleMotion() { return { time: this._audioNow(), level: this.getAudioLevel(), playing: Boolean(this._source && this._context.state === 'running') }; }
  _emit() {
    if (this._destroyed) return;
    const state = `${this._videoState}:${this._audioState}:${this._context?.state}`;
    if (this._traceEnabled && state !== this._lastTraceState) { this._lastTraceState = state; this._trace('state', { audioState: this._audioState }); }
    this.dispatchEvent(new CustomEvent('change', { detail: this.getSnapshot() }));
  }

  destroy() {
    if (this._destroyed) return;
    this._trace('destroy');
    this.pause(); this._destroyed = true;
    this._guideTransport?.destroy();
    ++this._videoGeneration;
    clearInterval(this._timer);
    for (const { controller } of this._loads.values()) controller.abort();
    this._buffers.clear();
    this._audioBuffer = null;
    document.removeEventListener('visibilitychange', this._visibility);
    window.removeEventListener('pagehide', this._pageHide);
    for (const [name, listener] of this._guideEvents) this._guide?.removeEventListener(name, listener);
    this._guideEvents = [];
    this._guideSourceNode?.disconnect();
    this._guideGain?.disconnect();
    this._guideGate?.disconnect();
    this._masterNode?.disconnect(); this._masterCeiling?.disconnect(); this._masterInput?.disconnect();
    if (this._context) {
      this._context.removeEventListener('statechange', this._contextState);
      this._context.close().catch(() => {});
    }
  }
}
