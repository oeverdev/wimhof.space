/* BREATHE: one complete, same-origin release; never interrupt an active session. */
const RELEASE = 'v5.0.2-native-balanced-300';
const CACHE_PREFIX = `breathe-flow:${self.registration.scope}:`;
const CACHE_NAME = `${CACHE_PREFIX}${RELEASE}`;
// BEGIN PRECACHE
const PRECACHE = [
  "./app.js",
  "./assets/app-icon-180.png",
  "./assets/app-icon-192.png",
  "./assets/app-icon-512.png",
  "./assets/app-icon.svg",
  "./assets/audio-loop.json",
  "./assets/energy-loop.wav",
  "./assets/floris-guide.m4a",
  "./assets/focus-loop.wav",
  "./assets/fork-energy.webp",
  "./assets/fork-focus.webp",
  "./assets/fork-loop.wav",
  "./assets/fork-meditate.webp",
  "./assets/fork-original.jpg",
  "./assets/fork-sleep.webp",
  "./assets/fork-source.opus.webm",
  "./assets/guide/breaths-000.m4a",
  "./assets/guide/breaths-001.m4a",
  "./assets/guide/breaths-002.m4a",
  "./assets/guide/breaths-003.m4a",
  "./assets/guide/breaths-004.m4a",
  "./assets/guide/breaths-005.m4a",
  "./assets/guide/breaths-006.m4a",
  "./assets/guide/breaths-007.m4a",
  "./assets/guide/breaths-008.m4a",
  "./assets/guide/breaths-009.m4a",
  "./assets/guide/breaths-010.m4a",
  "./assets/guide/breaths-011.m4a",
  "./assets/guide/breaths-012.m4a",
  "./assets/guide/breaths-013.m4a",
  "./assets/guide/breaths-014.m4a",
  "./assets/guide/breaths-015.m4a",
  "./assets/guide/breaths-016.m4a",
  "./assets/guide/breaths-017.m4a",
  "./assets/guide/breaths-018.m4a",
  "./assets/guide/breaths-019.m4a",
  "./assets/guide/breaths-020.m4a",
  "./assets/guide/breaths-021.m4a",
  "./assets/guide/breaths-022.m4a",
  "./assets/guide/breaths-023.m4a",
  "./assets/guide/breaths-024.m4a",
  "./assets/guide/breaths-025.m4a",
  "./assets/guide/breaths-026.m4a",
  "./assets/guide/breaths-027.m4a",
  "./assets/guide/breaths-028.m4a",
  "./assets/guide/breaths-029.m4a",
  "./assets/guide/breaths-030.m4a",
  "./assets/guide/breaths-031.m4a",
  "./assets/guide/breaths-032.m4a",
  "./assets/guide/breaths-033.m4a",
  "./assets/guide/breaths-034.m4a",
  "./assets/guide/breaths-035.m4a",
  "./assets/guide/breaths-036.m4a",
  "./assets/guide/breaths-037.m4a",
  "./assets/guide/breaths-038.m4a",
  "./assets/guide/breaths-039.m4a",
  "./assets/guide/breaths-040.m4a",
  "./assets/guide/breaths-041.m4a",
  "./assets/guide/breaths-042.m4a",
  "./assets/guide/breaths-043.m4a",
  "./assets/guide/breaths-044.m4a",
  "./assets/guide/breaths-045.m4a",
  "./assets/guide/music-000.m4a",
  "./assets/guide/music-001.m4a",
  "./assets/guide/music-002.m4a",
  "./assets/guide/music-003.m4a",
  "./assets/guide/music-004.m4a",
  "./assets/guide/music-005.m4a",
  "./assets/guide/music-006.m4a",
  "./assets/guide/music-007.m4a",
  "./assets/guide/music-008.m4a",
  "./assets/guide/music-009.m4a",
  "./assets/guide/music-010.m4a",
  "./assets/guide/music-011.m4a",
  "./assets/guide/music-012.m4a",
  "./assets/guide/music-013.m4a",
  "./assets/guide/music-014.m4a",
  "./assets/guide/music-015.m4a",
  "./assets/guide/music-016.m4a",
  "./assets/guide/music-017.m4a",
  "./assets/guide/music-018.m4a",
  "./assets/guide/music-019.m4a",
  "./assets/guide/music-020.m4a",
  "./assets/guide/music-021.m4a",
  "./assets/guide/music-022.m4a",
  "./assets/guide/music-023.m4a",
  "./assets/guide/music-024.m4a",
  "./assets/guide/music-025.m4a",
  "./assets/guide/music-026.m4a",
  "./assets/guide/music-027.m4a",
  "./assets/guide/music-028.m4a",
  "./assets/guide/music-029.m4a",
  "./assets/guide/music-030.m4a",
  "./assets/guide/music-031.m4a",
  "./assets/guide/music-032.m4a",
  "./assets/guide/music-033.m4a",
  "./assets/guide/music-034.m4a",
  "./assets/guide/music-035.m4a",
  "./assets/guide/music-036.m4a",
  "./assets/guide/music-037.m4a",
  "./assets/guide/music-038.m4a",
  "./assets/guide/music-039.m4a",
  "./assets/guide/music-040.m4a",
  "./assets/guide/music-041.m4a",
  "./assets/guide/music-042.m4a",
  "./assets/guide/music-043.m4a",
  "./assets/guide/music-044.m4a",
  "./assets/guide/music-045.m4a",
  "./assets/guide/voice-000.m4a",
  "./assets/guide/voice-001.m4a",
  "./assets/guide/voice-002.m4a",
  "./assets/guide/voice-003.m4a",
  "./assets/guide/voice-004.m4a",
  "./assets/guide/voice-005.m4a",
  "./assets/guide/voice-006.m4a",
  "./assets/guide/voice-007.m4a",
  "./assets/guide/voice-008.m4a",
  "./assets/guide/voice-009.m4a",
  "./assets/guide/voice-010.m4a",
  "./assets/guide/voice-011.m4a",
  "./assets/guide/voice-012.m4a",
  "./assets/guide/voice-013.m4a",
  "./assets/guide/voice-014.m4a",
  "./assets/guide/voice-015.m4a",
  "./assets/guide/voice-016.m4a",
  "./assets/guide/voice-017.m4a",
  "./assets/guide/voice-018.m4a",
  "./assets/guide/voice-019.m4a",
  "./assets/guide/voice-020.m4a",
  "./assets/guide/voice-021.m4a",
  "./assets/guide/voice-022.m4a",
  "./assets/guide/voice-023.m4a",
  "./assets/guide/voice-024.m4a",
  "./assets/guide/voice-025.m4a",
  "./assets/guide/voice-026.m4a",
  "./assets/guide/voice-027.m4a",
  "./assets/guide/voice-028.m4a",
  "./assets/guide/voice-029.m4a",
  "./assets/guide/voice-030.m4a",
  "./assets/guide/voice-031.m4a",
  "./assets/guide/voice-032.m4a",
  "./assets/guide/voice-033.m4a",
  "./assets/guide/voice-034.m4a",
  "./assets/guide/voice-035.m4a",
  "./assets/guide/voice-036.m4a",
  "./assets/guide/voice-037.m4a",
  "./assets/guide/voice-038.m4a",
  "./assets/guide/voice-039.m4a",
  "./assets/guide/voice-040.m4a",
  "./assets/guide/voice-041.m4a",
  "./assets/guide/voice-042.m4a",
  "./assets/guide/voice-043.m4a",
  "./assets/guide/voice-044.m4a",
  "./assets/guide/voice-045.m4a",
  "./assets/meditate-loop.wav",
  "./assets/profile.png",
  "./assets/sleep-loop.wav",
  "./assets/space-grotesk.woff2",
  "./guide-manifest.js",
  "./guide-scene.js",
  "./icons.js",
  "./index.html",
  "./manifest.webmanifest",
  "./media.js",
  "./motion.js",
  "./rounds.js",
  "./session-diagnostics.js",
  "./session-recovery.js",
  "./session-version.js",
  "./styles.css",
  "./tracks.js",
  "./version.json"
];
// END PRECACHE
const ALLOWED = new Set(PRECACHE.map(path => new URL(path, self.registration.scope).href));
const HOME = new URL('./index.html', self.registration.scope).href;
const ROOT = new URL('./', self.registration.scope).href;

self.addEventListener('install', event => {
  // Bound the audio release's concurrent downloads/cache bodies. Await every
  // batch: a failed download prevents activation and leaves the old cache intact.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (let offset = 0; offset < PRECACHE.length; offset += 2) {
      await cache.addAll(PRECACHE.slice(offset, offset + 2));
    }
  })());
  // Use the browser's normal waiting lifecycle: all old app windows must close.
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key))
  )));
});

async function withRange(response, range) {
  if (!range || response.status !== 200) return response;
  // Safari may request local audio in byte ranges. Serve the cached full asset
  // as a partial response without caching the partial response itself.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return response;
  // Blob slicing avoids a whole-media JavaScript ArrayBuffer for each tiny
  // range request. The browser controls whether its Blob backing is on disk.
  const blob = await response.blob();
  const size = blob.size;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = suffix || !match[2] ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end || end < 0) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const headers = new Headers(response.headers);
  // blob() contains decoded bytes, so inherited transport encodings
  // must not be applied again to the new partial response.
  headers.delete('Content-Encoding');
  headers.delete('Transfer-Encoding');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(blob.slice(start, end + 1, headers.get('Content-Type') || ''), { status: 206, headers });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  let key = url.href;
  if (request.mode === 'navigate' && (url.pathname === new URL(ROOT).pathname || url.pathname === new URL(HOME).pathname)) {
    key = HOME;
  }
  if (!ALLOWED.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(key);
    if (response) return withRange(response, request.headers.get('range'));
    return fetch(request);
  })());
});
