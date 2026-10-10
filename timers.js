/* =========================================================================
   Clockadashi — kitchen timers.
   The "Timer" button in the top-right corner opens them; several can run at
   once. While they run, the corner shows the next one to finish in digits
   readable across the kitchen, and a card beside it the two after that.
   A new timer starts at the length of the last one started (20 minutes the
   first time) and changes a minute at a time. When one finishes, the whole
   screen turns blue until Stop is tapped, with any music paused meanwhile.
   On the wall panel the helper app (android/, http://127.0.0.1:8791) does
   the ringing: TV audio paused, volume up, on time even when this page is in
   the background. If the TV is played again while a timer rings, the helper
   stops the ringing and the timer starts again for its full length (only one
   thing plays at a time). Elsewhere the page beeps itself. Timers are saved,
   so a reload or restart keeps them.
   ========================================================================= */
(function () {
  'use strict';
  var CK = window.CK;
  if (!CK) return;

  var DEFAULT_MIN = 20;
  var MAX_MIN = 720;          // 12 hours, for long proving and slow cooking
  var RING_MIN = 10;          // beeping stops after this long; the blue screen stays until Stop
  var CLOSE_AFTER_SEC = 60;   // the timer panel closes itself after this long untouched
  var HELPER = 'http://127.0.0.1:8791';
  var LS_TIMERS = 'clockadashi_timers';
  var LS_LAST = 'clockadashi_timer_minutes';
  var SS_BAKED = 'clockadashi_baked';
  var CIRC = 2 * Math.PI * 16;  // ring circumference (r = 16 in a 40x40 box)

  var log = CK.log;
  function $(id) { return document.getElementById(id); }
  var ui = {};
  ['timerFab', 'tfIcon', 'tfRing', 'tfArc', 'tfLabel', 'tfTime', 'timerNext', 'tp', 'tpClose', 'tpTime', 'tpLess',
    'tpSet', 'tpMore', 'tpStart', 'tpList', 'tpEmpty', 'alarm', 'alarmTitle', 'alarmSub', 'alarmAdd', 'alarmStop']
    .forEach(function (id) { ui[id] = $(id); });

  // { id, n, set (minutes asked for), total (ms, for the ring), endsAt, left (ms, when paused),
  //   state: 'running' | 'paused' | 'ringing', rangAt }
  var timers = load();
  var setMin = clampMin(+CK.lsGet(LS_LAST) || DEFAULT_MIN);
  var isOpen = false, closeTimer = 0, ringTimer = 0, exactTimer = 0, historyPushed = false;
  var musicPaused = false, listSig = '';

  /* ---- Helpers ------------------------------------------------------------- */
  function load() {
    try {
      var list = JSON.parse(CK.lsGet(LS_TIMERS) || '[]');
      return Array.isArray(list) ? list.filter(function (t) { return t && t.id && t.state; }) : [];
    } catch (e) { return []; }
  }
  function save() { CK.lsSet(LS_TIMERS, JSON.stringify(timers)); syncHelper(); }
  function clampMin(m) { return Math.max(1, Math.min(MAX_MIN, Math.round(m) || DEFAULT_MIN)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(ms) {  // 20:00, 4:05, 1:30:00
    var s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    s %= 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function at(ms) { var d = new Date(ms); return (d.getHours() % 12 || 12) + ':' + pad(d.getMinutes()); }
  function length(min) {  // 20 minutes, 1 hour, 1 hour 30 minutes
    var h = Math.floor(min / 60), m = min % 60, parts = [];
    if (h) parts.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m || !h) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
    return parts.join(' ');
  }
  function short(min) {  // 20 min, 1 hr 30 min: fits beside a timer's buttons
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + ' hr' + (m ? ' ' : '') : '') + (m || !h ? m + ' min' : '');
  }
  function left(t, now) {
    if (t.state === 'paused') return t.left;
    if (t.state === 'ringing') return 0;
    return Math.max(0, t.endsAt - now);
  }
  function byId(id) {
    for (var i = 0; i < timers.length; i++) if (timers[i].id === id) return timers[i];
    return null;
  }
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
  // The attribute, not .hidden: SVG elements (the ring) have no .hidden property.
  function show(node, on) { if (on) node.removeAttribute('hidden'); else node.setAttribute('hidden', ''); }
  function ringing() { return timers.filter(function (t) { return t.state === 'ringing'; }); }

  /* ---- The panel helper app rings, and knows the end times ---------------------
     It gets every running (and ringing) timer's end time after each change, so it
     rings on the second even if Chrome is in the background, and stops once the
     timer leaves the list (Stop, +1 min, cancel). */
  var helperOk = false, helperRetry = 0;
  function syncHelper() {
    clearTimeout(helperRetry);
    var list = timers.filter(function (t) { return t.state !== 'paused'; }).map(function (t) {
      return { id: t.id, label: 'Timer ' + t.n, min: t.set, end: t.state === 'ringing' ? t.rangAt : t.endsAt };
    });
    CK.fetchWithin(HELPER + '/alarm/schedule', { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ now: Date.now(), timers: list }) }, 5000)
      .then(function (r) {
        if (!r.ok) throw new Error('helper ' + r.status);
        if (!helperOk) log('timer', 'the panel helper app rings the timers');
        helperOk = true;
        updateSound();
      })
      .catch(function () {
        if (helperOk) log('timer', 'panel helper unreachable: this page beeps instead');
        helperOk = false;
        updateSound();
        if (timers.length) helperRetry = setTimeout(syncHelper, 60000);
      });
  }

  /* While a timer rings, ask the helper every couple of seconds whether the TV took
     the speaker back: it then stops ringing and restarts the timer for its full length
     ("postponed"), and the page follows. */
  var lastAsk = 0, postponedNote = 0;
  function askHelper() {
    if (!helperOk || !ringing().length || Date.now() - lastAsk < 1800) return;
    lastAsk = Date.now();
    CK.fetchWithin(HELPER + '/alarm/status', { cache: 'no-store' }, 4000, function (r) { return r.json(); })
      .then(function (j) {
        var moved = [];
        (j && j.postponed || []).forEach(function (p) {
          var t = byId(p.id);
          if (!t || t.state !== 'ringing' || !(p.end > Date.now())) return;
          t.state = 'running';
          t.endsAt = p.end;
          t.total = p.end - Date.now();
          t.rangAt = 0;
          moved.push(t);
        });
        if (!moved.length) return;
        musicPaused = false;  // the TV has the speaker now: the music stays paused
        moved.forEach(function (t) { log('timer', 'TV playing: Timer ' + t.n + ' restarted for ' + length(t.set)); });
        CK.setStatus('timer', (moved.length === 1 ? 'Timer ' + moved[0].n + ' restarted' : moved.length + ' timers restarted') +
          ' · rings at ' + at(moved[0].endsAt), 'timer');
        clearTimeout(postponedNote);
        postponedNote = setTimeout(function () { CK.setStatus('timer', ''); }, 120000);
        save();
        check();
      }, function () {});
  }

  /* ---- Sound (only without the helper) -----------------------------------------
     Browsers only allow sound after a tap, so every tap (and starting a timer)
     keeps the alarm able to beep. The beep is synthesised: nothing to download. */
  var actx = null;
  function sound() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { if (!actx) actx = new AC(); } catch (e) { return null; }
    if (actx.state === 'suspended' && actx.resume) actx.resume().catch(function () {});
    return actx;
  }
  document.addEventListener('pointerdown', function () { if (timers.length) sound(); }, { capture: true, passive: true });

  function beep() {
    var ctx = sound();
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime + 0.03;
    for (var i = 0; i < 4; i++) {  // a classic kitchen-timer beep-beep-beep-beep
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 1760;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      gain.gain.setValueAtTime(0.3, t + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.13);
      t += 0.19;
    }
  }

  function loud() {
    var now = Date.now();
    return !helperOk && ringing().some(function (t) { return now - t.rangAt < RING_MIN * 60000; });
  }
  function updateSound() {
    if (loud()) {
      if (!ringTimer) {
        beep();
        ringTimer = setInterval(function () { if (loud()) beep(); else updateSound(); }, 1400);
      }
    } else if (ringTimer) {
      clearInterval(ringTimer);
      ringTimer = 0;
    }
  }

  /* ---- Timing -------------------------------------------------------------------- */
  function check() {
    var now = Date.now(), rang = [];
    timers.forEach(function (t) {
      if (t.state === 'running' && t.endsAt <= now) {
        t.state = 'ringing';
        t.rangAt = t.endsAt;
        rang.push(t);
      }
    });
    if (rang.length) {
      save();
      rang.forEach(function (t) { log('timer', 'Timer ' + t.n + ' finished (' + length(t.set) + ')'); });
      if (!musicPaused && CK.player && CK.player.pauseForAlarm) musicPaused = CK.player.pauseForAlarm();
    }
    render(now);
    updateSound();
    scheduleExact();
  }

  // Ring on the second, not on the clock's next tick.
  function scheduleExact() {
    clearTimeout(exactTimer);
    var next = Infinity;
    timers.forEach(function (t) { if (t.state === 'running' && t.endsAt < next) next = t.endsAt; });
    if (next !== Infinity) exactTimer = setTimeout(check, Math.min(Math.max(0, next - Date.now()) + 20, 60000));
  }

  function startTimer() {
    sound();  // this tap is what lets the alarm beep later (when there's no helper)
    var now = Date.now(), ms = setMin * 60000, n = 1;
    timers.forEach(function (t) { if (t.n >= n) n = t.n + 1; });
    timers.push({ id: 't' + now.toString(36) + Math.floor(Math.random() * 1296).toString(36), n: n, set: setMin,
      total: ms, endsAt: now + ms, left: 0, state: 'running', rangAt: 0 });
    CK.lsSet(LS_LAST, String(setMin));  // the next new timer starts here
    save();
    log('timer', 'started Timer ' + n + ' for ' + length(setMin));
    closePanel(false);
    check();
  }

  function nudge(t, dir) {  // a minute more or less on a running or paused timer
    var now = Date.now(), ms = left(t, now) + dir * 60000;
    if (ms < 1000) return;
    if (t.state === 'paused') t.left = ms;
    else t.endsAt = now + ms;
    t.total = Math.max(ms, t.total + dir * 60000);
  }
  function snooze(t) {  // "+1 min" on a finished timer
    t.state = 'running';
    t.endsAt = Date.now() + 60000;
    t.total = 60000;
    t.rangAt = 0;
  }
  function remove(t) { timers = timers.filter(function (x) { return x !== t; }); }

  /* ---- Rendering --------------------------------------------------------------------- */
  function render(now) {
    renderFab(now);
    if (isOpen) renderList(now);
    renderAlarm();
  }

  // Ringing first, then whichever runs out soonest; paused ones last.
  function rank(t, now) { return t.state === 'ringing' ? -1 : t.state === 'paused' ? 1e12 + t.left : t.endsAt - now; }

  function renderFab(now) {
    var order = timers.slice().sort(function (a, b) { return rank(a, now) - rank(b, now); });
    var lead = order[0];
    var fab = ui.timerFab;
    document.body.classList.toggle('timers-on', !!lead);  // the corner grows; the clock makes room
    fab.classList.toggle('is-running', !!lead);
    fab.classList.toggle('is-ringing', !!lead && lead.state === 'ringing');
    fab.classList.toggle('is-paused', !!lead && lead.state === 'paused');
    show(ui.tfIcon, !lead);
    show(ui.tfRing, !!lead);
    show(ui.tfTime, !!lead);
    renderNext(order.slice(1), now);
    if (!lead) {
      setText(ui.tfLabel, 'Timer');
      fab.setAttribute('aria-label', 'Kitchen timers');
      return;
    }
    var ms = left(lead, now);
    setText(ui.tfLabel, 'Timer ' + lead.n + (lead.state === 'paused' ? ' · paused' : ''));
    setText(ui.tfTime, lead.state === 'ringing' ? 'Done' : fmt(ms));
    ui.tfArc.style.strokeDashoffset = String(CIRC * (1 - (lead.state === 'ringing' ? 0 : Math.min(1, ms / lead.total))));
    fab.setAttribute('aria-label', 'Kitchen timers: ' + (lead.state === 'ringing' ? 'Timer ' + lead.n + ' is done' :
      fmt(ms) + ' left on Timer ' + lead.n + (lead.state === 'paused' ? ', paused' : '')));
  }

  // The card beside the big timer: the next two, then "+N more".
  var nextRows = [];
  function renderNext(rest, now) {
    ui.timerNext.hidden = !rest.length;
    if (!rest.length) return;
    while (nextRows.length < 3) {
      var row = document.createElement('span');
      row.className = 'tn-row';
      row.innerHTML = '<span class="tn-name"></span><span class="tn-time num"></span>';
      ui.timerNext.appendChild(row);
      nextRows.push({ el: row, name: row.firstChild, time: row.lastChild });
    }
    for (var i = 0; i < 2; i++) {
      var t = rest[i], r = nextRows[i];
      r.el.hidden = !t;
      if (!t) continue;
      setText(r.name, 'Timer ' + t.n + (t.state === 'paused' ? ' · paused' : ''));
      setText(r.time, t.state === 'ringing' ? 'Done' : fmt(left(t, now)));
    }
    var more = nextRows[2];
    more.el.hidden = rest.length <= 2;
    more.el.classList.add('tn-more');
    setText(more.time, '+' + (rest.length - 2) + ' more');
    ui.timerNext.setAttribute('aria-label', rest.length + ' more timer' + (rest.length === 1 ? '' : 's'));
  }

  function subText(t) {
    if (t.state === 'ringing') return short(t.set) + ', finished at ' + at(t.rangAt);
    if (t.state === 'paused') return short(t.set) + ', paused';
    return short(t.set) + ', rings at ' + at(t.endsAt);
  }

  function button(act, label, icon, text) {
    return '<button type="button" class="tt-btn' + (text ? ' tt-pill' : ' ibtn') + '" data-act="' + act +
      '" aria-label="' + label + '">' + (icon ? CK.svg(icon) : '') + (text || '') + '</button>';
  }

  function buildList() {
    var frag = document.createDocumentFragment();
    timers.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'tt-row' + (t.state === 'ringing' ? ' is-ringing' : '') + (t.state === 'paused' ? ' is-paused' : '');
      row.setAttribute('data-id', t.id);
      var name = 'Timer ' + t.n;
      var actions = t.state === 'ringing'
        ? button('add', 'Add one minute to ' + name, '', '+1 min') + button('stop', 'Stop ' + name, '', 'Stop')
        : button('less', 'One minute less on ' + name, '', '−1') +
          button('more', 'One minute more on ' + name, '', '+1') +
          (t.state === 'paused' ? button('resume', 'Resume ' + name, 'play') : button('pause', 'Pause ' + name, 'pause')) +
          button('cancel', 'Cancel ' + name, 'close');
      row.innerHTML =
        '<span class="tt-badge"><svg class="tt-ring" viewBox="0 0 40 40" aria-hidden="true">' +
        '<circle class="tf-track" cx="20" cy="20" r="16"></circle><circle class="tt-arc" cx="20" cy="20" r="16"></circle></svg>' +
        '<span class="tt-n" aria-hidden="true">' + t.n + '</span></span>' +
        '<span class="tt-text"><span class="tt-left num"></span><span class="tt-sub"></span></span>' +
        '<span class="tt-actions">' + actions + '</span>';
      frag.appendChild(row);
    });
    ui.tpList.textContent = '';
    ui.tpList.appendChild(frag);
  }

  function renderList(now) {
    var sig = timers.map(function (t) { return t.id + t.state; }).join('|');
    if (sig !== listSig) { listSig = sig; buildList(); }
    ui.tpEmpty.hidden = timers.length > 0;
    var rows = ui.tpList.children;
    for (var i = 0; i < rows.length; i++) {
      var t = byId(rows[i].getAttribute('data-id'));
      if (!t) continue;
      var ms = left(t, now);
      setText(rows[i].querySelector('.tt-left'), t.state === 'ringing' ? 'Done' : fmt(ms));
      setText(rows[i].querySelector('.tt-sub'), subText(t));
      rows[i].querySelector('.tt-arc').style.strokeDashoffset =
        String(CIRC * (1 - (t.state === 'ringing' ? 0 : Math.min(1, ms / t.total))));
      var less = rows[i].querySelector('[data-act="less"]');
      if (less) less.disabled = ms <= 61000;
    }
  }

  function renderAlarm() {
    var done = ringing();
    if (!done.length) {
      ui.alarm.hidden = true;
      if (musicPaused) {  // pick the music up where the alarm interrupted it
        musicPaused = false;
        if (CK.player && CK.player.resumeAfterAlarm) CK.player.resumeAfterAlarm();
      }
      return;
    }
    var first = done[0];
    setText(ui.alarmTitle, done.length === 1 ? 'Timer ' + first.n + ' is done' : done.length + ' timers are done');
    setText(ui.alarmSub, done.length === 1 ? length(first.set) + ', finished at ' + at(first.rangAt)
      : done.map(function (t) { return 'Timer ' + t.n; }).join(' and '));
    if (ui.alarm.hidden) {
      ui.alarm.hidden = false;
      ui.alarmStop.focus({ preventScroll: true });
    }
  }

  function renderSet() {
    setText(ui.tpSet, fmt(setMin * 60000));
    ui.tpSet.classList.toggle('is-long', setMin >= 60);
    ui.tpSet.setAttribute('aria-label', length(setMin));
    ui.tpLess.disabled = setMin <= 1;
    ui.tpMore.disabled = setMin >= MAX_MIN;
  }

  /* ---- "Let's BAKE!": cookies and cupcakes, the first tap of each visit ------------- */
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
    for (var i = 0; i < (reduce ? 0 : 28); i++) {
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
  function firstTapThisVisit() {
    try {
      if (sessionStorage.getItem(SS_BAKED)) return false;
      sessionStorage.setItem(SS_BAKED, '1');
    } catch (e) {}
    return true;
  }

  /* ---- Panel ------------------------------------------------------------------------- */
  function openPanel() {
    if (isOpen) return;
    isOpen = true;
    sound();
    renderSet();
    listSig = '';
    ui.tp.classList.add('open');
    ui.tp.setAttribute('aria-hidden', 'false');
    headerClock();
    render(Date.now());
    try { history.pushState({ clockadashiTimers: 1 }, ''); historyPushed = true; } catch (e) {}
    ui.tpStart.focus({ preventScroll: true });
    touched();
  }

  function closePanel(fromBackButton) {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(closeTimer);
    ui.tp.classList.remove('open');
    ui.tp.setAttribute('aria-hidden', 'true');
    if (ui.tp.contains(document.activeElement)) ui.timerFab.focus({ preventScroll: true });
    if (historyPushed && !fromBackButton) history.back();
    historyPushed = false;
  }

  function touched() {
    clearTimeout(closeTimer);
    if (isOpen) closeTimer = setTimeout(function () { closePanel(false); }, CLOSE_AFTER_SEC * 1000);
  }

  function headerClock() {
    var d = CK.now();
    setText(ui.tpTime, (d.getHours() % 12 || 12) + ':' + pad(d.getMinutes()));
  }

  // Two taps to cancel, so a floury elbow can't wipe out a timer.
  function confirmTap(btn) {
    if (btn.classList.contains('is-confirm')) return true;
    btn.classList.add('is-confirm');
    var before = btn.innerHTML;
    btn.textContent = 'Cancel?';
    setTimeout(function () {
      if (!btn.isConnected) return;
      btn.classList.remove('is-confirm');
      btn.innerHTML = before;
    }, 3000);
    return false;
  }

  // Hold − or + to keep changing, faster the longer it's held.
  function stepper(btn, dir) {
    var timer = 0, delay = 0;
    function stepOnce() {
      var next = clampMin(setMin + dir);
      if (next === setMin) return false;
      setMin = next;
      renderSet();
      return true;
    }
    function repeat() {
      if (!stepOnce()) return stop();
      delay = Math.max(45, delay * 0.82);
      timer = setTimeout(repeat, delay);
    }
    function stop() { clearTimeout(timer); timer = 0; }
    btn.addEventListener('pointerdown', function (e) {
      if (btn.disabled) return;
      e.preventDefault();
      stepOnce();
      delay = 300;
      timer = setTimeout(repeat, 450);
      if (btn.setPointerCapture) { try { btn.setPointerCapture(e.pointerId); } catch (err) {} }
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { btn.addEventListener(t, stop); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stepOnce(); }
    });
  }

  /* ---- Wiring -------------------------------------------------------------------------- */
  ui.timerFab.addEventListener('click', function () {
    if (firstTapThisVisit()) letsBake();
    openPanel();
  });
  ui.timerNext.addEventListener('click', openPanel);
  ui.tpClose.addEventListener('click', function () { closePanel(false); });
  ui.tpStart.addEventListener('click', startTimer);
  stepper(ui.tpLess, -1);
  stepper(ui.tpMore, 1);
  ui.tpList.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-act]');
    var row = btn && btn.closest('.tt-row');
    var t = row && byId(row.getAttribute('data-id'));
    if (!t) return;
    var act = btn.getAttribute('data-act'), now = Date.now();
    if (act === 'less' || act === 'more') nudge(t, act === 'more' ? 1 : -1);
    else if (act === 'pause') { t.left = Math.max(1000, t.endsAt - now); t.state = 'paused'; }
    else if (act === 'resume') { t.endsAt = now + t.left; t.state = 'running'; }
    else if (act === 'cancel') { if (!confirmTap(btn)) return; remove(t); log('timer', 'cancelled Timer ' + t.n); }
    else if (act === 'stop') remove(t);
    else if (act === 'add') snooze(t);
    save();
    check();
  });
  ui.alarmStop.addEventListener('click', function () {
    ringing().forEach(function (t) { remove(t); log('timer', 'stopped Timer ' + t.n); });
    save();
    check();
  });
  ui.alarmAdd.addEventListener('click', function () {
    ringing().forEach(snooze);
    save();
    check();
  });
  ['pointerdown', 'keydown', 'wheel', 'scroll'].forEach(function (t) {
    ui.tp.addEventListener(t, touched, { passive: true, capture: true });
  });
  window.addEventListener('popstate', function () {  // Android back button closes the panel
    if (isOpen) { historyPushed = false; closePanel(true); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) closePanel(false); });
  CK.on('tick', function () { check(); askHelper(); if (isOpen) headerClock(); });

  CK.timers = {
    busy: function () { return timers.length > 0 || isOpen; },  // no app-update reloads meanwhile
    open: openPanel,
    describe: function () {
      var how = helperOk ? 'rung by the panel helper app' : 'rung by this page';
      if (!timers.length) return 'Timers: none (' + how + ')';
      var now = Date.now();
      return 'Timers (' + how + '): ' + timers.map(function (t) {
        return 'Timer ' + t.n + ' ' + t.state + ', ' + fmt(left(t, now)) + ' left of ' + length(t.set);
      }).join('; ');
    }
  };

  renderSet();
  syncHelper();
  check();
})();
