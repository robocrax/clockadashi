/* =========================================================================
   Clockadashi — the clock, the Ekadashi calendar and the offline plumbing.
   Plain ES2017 so older Android Chrome copes; no build step.
   Music lives in player.js and talks to this file through window.CK.
   ========================================================================= */
(function () {
  'use strict';

  /* ---- Settings ---------------------------------------------------------- */
  var VERSION = '3.1.0';
  var COUNTDOWN_DAYS = 8;      // a ProgressBar event gets its bar this many days ahead
  var APPROACH_DAYS = 4;       // purple tint from this many days out, until the red day before
  var PAD_HOURS = true;        // 08:05:09 rather than 8:05:09, so the clock never changes width
  var SYNC_EVERY_MIN = 30;     // re-check calendar, song list and app files this often
  var PROBE_ONLINE_SEC = 120;  // connection check while online…
  var PROBE_OFFLINE_SEC = 30;  // …and while offline, to notice Wi-Fi coming back quickly
  var RELOAD_IDLE_SEC = 90;    // a downloaded app update applies after this long untouched (never mid-song)

  var COLORS = { calm: '#000000', tomorrow: '#830300', today: '#ed6d19' };
  var APPROACH_FROM = [0x1a, 0x00, 0x1f];  // first purple day (APPROACH_DAYS out)
  var APPROACH_TO = [0x45, 0x00, 0x50];    // last purple day (2 days out)

  var LS_EVENTS = 'clockadashi_events_csv';    // same keys as v2, so the tablet keeps its copy
  var LS_TRACKS = 'clockadashi_tracks_json';
  var LS_SYNCED = 'clockadashi_last_fetch_at';
  var LS_LOG = 'clockadashi_log';
  var SS_RELOADED = 'clockadashi_reloaded_at';

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  var ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    repeatOne: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
    volDown: 'M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z',
    volUp: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    down: 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
    fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    fullscreenExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
    offline: 'M19.35 10.04C18.67 6.59 15.64 4 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46C10.21 6.23 11.08 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C23.16 18.16 24 16.68 24 15c0-2.64-2.05-4.78-4.65-4.96zM3 5.27l2.75 2.74C2.56 8.15 0 10.77 0 14c0 3.31 2.69 6 6 6h11.73l2 2L21 20.73 4.27 4 3 5.27zM7.73 10l8 8H6c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73z',
    saving: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    saved: 'M5 18h14v2H5v-2zm4.6-2.7L5 10.7l2-1.9 2.6 2.6L17 4l2 2-9.4 9.3z',
    note: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
    eq: 'M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z',
    search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    remove: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'
  };

  var CK = window.CK = { version: VERSION };

  /* ---- Small helpers ----------------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function noop() {}
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  CK.lsGet = lsGet;
  CK.lsSet = lsSet;

  function svg(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + ICONS[name] + '"/></svg>';
  }
  function setIcon(node, name) {
    if (node.getAttribute('data-shown') === name) return;
    node.innerHTML = svg(name);
    node.setAttribute('data-shown', name);
  }
  CK.svg = svg;
  CK.setIcon = setIcon;

  var handlers = {};
  CK.on = function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); };
  function emit(name, arg) {
    (handlers[name] || []).forEach(function (fn) {
      try { fn(arg); } catch (e) { log('error', name + ' handler: ' + e.message); }
    });
  }

  /* ---- Activity log: Wi-Fi drops, screen on/off, updates, errors ----------
     Kept in localStorage so it survives reboots. Long-press the clock to read
     it on the tablet, or CK.readLog() from remote DevTools. */
  function readLog() {
    var buf;
    try { buf = JSON.parse(lsGet(LS_LOG) || '[]'); } catch (e) { buf = []; }
    return Array.isArray(buf) ? buf : [];
  }
  function log(kind, detail) {
    var buf = readLog();  // re-read each time: a page being replaced may still be writing
    buf.push([Date.now(), kind, detail == null ? '' : String(detail).slice(0, 300)]);
    if (buf.length > 500) buf.splice(0, buf.length - 500);
    lsSet(LS_LOG, JSON.stringify(buf));
    if (window.console) console.log('[clockadashi]', kind, detail == null ? '' : detail);
  }
  CK.log = log;
  CK.readLog = readLog;
  window.addEventListener('error', function (e) {
    log('error', (e.message || 'script error') + ' at ' + String(e.filename || '').split('/').pop() + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    log('error', 'unhandled: ' + (r && r.message ? r.message : r));
  });

  /* ---- Time ---------------------------------------------------------------
     ?now=2026-10-21T20:00 previews any moment (the clock runs on from there),
     handy for checking the red and saffron days without editing events.csv. */
  var offsetMs = 0;
  (function () {
    var m = /[?&]now=([^&#]+)/.exec(location.search);
    if (!m) return;
    var s = decodeURIComponent(m[1]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T12:00';
    var t = Date.parse(s);  // no zone given, so it's read as the tablet's local time
    if (!isNaN(t)) offsetMs = t - Date.now();
  })();
  function now() { return new Date(Date.now() + offsetMs); }
  CK.now = now;

  /* ---- Calendar (events.csv) ---------------------------------------------- */
  function dayIndex(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000); }

  function splitCsvLine(line) {
    var out = [], cur = '', quoted = false;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (quoted) {
        if (c === '"' && line.charAt(i + 1) === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function parseEvents(text) {
    var byDay = {}, marked = [];
    String(text).replace(/^﻿/, '').split(/\r?\n/).forEach(function (line) {
      var f = splitCsvLine(line);
      var dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((f[0] || '').trim());
      var name = (f[1] || '').replace(/\s+/g, ' ').trim();
      if (!dm || !name) return;  // header row, blank lines, typos
      var y = +dm[1], mo = +dm[2], d = +dm[3];
      var isBar = /^progress\s*bar$/i.test((f[2] || '').trim());
      var day = dayIndex(y, mo, d);
      var list = byDay[day] || (byDay[day] = []);
      for (var i = 0; i < list.length; i++) {
        if (list[i].name.toLowerCase() === name.toLowerCase()) {  // listed twice: keep one
          if (isBar && !list[i].bar) { list[i].bar = true; marked.push(list[i]); }
          return;
        }
      }
      var ev = { name: name, bar: isBar, y: y, m: mo, d: d, day: day };
      list.push(ev);
      if (isBar) marked.push(ev);
    });
    return { byDay: byDay, marked: marked };
  }

  var cal = { byDay: {}, marked: [] };
  var calLoaded = false;

  function mixColor(a, b, t) {
    return 'rgb(' + a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); }).join(',') + ')';
  }

  function countdownLabel(ev, diff) {
    if (diff === 1) return 'Tomorrow is ' + ev.name;
    var weekday = WEEKDAYS[new Date(ev.y, ev.m - 1, ev.d).getDay()];
    return diff + ' days until ' + ev.name + ' on ' + weekday;
  }

  /* Everything the screen shows for a given moment. */
  function computeView(d) {
    var today = dayIndex(d.getFullYear(), d.getMonth() + 1, d.getDate());
    var todays = (cal.byDay[today] || []).slice().sort(function (a, b) {
      return (b.bar ? 1 : 0) - (a.bar ? 1 : 0);
    });
    var bars = [], soonest = Infinity, isToday = false;
    cal.marked.forEach(function (ev) {
      var diff = ev.day - today;
      if (diff === 0) isToday = true;
      if (diff < 1) return;
      if (diff < soonest) soonest = diff;
      if (diff > COUNTDOWN_DAYS) return;
      // Hour-accurate: the bar creeps forward all day instead of jumping at midnight.
      var end = new Date(ev.y, ev.m - 1, ev.d).getTime();
      var start = new Date(ev.y, ev.m - 1, ev.d - COUNTDOWN_DAYS).getTime();
      bars.push({ ev: ev, diff: diff, pct: clamp((d.getTime() - start) / (end - start), 0, 1),
        label: countdownLabel(ev, diff) });
    });
    bars.sort(function (a, b) { return a.diff - b.diff; });

    var v = { todays: todays, bars: bars, state: 'calm', color: COLORS.calm };
    if (isToday) { v.state = 'today'; v.color = COLORS.today; }
    else if (soonest === 1) { v.state = 'tomorrow'; v.color = COLORS.tomorrow; }
    else if (soonest >= 2 && soonest <= APPROACH_DAYS) {
      v.state = 'approach';
      v.color = mixColor(APPROACH_FROM, APPROACH_TO, APPROACH_DAYS > 2 ? (APPROACH_DAYS - soonest) / (APPROACH_DAYS - 2) : 1);
    }
    if (isToday) {
      v.headline = 'Today is ' + todays.filter(function (e) { return e.bar; })
        .map(function (e) { return e.name; }).join(' and ');
    } else if (bars.length) v.headline = bars[0].label;
    else v.headline = todays.map(function (e) { return e.name; }).join(', ');
    return v;
  }

  /* ---- Rendering ---------------------------------------------------------- */
  var el = {};
  var shown = { h: '', m: '', state: '', top: null, bars: null };

  function applyState(v) {
    var key = v.state + v.color;
    if (key === shown.state) return;
    shown.state = key;
    var b = document.body;
    b.classList.remove('s-calm', 's-approach', 's-tomorrow', 's-today');
    b.classList.add('s-' + v.state);
    b.style.backgroundImage = v.state === 'approach' ? 'linear-gradient(135deg, #000 0%, ' + v.color + ' 100%)' : '';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', v.state === 'approach' ? '#000000' : v.color);
  }

  function renderTop(v) {
    var sig = v.todays.map(function (e) { return (e.bar ? '*' : '') + e.name; }).join('|');
    if (sig === shown.top) return false;
    shown.top = sig;
    el.top.textContent = '';
    var lead = v.todays.length > 0 && v.todays[0].bar;
    v.todays.forEach(function (ev) {
      var line = document.createElement('div');
      line.className = 'ev' + (lead && !ev.bar ? ' ev-minor' : '');
      line.textContent = ev.name;
      el.top.appendChild(line);
    });
    return true;
  }

  function renderBars(v) {
    var sig = v.bars.map(function (b) { return b.label; }).join('|');
    var changed = sig !== shown.bars;
    if (changed) {
      shown.bars = sig;
      el.bars.textContent = '';
      v.bars.forEach(function (b, i) {
        var item = document.createElement('div');
        item.className = 'cd' + (i ? ' cd-more' : '');
        var label = document.createElement('div');
        label.className = 'cd-label';
        label.textContent = b.label;
        var track = document.createElement('div');
        track.className = 'cd-track';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', b.label);
        track.appendChild(document.createElement('div')).className = 'cd-fill';
        item.appendChild(label);
        item.appendChild(track);
        el.bars.appendChild(item);
      });
    }
    var tracks = el.bars.querySelectorAll('.cd-track');
    v.bars.forEach(function (b, i) {
      var pct = Math.round(b.pct * 1000) / 10;
      tracks[i].firstChild.style.width = pct + '%';
      tracks[i].setAttribute('aria-valuenow', String(Math.round(pct)));
    });
    return changed;
  }

  function renderMinute(d) {
    var v = CK.view = computeView(d);
    applyState(v);
    var changed = renderTop(v);
    if (renderBars(v)) changed = true;
    var dateText = WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (el.date.textContent !== dateText) el.date.textContent = dateText;
    if (changed) layout();
    emit('view', v);
  }

  function tick() {
    var d = now();
    var h = d.getHours() % 12 || 12;
    var hh = PAD_HOURS ? pad2(h) : String(h);
    var mm = pad2(d.getMinutes());
    if (hh !== shown.h) { shown.h = el.hh.textContent = hh; if (!PAD_HOURS) fitClock(); }
    if (mm !== shown.m) { shown.m = el.mm.textContent = mm; renderMinute(d); }
    el.ss.textContent = pad2(d.getSeconds());
    emit('tick', d);
    setTimeout(tick, 1010 - ((Date.now() + offsetMs) % 1000));
  }

  /* ---- Sizing: the clock takes every pixel the other rows leave it ---------- */
  function fitTop() {
    var top = el.top;
    // keep the centred text clear of the corner status and full-screen button
    var side = Math.max(56, statusReserve);
    top.style.paddingLeft = top.style.paddingRight = side + 'px';
    if (!top.firstChild) { top.style.fontSize = ''; return; }
    var w = window.innerWidth, h = window.innerHeight, wide = w >= h;
    var maxH = h * (wide ? 0.25 : 0.2);
    var size = Math.min(w * (wide ? 0.065 : 0.085), h * 0.13);
    top.style.fontSize = size + 'px';
    for (var i = 0; i < 20 && top.offsetHeight > maxH && size > 14; i++) {
      size = Math.max(14, size * 0.9);
      top.style.fontSize = size + 'px';
    }
  }

  function fitClock() {
    var w = el.clockArea.clientWidth, h = el.clockArea.clientHeight;
    if (!w || !h) return;
    // Everything inside #clockBlock is sized in em, so it scales linearly:
    // measure once at 100px and scale to fit.
    el.clockBlock.style.fontSize = '100px';
    var r = el.clockBlock.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var size = Math.floor(100 * Math.min(w * 0.97 / r.width, h * 0.95 / r.height));
    el.clockBlock.style.fontSize = Math.max(24, size) + 'px';
  }

  function layout() { fitTop(); fitClock(); }
  var layoutQueued = false;
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(function () { layoutQueued = false; layout(); });
  }
  CK.layout = queueLayout;

  /* ---- Corner status: offline, first calendar load, songs being saved ------ */
  var statuses = {};
  var STATUS_ORDER = ['offline', 'calendar', 'music'];
  CK.setStatus = function (key, text, icon) {
    var next = text ? { text: text, icon: icon || '' } : null;
    var prev = statuses[key];
    if ((!prev && !next) || (prev && next && prev.text === next.text && prev.icon === next.icon)) return;
    statuses[key] = next;
    if (el.status) renderStatus();
  };
  // Room kept beside today's events for the status. It only grows while the status
  // shows, so a ticking download percentage can't make the clock jitter in size.
  var statusReserve = 0;
  function renderStatus() {
    var s = null;
    for (var i = 0; i < STATUS_ORDER.length && !s; i++) s = statuses[STATUS_ORDER[i]];
    el.status.hidden = !s;
    if (s) {
      el.statusText.textContent = s.text;
      el.statusIcon.hidden = !s.icon;
      if (s.icon) setIcon(el.statusIcon, s.icon);
    }
    var reserve = s ? Math.max(statusReserve, el.status.offsetWidth + 20) : 0;
    if (reserve !== statusReserve) { statusReserve = reserve; queueLayout(); }
  }

  /* ---- Network: navigator.onLine lies on captive or dead Wi-Fi, so we probe -- */
  var net = CK.net = { online: navigator.onLine !== false, changedAt: Date.now(), lastOk: 0 };

  function fetchWithin(url, opts, ms, read) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var o = Object.assign({}, opts || {});
    if (ctrl) o.signal = ctrl.signal;
    var timer;
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('no answer after ' + Math.round(ms / 1000) + 's'));
      }, ms);
    });
    var work = fetch(url, o).then(function (r) { return read ? read(r) : r; });
    return Promise.race([work, timeout]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; });
  }
  CK.fetchWithin = fetchWithin;

  function setOnline(on, why) {
    if (on) net.lastOk = Date.now();
    if (on === net.online) return;
    net.online = on;
    net.changedAt = Date.now();
    log(on ? 'online' : 'offline', why);
    CK.setStatus('offline', on ? '' : 'Offline', 'offline');
    emit('net', on);
    if (on) syncAll('back online');
    scheduleProbe();
  }
  CK.setOnline = setOnline;

  var probeTimer = 0;
  function scheduleProbe() {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(probe, (net.online ? PROBE_ONLINE_SEC : PROBE_OFFLINE_SEC) * 1000);
  }
  function probe() {
    clearTimeout(probeTimer);
    if (navigator.onLine === false) { setOnline(false, 'tablet reports no network'); scheduleProbe(); return; }
    fetchWithin('manifest.json?probe=' + Date.now(), { cache: 'no-store', method: 'HEAD' }, 10000)
      .then(function (r) { setOnline(r.ok, r.ok ? 'server reachable' : 'server answered ' + r.status); },
        function (e) { setOnline(false, 'server unreachable: ' + (e && e.message)); })
      .then(scheduleProbe);
  }
  window.addEventListener('online', function () { log('wifi', 'tablet reports network back'); probe(); });
  window.addEventListener('offline', function () { setOnline(false, 'tablet reports network lost'); });

  /* ---- Data: events.csv + tracks.json, kept in localStorage for offline ---- */
  function textOf(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + String(r.url).split('/').pop());
    return r.text();
  }

  function applyEvents(text) {
    cal = parseEvents(text);
    calLoaded = true;
    shown.top = shown.bars = null;
    CK.setStatus('calendar', '');
    renderMinute(now());
  }

  function applyTracks(text) {
    var list = JSON.parse(text);
    if (!Array.isArray(list)) throw new Error('tracks.json must be a list');
    CK.tracks = list;
    emit('tracks', list);
  }

  var dataSync = null;
  function syncData(why) {
    if (dataSync) return dataSync;
    if (navigator.onLine === false) {  // no point trying; the saved copy is already on screen
      if (!calLoaded) CK.setStatus('calendar', 'Calendar will load when Wi‑Fi is back');
      return Promise.resolve();
    }
    dataSync = Promise.all([
      fetchWithin('events.csv', { cache: 'no-store' }, 20000, textOf),
      fetchWithin('tracks.json', { cache: 'no-store' }, 20000, textOf)
    ]).then(function (res) {
      var csv = res[0], tr = res[1];
      if (!/^\s*\d{4}-\d{1,2}-\d{1,2}\s*,/m.test(csv)) throw new Error('events.csv has no dated rows');
      JSON.parse(tr);  // a broken song list must never replace a good one
      lsSet(LS_SYNCED, String(Date.now()));
      if (!calLoaded || csv !== lsGet(LS_EVENTS)) {
        lsSet(LS_EVENTS, csv);
        applyEvents(csv);
        log('calendar', 'loaded new copy (' + why + ')');
      }
      if (!CK.tracks || tr !== lsGet(LS_TRACKS)) {
        lsSet(LS_TRACKS, tr);
        applyTracks(tr);
        log('songs', 'loaded new song list (' + why + ')');
      }
      setOnline(true, 'calendar check');
    }).catch(function (e) {
      log('sync failed', why + ': ' + (e && e.message));
      if (!calLoaded) CK.setStatus('calendar', 'Calendar will load when Wi‑Fi is back');
      probe();
    }).then(function () { dataSync = null; });
    return dataSync;
  }

  /* ---- App updates: the service worker re-checks the files; we reload when
     nobody is using the screen and no song is playing. ------------------------ */
  var swReg = null, reloadWanted = '';
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(function (r) { swReg = r; })
      .catch(function (e) { log('error', 'service worker: ' + e.message); });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) wantReload('new version installed');
      hadController = true;
    });
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'shell-updated') wantReload('app files changed on the server');
    });
  }
  function checkForAppUpdate() {
    if (!swReg) return;
    swReg.update().catch(noop);
    var c = navigator.serviceWorker.controller;
    if (c) c.postMessage({ type: 'refresh-shell' });
  }
  function wantReload(why) {
    if (!reloadWanted) log('update', why + '; will apply when idle');
    reloadWanted = why;
  }
  function maybeReload() {
    if (!reloadWanted) return;
    var idle = Date.now() - lastTouch > RELOAD_IDLE_SEC * 1000;
    var busy = CK.player && CK.player.busy();
    var last = 0;
    try { last = +sessionStorage.getItem(SS_RELOADED) || 0; } catch (e) {}
    if (!idle || busy || !el.diag.hidden || Date.now() - last < 10 * 60000) return;
    try { sessionStorage.setItem(SS_RELOADED, String(Date.now())); } catch (e) {}
    log('update', 'reloading: ' + reloadWanted);
    location.reload();
  }

  function syncAll(why) {
    syncData(why);
    checkForAppUpdate();
    emit('sync', why);
  }

  /* ---- Full screen (tap anywhere; an installed app is full screen already) -- */
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function enterFullscreen() {
    var de = document.documentElement;
    var fn = de.requestFullscreen || de.webkitRequestFullscreen;
    if (!fn || fsElement()) return;
    try { var p = fn.call(de, { navigationUI: 'hide' }); if (p && p.catch) p.catch(noop); } catch (e) {}
  }
  function exitFullscreen() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn || !fsElement()) return;
    try { var p = fn.call(document); if (p && p.catch) p.catch(noop); } catch (e) {}
  }
  function renderFsButton() {
    var on = !!fsElement();
    setIcon(el.fsBtn, on ? 'fullscreenExit' : 'fullscreen');
    el.fsBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
  }
  function displayMode() {
    var modes = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
    for (var i = 0; i < modes.length; i++) {
      if (window.matchMedia && matchMedia('(display-mode: ' + modes[i] + ')').matches) return modes[i];
    }
    return 'unknown';
  }

  /* ---- Keep the screen on -------------------------------------------------- */
  var wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }, function (e) { log('screen', 'could not keep the screen on: ' + e.message); });
  }

  /* ---- Diagnostics (long-press the clock) ---------------------------------- */
  function when(ms) {
    if (!ms) return 'never';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

  function openDiag() {
    var lines = [
      'Clockadashi ' + VERSION + (offsetMs ? '  (previewing ' + when(now().getTime()) + ')' : ''),
      'Network: ' + (net.online ? 'online' : 'OFFLINE') + ' since ' + when(net.changedAt) +
        '; server last reached ' + when(net.lastOk),
      'Calendar last checked: ' + when(+lsGet(LS_SYNCED)),
      'Screen: ' + window.innerWidth + '×' + window.innerHeight + ' at ' + (window.devicePixelRatio || 1) +
        'x, ' + (fsElement() ? 'full screen' : 'not full screen') + ', display mode ' + displayMode() +
        ', screen lock ' + (wakeLock ? 'held' : 'not held'),
      'Offline app: ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? 'active' : 'not active yet') +
        (reloadWanted ? '; update waiting (' + reloadWanted + ')' : ''),
      'Browser: ' + navigator.userAgent
    ];
    if (CK.player) lines.push(CK.player.describe());
    el.diagText.textContent = lines.join('\n');
    el.diag.hidden = false;

    var extra = [];
    var st = navigator.storage;
    Promise.all([
      st && st.estimate ? st.estimate().then(function (e) { extra.push('Storage: ' + mb(e.usage || 0) + ' used of ' + mb(e.quota || 0) + ' allowed'); }).catch(noop) : null,
      st && st.persisted ? st.persisted().then(function (p) { extra.push('Storage mode: ' + (p ? 'persistent' : 'best-effort (Android may clear it when space runs low)')); }).catch(noop) : null
    ]).then(function () {
      var entries = readLog().slice().reverse().map(function (e) {
        return when(e[0]) + '  ' + e[1] + (e[2] ? '  ' + e[2] : '');
      });
      el.diagText.textContent = lines.concat(extra).join('\n') + '\n\nActivity, newest first\n' + entries.join('\n');
    });
  }
  CK.diag = openDiag;

  /* ---- Boot ---------------------------------------------------------------- */
  var lastTouch = Date.now();

  function boot() {
    ['screen', 'top', 'clockArea', 'clockBlock', 'hh', 'mm', 'ss', 'date', 'bars', 'status', 'statusIcon',
      'statusText', 'fsBtn', 'diag', 'diagText', 'diagClose', 'diagClear'].forEach(function (id) { el[id] = $(id); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-icon]'), function (node) {
      setIcon(node, node.getAttribute('data-icon'));
    });

    log('start', VERSION + ', ' + window.innerWidth + '×' + window.innerHeight + ', ' + displayMode() +
      (navigator.onLine === false ? ', no network' : ''));

    var csv = lsGet(LS_EVENTS), tr = lsGet(LS_TRACKS);
    if (csv) {
      try { applyEvents(csv); } catch (e) { log('error', 'saved calendar: ' + e.message); }
    } else CK.setStatus('calendar', 'Loading calendar…');
    if (tr) {
      try { applyTracks(tr); } catch (e) { log('error', 'saved song list: ' + e.message); }
    }
    if (!net.online) CK.setStatus('offline', 'Offline', 'offline');
    renderStatus();

    tick();
    layout();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueLayout);
    window.addEventListener('resize', queueLayout);
    if ('ResizeObserver' in window) new ResizeObserver(queueLayout).observe(el.clockArea);

    ['pointerdown', 'keydown', 'wheel'].forEach(function (t) {
      document.addEventListener(t, function () { lastTouch = Date.now(); }, { passive: true, capture: true });
    });
    el.screen.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button, input, a')) return;
      enterFullscreen();
    });
    el.fsBtn.addEventListener('click', function () { if (fsElement()) exitFullscreen(); else enterFullscreen(); });
    var fsSupported = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
    el.fsBtn.hidden = !fsSupported || displayMode() === 'fullscreen';
    document.addEventListener('fullscreenchange', renderFsButton);
    document.addEventListener('webkitfullscreenchange', renderFsButton);
    renderFsButton();

    var pressTimer = 0;
    el.clockBlock.addEventListener('pointerdown', function () {
      clearTimeout(pressTimer);
      pressTimer = setTimeout(openDiag, 1500);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      el.clockBlock.addEventListener(t, function () { clearTimeout(pressTimer); });
    });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.diagClose.addEventListener('click', function () { el.diag.hidden = true; });
    el.diagClear.addEventListener('click', function () {
      lsSet(LS_LOG, '[]');
      log('log', 'cleared');
      openDiag();
    });

    document.addEventListener('visibilitychange', function () {
      var visible = document.visibilityState === 'visible';
      log(visible ? 'screen on' : 'screen off', '');
      if (visible) { keepAwake(); probe(); }
    });
    keepAwake();

    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then(function (p) {
        if (p) return;
        return navigator.storage.persist().then(function (granted) {
          log('storage', granted ? 'persistent storage granted' : 'persistent storage not granted yet');
        });
      }).catch(noop);
    }

    registerServiceWorker();
    syncAll('start');
    scheduleProbe();
    setInterval(function () { syncAll('every ' + SYNC_EVERY_MIN + ' min'); }, SYNC_EVERY_MIN * 60000);
    setInterval(maybeReload, 15000);
  }

  if (document.readyState === 'complete') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
