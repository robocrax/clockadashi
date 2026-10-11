/* =========================================================================
   Clockadashi — the month, from the calendar button (top-left).
   A wall-calendar month in the Gujarati style: the lunar month names and
   the Vikram Samvat year above the grid, each Ekadashi marked with a fruit
   (a fasting day), countdown (ProgressBar) days in saffron, Poonam and
   Amavasya with their moons, other events as a dot, and the month's events
   listed beside it. Tapping a day previews it on the clock screen (app.js).
   The lunar months are worked out here (new moons and the sidereal Sun,
   Lahiri ayanamsa, amanta months as in Gujarat); the events come only from
   events.csv. A lunar month's first day can be a day out near the boundary.
   ========================================================================= */
(function () {
  'use strict';
  var CK = window.CK;
  if (!CK) return;

  var CLOSE_AFTER_SEC = 60;  // closes itself after this long untouched
  var MONTHS_BACK = 12, MONTHS_AHEAD = 24;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // amanta lunar months, Chaitra first; each is named for the Sun's entry into the next sign
  var LUNAR = ['Chaitra', 'Vaishakh', 'Jeth', 'Ashadh', 'Shravan', 'Bhadarvo', 'Aso', 'Kartak', 'Magshar',
    'Posh', 'Maha', 'Fagan'];
  var FRUITS = ['🍌', '🍎', '🍇', '🍊', '🍉', '🥭', '🍍', '🍐', '🍓', '🍑'];

  function $(id) { return document.getElementById(id); }
  var ui = {};
  ['cs', 'csClose', 'csPrev', 'csNext', 'csMonth', 'csLunar', 'csToday', 'csGrid', 'csList', 'csNote']
    .forEach(function (id) { ui[id] = $(id); });
  if (!ui.cs) return;

  /* ---- Lunar months ----------------------------------------------------------- */
  var RAD = Math.PI / 180;
  function sin(deg) { return Math.sin(deg * RAD); }

  // Meeus, Astronomical Algorithms ch. 49: new moon number k (0 = 6 January 2000), as a Julian day (TT)
  function newMoon(k) {
    var T = k / 1236.85, T2 = T * T;
    var jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T2 * T + 0.00000000073 * T2 * T2;
    var E = 1 - 0.002516 * T - 0.0000074 * T2;
    var M = 2.5534 + 29.1053567 * k - 0.0000014 * T2;
    var Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T2 * T;
    var F = 160.7108 + 390.67050284 * k - 0.0016118 * T2;
    var O = 124.7746 - 1.56375588 * k + 0.0020672 * T2;
    return jde - 0.4072 * sin(Mp) + 0.17241 * E * sin(M) + 0.01608 * sin(2 * Mp) + 0.01039 * sin(2 * F) +
      0.00739 * E * sin(Mp - M) - 0.00514 * E * sin(Mp + M) + 0.00208 * E * E * sin(2 * M) - 0.00111 * sin(Mp - 2 * F) -
      0.00057 * sin(Mp + 2 * F) + 0.00056 * E * sin(2 * Mp + M) - 0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F) +
      0.00038 * E * sin(M - 2 * F) - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(O) - 0.00007 * sin(Mp + 2 * M) +
      0.00004 * sin(2 * Mp - 2 * F) + 0.00004 * sin(3 * M) + 0.00003 * sin(Mp + M - 2 * F) + 0.00003 * sin(2 * Mp + 2 * F) -
      0.00003 * sin(Mp + M + 2 * F) + 0.00003 * sin(Mp - M + 2 * F) - 0.00002 * sin(Mp - M - 2 * F) -
      0.00002 * sin(3 * Mp + M) + 0.00002 * sin(4 * Mp);
  }

  // The Sun's sidereal longitude (Meeus ch. 25, about 0.01 degrees, less the Lahiri ayanamsa)
  function siderealSun(jd) {
    var T = (jd - 2451545) / 36525;
    var L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    var M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    var C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) + (0.019993 - 0.000101 * T) * sin(2 * M) +
      0.000289 * sin(3 * M);
    var lon = L0 + C - 0.00569 - 0.00478 * sin(125.04 - 1934.136 * T);
    var ayanamsa = 23.85709 + (jd - 2451545) / 365.25 * 0.0139697;
    return ((lon - ayanamsa) % 360 + 360) % 360;
  }
  function sign(jd) { return Math.floor(siderealSun(jd) / 30); }

  // The first local day whose sunrise (taken as 6:30) comes after the new moon: Sud 1.
  function firstDay(jde) {
    var t = (jde - 2440587.5) * 86400000 - 69000;  // TT to UTC (delta T is about 69 s)
    var d = new Date(t), rise = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6, 30);
    return t < rise.getTime() ? rise : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 6, 30);
  }

  // Lunar months overlapping [from, to): { start (Date), name, vs }
  var lunarCache = {};
  function lunarMonths(from, to) {
    var key = from.getTime() + ':' + to.getTime();
    if (lunarCache[key]) return lunarCache[key];
    var out = [];
    var k = Math.floor((from.getFullYear() + from.getMonth() / 12 - 2000) * 12.3685) - 2;
    var a = newMoon(k);
    for (var guard = 0; guard < 40; guard++, k++) {
      var b = newMoon(k + 1), start = firstDay(a), next = firstDay(b);
      if (start >= to) break;
      if (next > from) {
        var s0 = sign(a), i = (s0 + 1) % 12, adhik = s0 === sign(b);  // no sankranti in it: Adhik
        // the Samvat turns over at Kartak Sud 1 (the day after Diwali)
        var vs = start.getFullYear() + 56 + (start.getMonth() >= 9 && i >= 7 && i <= 9 ? 1 : 0);
        out.push({ start: start, name: (adhik ? 'Adhik ' : '') + LUNAR[i], vs: vs });
      }
      a = b;
    }
    lunarCache[key] = out;
    return out;
  }

  /* ---- The month on screen ------------------------------------------------------ */
  var shownY, shownM, isOpen = false, closeTimer = 0, historyPushed = false;

  function sameDay(a, y, m, d) { return a && a.y === y && a.m === m && a.d === d; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function isEkadashi(ev) { return /ekadashi/i.test(ev.name); }
  function moonOf(evs) {
    for (var i = 0; i < evs.length; i++) {
      if (/poonam|purnima/i.test(evs[i].name)) return '🌕';
      if (/amavasya/i.test(evs[i].name)) return '🌑';
    }
    return '';
  }

  function render() {
    var cal = CK.events(), byDay = cal.byDay || {};
    var real = new Date(), preview = CK.preview.get();
    var todayIdx = CK.dayIndex(real.getFullYear(), real.getMonth() + 1, real.getDate());
    var first = new Date(shownY, shownM, 1), after = new Date(shownY, shownM + 1, 1);
    var days = Math.round((after - first) / 86400000);

    ui.csMonth.textContent = MONTHS[shownM] + ' ' + shownY;
    var lunar = lunarMonths(first, after), starts = {}, vs = [];
    lunar.forEach(function (l) {
      if (l.start >= first) starts[l.start.getDate()] = l.name;
      if (vs.indexOf(l.vs) < 0) vs.push(l.vs);
    });
    ui.csLunar.textContent = lunar.map(function (l) { return l.name; }).join(' · ') +
      '  ·  Vikram Samvat ' + vs.join('–');

    var html = '', list = '';
    for (var b = 0; b < first.getDay(); b++) html += '<span class="cs-day is-blank" aria-hidden="true"></span>';
    for (var d = 1; d <= days; d++) {
      var idx = CK.dayIndex(shownY, shownM + 1, d), evs = byDay[idx] || [];
      var eka = evs.some(isEkadashi), bar = evs.some(function (e) { return e.bar; });
      var fruit = eka ? FRUITS[idx % FRUITS.length] : '', moon = moonOf(evs);
      var cls = 'cs-day' + (bar || eka ? ' is-bar' : '') + (idx === todayIdx ? ' is-today' : '') +
        (idx < todayIdx ? ' is-past' : '') + (sameDay(preview, shownY, shownM, d) ? ' is-preview' : '');
      var date = WEEKDAYS[(first.getDay() + d - 1) % 7] + ' ' + d + ' ' + MONTHS[shownM];
      var label = date + (evs.length ? ': ' + evs.map(function (e) { return e.name; }).join(', ') : '') +
        (starts[d] ? ', ' + starts[d] + ' begins' : '');
      html += '<button type="button" class="' + cls + '" data-d="' + d + '" aria-label="' + esc(label) + '">' +
        '<span class="cs-n">' + d + '</span>' +
        (moon ? '<span class="cs-moon" aria-hidden="true">' + moon + '</span>' : '') +
        (fruit ? '<span class="cs-fruit" aria-hidden="true">' + fruit + '</span>' : '') +
        (starts[d] ? '<span class="cs-lm" aria-hidden="true">' + esc(starts[d]) + '</span>' : '') +
        (evs.length && !bar && !eka ? '<span class="cs-dot" aria-hidden="true"></span>' : '') +
        '</button>';
      if (evs.length) {
        var names = evs.slice().sort(function (x, y) { return (y.bar ? 1 : 0) - (x.bar ? 1 : 0); })
          .map(function (e) { return e.bar ? '<b>' + esc(e.name) + '</b>' : esc(e.name); }).join(' · ');
        list += '<button type="button" class="cl-row' + (sameDay(preview, shownY, shownM, d) ? ' is-preview' : '') +
          '" data-d="' + d + '"><span class="cl-date">' + WEEKDAYS[(first.getDay() + d - 1) % 7].slice(0, 3) + ' ' + d +
          '</span><span class="cl-icon" aria-hidden="true">' + (fruit || moon) + '</span><span class="cl-names">' +
          names + '</span></button>';
      }
    }
    ui.csGrid.innerHTML = html;
    ui.csList.innerHTML = list;

    // events.csv covers a limited span: say so rather than show an empty month as "nothing on"
    var known = Object.keys(byDay).map(Number);
    var lo = Math.min.apply(null, known), hi = Math.max.apply(null, known);
    var monthLo = CK.dayIndex(shownY, shownM + 1, 1), monthHi = monthLo + days - 1, note = '';
    if (!known.length) note = 'The calendar hasn’t loaded yet.';
    else if (monthLo > hi || monthHi < lo) note = 'The event list covers ' + span(lo, hi) + ' only.';
    else if (monthHi > hi) note = 'The event list ends on ' + span(hi) + '.';
    else if (!list) note = 'No events this month.';
    ui.csNote.textContent = note;

    var now = new Date();
    var min = new Date(now.getFullYear(), now.getMonth() - MONTHS_BACK, 1);
    var max = new Date(now.getFullYear(), now.getMonth() + MONTHS_AHEAD, 1);
    ui.csPrev.disabled = first <= min;
    ui.csNext.disabled = first >= max;
  }

  function span(a, b) {
    function one(i) { var d = new Date(i * 86400000); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
    return b === undefined ? one(a) : one(a) + ' to ' + one(b);
  }

  /* ---- Opening and closing -------------------------------------------------------- */
  function open() {
    var p = CK.preview.get(), now = new Date();
    shownY = p ? p.y : now.getFullYear();
    shownM = p ? p.m : now.getMonth();
    render();
    if (isOpen) return;
    isOpen = true;
    ui.cs.classList.add('open');
    ui.cs.setAttribute('aria-hidden', 'false');
    try { history.pushState({ clockadashiCalendar: 1 }, ''); historyPushed = true; } catch (e) {}
    ui.csClose.focus({ preventScroll: true });
    touched();
  }

  function close(fromBackButton) {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(closeTimer);
    ui.cs.classList.remove('open');
    ui.cs.setAttribute('aria-hidden', 'true');
    if (ui.cs.contains(document.activeElement)) document.activeElement.blur();
    if (historyPushed && !fromBackButton) history.back();
    historyPushed = false;
  }

  function touched() {
    clearTimeout(closeTimer);
    if (isOpen) closeTimer = setTimeout(function () { close(false); }, CLOSE_AFTER_SEC * 1000);
  }

  function step(n) {
    var d = new Date(shownY, shownM + n, 1);
    shownY = d.getFullYear();
    shownM = d.getMonth();
    render();
  }

  function pick(e) {
    var btn = e.target.closest && e.target.closest('[data-d]');
    if (!btn) return;
    CK.preview.set({ y: shownY, m: shownM, d: +btn.getAttribute('data-d') });  // today ends the preview
    close(false);
  }

  ui.csClose.addEventListener('click', function () { close(false); });
  ui.csPrev.addEventListener('click', function () { step(-1); });
  ui.csNext.addEventListener('click', function () { step(1); });
  ui.csToday.addEventListener('click', function () { CK.preview.set(null); close(false); });
  ui.csGrid.addEventListener('click', pick);
  ui.csList.addEventListener('click', pick);
  ['pointerdown', 'keydown', 'wheel', 'scroll'].forEach(function (t) {
    ui.cs.addEventListener(t, touched, { passive: true, capture: true });
  });
  window.addEventListener('popstate', function () {  // Android back button closes it
    if (isOpen) { historyPushed = false; close(true); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) close(false); });
  CK.on('events', function () { if (isOpen) render(); });

  CK.calendar = { open: open, close: function () { close(false); }, lunarMonths: lunarMonths };
})();
