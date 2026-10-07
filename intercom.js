/* =========================================================================
   Clockadashi — intercom.
   Hold the microphone next to the mini player to record; let go and it plays
   through the panel's speakers at full volume, then the volume goes back.
   The panel helper app (android/, http://127.0.0.1:8791) does the playing:
   it pauses the TV's Bluetooth audio and the music while you talk, sets
   full volume, plays, restores the volume and hands the audio back.
   Without the helper (e.g. on a computer) it plays in the page instead.
   ========================================================================= */
(function () {
  'use strict';
  var CK = window.CK;
  if (!CK) return;

  var HELPER = 'http://127.0.0.1:8791';
  var MIN_HOLD_MS = 400;      // shorter than this is a tap: just show the hint
  var MAX_HOLD_SEC = 60;      // recording stops itself after this long
  var MIC_IDLE_SEC = 120;     // the microphone is released after this long unused
  var LS_NO_MIC = 'clockadashi_no_mic';  // set once opening the mic failed: the button stays hidden

  var log = CK.log;
  var btn = document.getElementById('miniTalk');
  if (!btn) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder !== 'function') {
    btn.hidden = true;
    return;
  }

  var stream = null, idleTimer = 0, recorder = null, chunks = [], startedAt = 0, maxTimer = 0, holding = false;

  function helper(path, opts) {
    return CK.fetchWithin(HELPER + path, Object.assign({ cache: 'no-store' }, opts || {}), 8000)
      .then(function (r) { if (!r.ok) throw new Error('helper ' + r.status); return r.json(); });
  }
  function say(text) { if (CK.player && CK.player.flash) CK.player.flash(text); }
  function setState(s) {
    btn.classList.toggle('is-recording', s === 'recording');
    btn.classList.toggle('is-playing', s === 'playing');
    btn.setAttribute('aria-label', s === 'recording' ? 'Recording — let go to play' : 'Hold to talk');
  }

  function getMic() {
    clearTimeout(idleTimer);
    if (stream && stream.active) return Promise.resolve(stream);
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).then(function (s) { stream = s; return s; });
  }
  function releaseMicLater() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (stream && !recorder) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    }, MIC_IDLE_SEC * 1000);
  }

  function start() {
    if (recorder) return;
    holding = true;
    helper('/intercom/begin').catch(function () {});   // pause the TV + music so they aren't recorded
    getMic().then(function (s) {
      if (!holding) { releaseMicLater(); return; }       // let go before the mic was ready
      chunks = [];
      var type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      recorder = new MediaRecorder(s, type ? { mimeType: type } : undefined);
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = finished;
      recorder.start();
      startedAt = Date.now();
      setState('recording');
      maxTimer = setTimeout(stop, MAX_HOLD_SEC * 1000);
    }).catch(function (e) {
      holding = false;
      helper('/intercom/cancel').catch(function () {});
      log('intercom', 'microphone unavailable: ' + (e && e.name));
      if (e && e.name === 'NotAllowedError') { say('Allow the microphone to use the intercom'); return; }
      say('No microphone on this device');
      noMic(true);
    });
  }

  // Some devices (this panel included) list a microphone that can't actually be opened,
  // so the button hides after a real failure and comes back once a mic works (e.g. one plugged in).
  function noMic(missing) {
    btn.hidden = missing;
    if (missing) CK.lsSet(LS_NO_MIC, String(Date.now()));
    else CK.lsSet(LS_NO_MIC, '');
  }
  function recheckMic() {
    if (!CK.lsGet(LS_NO_MIC) || recorder || !navigator.permissions) return;
    navigator.permissions.query({ name: 'microphone' }).then(function (p) {
      if (p.state !== 'granted') return;  // only probe silently when it won't prompt
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        s.getTracks().forEach(function (t) { t.stop(); });
        log('intercom', 'microphone found');
        noMic(false);
      }, function () {});
    }).catch(function () {});
  }
  if (CK.lsGet(LS_NO_MIC)) btn.hidden = true;
  recheckMic();
  navigator.mediaDevices.addEventListener('devicechange', recheckMic);

  function stop() {
    holding = false;
    clearTimeout(maxTimer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function finished() {
    var held = Date.now() - startedAt, type = recorder.mimeType || 'audio/webm';
    recorder = null;
    setState('');
    releaseMicLater();
    if (held < MIN_HOLD_MS || !chunks.length) {
      helper('/intercom/cancel').catch(function () {});
      say('Hold the microphone to talk');
      return;
    }
    var clip = new Blob(chunks, { type: type });
    chunks = [];
    setState('playing');
    helper('/intercom/play', { method: 'POST', body: clip, headers: { 'Content-Type': type } })
      .then(function () { setTimeout(function () { setState(''); }, held + 500); })
      .catch(function (e) {
        // no helper: play it here (the page can't raise the system volume)
        log('intercom', 'helper unavailable (' + e.message + '), playing in the page');
        var a = new Audio(URL.createObjectURL(clip));
        a.volume = 1;
        a.onended = a.onerror = function () { URL.revokeObjectURL(a.src); setState(''); };
        a.play().catch(function () { setState(''); });
      });
  }

  btn.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch (err) {}
    start();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
    btn.addEventListener(t, function () { if (holding || recorder) stop(); });
  });
  btn.addEventListener('click', function (e) { e.preventDefault(); });
  btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  setState('');
})();
