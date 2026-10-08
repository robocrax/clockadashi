/* =========================================================================
   Clockadashi — kitchen timers.
   The round timer button next to the music player opens the timer sheet; once
   a timer runs, the button shows the next one counting down, big enough to
   read across the kitchen. Any number of timers; a new one starts at the
   length used last time (20 minutes the first time), with −1 / +1 minute.
   Timers are kept in localStorage as end times, so they survive reloads.
   When one finishes, a full-screen banner appears and the panel helper app
   (android/, http://127.0.0.1:8791) rings: it pauses the TV and music, turns
   the volume up, and puts everything back when the timer is stopped. The
   helper keeps its own copy of the end times, so it rings on time even when
   the page is in the background. Without the helper the page rings itself.
   ========================================================================= */
(function () {
  'use strict';
  var CK = window.CK;
  if (!CK) return;

  var DEFAULT_MIN = 20;          // first timer ever
  var MIN_MIN = 1, MAX_MIN = 300;
  var CLOSE_AFTER_SEC = 90;      // the sheet slides away after this long untouched
  var PAGE_RING_SEC = 180;       // without the helper, the page rings for at most this long
  var HELPER = 'http://127.0.0.1:8791';
  var LS_TIMERS = 'clockadashi_timers';
  var LS_LAST = 'clockadashi_timer_minutes';

  var log = CK.log;
  function $(id) { return document.getElementById(id); }
  var ui = {};
  ['timerBtn', 'timerBtnLabel', 'timerBtnText', 'timerNext', 'tm', 'tmClose', 'tmMinus', 'tmNewTime', 'tmPlus', 'tmStart',
    'tmList', 'tmAlert', 'tmAlertTitle', 'tmAlertSub', 'tmAlertStop', 'tmAlertMore'].forEach(function (id) { ui[id] = $(id); });
  if (!ui.timerBtn) return;

  /* ---- State -------------------------------------------------------------- */
  // { id, n: label number, total: ms, end: epoch ms while running, left: ms while paused, rang: bool }
  var timers = readTimers();
  var newMin = clampMin(+CK.lsGet(LS_LAST) || DEFAULT_MIN);

  function readTimers() {
    try {
      var t = JSON.parse(CK.lsGet(LS_TIMERS) || '[]');
      return Array.isArray(t) ? t.filter(function (x) { return x && x.id && x.total > 0; }) : [];
    } catch (e) { return []; }
  }
  function save() { CK.lsSet(LS_TIMERS, JSON.stringify(timers)); }
  function clampMin(m) { return Math.max(MIN_MIN, Math.min(MAX_MIN, Math.round(m))); }
  function remaining(t, now) { return t.end ? t.end - now : t.left; }
  function isDue(t, now) { return !!t.end && t.end <= now; }
  function label(t) { return 'Timer ' + t.n; }
  // what it was set for when started (adding or taking minutes later doesn't change this)
  function setFor(t) { return minutesText(t.min || Math.round(t.total / 60000)); }
  function nextNumber() {
    for (var n = 1; ; n++) {
      if (!timers.some(function (t) { return t.n === n; })) return n;
    }
  }
  function fmt(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    s = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') + m : String(m)) + ':' + (s < 10 ? '0' : '') + s;
  }
  function minutesText(min) { return min + ' min'; }

  /* ---- Changes ------------------------------------------------------------ */
  function changed() {
    save();
    syncHelper();
    render();
  }

  function startTimer() {
    var ms = newMin * 60000;
    timers.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), n: nextNumber(),
      min: newMin, total: ms, end: Date.now() + ms, left: 0, rang: false });
    CK.lsSet(LS_LAST, String(newMin));
    log('timer', minutesText(newMin) + ' started');
    unlockPageSound();
    changed();
  }
  function find(id) { for (var i = 0; i < timers.length; i++) if (timers[i].id === id) return timers[i]; return null; }
  function adjust(id, deltaMin) {
    var t = find(id);
    if (!t) return;
    var now = Date.now(), d = deltaMin * 60000;
    if (t.end) t.end = Math.max(now + 1000, t.end + d);
    else t.left = Math.max(1000, t.left + d);
    t.total = Math.max(t.total + d, remaining(t, now));
    t.rang = false;
    changed();
  }
  function togglePause(id) {
    var t = find(id), now = Date.now();
    if (!t || isDue(t, now)) return;
    if (t.end) { t.left = t.end - now; t.end = 0; } else { t.end = now + t.left; t.left = 0; }
    changed();
  }
  function remove(id) {
    timers = timers.filter(function (t) { return t.id !== id; });
    changed();
  }
  function stopRinging() {
    var now = Date.now();
    timers = timers.filter(function (t) { return !isDue(t, now); });
    changed();
  }
  function oneMoreMinute() {
    var now = Date.now();
    timers.forEach(function (t) {
      if (isDue(t, now)) { t.end = now + 60000; t.total = Math.max(t.total, 60000); t.rang = false; }
    });
    changed();
  }

  /* ---- The helper app rings (and knows the end times) --------------------- */
  var helperOk = false, syncTimer = 0;
  function syncHelper() {
    clearTimeout(syncTimer);
    var running = timers.filter(function (t) { return t.end; })
      .map(function (t) { return { id: t.id, label: label(t), end: t.end }; });
    CK.fetchWithin(HELPER + '/alarm/schedule', { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ now: Date.now(), timers: running }) }, 5000)
      .then(function (r) {
        if (!r.ok) throw new Error('helper ' + r.status);
        if (!helperOk) log('timer', 'panel helper rings the timers');
        helperOk = true;
      })
      .catch(function () {
        if (helperOk) log('timer', 'panel helper unreachable: the page rings instead');
        helperOk = false;
        syncTimer = setTimeout(syncHelper, 60000);  // try again later (e.g. after a helper restart)
      });
  }

  /* ---- Page ringing, only when there is no helper ------------------------- */
  var ctx = null, ringStarted = 0, ringTimer = 0;
  function unlockPageSound() {  // needs a tap: done when a timer is started
    if (ctx || typeof (window.AudioContext || window.webkitAudioContext) !== 'function') return;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; }
  }
  function chime() {
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    var t0 = ctx.currentTime;
    [1046.5, 1318.5, 1568].forEach(function (f, i) {
      var o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + i * 0.22;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.6, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.65);
    });
  }
  function pageRing(on) {
    if (on && !helperOk) {
      if (!ringTimer) {
        ringStarted = Date.now();
        chime();
        ringTimer = setInterval(function () {
          if (Date.now() - ringStarted > PAGE_RING_SEC * 1000) { clearInterval(ringTimer); ringTimer = 0; return; }
          chime();
        }, 1800);
      }
    } else if (ringTimer) {
      clearInterval(ringTimer);
      ringTimer = 0;
    }
  }

  /* ---- Rendering ------------------------------------------------------------ */
  var rows = {};
  function render() {
    var now = Date.now();
    var due = timers.filter(function (t) { return isDue(t, now); });
    var running = timers.filter(function (t) { return t.end && !isDue(t, now); })
      .sort(function (a, b) { return a.end - b.end; });

    // bottom-left: "Timer" when idle; otherwise the next timer in big digits (or "Done"),
    // and a second card with the two after it
    var paused = timers.filter(function (t) { return !t.end; })
      .sort(function (a, b) { return a.left - b.left; });
    var upcoming = running.concat(paused);
    var next = due.length ? null : upcoming[0];
    var on = timers.length > 0;
    document.body.classList.toggle('timers-on', on);
    ui.timerBtn.classList.toggle('is-due', due.length > 0);
    ui.timerBtn.classList.toggle('is-paused', !!next && !next.end);
    ui.timerBtnText.hidden = !on;
    if (!on) {
      setText(ui.timerBtnLabel, 'Timer');
    } else if (due.length) {
      setText(ui.timerBtnLabel, due.length === 1 ? label(due[0]) : due.length + ' timers');
      setText(ui.timerBtnText, 'Done');
    } else {
      setText(ui.timerBtnLabel, label(next) + (next.end ? '' : ' · paused'));
      setText(ui.timerBtnText, fmt(remaining(next, now)));
    }
    ui.timerBtn.setAttribute('aria-label', on ? 'Kitchen timers: ' + ui.timerBtnLabel.textContent + ' ' +
      ui.timerBtnText.textContent : 'Kitchen timers');
    renderNext(due.length ? upcoming : upcoming.slice(1), now);

    // the alert
    var ringing = due.length > 0;
    if (ringing) {
      ui.tmAlertTitle.textContent = due.length === 1 ? label(due[0]) + ' is done' : due.length + ' timers are done';
      ui.tmAlertSub.textContent = due.map(function (t) { return label(t) + ' · ' + setFor(t) + ' timer'; }).join('   ');
      due.forEach(function (t) { if (!t.rang) { t.rang = true; log('timer', label(t) + ' done'); save(); } });
    }
    if (ui.tmAlert.hidden === ringing) {
      ui.tmAlert.hidden = !ringing;
      if (ringing) ui.tmAlertStop.focus({ preventScroll: true });
    }
    pageRing(ringing);

    // the sheet
    ui.tmNewTime.textContent = minutesText(newMin);
    if (!isOpen) return;
    var keep = {};
    timers.slice().sort(function (a, b) { return remaining(a, now) - remaining(b, now); }).forEach(function (t, i) {
      keep[t.id] = true;
      var r = rows[t.id] || (rows[t.id] = buildRow(t));
      if (ui.tmList.children[i] !== r.el) ui.tmList.insertBefore(r.el, ui.tmList.children[i] || null);
      var left = remaining(t, now);
      r.name.textContent = label(t) + ' · ' + setFor(t);
      r.time.textContent = isDue(t, now) ? 'Done' : fmt(left);
      r.bar.style.width = Math.max(0, Math.min(100, 100 - left / t.total * 100)) + '%';
      r.el.classList.toggle('is-paused', !t.end);
      r.el.classList.toggle('is-due', isDue(t, now));
      CK.setIcon(r.pause, t.end ? 'pause' : 'play');
      r.pause.setAttribute('aria-label', t.end ? 'Pause' : 'Resume');
    });
    Object.keys(rows).forEach(function (id) {
      if (!keep[id]) { rows[id].el.remove(); delete rows[id]; }
    });
    ui.tmList.classList.toggle('is-empty', !timers.length);
  }

  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  // The card beside the big timer: the next two after it, and how many more.
  var nextRows = [];
  function renderNext(rest, now) {
    ui.timerNext.hidden = !rest.length;
    if (!rest.length) return;
    var shown = rest.slice(0, 2);
    while (nextRows.length < 3) {
      var row = document.createElement('span');
      row.className = 'tn-row';
      row.innerHTML = '<span class="tn-name"></span><span class="tn-time"></span>';
      ui.timerNext.appendChild(row);
      nextRows.push({ el: row, name: row.firstChild, time: row.lastChild });
    }
    nextRows.forEach(function (r, i) {
      var t = shown[i];
      r.el.hidden = !t && i < 2;
      if (i === 2) {  // "+N more"
        r.el.hidden = rest.length <= 2;
        setText(r.name, '');
        setText(r.time, '+' + (rest.length - 2) + ' more');
        r.el.classList.add('tn-more');
        return;
      }
      if (!t) return;
      setText(r.name, label(t) + (t.end ? '' : ' · paused'));
      setText(r.time, fmt(remaining(t, now)));
    });
  }

  /* ---- "Let's BAKE!": cookies and cupcakes, first tap of each session ------ */
  var SS_BAKED = 'clockadashi_baked';
  var FX_SVG = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
    // cookie: golden disc, darker rim, chocolate chips, a bite out of one side
    '<symbol id="fx-cookie" viewBox="0 0 64 64"><mask id="fx-bite"><rect width="64" height="64" fill="#fff"/>' +
    '<circle cx="58" cy="14" r="9" fill="#000"/><circle cx="50" cy="6" r="7" fill="#000"/></mask>' +
    '<g mask="url(#fx-bite)"><circle cx="32" cy="32" r="28" fill="#b9773c"/><circle cx="32" cy="32" r="24" fill="#d99a55"/>' +
    '<ellipse cx="24" cy="22" rx="8" ry="4" fill="#e9b877" opacity=".6"/>' +
    '<g fill="#4a2a17"><circle cx="22" cy="30" r="4"/><circle cx="38" cy="24" r="3.5"/><circle cx="40" cy="40" r="4.5"/>' +
    '<circle cx="26" cy="44" r="3.5"/><circle cx="31" cy="35" r="2.5"/><circle cx="47" cy="30" r="2.5"/></g></g></symbol>' +
    // cupcake: striped wrapper, swirled pink frosting, sprinkles, cherry
    '<symbol id="fx-cupcake" viewBox="0 0 64 64">' +
    '<path d="M14 36h36l-5 24H19z" fill="#4fa3e0"/><path d="M22 36l2 24M32 36v24M42 36l-2 24" stroke="#2f7fbf" stroke-width="3"/>' +
    '<path d="M10 37c0-7 5-11 11-11 1-7 6-11 11-11s10 4 11 11c6 0 11 4 11 11z" fill="#f48fb1"/>' +
    '<path d="M16 30c4-3 10-3 14 0M30 22c3-2 7-2 10 1" stroke="#f8bbd0" stroke-width="3" fill="none" stroke-linecap="round"/>' +
    '<g stroke-width="2.5" stroke-linecap="round"><path d="M20 33l2-2" stroke="#ffe082"/><path d="M38 30l2 2" stroke="#80deea"/>' +
    '<path d="M28 27l3-1" stroke="#a5d6a7"/><path d="M44 34l2-2" stroke="#fff"/></g>' +
    '<path d="M33 9c1-4 4-6 7-6" stroke="#5d4037" stroke-width="2" fill="none"/><circle cx="32" cy="12" r="6" fill="#e53935"/>' +
    '<circle cx="30" cy="10" r="1.8" fill="#ff8a80"/></symbol></defs></svg>';

  function letsBake() {
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var fx = document.createElement('div');
    fx.className = 'bake-fx';
    fx.setAttribute('aria-hidden', 'true');
    var html = FX_SVG + '<div class="bake-title">Let’s BAKE!</div>';
    var count = reduce ? 0 : 28;
    for (var i = 0; i < count; i++) {
      var size = 44 + Math.random() * 56, dur = 2.2 + Math.random() * 1.6, delay = Math.random() * 1.1;
      var spin = (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 360);
      html += '<svg class="bake-item" style="left:' + (Math.random() * 96).toFixed(1) + '%;width:' + size.toFixed(0) +
        'px;height:' + size.toFixed(0) + 'px;animation-duration:' + dur.toFixed(2) + 's;animation-delay:' + delay.toFixed(2) +
        's;--spin:' + spin.toFixed(0) + 'deg"><use href="#fx-' + (Math.random() < 0.5 ? 'cookie' : 'cupcake') + '"/></svg>';
    }
    fx.innerHTML = html;
    document.body.appendChild(fx);
    setTimeout(function () { fx.remove(); }, reduce ? 1600 : 4200);
  }
  function firstTapThisSession() {
    try {
      if (sessionStorage.getItem(SS_BAKED)) return false;
      sessionStorage.setItem(SS_BAKED, '1');
    } catch (e) {}
    return true;
  }

  function iconButton(icon, labelText, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ibtn tm-row-btn';
    b.setAttribute('aria-label', labelText);
    CK.setIcon(b, icon);
    b.addEventListener('click', onClick);
    return b;
  }
  function textButton(text, labelText, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tm-row-step';
    b.textContent = text;
    b.setAttribute('aria-label', labelText);
    b.addEventListener('click', onClick);
    return b;
  }
  function buildRow(t) {
    var el = document.createElement('div');
    el.className = 'tm-row';
    var info = document.createElement('div');
    info.className = 'tm-row-info';
    var name = document.createElement('div');
    name.className = 'tm-row-name';
    var time = document.createElement('div');
    time.className = 'tm-row-time';
    var track = document.createElement('div');
    track.className = 'tm-row-track';
    var bar = document.createElement('i');
    track.appendChild(bar);
    info.appendChild(name);
    info.appendChild(time);
    info.appendChild(track);
    var id = t.id;
    var pause = iconButton('pause', 'Pause', function () { togglePause(id); });
    el.appendChild(info);
    el.appendChild(textButton('−1', 'One minute less', function () { adjust(id, -1); }));
    el.appendChild(textButton('+1', 'One minute more', function () { adjust(id, 1); }));
    el.appendChild(pause);
    el.appendChild(iconButton('close', 'Remove timer', function () { remove(id); }));
    return { el: el, name: name, time: time, bar: bar, pause: pause };
  }

  /* ---- Open / close (like the music player: back button, auto-close) ------- */
  var isOpen = false, historyPushed = false, closeTimer = 0;
  function open() {
    if (isOpen) return;
    isOpen = true;
    if (CK.player && CK.player.close) CK.player.close();
    ui.tm.classList.add('open');
    ui.tm.setAttribute('aria-hidden', 'false');
    try { history.pushState({ clockadashiTimers: 1 }, ''); historyPushed = true; } catch (e) {}
    render();
    ui.tmStart.focus({ preventScroll: true });
    touched();
  }
  function close(fromBackButton) {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(closeTimer);
    ui.tm.classList.remove('open');
    ui.tm.setAttribute('aria-hidden', 'true');
    if (ui.tm.contains(document.activeElement)) ui.timerBtn.focus({ preventScroll: true });
    if (historyPushed && !fromBackButton) history.back();
    historyPushed = false;
  }
  function touched() {
    clearTimeout(closeTimer);
    if (isOpen) closeTimer = setTimeout(function () { close(false); }, CLOSE_AFTER_SEC * 1000);
  }
  window.addEventListener('popstate', function () { if (isOpen) { historyPushed = false; close(true); } });
  ['pointerdown', 'keydown'].forEach(function (t) { ui.tm.addEventListener(t, touched, { passive: true, capture: true }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(false); });

  /* ---- Controls --------------------------------------------------------------- */
  ui.timerBtn.addEventListener('click', function () {
    if (!ui.tmAlert.hidden) return;
    if (firstTapThisSession()) letsBake();
    open();
  });
  ui.timerNext.addEventListener('click', function () { if (ui.tmAlert.hidden) open(); });
  ui.tmClose.addEventListener('click', function () { close(false); });
  ui.tmMinus.addEventListener('click', function () { newMin = clampMin(newMin - 1); render(); });
  ui.tmPlus.addEventListener('click', function () { newMin = clampMin(newMin + 1); render(); });
  ui.tmStart.addEventListener('click', function () { startTimer(); });
  ui.tmAlertStop.addEventListener('click', stopRinging);
  ui.tmAlertMore.addEventListener('click', oneMoreMinute);

  CK.on('tick', render);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') render(); });

  CK.timers = {
    // a page reload now would interrupt something (the update reload and idle full screen wait)
    busy: function () { return isOpen || !ui.tmAlert.hidden; },
    describe: function () {
      var now = Date.now();
      return 'Timers: ' + (timers.length ? timers.map(function (t) {
        return label(t) + ' ' + (isDue(t, now) ? 'done' : fmt(remaining(t, now)) + (t.end ? '' : ' paused'));
      }).join(', ') : 'none') + '; next one ' + minutesText(newMin) + '; ' +
        (helperOk ? 'rung by the panel helper' : 'rung by the page');
    }
  };

  syncHelper();
  render();
})();
