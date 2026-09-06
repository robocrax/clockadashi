/* =========================================================================
   CLOCKADASHI — configurable constants (adjust freely)
   ========================================================================= */
const PROGRESS_BAR_DAYS_BEFORE = 8;        // days before a "ProgressBar" event to start showing the progress strip
const TIME_FORMAT_24H = false;             // true = 24h clock, false = 12h with AM/PM
const DATA_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // how often to re-fetch events.csv / tracks.json
const DATA_CHECK_INTERVAL_MS = 5 * 60 * 1000;         // how often we check whether a refresh is due (no network call unless due)
const IDLE_FULLSCREEN_MS = 2 * 60 * 1000;             // re-enter fullscreen after this much idle time
const EVENTS_CSV_URL = 'events.csv';
const TRACKS_JSON_URL = 'tracks.json';

const LS_EVENTS = 'clockadashi_events_csv';
const LS_TRACKS = 'clockadashi_tracks_json';
const LS_LAST_FETCH = 'clockadashi_last_fetch_at';

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* =========================================================================
   DOM refs
   ========================================================================= */
const el = {
  clockMain: document.getElementById('clockMain'),
  clockSeconds: document.getElementById('clockSeconds'),
  clockAmPm: document.getElementById('clockAmPm'),
  dateRow: document.getElementById('dateRow'),
  eventList: document.getElementById('eventList'),
  loadingIndicator: document.getElementById('loadingIndicator'),
  progressWrap: document.getElementById('progressWrap'),
  progressLabel: document.getElementById('progressLabel'),
  progressFill: document.getElementById('progressFill'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
};

let eventsByDate = {};      // { 'YYYY-MM-DD': [{ name, type }, ...] } — a day can have more than one event
let progressEvents = [];    // [{ dateKey, date, name }]
let lastRenderedMinute = null;

/* =========================================================================
   Clock
   ========================================================================= */
function pad2(n) { return String(n).padStart(2, '0'); }

function renderClock() {
  const now = new Date();
  let hours = now.getHours();
  let ampm = '';
  if (!TIME_FORMAT_24H) {
    ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
  }
  el.clockMain.textContent = `${TIME_FORMAT_24H ? pad2(hours) : hours}:${pad2(now.getMinutes())}`;
  el.clockSeconds.textContent = `:${pad2(now.getSeconds())}`;
  el.clockAmPm.textContent = ampm;

  const minuteKey = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate() + '-' + now.getMinutes();
  if (minuteKey !== lastRenderedMinute) {
    lastRenderedMinute = minuteKey;
    renderDate(now);
    renderTodayEvent(now);
    renderProgressBar(now);
  }
}

function renderDate(now) {
  el.dateRow.textContent = `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}

/* =========================================================================
   Events (CSV) parsing
   ========================================================================= */
function dateKeyFromParts(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function localMidnight(y, m, d) {
  return new Date(y, m - 1, d);
}

function parseEventsCsv(csvText) {
  const byDate = {};
  const progress = [];

  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // skip header if present
  let start = 0;
  if (/^date\s*,\s*event/i.test(lines[0])) start = 1;

  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim());
    const [dateStr, name, type] = parts;
    if (!dateStr || !name) continue;
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const key = dateKeyFromParts(y, mo, d);

    if (!byDate[key]) byDate[key] = [];
    byDate[key].push({ name, type: type || '' });

    if (type && type.toLowerCase() === 'progressbar') {
      progress.push({ dateKey: key, date: localMidnight(y, mo, d), name });
    }
  }
  return { byDate, progress };
}

function renderTodayEvent(now) {
  const key = dateKeyFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const events = eventsByDate[key] || [];

  el.eventList.innerHTML = '';
  el.eventList.classList.toggle('compact', events.length > 1);

  events.forEach(ev => {
    const line = document.createElement('div');
    line.className = 'eventLine';
    line.textContent = ev.name;
    el.eventList.appendChild(line);
  });
}

function renderProgressBar(now) {
  if (!progressEvents.length) {
    el.progressWrap.hidden = true;
    return;
  }
  const today = localMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate());
  let best = null;
  for (const pe of progressEvents) {
    const diffDays = Math.round((pe.date - today) / 86400000);
    if (diffDays >= 0 && diffDays <= PROGRESS_BAR_DAYS_BEFORE) {
      if (!best || diffDays < best.diffDays) best = { ...pe, diffDays };
    }
  }
  if (!best) {
    el.progressWrap.hidden = true;
    return;
  }
  const percent = ((PROGRESS_BAR_DAYS_BEFORE - best.diffDays) / PROGRESS_BAR_DAYS_BEFORE) * 100;
  const dayLabel = best.diffDays === 0 ? 'Today' : `${best.diffDays} day${best.diffDays === 1 ? '' : 's'} away`;
  el.progressLabel.textContent = `${best.name} — ${dayLabel}`;
  el.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  el.progressWrap.hidden = false;
}

/* =========================================================================
   Loading indicator
   ========================================================================= */
function showLoading(withText) {
  el.loadingIndicator.hidden = false;
  if (withText) {
    el.eventList.innerHTML = '';
    el.eventList.classList.remove('compact');
    const line = document.createElement('div');
    line.className = 'eventLine';
    line.textContent = withText;
    el.eventList.appendChild(line);
  }
}
function hideLoading() {
  el.loadingIndicator.hidden = true;
}

/* =========================================================================
   Data refresh cycle (events.csv + tracks.json)
   24h interval, cache-fallback on failure, immediate retry when back online
   ========================================================================= */
function applyEventsFromCache() {
  const csv = localStorage.getItem(LS_EVENTS);
  if (csv) {
    const parsed = parseEventsCsv(csv);
    eventsByDate = parsed.byDate;
    progressEvents = parsed.progress;
  }
}

async function checkAndRefreshData() {
  const lastFetch = Number(localStorage.getItem(LS_LAST_FETCH) || 0);
  const due = (Date.now() - lastFetch) >= DATA_REFRESH_INTERVAL_MS;
  const hasCache = !!(localStorage.getItem(LS_EVENTS) && localStorage.getItem(LS_TRACKS));

  if (!hasCache) showLoading('Loading Ekadashi calendar…');

  if (!due && hasCache) return; // nothing to do yet

  if (!navigator.onLine) {
    if (!hasCache) showLoading('Offline — waiting for connection…');
    return;
  }

  try {
    const [csvText, tracksText] = await Promise.all([
      fetch(EVENTS_CSV_URL, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('events fetch failed'); return r.text(); }),
      fetch(TRACKS_JSON_URL, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('tracks fetch failed'); return r.text(); }),
    ]);

    // validate tracks JSON before committing
    const tracks = JSON.parse(tracksText);

    localStorage.setItem(LS_EVENTS, csvText);
    localStorage.setItem(LS_TRACKS, tracksText);
    localStorage.setItem(LS_LAST_FETCH, String(Date.now()));

    const parsed = parseEventsCsv(csvText);
    eventsByDate = parsed.byDate;
    progressEvents = parsed.progress;

    if (window.ClockadashiPlayer) window.ClockadashiPlayer.setTracks(tracks);
  } catch (e) {
    console.warn('[clockadashi] data refresh failed, keeping previous cached version:', e);
    if (!hasCache) showLoading('Unable to load calendar (offline)');
  } finally {
    hideLoading();
    lastRenderedMinute = null; // force re-render of date/event/progress on next tick
  }
}

/* =========================================================================
   Fullscreen handling
   - tap anywhere enters fullscreen
   - the corner icon toggles enter/exit explicitly
   - after IDLE_FULLSCREEN_MS of inactivity, best-effort re-enter fullscreen
     (note: browsers require a user gesture for this API, so this is a
     best-effort call — it will silently no-op on browsers that enforce
     that restriction strictly)
   ========================================================================= */
let lastInteraction = Date.now();
['pointerdown', 'keydown'].forEach(evt => {
  document.addEventListener(evt, () => { lastInteraction = Date.now(); }, { passive: true });
});

function updateFullscreenIcon() {
  const isFs = !!document.fullscreenElement;
  el.fullscreenBtn.querySelector('.icon-expand').classList.toggle('is-hidden', isFs);
  el.fullscreenBtn.querySelector('.icon-compress').classList.toggle('is-hidden', !isFs);
}

document.addEventListener('fullscreenchange', updateFullscreenIcon);

document.addEventListener('click', (e) => {
  if (e.target.closest('#fullscreenBtn')) return;
  if (e.target.closest('#player')) return; // don't fight with player control taps
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
});

el.fullscreenBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
});

setInterval(() => {
  if (!document.fullscreenElement && (Date.now() - lastInteraction) >= IDLE_FULLSCREEN_MS) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}, 30000);

/* =========================================================================
   Init
   ========================================================================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('[clockadashi] SW registration failed', err));
  });
}

applyEventsFromCache();
setInterval(renderClock, 1000);
renderClock();

checkAndRefreshData();
setInterval(checkAndRefreshData, DATA_CHECK_INTERVAL_MS);
window.addEventListener('online', checkAndRefreshData);
