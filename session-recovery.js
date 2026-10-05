import { getGuideFrame } from './guide-scene.js';

/** Small metadata only. This module never loads media, runs a timer or starts audio. */
export const CHECKPOINT_SCHEMA = 1;
export const CHECKPOINT_KEY = 'breathe-session-v1';
export const SAVE_INTERVAL_MS = 5000;
export const WRITER_LEASE_MS = 15000;
export const RECOVERY_STATUS = Object.freeze({
  load: Object.freeze(['empty', 'valid', 'completed', 'invalid', 'mismatch', 'storage-error']),
  plan: Object.freeze(['none', 'resume-cycle', 'restart-round', 'restart-intro', 'resume-closing', 'restart-session', 'completed', 'storage-unavailable']),
  save: Object.freeze(['saved', 'throttled', 'unchanged', 'ignored-empty', 'ignored-unclaimed', 'not-writer', 'invalid', 'storage-error', 'completion-pending']),
  claim: Object.freeze(['claimed', 'explicit-required', 'not-writer', 'invalid', 'storage-error']),
  clear: Object.freeze(['cleared', 'ignored-unclaimed', 'not-writer', 'invalid', 'storage-error']),
  release: Object.freeze(['released', 'ignored-unclaimed', 'not-writer', 'storage-error']),
  error: Object.freeze(['invalid-context', 'corrupt-json', 'record-too-large', 'invalid-schema', 'invalid-fields', 'invalid-position', 'invalid-gains', 'invalid-time', 'phase-mismatch', 'release-mismatch', 'timeline-mismatch', 'duration-mismatch', 'storage-unavailable', 'storage-read', 'storage-write', 'storage-race', 'invalid-writer', 'explicit-required', 'invalid-reason', 'incomplete-session', 'invalid-id'])
});

const PHASES = new Set(['intro', 'breathe', 'settle', 'hold', 'recovery', 'rest', 'closing', 'complete']);
const REASONS = new Set(['interval', 'transition', 'seek', 'pause']);
const MAX_RECORD_LENGTH = 4096;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const validLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const validInt = value => Number.isSafeInteger(value) && value >= 0;
const validGains = value => isObject(value) && Object.keys(value).length === 3 && ['voice', 'breaths', 'music'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 2);
const failure = (status, code) => ({ status, checkpoint: null, error: { code } });
const copy = value => JSON.parse(JSON.stringify(value));

function validContext({ guide, release, timelineHash } = {}) {
  return validLabel(release) && validLabel(timelineHash) && isObject(guide)
    && validInt(guide.durationMs) && guide.durationMs > 0
    && validInt(guide.recoveryStartMs) && guide.recoveryStartMs < guide.durationMs
    && Array.isArray(guide.rounds) && guide.rounds.length > 0
    && Array.isArray(guide.breathingSegments) && Array.isArray(guide.cues);
}

/** Validate before mapping. A different release/timeline is never mapped by seconds. */
export function validateCheckpoint(raw, context = {}) {
  if (raw === null || raw === undefined) return { status: 'empty', checkpoint: null };
  if (!validContext(context)) return failure('invalid', 'invalid-context');
  let checkpoint;
  try {
    const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (typeof serialized !== 'string' || serialized.length > MAX_RECORD_LENGTH) return failure('invalid', 'record-too-large');
    checkpoint = JSON.parse(serialized);
  } catch { return failure('invalid', 'corrupt-json'); }
  if (!isObject(checkpoint) || checkpoint.schema !== CHECKPOINT_SCHEMA) return failure('invalid', 'invalid-schema');
  const fields = ['schema', 'sessionId', 'release', 'timelineHash', 'durationMs', 'positionMs', 'phase', 'round', 'intent', 'gains', 'savedAt'];
  if (Object.keys(checkpoint).length !== fields.length || !fields.every(field => Object.hasOwn(checkpoint, field))
    || !validId(checkpoint.sessionId) || !validLabel(checkpoint.release) || !validLabel(checkpoint.timelineHash)
    || !PHASES.has(checkpoint.phase) || !(checkpoint.round === null || (Number.isSafeInteger(checkpoint.round) && checkpoint.round >= 1 && checkpoint.round <= 5))
    || !['paused', 'playing'].includes(checkpoint.intent)) return failure('invalid', 'invalid-fields');
  if (!validInt(checkpoint.durationMs) || checkpoint.durationMs === 0 || !validInt(checkpoint.positionMs) || checkpoint.positionMs > checkpoint.durationMs) return failure('invalid', 'invalid-position');
  if (!validGains(checkpoint.gains)) return failure('invalid', 'invalid-gains');
  if (!validInt(checkpoint.savedAt) || (validInt(context.nowMs) && checkpoint.savedAt > context.nowMs + 300000)) return failure('invalid', 'invalid-time');
  for (const [field, code] of [['release', 'release-mismatch'], ['timelineHash', 'timeline-mismatch']]) {
    const compatibleRelease = field === 'release' && Array.isArray(context.compatibleReleases) && context.compatibleReleases.includes(checkpoint.release);
    if (checkpoint[field] !== context[field] && !compatibleRelease) return { status: 'mismatch', checkpoint, error: { code } };
  }
  if (checkpoint.durationMs !== context.guide.durationMs) return { status: 'mismatch', checkpoint, error: { code: 'duration-mismatch' } };
  let frame;
  try { frame = getGuideFrame(context.guide, checkpoint.positionMs / 1000); }
  catch { return failure('invalid', 'invalid-context'); }
  if (checkpoint.phase !== frame.phase || checkpoint.round !== frame.round) return failure('invalid', 'phase-mismatch');
  return { status: checkpoint.positionMs === checkpoint.durationMs ? 'completed' : 'valid', checkpoint };
}

function recoveryPlan(result, context) {
  const base = { kind: 'none', requiresGesture: true, autoplay: false, targetPositionMs: null, savedPositionMs: result.checkpoint?.positionMs ?? null, round: result.checkpoint?.round ?? null, message: 'Sessie onderbroken.' };
  if (result.status === 'empty') return { ...base, requiresGesture: false, message: '' };
  if (result.status === 'storage-error') return { ...base, kind: 'storage-unavailable', targetPositionMs: 0, message: 'Sessieherstel is niet beschikbaar omdat lokale opslag niet bereikbaar is. Je kunt bewust een nieuwe sessie starten.' };
  if (result.status === 'invalid' || result.status === 'mismatch') return { ...base, kind: 'restart-session', targetPositionMs: 0, message: result.status === 'mismatch' ? 'Sessie onderbroken. De opgeslagen sessie hoort bij een andere versie of tijdlijn. Start bewust een nieuwe sessie.' : 'Sessie onderbroken. Het opgeslagen hervatpunt kan niet betrouwbaar worden gelezen. Start bewust een nieuwe sessie.' };
  if (result.status === 'completed') return { ...base, kind: 'completed', targetPositionMs: 0, message: 'Deze sessie was afgerond. Je kunt bewust een nieuwe sessie starten.' };
  const checkpoint = result.checkpoint;
  if (checkpoint.phase === 'intro') return { ...base, kind: 'restart-intro', targetPositionMs: 0, message: 'Sessie onderbroken. Begin de introductie opnieuw wanneer je er klaar voor bent.' };
  if (checkpoint.phase === 'closing') return { ...base, kind: 'resume-closing', targetPositionMs: context.guide.recoveryStartMs, message: 'Sessie onderbroken. Adem rustig en normaal. Je kunt de afronding opnieuw starten.' };
  const round = context.guide.rounds.find(item => item.number === checkpoint.round);
  if (checkpoint.phase === 'breathe') {
    const segment = context.guide.breathingSegments.find(item => item.round === checkpoint.round);
    const cycle = segment?.cycles.find(item => checkpoint.positionMs >= item.startMs && checkpoint.positionMs < item.endMs);
    if (cycle) return { ...base, kind: 'resume-cycle', targetPositionMs: cycle.startMs, cycle: cycle.number, message: `Sessie onderbroken tijdens ronde ${checkpoint.round}. Hervat bewust bij het begin van ademteug ${cycle.number}.` };
  }
  if (round) return { ...base, kind: 'restart-round', targetPositionMs: round.startMs, message: `Sessie onderbroken. Adem eerst rustig en normaal. Begin ronde ${checkpoint.round} opnieuw wanneer je er klaar voor bent.` };
  return { ...base, kind: 'restart-session', targetPositionMs: 0, message: 'Sessie onderbroken. Start bewust een nieuwe sessie.' };
}

/** Returns an offered action only; the caller must obtain a new user gesture. */
export function planRecovery(raw, context = {}) {
  return recoveryPlan(validateCheckpoint(raw, context), context);
}

function defaultId() {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * One explicit owner. Only claim writes the owner pointer; saves write a token's
 * fenced slot. Thus even an interleaved late old-tab write cannot replace the new
 * owner's checkpoint. The lease records liveness, never grants automatic takeover.
 * No lifecycle listeners are installed: hidden tabs retain their current token.
 */
export function createSessionRecovery({ guide, release, timelineHash, compatibleReleases = [], storage, now = Date.now, idFactory = defaultId, key = CHECKPOINT_KEY } = {}) {
  const context = () => ({ guide, release, timelineHash, compatibleReleases, nowMs: now() });
  let token = null;
  let sessionId = null;
  let leaseUntil = 0;
  let lastWriteAt = null;
  let lastCheckpoint = null;
  let released = false;
  let lastError = null;
  const slotKey = ownerToken => `${key}:writer:${ownerToken}`;
  const getStorage = () => {
    const value = storage === undefined ? globalThis.localStorage : storage;
    if (!value || typeof value.getItem !== 'function' || typeof value.setItem !== 'function') throw new Error('storage-unavailable');
    return value;
  };
  function storageError(code) { lastError = { code }; return failure('storage-error', code); }
  function parsePointer(raw) {
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (isObject(value) && value.kind === 'writer-pointer') {
      if (value.schema !== CHECKPOINT_SCHEMA || !validId(value.token) || !validInt(value.claimedAt)) throw new Error('invalid-writer');
      return value;
    }
    return null;
  }
  function read() {
    let target;
    try { target = getStorage(); } catch { return storageError('storage-unavailable'); }
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw;
      try { raw = target.getItem(key); } catch { return storageError('storage-read'); }
      let pointer;
      try { pointer = parsePointer(raw); }
      catch { return { ...failure('invalid', 'invalid-writer'), rawCheckpoint: raw, rawPointer: raw, pointer: null }; }
      // Accept a direct schema-1 record for non-destructive migration and testing.
      if (!pointer) return { ...validateCheckpoint(raw, context()), rawCheckpoint: raw, rawPointer: raw, pointer: null };
      try {
        const rawSlot = target.getItem(slotKey(pointer.token));
        if (target.getItem(key) !== raw) continue;
        const slot = JSON.parse(rawSlot);
        if (!isObject(slot) || slot.schema !== CHECKPOINT_SCHEMA || slot.token !== pointer.token || !validId(slot.sessionId) || !validInt(slot.leaseUntil) || !(slot.checkpoint === null || typeof slot.checkpoint === 'string')) {
          return { ...failure('invalid', 'invalid-writer'), rawCheckpoint: rawSlot, rawPointer: raw, pointer };
        }
        return { ...validateCheckpoint(slot.checkpoint, context()), rawCheckpoint: slot.checkpoint, rawPointer: raw, pointer, slot };
      } catch (error) {
        if (error instanceof SyntaxError) return { ...failure('invalid', 'invalid-writer'), rawCheckpoint: raw, rawPointer: raw, pointer };
        return storageError('storage-read');
      }
    }
    return storageError('storage-race');
  }
  function load() {
    const result = read();
    return { status: result.status, checkpoint: result.checkpoint, plan: recoveryPlan(result, context()), ...(result.error ? { error: result.error } : {}) };
  }
  function ownership() {
    if (!token || released) return { status: 'ignored-unclaimed' };
    try {
      const pointer = parsePointer(getStorage().getItem(key));
      if (!pointer || pointer.token !== token) return { status: 'not-writer' };
      return { status: 'writer', pointer };
    } catch (error) { return error instanceof SyntaxError || error.message === 'invalid-writer' ? { status: 'not-writer' } : storageError('storage-read'); }
  }
  function writeSlot(rawCheckpoint, nextLease) {
    const owner = ownership();
    if (owner.status !== 'writer') return owner;
    try { getStorage().setItem(slotKey(token), JSON.stringify({ schema: CHECKPOINT_SCHEMA, token, sessionId, leaseUntil: nextLease, checkpoint: rawCheckpoint })); }
    catch { return storageError('storage-write'); }
    const after = ownership();
    if (after.status !== 'writer') return after;
    leaseUntil = nextLease;
    lastError = null;
    return { status: 'written' };
  }
  function claim({ explicit = false, sessionId: requestedSessionId } = {}) {
    if (explicit !== true) return { status: 'explicit-required', error: { code: 'explicit-required' } };
    if (!validContext(context())) return failure('invalid', 'invalid-context');
    if (ownership().status === 'writer' && (requestedSessionId === undefined || requestedSessionId === sessionId)) {
      return { status: 'claimed', token, sessionId, leaseUntil };
    }
    const previous = read();
    if (previous.status === 'storage-error') return previous;
    let nextToken;
    let nextSessionId;
    let timestamp;
    try {
      nextToken = idFactory();
      nextSessionId = requestedSessionId ?? previous.checkpoint?.sessionId ?? idFactory();
      timestamp = now();
    } catch { return failure('invalid', 'invalid-id'); }
    if (!validId(nextToken) || !validId(nextSessionId) || nextToken === previous.pointer?.token || !validInt(timestamp)) return failure('invalid', 'invalid-id');
    const nextLease = timestamp + WRITER_LEASE_MS;
    try {
      const target = getStorage();
      // Prepare the entire copy before publishing ownership; a quota failure here
      // leaves the previous pointer and checkpoint intact.
      target.setItem(slotKey(nextToken), JSON.stringify({ schema: CHECKPOINT_SCHEMA, token: nextToken, sessionId: nextSessionId, leaseUntil: nextLease, checkpoint: previous.rawCheckpoint ?? null }));
      target.setItem(key, JSON.stringify({ schema: CHECKPOINT_SCHEMA, kind: 'writer-pointer', token: nextToken, claimedAt: timestamp }));
      token = nextToken;
      sessionId = nextSessionId;
      released = false;
      const owner = ownership();
      if (owner.status !== 'writer') return owner;
      leaseUntil = nextLease;
      lastWriteAt = previous.checkpoint?.savedAt ?? null;
      lastCheckpoint = previous.status === 'valid' ? previous.checkpoint : null;
      lastError = null;
      // Only the one known previous slot is eligible for cleanup. Late stale writes
      // are fenced away from the pointer and can at worst leave a small orphan.
      if (previous.pointer?.token !== nextToken && previous.pointer?.token && typeof target.removeItem === 'function') {
        try { target.removeItem(slotKey(previous.pointer.token)); } catch { /* Checkpoint is already safely copied. */ }
      }
      return { status: 'claimed', token, sessionId, leaseUntil };
    } catch { return storageError('storage-write'); }
  }
  function save({ positionMs, intent, gains } = {}, { reason = 'interval', meaningful = false } = {}) {
    if (!REASONS.has(reason)) return failure('invalid', 'invalid-reason');
    if (!meaningful || positionMs === 0) return { status: 'ignored-empty' };
    const owner = ownership();
    if (owner.status !== 'writer') return owner;
    if (!validInt(positionMs) || positionMs > guide.durationMs) return failure('invalid', 'invalid-position');
    if (positionMs === guide.durationMs) return { status: 'completion-pending' };
    let checkpoint;
    try {
      const frame = getGuideFrame(guide, positionMs / 1000);
      checkpoint = { schema: CHECKPOINT_SCHEMA, sessionId, release, timelineHash, durationMs: guide.durationMs, positionMs, phase: frame.phase, round: frame.round, intent, gains, savedAt: now() };
    } catch { return failure('invalid', 'invalid-context'); }
    const checked = validateCheckpoint(checkpoint, context());
    if (checked.status !== 'valid') return checked;
    const comparable = item => item && JSON.stringify([item.sessionId, item.positionMs, item.phase, item.round, item.intent, item.gains.voice, item.gains.breaths, item.gains.music]);
    if (comparable(lastCheckpoint) === comparable(checkpoint)) return { status: 'unchanged' };
    const stateChanged = !lastCheckpoint || checkpoint.phase !== lastCheckpoint.phase || checkpoint.round !== lastCheckpoint.round || checkpoint.intent !== lastCheckpoint.intent;
    const immediate = reason === 'seek' || reason === 'pause' || (reason === 'transition' && stateChanged);
    if (!immediate && lastWriteAt !== null && checkpoint.savedAt - lastWriteAt < SAVE_INTERVAL_MS) return { status: 'throttled' };
    const written = writeSlot(JSON.stringify(checkpoint), checkpoint.savedAt + WRITER_LEASE_MS);
    if (written.status !== 'written') return written;
    lastCheckpoint = copy(checkpoint);
    lastWriteAt = checkpoint.savedAt;
    return { status: 'saved', checkpoint: copy(checkpoint) };
  }
  function clear({ reason, positionMs } = {}) {
    if (!['reset', 'complete'].includes(reason)) return failure('invalid', 'invalid-reason');
    if (reason === 'complete' && (!validInt(positionMs) || positionMs < guide.durationMs)) return failure('invalid', 'incomplete-session');
    const written = writeSlot(null, now() + WRITER_LEASE_MS);
    if (written.status !== 'written') return written;
    lastCheckpoint = null;
    lastWriteAt = null;
    return { status: 'cleared', reason };
  }
  function releaseWriter() {
    const owner = ownership();
    if (owner.status !== 'writer') return owner;
    const current = read();
    if (current.status === 'storage-error') return current;
    const written = writeSlot(current.rawCheckpoint ?? null, 0);
    if (written.status !== 'written') return written;
    released = true;
    return { status: 'released' };
  }
  function getStatus() {
    const owner = ownership();
    return { writer: owner.status === 'writer', status: owner.status, token, sessionId, leaseUntil, leaseExpired: leaseUntil <= now(), lastWriteAt, error: lastError };
  }
  return Object.freeze({ load, claim, save, clear, releaseWriter, getStatus });
}
