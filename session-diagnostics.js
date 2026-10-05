// Bounded, tab-local evidence only. This module never controls playback,
// changes checkpoints or sends data over the network.
export const DIAGNOSTICS_KEY = 'breathe-diagnostics-v1';
export const DIAGNOSTICS_LIMIT = 24576;
const MAX_EVENTS = 32;
const copy = value => JSON.parse(JSON.stringify(value));
const label = value => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 96) : null;
const number = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const states = new Set(['uninitialized', 'ready', 'loading', 'buffering', 'playing', 'paused', 'ended', 'error', 'running', 'suspended', 'interrupted', 'closed']);
const events = new Set(['document-start', 'transport-state', 'interruption', 'visibilitychange', 'pagehide', 'pageshow', 'freeze', 'resume', 'error', 'unhandledrejection', 'service-worker-controllerchange']);
const reasons = new Set(['guide-underrun', 'guide-start-blocked', 'guide-load-error', 'fork-load-error', 'audio-context-interrupted', 'audio-context-suspended', 'audio-context-closed', 'pagehide', 'native-context-unavailable', 'native-play-error', 'native-starved', 'native-pause', 'native-media-error']);
const state = value => states.has(value) ? value : 'unknown';
const resourceFields = ['activeDecoders', 'queuedLoads', 'guideCacheSets', 'guideNodes', 'guideTails', 'guideLoads', 'forkCacheBuffers', 'retainedPCMBytes'];

function cleanSnapshot(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    positionMs: number(raw.positionMs), guideState: state(raw.guideState),
    audioState: state(raw.audioState), context: state(raw.context),
    hidden: typeof raw.hidden === 'boolean' ? raw.hidden : null,
    resources: Object.fromEntries(resourceFields.map(key => [key, number(raw.resources?.[key])]))
  };
}
function cleanEvent(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    at: number(raw.at), event: events.has(raw.event) ? raw.event : 'unknown-event', reason: reasons.has(raw.reason) ? raw.reason : null,
    positionMs: number(raw.positionMs), context: state(raw.context),
    hidden: typeof raw.hidden === 'boolean' ? raw.hidden : null,
    persisted: typeof raw.persisted === 'boolean' ? raw.persisted : null
  };
}
function cleanDocument(raw) {
  if (!raw || typeof raw !== 'object' || !label(raw.documentId) || !Array.isArray(raw.events)) return null;
  return {
    documentId: label(raw.documentId), release: label(raw.release), timelineHash: label(raw.timelineHash),
    startedAt: number(raw.startedAt), updatedAt: number(raw.updatedAt),
    navigationType: ['navigate', 'reload', 'back_forward', 'prerender'].includes(raw.navigationType) ? raw.navigationType : 'unknown',
    wasDiscarded: typeof raw.wasDiscarded === 'boolean' ? raw.wasDiscarded : null,
    snapshot: cleanSnapshot(raw.snapshot), events: raw.events.slice(-MAX_EVENTS).map(cleanEvent)
  };
}

export function createSessionDiagnostics({ media, release, timelineHash, storage, windowObject = globalThis.window,
  documentObject = globalThis.document, performanceObject = globalThis.performance, now = Date.now,
  idFactory = () => globalThis.crypto?.randomUUID?.() || `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` } = {}) {
  const listeners = [];
  let storageAvailable = Boolean(storage), previous = null, lastSignature = '', lastPersist = 0;
  try {
    const raw = storage?.getItem(DIAGNOSTICS_KEY);
    if (raw && raw.length <= DIAGNOSTICS_LIMIT) {
      const stored = JSON.parse(raw);
      if (stored.schema === 1) previous = cleanDocument(stored.current);
    }
  } catch { storageAvailable = false; }
  let navigation;
  try { navigation = performanceObject?.getEntriesByType?.('navigation')?.[0]; } catch {}
  const current = cleanDocument({ documentId: idFactory(), release, timelineHash, startedAt: now(), updatedAt: now(),
    navigationType: navigation?.type, wasDiscarded: documentObject?.wasDiscarded, events: [] });
  const snapshot = () => {
    let info = {}, audio = {};
    try { info = media?.getDiagnostics?.() || {}; audio = media?.getSnapshot?.().audio || {}; } catch {}
    current.updatedAt = now();
    current.snapshot = cleanSnapshot({ positionMs: (info.guidePosition || 0) * 1000, guideState: info.guideState,
      audioState: audio.state, context: info.contextState, hidden: Boolean(documentObject?.hidden), resources: info });
    return current.snapshot;
  };
  const report = () => ({ schema: 1, storageAvailable, previous, current });
  const persist = () => {
    if (!storage) return false;
    try {
      let serialized = JSON.stringify(report());
      // A hard bound also applies to data read from an earlier document.
      while (serialized.length > DIAGNOSTICS_LIMIT && (previous?.events.length || current.events.length)) {
        if (previous?.events.length) previous.events.shift(); else current.events.shift();
        serialized = JSON.stringify(report());
      }
      if (serialized.length > DIAGNOSTICS_LIMIT) return false;
      storage.setItem(DIAGNOSTICS_KEY, serialized); lastPersist = now(); storageAvailable = true;
      return true;
    } catch { storageAvailable = false; return false; }
  };
  const record = (event, details = {}) => {
    const observed = snapshot();
    current.events.push(cleanEvent({ at: now(), event, reason: details.reason, positionMs: observed.positionMs,
      context: observed.context, hidden: observed.hidden, persisted: details.persisted }));
    if (current.events.length > MAX_EVENTS) current.events.shift();
    persist();
  };
  const capture = () => { snapshot(); if (now() - lastPersist >= 5000) persist(); };
  const listen = (target, name, listener) => {
    if (!target?.addEventListener) return;
    // Evidence failures must never interrupt an exercise.
    const safe = event => { try { listener(event); } catch {} };
    target.addEventListener(name, safe); listeners.push([target, name, safe]);
  };
  listen(media, 'change', () => {
    const observed = snapshot();
    const signature = `${observed.guideState}:${observed.audioState}:${observed.context}`;
    if (signature !== lastSignature) { lastSignature = signature; record('transport-state'); }
  });
  listen(media, 'interruption', event => record('interruption', { reason: event.detail?.reason }));
  listen(documentObject, 'visibilitychange', () => record('visibilitychange'));
  for (const event of ['pagehide', 'pageshow']) listen(windowObject, event, value => record(event, { persisted: Boolean(value.persisted) }));
  for (const event of ['freeze', 'resume']) listen(documentObject, event, () => record(event));
  // Deliberately omit messages, stacks, URLs, filenames, user data and media.
  for (const event of ['error', 'unhandledrejection']) listen(windowObject, event, () => record(event));
  listen(windowObject?.navigator?.serviceWorker, 'controllerchange', () => record('service-worker-controllerchange'));
  record('document-start');
  return {
    documentId: current.documentId, record, capture,
    export: () => { snapshot(); return copy(report()); },
    destroy: () => { for (const [target, name, listener] of listeners) target.removeEventListener(name, listener); }
  };
}
