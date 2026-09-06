/* =========================================================================
   CLOCKADASHI — music player + offline media cache sync
   Floating card (art + title + single play/pause button). Tapping the card
   body reveals the full track list so the person can choose where to
   start; tapping a track plays it from the beginning and collapses the
   list back down. No seek bar — tracks always start fresh.
   ========================================================================= */
const MEDIA_CACHE_NAME = 'clockadashi-media-v1';
const LS_TRACKS_KEY = 'clockadashi_tracks_json';

const pel = {
  player: document.getElementById('player'),
  card: document.getElementById('playerCard'),
  art: document.getElementById('trackArt'),
  artPlaceholder: document.getElementById('trackArtPlaceholder'),
  title: document.getElementById('trackTitle'),
  author: document.getElementById('trackAuthor'),
  playBtn: document.getElementById('playBtn'),
  audio: document.getElementById('audioEl'),
  downloadStatus: document.getElementById('downloadStatus'),
  listPanel: document.getElementById('trackListPanel'),
  list: document.getElementById('trackList'),
};

let tracks = [];
let currentIndex = 0;
let isExpanded = false;

function sortTracks(list) {
  return [...list].sort((a, b) => (a.sort_id ?? 0) - (b.sort_id ?? 0));
}

/* ---------- expand / collapse the track list ---------- */
function setExpanded(value) {
  isExpanded = value;
  pel.player.classList.toggle('expanded', isExpanded);
  pel.card.setAttribute('aria-expanded', String(isExpanded));
}

pel.card.addEventListener('click', () => setExpanded(!isExpanded));
pel.card.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!isExpanded); }
});

document.addEventListener('click', (e) => {
  if (isExpanded && !e.target.closest('#player')) setExpanded(false);
});

/* ---------- track list rendering ---------- */
function renderTrackList() {
  pel.list.innerHTML = '';
  tracks.forEach((t, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'trackRow' + (i === currentIndex ? ' playing' : '');
    row.dataset.index = String(i);

    let artHtml;
    if (t.image) {
      artHtml = `<img class="rowArt" src="${t.image}" alt="">`;
    } else {
      artHtml = `<div class="rowArtPlaceholder">&#9835;</div>`;
    }

    row.innerHTML = `
      ${artHtml}
      <div class="rowText">
        <div class="rowTitle">${t.title || ''}</div>
        <div class="rowAuthor">${t.author || ''}</div>
      </div>
    `;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      loadTrack(i, true);
      setExpanded(false);
    });
    pel.list.appendChild(row);
  });
}

function highlightPlayingRow() {
  pel.list.querySelectorAll('.trackRow').forEach(row => {
    row.classList.toggle('playing', Number(row.dataset.index) === currentIndex);
  });
}

/* ---------- playback ---------- */
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
  highlightPlayingRow();

  if (autoplay) {
    pel.audio.play().catch(() => {});
  }
}

function updatePlayIcon() {
  const playing = !pel.audio.paused && !pel.audio.ended;
  pel.playBtn.querySelector('.icon-play').classList.toggle('is-hidden', playing);
  pel.playBtn.querySelector('.icon-pause').classList.toggle('is-hidden', !playing);
}

pel.playBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!tracks.length) return;
  if (pel.audio.paused) {
    pel.audio.play().catch(() => {});
  } else {
    pel.audio.pause();
  }
});

pel.audio.addEventListener('play', updatePlayIcon);
pel.audio.addEventListener('pause', updatePlayIcon);
pel.audio.addEventListener('ended', () => loadTrack(currentIndex + 1, true));

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
    renderTrackList();
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
      renderTrackList();
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
