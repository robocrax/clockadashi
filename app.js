/* =========================================================================
   CLOCKADASHI — configurable constants (adjust freely)
   ========================================================================= */
const PROGRESS_BAR_DAYS_BEFORE = 8;        // days before a "ProgressBar" event to start showing its countdown bar
const TIME_FORMAT_24H = false;             // true = 24h clock, false = 12h with AM/PM
const DATA_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // how often to re-fetch events.csv / tracks.json
const DATA_CHECK_INTERVAL_MS = 5 * 60 * 1000;         // how often we check whether a refresh is due (no network call unless due)
const IDLE_FULLSCREEN_MS = 2 * 60 * 1000;             // re-enter fullscreen after this much idle time
const PLAYER_IDLE_HIDE_MS = 2 * 60 * 1000;            // hide the music card after this much inactivity
const CLOCK_FIT_MARGIN_PX = 20;                       // buffer the clock stops short of neighbouring elements by
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
  clockGroup: document.getElementById('clockGroup'),
  clockEl: document.getElementById('clock'),
  clockMain: document.getElementById('clockMain'),
  clockSeconds: document.getElementById('clockSeconds'),
  clockAmPm: document.getElementById('clockAmPm'),
  dateRow: document.getElementById('dateRow'),
  cornerLeft: document.getElementById('cornerLeft'),
  eventList: document.getElementById('eventList'),
  loadingIndicator: document.getElementById('loadingIndicator'),
  progressList: document.getElementById('progressList'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
  player: document.getElementById('player'),
  playerCard: document.getElementById('playerCard'),
};

let eventsByDate = {};      // { 'YYYY-MM-DD': [{ name, type }, ...] } — a day can have more than one event
let progressEvents = [];    // [{ dateKey, date, name }]
let lastRenderedMinute = null;
let lastCornerSignature = '';

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
    maybeRefitClock();
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
  el.progressList.innerHTML = '';
  if (!progressEvents.length) return;

  // Hourly (not day-level) granularity, so the bar creeps forward through
  // the day instead of only jumping once at midnight.
  const totalWindowHours = PROGRESS_BAR_DAYS_BEFORE * 24;
  const matches = [];

  for (const pe of progressEvents) {
    const diffHours = (pe.date - now) / 3600000;
    // window opens PROGRESS_BAR_DAYS_BEFORE days out, and closes at the end
    // of the event's own day (i.e. once the next day begins)
    if (diffHours <= totalWindowHours && diffHours > -24) {
      const percent = Math.max(0, Math.min(100, ((totalWindowHours - diffHours) / totalWindowHours) * 100));
      matches.push({ ...pe, percent });
    }
  }

  // soonest event (highest percent) first
  matches.sort((a, b) => b.percent - a.percent);

  matches.forEach(m => {
    const item = document.createElement('div');
    item.className = 'progressItem';
    const dayName = WEEKDAYS[m.date.getDay()];
    item.innerHTML =
      '<div class="progressItemLabel">' + m.name + ' — ' + dayName + '</div>' +
      '<div class="progressItemTrack"><div class="progressItemFill" style="width:' + m.percent + '%"></div></div>';
    el.progressList.appendChild(item);
  });
}

/* =========================================================================
   Clock sizing — grow #clock until it would touch a neighbouring element,
   then back off a small margin. Re-run whenever the viewport changes or
   the bottom-left info block's content changes size.
   ========================================================================= */
function debounce(fn, waitMs) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), waitMs);
  };
}

function fitClockToScreen() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const topReserve = el.fullscreenBtn.getBoundingClientRect().height + CLOCK_FIT_MARGIN_PX * 2;
  const bottomReserve = Math.max(
    el.cornerLeft.getBoundingClientRect().height,
    el.playerCard.getBoundingClientRect().height
  ) + CLOCK_FIT_MARGIN_PX * 2;

  const maxWidth = Math.max(100, vw - CLOCK_FIT_MARGIN_PX * 2);
  const maxHeight = Math.max(100, vh - topReserve - bottomReserve);

  let lo = 40, hi = 1000, best = lo;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    el.clockEl.style.fontSize = mid + 'px';
    const rect = el.clockGroup.getBoundingClientRect();
    if (rect.width <= maxWidth && rect.height <= maxHeight) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  el.clockEl.style.fontSize = Math.max(40, best - 4) + 'px';
}

function maybeRefitClock() {
  const sig = el.cornerLeft.textContent + '|' + el.progressList.children.length;
  if (sig !== lastCornerSignature) {
    lastCornerSignature = sig;
    requestAnimationFrame(fitClockToScreen);
  }
}

const debouncedFit = debounce(fitClockToScreen, 150);
window.addEventListener('resize', debouncedFit);
window.addEventListener('orientationchange', debouncedFit);
document.addEventListener('fullscreenchange', () => setTimeout(fitClockToScreen, 60));

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
  document.addEventListener(evt, () => {
    lastInteraction = Date.now();
    showPlayer();
  }, { passive: true });
});

function showPlayer() {
  el.player.classList.remove('idle-hidden');
}

function hidePlayerIfIdle() {
  if ((Date.now() - lastInteraction) >= PLAYER_IDLE_HIDE_MS) {
    if (window.ClockadashiPlayer) window.ClockadashiPlayer.collapse();
    el.player.classList.add('idle-hidden');
  }
}

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
  hidePlayerIfIdle();
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
requestAnimationFrame(fitClockToScreen);

checkAndRefreshData();
setInterval(checkAndRefreshData, DATA_CHECK_INTERVAL_MS);
window.addEventListener('online', checkAndRefreshData);
