/* =========================================================================
   CLOCKADASHI — music player + offline media cache sync
   ========================================================================= */
const MEDIA_CACHE_NAME = 'clockadashi-media-v1';
const LS_TRACKS_KEY = 'clockadashi_tracks_json';

const pel = {
  art: document.getElementById('trackArt'),
  artPlaceholder: document.getElementById('trackArtPlaceholder'),
  title: document.getElementById('trackTitle'),
  author: document.getElementById('trackAuthor'),
  seek: document.getElementById('seek'),
  playBtn: document.getElementById('playBtn'),
  iconPlay: document.getElementById('iconPlay'),
  iconPause: document.getElementById('iconPause'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  audio: document.getElementById('audioEl'),
  downloadStatus: document.getElementById('downloadStatus'),
};

let tracks = [];
let currentIndex = 0;
let isSeeking = false;

function sortTracks(list) {
  return [...list].sort((a, b) => (a.sort_id ?? 0) - (b.sort_id ?? 0));
}

function loadTrack(index, autoplay) {
  if (!tracks.length) return;
  currentIndex = (index + tracks.length) % tracks.length;
  const t = tracks[currentIndex];

  pel.title.textContent = t.title || '';
  pel.author.textContent = t.author || '';

  if (t.image) {
    pel.art.src = t.image;
    pel.art.hidden = false;
    pel.artPlaceholder.hidden = true;
  } else {
    pel.art.hidden = true;
    pel.artPlaceholder.hidden = false;
  }

  pel.audio.src = t.path;
  pel.seek.value = 0;

  if (autoplay) {
    pel.audio.play().catch(() => {});
  }
}

function updatePlayIcon() {
  const playing = !pel.audio.paused && !pel.audio.ended;
  pel.iconPlay.hidden = playing;
  pel.iconPause.hidden = !playing;
}

pel.playBtn.addEventListener('click', () => {
  if (!tracks.length) return;
  if (pel.audio.paused) {
    pel.audio.play().catch(() => {});
  } else {
    pel.audio.pause();
  }
});

pel.prevBtn.addEventListener('click', () => loadTrack(currentIndex - 1, true));
pel.nextBtn.addEventListener('click', () => loadTrack(currentIndex + 1, true));

pel.audio.addEventListener('play', updatePlayIcon);
pel.audio.addEventListener('pause', updatePlayIcon);
pel.audio.addEventListener('ended', () => loadTrack(currentIndex + 1, true));

pel.audio.addEventListener('timeupdate', () => {
  if (isSeeking || !pel.audio.duration) return;
  pel.seek.value = String(Math.round((pel.audio.currentTime / pel.audio.duration) * 1000));
});

pel.seek.addEventListener('input', () => { isSeeking = true; });
pel.seek.addEventListener('change', () => {
  if (pel.audio.duration) {
    pel.audio.currentTime = (Number(pel.seek.value) / 1000) * pel.audio.duration;
  }
  isSeeking = false;
});

/* =========================================================================
   Offline media cache sync
   Downloads missing tracks/images one at a time (low RAM/CPU footprint),
   removes cached files that are no longer listed in tracks.json.
   ========================================================================= */
function setDownloadStatus(text) {
  if (!text) {
    pel.downloadStatus.hidden = true;
    return;
  }
  pel.downloadStatus.hidden = false;
  pel.downloadStatus.textContent = text;
}

async function syncMediaCache(list) {
  if (!('caches' in window)) return;

  const cache = await caches.open(MEDIA_CACHE_NAME);
  const wanted = new Set();
  list.forEach(t => {
    if (t.path) wanted.add(new URL(t.path, location.href).toString());
    if (t.image) wanted.add(new URL(t.image, location.href).toString());
  });

  // remove stale entries no longer referenced by the latest tracks.json
  const existing = await cache.keys();
  for (const req of existing) {
    if (!wanted.has(req.url)) {
      await cache.delete(req);
    }
  }

  // download missing files sequentially to keep memory/network usage low
  const toDownload = [];
  for (const url of wanted) {
    const match = await cache.match(url);
    if (!match) toDownload.push(url);
  }

  let done = 0;
  const totalMissing = toDownload.length;
  for (const url of toDownload) {
    try {
      setDownloadStatus(`Downloading offline music ${done + 1}/${totalMissing}…`);
      const resp = await fetch(url);
      if (resp.ok) await cache.put(url, resp.clone());
    } catch (e) {
      console.warn('[clockadashi] media download failed, will retry on next refresh:', url, e);
    }
    done++;
  }
  setDownloadStatus(null);
}

/* =========================================================================
   Public API used by app.js
   ========================================================================= */
window.ClockadashiPlayer = {
  setTracks(list) {
    const wasEmpty = tracks.length === 0;
    tracks = sortTracks(list);
    if (wasEmpty && tracks.length) loadTrack(0, false);
    syncMediaCache(tracks);
  },
};

/* =========================================================================
   Init from cache immediately (so playback/UI is ready before any network
   round-trip completes)
   ========================================================================= */
(function initFromCache() {
  const raw = localStorage.getItem(LS_TRACKS_KEY);
  if (raw) {
    try {
      const list = JSON.parse(raw);
      tracks = sortTracks(list);
      if (tracks.length) loadTrack(0, false);
      syncMediaCache(tracks);
    } catch (e) {
      console.warn('[clockadashi] failed to parse cached tracks.json', e);
    }
  } else {
    pel.title.textContent = 'No music cached yet';
    pel.author.textContent = '';
  }
})();
