/* =========================================================================
   Clockadashi service worker — keeps everything working with no Wi-Fi.
   - App files: served from the tablet first. They are re-checked in the
     background (on every start and whenever app.js asks); if any changed,
     the page is told and reloads itself once nobody is using it.
   - Songs and artwork: served from the offline library that player.js
     fills, including the partial (range) requests the audio player makes
     to seek. Anything not saved yet streams from the network.
   - events.csv / tracks.json: left alone; app.js keeps its own copies.
   Changing this file (e.g. VERSION) also triggers a clean reinstall.
   ========================================================================= */
'use strict';

var VERSION = '3.1.0';
var SHELL_CACHE = 'clockadashi-shell-' + VERSION;
var MEDIA_CACHE = 'clockadashi-media-v1';  // filled by player.js
var SHELL_FILES = ['index.html', 'style.css', 'app.js', 'player.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png'];

function abs(f) { return new URL(f, self.registration.scope).href; }
var SHELL_URLS = {};
SHELL_FILES.forEach(function (f) { SHELL_URLS[abs(f)] = true; });

self.addEventListener('install', function (event) {
  // All or nothing: a half-downloaded update never replaces a working version.
  event.waitUntil(Promise.all(SHELL_FILES.map(function (f) {
    return fetch(new Request(abs(f), { cache: 'reload' })).then(function (r) {
      if (!r.ok) throw new Error(f + ' HTTP ' + r.status);
      return r;
    });
  })).then(function (responses) {
    return caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL_FILES.map(function (f, i) { return cache.put(abs(f), responses[i]); }));
    });
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) {
      // old app-file caches only; song caches are kept (player.js tidies those)
      return n.indexOf('clockadashi-shell-') === 0 && n !== SHELL_CACHE;
    }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/[?&]probe=/.test(url.search)) return;  // connection checks must really hit the network

  if (req.mode === 'navigate') {
    event.respondWith(fromShell(abs('index.html'), req));
    event.waitUntil(refreshShell().then(tellPages, function () {}));
    return;
  }
  var bare = url.origin + url.pathname;
  if (SHELL_URLS[bare]) { event.respondWith(fromShell(bare, req)); return; }
  if (url.pathname.indexOf('/music/') >= 0) event.respondWith(fromMedia(bare, req));
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'refresh-shell') {
    event.waitUntil(refreshShell().then(tellPages, function () {}));
  }
});

function fromShell(key, req) {
  return caches.open(SHELL_CACHE).then(function (cache) { return cache.match(key); }).then(function (hit) {
    if (!hit) return fetch(req);
    // GitHub Pages marks files fresh for 10 minutes; Chrome would then reuse an old
    // app.js from memory after an update-reload. no-cache makes it ask us every time.
    var headers = new Headers(hit.headers);
    headers.set('Cache-Control', 'no-cache');
    headers.delete('Expires');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: headers });
  });
}

/* ---- App files: re-check in the background --------------------------------- */
var refreshing = null;
function refreshShell() {
  if (refreshing) return refreshing;
  refreshing = Promise.all(SHELL_FILES.map(function (f) {
    return fetch(abs(f), { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(f + ' HTTP ' + r.status);
      return r;
    });
  })).then(function (fresh) {
    return caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL_FILES.map(function (f, i) {
        return cache.match(abs(f)).then(function (old) {
          return Promise.all([fresh[i].clone().arrayBuffer(), old ? old.arrayBuffer() : null]);
        }).then(function (bufs) { return !sameBytes(bufs[0], bufs[1]); });
      })).then(function (changed) {
        if (changed.indexOf(true) < 0) return false;
        return Promise.all(SHELL_FILES.map(function (f, i) { return cache.put(abs(f), fresh[i]); }))
          .then(function () { return true; });
      });
    });
  });
  refreshing.then(done, done);
  function done() { refreshing = null; }
  return refreshing;
}

function sameBytes(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  var x = new Uint8Array(a), y = new Uint8Array(b);
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function tellPages(changed) {
  if (!changed) return;
  return self.clients.matchAll({ type: 'window' }).then(function (pages) {
    pages.forEach(function (p) { p.postMessage({ type: 'shell-updated' }); });
  });
}

/* ---- Songs and artwork -------------------------------------------------------- */
function fromMedia(key, req) {
  return caches.open(MEDIA_CACHE).then(function (cache) { return cache.match(key); }).then(function (hit) {
    if (!hit) return fetch(req);
    var range = req.headers.get('Range');
    return range ? slice(hit, range) : hit;
  }).catch(function () {
    return new Response('', { status: 503, statusText: 'Offline and not saved yet' });
  });
}

// Answer "Range: bytes=a-b" from a saved file, as a web server would.
function slice(res, header) {
  return res.blob().then(function (blob) {
    var size = blob.size;
    var m = /^bytes=(\d*)-(\d*)$/.exec(header.replace(/\s+/g, ''));
    if (!m || (m[1] === '' && m[2] === '')) {
      return new Response(blob, { status: 200, headers: headersFor(res, size) });
    }
    var start, end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }  // last N bytes
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start >= size || end < start) {
      return new Response('', { status: 416, statusText: 'Range Not Satisfiable',
        headers: { 'Content-Range': 'bytes */' + size } });
    }
    var part = blob.slice(start, end + 1);
    var h = headersFor(res, part.size);
    h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    return new Response(part, { status: 206, statusText: 'Partial Content', headers: h });
  });
}

function headersFor(res, length) {
  return {
    'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes'
  };
}
