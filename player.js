/* =========================================================================
   Clockadashi — music.
   A mini player that is always on screen, a full YouTube-Music-style player
   behind it, and an offline library: each song is downloaded in 1 MB pieces
   (a Wi-Fi drop only loses the piece in flight, and the download resumes
   from there) and is then played from the tablet's own storage.
   Songs come from tracks.json, plus any picked in the Search tab: those are
   fetched from YouTube by the song server (server/ytdl_server.py, yt-dlp)
   and then kept here like the rest.
   ========================================================================= */
(function () {
  'use strict';
  var CK = window.CK;
  if (!CK) return;

  var MEDIA_CACHE = 'clockadashi-media-v1';  // same name as v2, so songs already saved are kept
  var PARTS_CACHE = 'clockadashi-parts-v1';  // half-downloaded songs, one entry per piece
  var LEGACY_CACHES = ['ghanshyam-dj-v1'];   // the very first version saved songs here too
  var PIECE = 1024 * 1024;
  var CLOSE_AFTER_SEC = 90;                  // the full player slides away after this long untouched
  var RECHECK_FILES_HOURS = 24;              // look for songs replaced on the site this often
  var SONG_SERVER = 'http://localhost:8790'; // server/ytdl_server.py; change with ?songserver=
  var LS_PLAYER = 'clockadashi_player';
  var LS_DURATIONS = 'clockadashi_durations';
  var LS_CHECKED = 'clockadashi_media_checked_at';
  var LS_ADDED = 'clockadashi_added_songs';
  var LS_SERVER = 'clockadashi_song_server';

  var log = CK.log;
  function $(id) { return document.getElementById(id); }
  function noop() {}
  function readJSON(k) { try { return JSON.parse(CK.lsGet(k) || 'null'); } catch (e) { return null; } }

  var audio = $('audio');
  var ui = {};
  ['miniOpen', 'miniArt', 'miniPh', 'miniTitle', 'miniSub', 'miniPlay', 'miniNext', 'miniBar',
    'fp', 'fpClose', 'fpSwatch', 'fpHeadline', 'fpTime', 'fpArtBox', 'fpArt', 'fpArtPh', 'fpTitle', 'fpSub',
    'fpSeek', 'fpCur', 'fpDur', 'fpShuffle', 'fpPrev', 'fpPlay', 'fpNext', 'fpRepeat', 'fpVol', 'fpSaved',
    'fpQueue', 'tabQueue', 'tabSearch', 'paneQueue', 'paneSearch', 'searchForm', 'searchInput', 'searchNote',
    'searchResults'].forEach(function (id) { ui[id] = $(id); });

  // Where the song server is. Given once as ?songserver=...&songtoken=..., then remembered.
  var server = (function () {
    var s = readJSON(LS_SERVER) || {};
    var u = /[?&]songserver=([^&#]*)/.exec(location.search), k = /[?&]songtoken=([^&#]*)/.exec(location.search);
    if (u) s.url = decodeURIComponent(u[1]);
    if (k) s.token = decodeURIComponent(k[1]);
    if (u || k) CK.lsSet(LS_SERVER, JSON.stringify(s));
    return { url: String(s.url || SONG_SERVER).replace(/\/+$/, ''), token: s.token || '' };
  })();

  var baseList = [];                      // tracks.json
  var added = readJSON(LS_ADDED) || [];   // picked in the Search tab
  var tracks = [];   // both, sorted by sort_id
  var order = [];    // play order: indices into tracks
  var cur = -1;      // index into tracks
  var saved = {};    // storage key -> true once fully stored offline
  var saving = {};   // storage key -> 0..1 while downloading
  var inFlight = {}; // storage key -> promise, so nothing downloads twice at once
  var durations = readJSON(LS_DURATIONS) || {};
  var prefs = Object.assign({ shuffle: false, repeat: 'all', volume: 1, id: null, at: 0 }, readJSON(LS_PLAYER) || {});
  var wantPlay = false, pendingSeek = 0, errorRun = 0, dragging = false, playWhenReady = '';
  var isOpen = false, closeTimer = 0, flashTimer = 0, lastSecond = -1, lastKept = 0, lastUiAt = 0;

  /* ---- Helpers ------------------------------------------------------------- */
  function abs(p) { return new URL(p, location.href).href; }
  function songUrl(t) { return abs(t.path); }
  function fileName(url) { try { return decodeURIComponent(url.split('?')[0].split('/').pop()); } catch (e) { return url; } }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function savePrefs() { CK.lsSet(LS_PLAYER, JSON.stringify(prefs)); }
  function saveDurations() { CK.lsSet(LS_DURATIONS, JSON.stringify(durations)); }
  function indexOfId(id) {
    for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return i;
    return -1;
  }
  function isSaved(i) { return !!(tracks[i] && saved[songUrl(tracks[i])]); }
  // Songs from tracks.json can stream while online; searched songs play once saved.
  function playable(i) { var t = tracks[i]; return !!t && (isSaved(i) || (CK.net.online && !t.yt)); }
  // A searched song shows YouTube's artwork until its own copy is saved.
  function artFor(t) { return t.yt && !saved[abs(t.image)] ? t.thumb : t.image; }
  function loadedSrc() { return audio.getAttribute('src') || ''; }
  function duration() {
    if (isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    var t = tracks[cur];
    return (t && durations[t.id]) || 0;
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  /* ---- Song list ------------------------------------------------------------ */
  function addedTrack(a, n) {
    return { id: 'yt:' + a.id, sort_id: 1000000 + n, path: 'music/yt/' + a.id, image: 'music/yt/' + a.id + '.jpg',
      title: a.title, author: a.artist, yt: a.id, thumb: a.thumb || '' };
  }
  function applyLibrary() { setTracks(baseList.concat(added.map(addedTrack))); }

  function setTracks(list) {
    var keepId = tracks[cur] ? tracks[cur].id : prefs.id;
    var previous = order.map(function (i) { return tracks[i] && tracks[i].id; });
    tracks = list.filter(function (t) { return t && typeof t.path === 'string' && t.path; })
      .map(function (t, n) {
        return { id: String(t.id || t.path), sort: +t.sort_id || 0, n: n, path: t.path,
          title: String(t.title || fileName(t.path)), author: String(t.author || ''), image: t.image || '',
          yt: t.yt || '', thumb: t.thumb || '' };
      })
      .sort(function (a, b) { return a.sort - b.sort || a.n - b.n; });
    cur = indexOfId(keepId);
    if (cur < 0 && loadedSrc()) {  // the loaded song was taken off the list
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      wantPlay = false;
    }
    buildOrder(previous);
    if (cur < 0 && tracks.length) { cur = order[0]; prefs.at = 0; }
    renderQueue();
    renderNow();
    refreshSaved().then(function () {
      if (cur >= 0 && !loadedSrc()) prime(cur, prefs.id === tracks[cur].id ? prefs.at : 0);
      syncLibrary();
    });
  }

  // With shuffle on, an updated list keeps its shuffled order and new songs go last.
  function buildOrder(previous) {
    var natural = tracks.map(function (t, i) { return i; });
    if (!prefs.shuffle) { order = natural; return; }
    var pos = {};
    (previous || []).forEach(function (id, k) { if (id) pos[id] = k; });
    var known = natural.filter(function (i) { return pos[tracks[i].id] != null; })
      .sort(function (a, b) { return pos[tracks[a].id] - pos[tracks[b].id]; });
    var fresh = natural.filter(function (i) { return pos[tracks[i].id] == null; });
    if (known.length) { order = known.concat(fresh); return; }
    for (var i = fresh.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), x = fresh[i];
      fresh[i] = fresh[j];
      fresh[j] = x;
    }
    if (cur >= 0) { fresh.splice(fresh.indexOf(cur), 1); fresh.unshift(cur); }
    order = fresh;
  }

  /* ---- Playback ------------------------------------------------------------- */
  // Load a song without playing it (after a restart, so play resumes where it left off).
  function prime(i, at) {
    if (!playable(i)) return false;
    cur = i;
    pendingSeek = at || 0;
    audio.preload = 'metadata';
    audio.src = tracks[i].path;
    renderNow();
    return true;
  }

  function start() {
    wantPlay = true;
    if (audio.error) audio.load();  // a stream that dropped earlier: fetch it again
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function (e) {
        if (e && e.name === 'AbortError') return;  // another song was picked meanwhile
        log('music', 'could not start: ' + (e && e.name));
        renderPlaying();
      });
    }
  }

  function playIndex(i, at) {
    var t = tracks[i];
    if (!t) return;
    var same = cur === i && loadedSrc() === t.path;
    cur = i;
    prefs.id = t.id;
    prefs.at = Math.floor(at || 0);
    savePrefs();
    if (same && audio.readyState >= 1) audio.currentTime = at || 0;
    else {
      pendingSeek = at || 0;
      audio.preload = 'auto';
      audio.src = t.path;
    }
    start();
    renderNow();
  }

  function toggle() {
    if (!tracks.length) { flash(CK.net.online ? 'Search for a song to add one' : 'Connect to Wi‑Fi to load songs'); return; }
    if (!audio.paused) { wantPlay = false; audio.pause(); return; }
    if (cur >= 0 && loadedSrc() && playable(cur)) { start(); return; }
    if (cur >= 0 && playable(cur)) { playIndex(cur, prefs.id === tracks[cur].id ? prefs.at : 0); return; }
    step(1, false);
  }

  // Move through the play order, skipping songs that can't play right now.
  function step(dir, auto) {
    var n = order.length;
    if (!n) return;
    var p = order.indexOf(cur);
    if (p < 0) p = dir > 0 ? -1 : 0;
    for (var k = 1; k <= n; k++) {
      var q = p + dir * k;
      if (q >= n || q < 0) {
        if (auto && prefs.repeat === 'off') { endOfList(); return; }
        q = ((q % n) + n) % n;
      }
      if (playable(order[q])) { playIndex(order[q], 0); return; }
    }
    wantPlay = false;
    audio.pause();
    flash(CK.net.online ? 'Couldn’t play any song' : 'No songs saved for offline yet');
  }

  function prev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    step(-1, false);
  }

  function endOfList() {
    wantPlay = false;
    audio.pause();
    prefs.at = 0;
    if (order.length) {
      prefs.id = tracks[order[0]].id;
      if (!prime(order[0], 0)) cur = order[0];
    }
    savePrefs();
    renderNow();
  }

  function keepPosition(force) {
    var t = tracks[cur];
    if (!t || !loadedSrc()) return;
    var nowMs = Date.now();
    if (!force && nowMs - lastKept < 15000) return;
    lastKept = nowMs;
    prefs.id = t.id;
    prefs.at = Math.floor(audio.currentTime || 0);
    savePrefs();
  }

  function setBuffering(on) {
    ui.miniPlay.classList.toggle('is-buffering', on);
    ui.fpPlay.classList.toggle('is-buffering', on);
  }

  audio.addEventListener('loadedmetadata', function () {
    if (pendingSeek && pendingSeek < audio.duration - 2) {
      try { audio.currentTime = pendingSeek; } catch (e) {}
    }
    pendingSeek = 0;
    var t = tracks[cur];
    if (t && isFinite(audio.duration)) {
      var d = Math.round(audio.duration);
      if (durations[t.id] !== d) {
        durations[t.id] = d;
        saveDurations();
        updateRows();
      }
    }
    renderProgress(true);
    positionState();
  });
  audio.addEventListener('play', renderPlaying);
  audio.addEventListener('pause', function () { renderPlaying(); keepPosition(true); setBuffering(false); });
  audio.addEventListener('playing', function () { errorRun = 0; setBuffering(false); positionState(); });
  audio.addEventListener('waiting', function () { if (wantPlay) setBuffering(true); });
  audio.addEventListener('seeked', positionState);
  audio.addEventListener('timeupdate', function () { renderProgress(false); keepPosition(false); });
  audio.addEventListener('ended', function () {
    prefs.at = 0;
    savePrefs();
    if (prefs.repeat === 'one') { audio.currentTime = 0; start(); }
    else step(1, true);
  });
  audio.addEventListener('error', function () {
    var t = tracks[cur], err = audio.error;
    setBuffering(false);
    if (!t || !loadedSrc()) return;
    log('music', 'could not play ' + t.title + ' (media error ' + (err ? err.code : '?') + ')');
    if (wantPlay && ++errorRun < tracks.length) step(1, true);
    else { wantPlay = false; errorRun = 0; flash(CK.net.online ? 'Couldn’t play this song' : 'Needs Wi‑Fi — not saved yet'); renderPlaying(); }
  });

  /* ---- Lock screen / notification controls --------------------------------- */
  function mediaMeta(t) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata !== 'function') return;
    var art = artFor(t);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.author, album: 'Clockadashi',
        artwork: art ? [{ src: abs(art), sizes: '512x512', type: 'image/jpeg' }] : []
      });
    } catch (e) {}
  }
  function positionState() {
    var ms = navigator.mediaSession, d = audio.duration;
    if (!ms || !ms.setPositionState || !isFinite(d) || d <= 0) return;
    try { ms.setPositionState({ duration: d, position: Math.min(audio.currentTime || 0, d), playbackRate: 1 }); } catch (e) {}
  }
  if ('mediaSession' in navigator) {
    [['play', function () { if (audio.paused) toggle(); }],
      ['pause', function () { wantPlay = false; audio.pause(); }],
      ['previoustrack', prev],
      ['nexttrack', function () { step(1, false); }],
      ['seekto', function (d) { if (d && d.seekTime != null) audio.currentTime = d.seekTime; }],
      ['seekbackward', function (d) { audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); }],
      ['seekforward', function (d) { audio.currentTime = Math.min(duration(), audio.currentTime + ((d && d.seekOffset) || 10)); }]
    ].forEach(function (h) { try { navigator.mediaSession.setActionHandler(h[0], h[1]); } catch (e) {} });
  }

  /* ---- Rendering ------------------------------------------------------------ */
  function setArt(img, ph, src) {
    if (!src) {
      img.hidden = true;
      img.removeAttribute('src');
      ph.hidden = false;
      return;
    }
    if (img.getAttribute('src') !== src) img.src = src;
    img.hidden = false;
    ph.hidden = true;
  }
  [[ui.miniArt, ui.miniPh], [ui.fpArt, ui.fpArtPh]].forEach(function (pair) {
    pair[0].addEventListener('error', function () { pair[0].hidden = true; pair[1].hidden = false; fitArt(); });
  });
  ui.fpArt.addEventListener('load', fitArt);

  function renderNow() {
    var t = tracks[cur];
    if (!t) {
      ui.miniTitle.textContent = 'No music yet';
      if (!flashTimer) ui.miniSub.textContent = CK.net.online ? 'Open the player to search for songs' : 'Connect to Wi‑Fi to load songs';
      ui.fpTitle.textContent = 'No music yet';
      ui.fpSub.textContent = '';
      setArt(ui.miniArt, ui.miniPh, '');
      setArt(ui.fpArt, ui.fpArtPh, '');
      tint('');
    } else {
      var art = artFor(t);
      ui.miniTitle.textContent = t.title;
      if (!flashTimer) ui.miniSub.textContent = t.author;
      ui.fpTitle.textContent = t.title;
      ui.fpSub.textContent = t.author;
      setArt(ui.miniArt, ui.miniPh, art);
      setArt(ui.fpArt, ui.fpArtPh, art);
      tint(art);
      mediaMeta(t);
    }
    ui.miniOpen.setAttribute('aria-label', 'Open music player' + (t ? ', ' + t.title : ''));
    fitArt();
    renderPlaying();
    renderProgress(true);
    updateRows();
  }

  function renderPlaying() {
    var playing = !audio.paused && !audio.ended;
    var name = playing ? 'pause' : 'play', label = playing ? 'Pause' : 'Play';
    CK.setIcon(ui.miniPlay, name);
    CK.setIcon(ui.fpPlay, name);
    ui.miniPlay.setAttribute('aria-label', label);
    ui.fpPlay.setAttribute('aria-label', label);
    ui.fp.classList.toggle('is-playing', playing);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) {}
    }
  }

  function renderProgress(force) {
    var d = duration();
    var t = loadedSrc() ? (audio.currentTime || pendingSeek || 0) : (tracks[cur] && prefs.id === tracks[cur].id ? prefs.at : 0);
    var sec = Math.floor(t);
    if (!force && sec === lastSecond) return;
    lastSecond = sec;
    var pct = d > 0 ? Math.min(100, t / d * 100) : 0;
    ui.miniBar.style.width = pct + '%';
    if (isOpen && !dragging) {
      ui.fpSeek.value = String(Math.round(pct * 10));
      ui.fpSeek.style.setProperty('--p', pct + '%');
      ui.fpCur.textContent = fmt(t);
      ui.fpDur.textContent = d > 0 ? fmt(d) : '–:––';
    }
  }

  function renderModes() {
    ui.fpShuffle.classList.toggle('is-off', !prefs.shuffle);
    ui.fpShuffle.setAttribute('aria-pressed', String(prefs.shuffle));
    CK.setIcon(ui.fpRepeat, prefs.repeat === 'one' ? 'repeatOne' : 'repeat');
    ui.fpRepeat.classList.toggle('is-off', prefs.repeat === 'off');
    ui.fpRepeat.setAttribute('aria-label', prefs.repeat === 'one' ? 'Repeating this song' :
      prefs.repeat === 'all' ? 'Repeating all songs' : 'Repeat is off');
  }

  function renderVolume() {
    ui.fpVol.value = String(Math.round(prefs.volume * 100));
    ui.fpVol.style.setProperty('--p', Math.round(prefs.volume * 100) + '%');
  }

  // Big artwork keeps its own shape: square album art, or a 16:9 video thumbnail.
  function fitArt() {
    if (!isOpen) return;
    var bw = ui.fpArtBox.clientWidth, bh = ui.fpArtBox.clientHeight;
    if (!bw || !bh) return;
    var img = ui.fpArt, showImg = !img.hidden && img.naturalWidth > 0;
    var ar = showImg ? img.naturalWidth / img.naturalHeight : 1;
    var w = Math.min(bw, bh * ar), h = w / ar;
    var target = showImg ? img : ui.fpArtPh;
    target.style.width = Math.floor(w) + 'px';
    target.style.height = Math.floor(h) + 'px';
  }

  // YouTube Music tints the player with the artwork's colour; so do we.
  // (YouTube's own artwork can't be read this way, so searched songs get it once saved.)
  var tints = {};
  function tint(src) {
    if (!src) { setTint(''); return; }
    if (tints[src] != null) { setTint(tints[src]); return; }
    var img = new Image();
    img.onload = function () {
      tints[src] = averageTone(img);
      if (tracks[cur] && artFor(tracks[cur]) === src) setTint(tints[src]);
    };
    img.src = src;
  }
  function setTint(c) {
    if (c) ui.fp.style.setProperty('--tint', c);
    else ui.fp.style.removeProperty('--tint');
  }
  function averageTone(img) {
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 12;
      var x = c.getContext('2d');
      x.drawImage(img, 0, 0, 12, 12);
      var d = x.getImageData(0, 0, 12, 12).data, r = 0, g = 0, b = 0, w = 0;
      for (var i = 0; i < d.length; i += 4) {
        var k = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) + 10;  // favour colourful pixels
        r += d[i] * k; g += d[i + 1] * k; b += d[i + 2] * k; w += k;
      }
      return deepTone(r / w / 255, g / w / 255, b / w / 255);
    } catch (e) { return ''; }
  }
  function deepTone(r, g, b) {
    // Keep the hue, settle on a dark tone so white text always reads on it.
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2;
    if (mx !== mn) {
      var dd = mx - mn;
      s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      h = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      h *= 60;
    }
    return 'hsl(' + Math.round(h) + ',' + Math.round(Math.min(0.62, s) * 100) + '%,24%)';
  }

  /* ---- Song rows: "Up next" and search results share one layout -------------- */
  function makeRow(art, title, sub) {
    var row = document.createElement('div');
    row.className = 'q-row';
    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'q-main';
    var box = document.createElement('span');
    box.className = 'q-art';
    if (art) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = art;
      box.appendChild(img);
    } else box.innerHTML = CK.svg('note');
    var eq = document.createElement('span');
    eq.className = 'q-eq';
    eq.innerHTML = CK.svg('eq');
    box.appendChild(eq);
    var meta = document.createElement('span');
    meta.className = 'q-meta';
    var t = document.createElement('span');
    t.className = 'q-title';
    t.textContent = title;
    var s = document.createElement('span');
    s.className = 'q-sub';
    s.textContent = sub;
    meta.appendChild(t);
    meta.appendChild(s);
    var state = document.createElement('span');
    state.className = 'q-state';
    var dur = document.createElement('span');
    dur.className = 'q-dur';
    main.appendChild(box);
    main.appendChild(meta);
    main.appendChild(state);
    main.appendChild(dur);
    row.appendChild(main);
    return row;
  }

  function setState(node, icon, text, hint) {
    if (node.getAttribute('data-sig') === icon + text) return;
    node.setAttribute('data-sig', icon + text);
    node.innerHTML = icon ? CK.svg(icon) : '';
    if (text) node.appendChild(document.createTextNode(text));
    node.title = hint || '';
  }

  function renderQueue() {
    var frag = document.createDocumentFragment();
    order.forEach(function (i) {
      var t = tracks[i];
      var row = makeRow(artFor(t), t.title, t.author);
      row.setAttribute('data-i', String(i));
      if (t.yt) {
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ibtn q-remove';
        rm.setAttribute('aria-label', 'Remove ' + t.title);
        rm.innerHTML = CK.svg('remove');
        row.appendChild(rm);
      }
      frag.appendChild(row);
    });
    ui.fpQueue.textContent = '';
    ui.fpQueue.appendChild(frag);
    updateRows();
  }

  function updateRows() {
    var online = CK.net.online, rows = ui.fpQueue.children;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r], i = +row.getAttribute('data-i'), t = tracks[i];
      if (!t) continue;
      var url = songUrl(t), main = row.firstChild;
      row.classList.toggle('is-current', i === cur);
      row.classList.toggle('is-unavailable', !saved[url] && (!online || !!t.yt));
      if (saved[url]) setState(main.children[2], 'saved', '', 'Saved for offline');
      else if (saving[url] != null) setState(main.children[2], 'saving', Math.floor(saving[url] * 100) + '%', 'Saving for offline');
      else setState(main.children[2], '', !online ? 'Needs Wi‑Fi' : t.yt ? 'Not saved yet' : '', '');
      main.children[3].textContent = durations[t.id] ? fmt(durations[t.id]) : '';
    }
    if (!flashTimer || !isOpen) ui.fpSaved.textContent = savedSummary();
    updateResults();
    syncStatus();
  }

  function savedSummary() {
    var n = tracks.length, count = 0, busy = false;
    tracks.forEach(function (t) {
      if (saved[songUrl(t)]) count++;
      else if (saving[songUrl(t)] != null) busy = true;
    });
    if (!n) return '';
    if (count === n) return n === 1 ? 'Saved for offline' : 'All ' + n + ' songs saved for offline';
    if (busy) return 'Saving for offline: ' + count + ' of ' + n + ' done';
    return count + ' of ' + n + ' songs saved for offline';
  }

  // Small corner note on the clock screen while songs are downloading.
  function syncStatus() {
    var done = 0, active = null;
    tracks.forEach(function (t) {
      var u = songUrl(t);
      if (saved[u]) done++;
      else if (saving[u] != null) active = saving[u];
    });
    if (active == null || !CK.net.online) { CK.setStatus('music', ''); return; }
    CK.setStatus('music', 'Saving songs for offline: ' + done + ' of ' + tracks.length +
      ' (' + Math.floor(active * 100) + '%)', 'saving');
  }

  function flash(text) {
    clearTimeout(flashTimer);
    ui.miniSub.textContent = text;
    if (isOpen) ui.fpSaved.textContent = text;
    flashTimer = setTimeout(function () { flashTimer = 0; renderNow(); }, 4000);
  }

  // Removing a searched song takes two taps, so a stray touch can't delete it.
  function askRemove(btn, t) {
    if (btn.classList.contains('is-confirm')) { removeAdded(t); return; }
    btn.classList.add('is-confirm');
    btn.textContent = 'Remove';
    btn.setAttribute('aria-label', 'Tap again to remove ' + t.title);
    setTimeout(function () {
      if (!btn.isConnected) return;
      btn.classList.remove('is-confirm');
      btn.innerHTML = CK.svg('remove');
      btn.setAttribute('aria-label', 'Remove ' + t.title);
    }, 3000);
  }

  function removeAdded(t) {
    if (tracks[cur] === t && !audio.paused) step(1, false);
    added = added.filter(function (a) { return 'yt:' + a.id !== t.id; });
    CK.lsSet(LS_ADDED, JSON.stringify(added));
    log('music', 'removed ' + t.title);
    applyLibrary();  // the library sync that follows deletes its saved files
  }

  /* ---- Search (YouTube Music, through the song server) -------------------------- */
  var searchKind = 'songs', lastQuery = '', searchSeq = 0, results = [];

  function serverCall(path, method) {
    return CK.fetchWithin(server.url + path, { method: method || 'GET', cache: 'no-store',
      headers: server.token ? { 'X-Token': server.token } : {} }, 30000, function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || 'The song server answered ' + r.status);
        return body;
      });
    });
  }

  function serverProblem(e) {
    if (!CK.net.online) return 'Searching needs Wi‑Fi. Saved songs still play.';
    var m = (e && e.message) || '';
    if (/fetch|network|no answer|load failed/i.test(m)) {
      return 'Can’t reach the song server at ' + server.url.replace(/^https?:\/\//, '') +
        '. Start server/ytdl_server.py on the computer, then try again.';
    }
    return m;
  }

  function note(text) {
    ui.searchNote.textContent = text || '';
    ui.searchNote.hidden = !text;
  }

  function showTab(name) {
    var search = name === 'search';
    ui.paneQueue.hidden = search;
    ui.paneSearch.hidden = !search;
    ui.tabQueue.classList.toggle('is-active', !search);
    ui.tabSearch.classList.toggle('is-active', search);
    ui.tabQueue.setAttribute('aria-selected', String(!search));
    ui.tabSearch.setAttribute('aria-selected', String(search));
    if (search && !results.length) ui.searchInput.focus({ preventScroll: true });
  }

  function runSearch(query) {
    var q = String(query || '').trim();
    if (!q) return;
    lastQuery = q;
    var seq = ++searchSeq;
    note('Searching YouTube Music…');
    serverCall('/search?q=' + encodeURIComponent(q) + '&type=' + searchKind).then(function (data) {
      if (seq !== searchSeq) return;
      results = (data.results || []).filter(function (r) { return r && r.id; });
      renderResults();
      note(results.length ? '' : 'Nothing found for “' + q + '”. Try other words, or switch to ' +
        (searchKind === 'songs' ? 'Videos.' : 'Songs.'));
    }, function (e) {
      if (seq !== searchSeq) return;
      results = [];
      renderResults();
      note(serverProblem(e));
    });
  }

  function renderResults() {
    var frag = document.createDocumentFragment();
    results.forEach(function (r, n) {
      var row = makeRow(r.thumb, r.title, r.artist);
      row.setAttribute('data-r', String(n));
      frag.appendChild(row);
    });
    ui.searchResults.textContent = '';
    ui.searchResults.scrollTop = 0;
    ui.searchResults.appendChild(frag);
    updateResults();
  }

  function updateResults() {
    var rows = ui.searchResults.children;
    for (var n = 0; n < rows.length; n++) {
      var r = results[+rows[n].getAttribute('data-r')];
      if (!r) continue;
      var key = abs('music/yt/' + r.id), main = rows[n].firstChild;
      if (saved[key]) setState(main.children[2], 'saved', '', 'Saved for offline');
      else if (saving[key] != null) setState(main.children[2], 'saving', Math.floor(saving[key] * 100) + '%', 'Saving');
      else setState(main.children[2], 'add', '', 'Save and play');
      rows[n].classList.toggle('is-current', !!(tracks[cur] && tracks[cur].yt === r.id));
      main.children[3].textContent = r.duration ? fmt(r.duration) : '';
    }
  }

  // Tapping a result: add it to the library, have the server fetch it with yt-dlp,
  // save it here, then play it.
  function addFromSearch(r) {
    var id = 'yt:' + r.id;
    if (!added.some(function (a) { return a.id === r.id; })) {
      added.push({ id: r.id, title: r.title, artist: r.artist, album: r.album || '', duration: r.duration || 0,
        thumb: r.thumb || '', kind: r.kind || 'song', addedAt: Date.now() });
      CK.lsSet(LS_ADDED, JSON.stringify(added));
      if (r.duration && !durations[id]) { durations[id] = r.duration; saveDurations(); }
      log('music', 'added ' + r.title + ' from YouTube Music');
      applyLibrary();
    }
    var i = indexOfId(id);
    if (i < 0) return;
    if (isSaved(i)) { playWhenReady = ''; playIndex(i, 0); return; }
    playWhenReady = id;
    fetchSong(tracks[i]);
  }

  function songItems(t) {
    return [{ key: songUrl(t), src: server.url + '/audio/' + t.yt, track: t },
      { key: abs(t.image), src: server.url + '/art/' + t.yt, track: t, art: true }];
  }

  function fetchSong(t) {
    if (!('caches' in window)) return;
    var items = songItems(t);
    caches.open(MEDIA_CACHE).then(function (media) {
      return saveItem(items[0], media).then(function () {
        if (playWhenReady === t.id) {
          playWhenReady = '';
          var i = indexOfId(t.id);
          if (i >= 0) playIndex(i, 0);
        }
        return saveItem(items[1], media).catch(noop).then(function () {
          if (tracks[cur] === t) renderNow();
        });
      });
    }).catch(function (e) {
      if (playWhenReady === t.id) playWhenReady = '';
      log('music', 'could not save ' + t.title + ': ' + e.message);
      flash('Couldn’t save ' + t.title);
      if (!ui.paneSearch.hidden) note(serverProblem(e));
    });
  }

  /* ---- Full player ---------------------------------------------------------- */
  var historyPushed = false;
  function openFull() {
    if (isOpen) return;
    isOpen = true;
    ui.fp.classList.add('open');
    ui.fp.setAttribute('aria-hidden', 'false');
    renderModes();
    renderVolume();
    updateRows();
    renderProgress(true);
    headerClock(CK.now());
    requestAnimationFrame(fitArt);
    var current = ui.fpQueue.querySelector('.is-current');
    if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
    try { history.pushState({ clockadashiPlayer: 1 }, ''); historyPushed = true; } catch (e) {}
    ui.fpClose.focus({ preventScroll: true });
    touched();
  }

  function closeFull(fromBackButton) {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(closeTimer);
    ui.fp.classList.remove('open');
    ui.fp.setAttribute('aria-hidden', 'true');
    if (ui.fp.contains(document.activeElement)) ui.miniOpen.focus({ preventScroll: true });
    if (historyPushed && !fromBackButton) history.back();
    historyPushed = false;
  }

  function touched() {
    clearTimeout(closeTimer);
    if (isOpen) {
      closeTimer = setTimeout(function () {
        if (dragging || document.activeElement === ui.searchInput) touched();  // never mid-drag or mid-typing
        else closeFull();
      }, CLOSE_AFTER_SEC * 1000);
    }
  }

  function headerClock(d) {
    var text = (d.getHours() % 12 || 12) + ':' + pad(d.getMinutes());
    if (ui.fpTime.textContent !== text) ui.fpTime.textContent = text;
  }

  window.addEventListener('popstate', function () {  // Android back button closes the player
    if (isOpen) { historyPushed = false; closeFull(true); }
  });
  ['pointerdown', 'keydown', 'wheel', 'scroll', 'input'].forEach(function (t) {
    ui.fp.addEventListener(t, touched, { passive: true, capture: true });
  });
  window.addEventListener('resize', function () { if (isOpen) requestAnimationFrame(fitArt); });

  /* ---- Controls --------------------------------------------------------------- */
  ui.miniOpen.addEventListener('click', openFull);
  ui.miniPlay.addEventListener('click', toggle);
  ui.miniNext.addEventListener('click', function () { step(1, false); });
  ui.fpClose.addEventListener('click', function () { closeFull(false); });
  ui.fpPlay.addEventListener('click', toggle);
  ui.fpNext.addEventListener('click', function () { step(1, false); });
  ui.fpPrev.addEventListener('click', prev);
  ui.fpShuffle.addEventListener('click', function () {
    prefs.shuffle = !prefs.shuffle;
    savePrefs();
    buildOrder();
    renderQueue();
    renderModes();
  });
  ui.fpRepeat.addEventListener('click', function () {
    prefs.repeat = prefs.repeat === 'all' ? 'one' : prefs.repeat === 'one' ? 'off' : 'all';
    savePrefs();
    renderModes();
  });
  ui.fpSeek.addEventListener('input', function () {
    dragging = true;
    var v = +ui.fpSeek.value;
    ui.fpSeek.style.setProperty('--p', v / 10 + '%');
    ui.fpCur.textContent = fmt(v / 1000 * duration());
  });
  ui.fpSeek.addEventListener('change', function () {
    dragging = false;
    var target = +ui.fpSeek.value / 1000 * duration();
    if (loadedSrc() && audio.readyState >= 1) audio.currentTime = target;
    else { pendingSeek = target; prefs.at = Math.floor(target); savePrefs(); }
    renderProgress(true);
  });
  ui.fpVol.addEventListener('input', function () {
    prefs.volume = +ui.fpVol.value / 100;
    audio.volume = prefs.volume;
    ui.fpVol.style.setProperty('--p', ui.fpVol.value + '%');
    savePrefs();
  });
  ui.fpQueue.addEventListener('click', function (e) {
    var row = e.target.closest && e.target.closest('.q-row');
    if (!row) return;
    var i = +row.getAttribute('data-i'), t = tracks[i];
    var rm = e.target.closest('.q-remove');
    if (rm) { if (t) askRemove(rm, t); return; }
    if (i === cur) { if (audio.paused) toggle(); return; }
    if (!playable(i)) { flash(t && t.yt && CK.net.online ? 'Still saving — it plays once saved' : 'Needs Wi‑Fi — not saved yet'); return; }
    playIndex(i, 0);
  });
  ui.tabQueue.addEventListener('click', function () { showTab('queue'); });
  ui.tabSearch.addEventListener('click', function () { showTab('search'); });
  ui.searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    ui.searchInput.blur();  // put the on-screen keyboard away so the results show
    runSearch(ui.searchInput.value);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.chip[data-kind]'), function (chip) {
    chip.addEventListener('click', function () {
      searchKind = chip.getAttribute('data-kind');
      Array.prototype.forEach.call(document.querySelectorAll('.chip[data-kind]'), function (c) {
        var on = c === chip;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', String(on));
      });
      if (lastQuery) runSearch(lastQuery);
    });
  });
  ui.searchResults.addEventListener('click', function (e) {
    var row = e.target.closest && e.target.closest('.q-row');
    var r = row && results[+row.getAttribute('data-r')];
    if (r) addFromSearch(r);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) closeFull(false);
    else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); toggle(); }
  });
  audio.volume = prefs.volume;

  /* ---- Offline library ---------------------------------------------------------
     Each file is fetched in 1 MB ranges into PARTS_CACHE, then joined into one
     entry in MEDIA_CACHE under its own address on this site (searched songs
     live at music/yt/<id>). sw.js serves that entry, slicing it for the audio
     player's range requests, so seeking works with no network at all. */
  var librarySyncing = false, syncAgain = false, retryTimer = 0, retryDelay = 30000, lastProblem = '';

  function refreshSaved() {
    if (!('caches' in window)) return Promise.resolve();
    return caches.open(MEDIA_CACHE).then(function (c) { return c.keys(); }).then(function (keys) {
      var have = {};
      keys.forEach(function (k) { have[k.url] = true; });
      saved = {};
      tracks.forEach(function (t) {
        var u = songUrl(t);
        if (have[u]) saved[u] = true;
        if (t.image && have[abs(t.image)]) saved[abs(t.image)] = true;
      });
      updateRows();
    }).catch(function (e) { log('music', 'could not read the offline library: ' + e.message); });
  }

  // Read the length of each saved song (a few KB from local storage) so the queue can show it.
  var learning = false;
  function learnDurations() {
    if (learning) return;
    var todo = tracks.filter(function (t) { return !durations[t.id] && saved[songUrl(t)]; });
    if (!todo.length) return;
    learning = true;
    var probe = new Audio();
    probe.preload = 'metadata';
    probe.muted = true;
    (function next() {
      var t = todo.shift();
      if (!t) { probe.removeAttribute('src'); probe.load(); learning = false; return; }
      var timer = 0;
      function done() {
        clearTimeout(timer);
        probe.onloadedmetadata = probe.onerror = null;
        if (isFinite(probe.duration) && probe.duration > 0) {
          durations[t.id] = Math.round(probe.duration);
          saveDurations();
          updateRows();
        }
        next();
      }
      timer = setTimeout(done, 15000);
      probe.onloadedmetadata = probe.onerror = done;
      probe.src = t.path;
    })();
  }

  // Everything that should be on the tablet: { key it's stored under, src to fetch from }.
  function wantedItems() {
    var items = [], seen = {};
    function add(it) { if (!seen[it.key]) { seen[it.key] = true; items.push(it); } }
    tracks.forEach(function (t) {  // artwork first: it's small
      if (t.image && !t.yt) add({ key: abs(t.image), src: abs(t.image), track: t, art: true });
    });
    var p = Math.max(0, order.indexOf(cur));
    for (var k = 0; k < order.length; k++) {
      var t = tracks[order[(p + k) % order.length]];
      if (t.yt) songItems(t).forEach(add);  // song first, so the server knows the artwork to use
      else add({ key: songUrl(t), src: songUrl(t), track: t });
    }
    return items;
  }

  function partKey(url, n) { return url + (url.indexOf('?') < 0 ? '?' : '&') + 'part=' + n; }

  function getRange(src, from, to) {
    var headers = { Range: 'bytes=' + from + '-' + to };
    if (server.token && src.indexOf(server.url) === 0) headers['X-Token'] = server.token;
    return CK.fetchWithin(src, { cache: 'no-store', headers: headers }, 90000, function (r) {
      if (r.status !== 200 && r.status !== 206) throw new Error('HTTP ' + r.status + ' for ' + fileName(src));
      var total = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') || '');
      return r.blob().then(function (b) {
        var size = total ? +total[1] : b.size;
        if (r.status === 206 && b.size !== Math.min(to, size - 1) - from + 1) throw new Error('piece of ' + fileName(src) + ' arrived incomplete');
        return { full: r.status === 200, blob: b, total: size, etag: r.headers.get('ETag') || '',
          type: r.headers.get('Content-Type') || (/\.jpe?g$/i.test(src) ? 'image/jpeg' : 'audio/mpeg') };
      });
    });
  }

  function storedResponse(blob, meta) {
    return new Response(blob, { headers: { 'Content-Type': meta.type, 'Content-Length': String(blob.size),
      'ETag': meta.etag || '', 'X-Saved-At': new Date().toISOString() } });
  }

  async function clearParts(parts, key) {
    var keys = await parts.keys();
    var prefix = partKey(key, '');
    for (var i = 0; i < keys.length; i++) if (keys[i].url.indexOf(prefix) === 0) await parts.delete(keys[i]);
  }

  async function download(key, src, media, onProgress) {
    var parts = await caches.open(PARTS_CACHE);
    var metaHit = await parts.match(partKey(key, 'meta'));
    var meta = metaHit ? await metaHit.json() : null;
    if (!meta) {
      var first = await getRange(src, 0, PIECE - 1);
      if (first.full) {  // the server ignored the range and sent everything
        await media.put(key, storedResponse(first.blob, first));
        return;
      }
      meta = { total: first.total, etag: first.etag, type: first.type, piece: PIECE };
      await parts.put(partKey(key, 0), new Response(first.blob));
      await parts.put(partKey(key, 'meta'), new Response(JSON.stringify(meta)));
    }
    var count = Math.ceil(meta.total / meta.piece);
    for (var n = 0; n < count; n++) {
      if (await parts.match(partKey(key, n))) { onProgress((n + 1) / count); continue; }
      if (!CK.net.online) throw new Error('offline');
      var from = n * meta.piece, to = Math.min(meta.total, from + meta.piece) - 1;
      var got = await getRange(src, from, to);
      if (got.full || got.total !== meta.total || (meta.etag && got.etag && got.etag !== meta.etag)) {
        await clearParts(parts, key);
        throw new Error(fileName(key) + ' changed on the server; starting it again');
      }
      await parts.put(partKey(key, n), new Response(got.blob));
      onProgress((n + 1) / count);
    }
    var blobs = [];
    for (n = 0; n < count; n++) blobs.push(await (await parts.match(partKey(key, n))).blob());
    var whole = new Blob(blobs, { type: meta.type });
    if (whole.size !== meta.total) {
      await clearParts(parts, key);
      throw new Error(fileName(key) + ' joined to the wrong size; starting it again');
    }
    await media.put(key, storedResponse(whole, meta));
    await clearParts(parts, key);
  }

  // A searched song: ask the server to fetch it from YouTube, and wait until it has.
  async function serverPrepare(t, onProgress) {
    var ask = '/download?id=' + encodeURIComponent(t.yt) + (t.thumb ? '&thumb=' + encodeURIComponent(t.thumb) : '');
    var st = await serverCall(ask, 'POST'), since = Date.now();
    while (st.state !== 'ready') {
      if (st.state === 'error') throw new Error(st.error || 'YouTube download failed');
      if (Date.now() - since > 30 * 60000) throw new Error('YouTube download took longer than 30 minutes');
      onProgress(st.progress || 0);
      await wait(1500);
      st = st.state === 'none' ? await serverCall(ask, 'POST') : await serverCall('/status?id=' + encodeURIComponent(t.yt));
    }
  }

  function progressTo(key, f) {
    saving[key] = f;
    if (Date.now() - lastUiAt > 1000) { lastUiAt = Date.now(); updateRows(); }
  }

  // Save one file (song or artwork) into the offline library. Safe to call twice.
  function saveItem(it, media) {
    if (inFlight[it.key]) return inFlight[it.key];
    var job = (async function () {
      if (await media.match(it.key)) { saved[it.key] = true; return; }
      if (!it.track.yt) {
        var legacy = await caches.match(it.key);  // saved by an older version under another name
        if (legacy && legacy.ok && legacy.type === 'basic') {
          await media.put(it.key, legacy);
          saved[it.key] = true;
          log('music', 'kept ' + fileName(it.key) + ' from the previous version');
          return;
        }
      }
      if (!CK.net.online) throw new Error('offline');
      saving[it.key] = 0;
      updateRows();
      var share = 0;
      if (it.track.yt && !it.art) {  // the YouTube part is most of the wait
        share = 0.8;
        await serverPrepare(it.track, function (f) { progressTo(it.key, f * share); });
      }
      await download(it.key, it.src, media, function (f) { progressTo(it.key, share + f * (1 - share)); });
      saved[it.key] = true;
      log('music', 'saved ' + (it.track.yt && !it.art ? it.track.title : fileName(it.key)) + ' for offline');
    })();
    inFlight[it.key] = job;
    function settle() { delete inFlight[it.key]; delete saving[it.key]; updateRows(); }
    job.then(settle, settle);
    return job;
  }

  // Once a day, ask the site whether a saved song was replaced (same name, new file).
  async function recheckSaved(media, items) {
    var last = +CK.lsGet(LS_CHECKED) || 0;
    if (!CK.net.online || Date.now() - last < RECHECK_FILES_HOURS * 3600000) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].src !== items[i].key) continue;  // only files hosted with the app
      var hit = await media.match(items[i].key);
      if (!hit) continue;
      var head;
      try { head = await CK.fetchWithin(items[i].key, { method: 'HEAD', cache: 'no-store' }, 20000); } catch (e) { return; }
      if (!head.ok) continue;
      var remote = +head.headers.get('Content-Length') || 0;
      var local = +hit.headers.get('Content-Length') || (await hit.blob()).size;
      if (remote && local && remote !== local) {
        await media.delete(items[i].key);
        delete saved[items[i].key];
        log('music', fileName(items[i].key) + ' was replaced on the server; downloading the new one');
      }
    }
    CK.lsSet(LS_CHECKED, String(Date.now()));
  }

  async function syncLibrary() {
    if (!('caches' in window) || !tracks.length) return;
    if (librarySyncing) { syncAgain = true; return; }
    librarySyncing = true;
    clearTimeout(retryTimer);
    var failed = 0, problem = '';
    try {
      var media = await caches.open(MEDIA_CACHE);
      var items = wantedItems(), wanted = {};
      items.forEach(function (it) { wanted[it.key] = true; });

      // Forget songs taken off tracks.json or removed from the library, and their half-downloads.
      var keys = await media.keys();
      for (var i = 0; i < keys.length; i++) {
        if (!wanted[keys[i].url]) { await media.delete(keys[i]); log('music', 'removed ' + fileName(keys[i].url) + ' from the tablet'); }
      }
      var parts = await caches.open(PARTS_CACHE), partKeys = await parts.keys();
      for (i = 0; i < partKeys.length; i++) {
        if (!wanted[partKeys[i].url.replace(/[?&]part=[^&]*$/, '')]) await parts.delete(partKeys[i]);
      }

      await recheckSaved(media, items);

      for (i = 0; i < items.length; i++) {
        var it = items[i];
        if (await media.match(it.key)) { saved[it.key] = true; continue; }
        if (!CK.net.online) break;
        try {
          await saveItem(it, media);
        } catch (e) {
          if (!it.track.yt || (e && e.name === 'QuotaExceededError')) throw e;
          failed++;  // the song server may be off: carry on with the others
          problem = 'could not save ' + it.track.title + ': ' + e.message;
        }
      }
      if (items.every(function (it) { return saved[it.key]; })) {
        LEGACY_CACHES.forEach(function (name) { caches.delete(name).catch(noop); });
      }
      learnDurations();
      if (failed) throw new Error(problem);
      retryDelay = 30000;
      lastProblem = '';
    } catch (e) {
      var message = (e && e.message) || String(e);
      if (e && e.name === 'QuotaExceededError') {
        log('music', 'tablet storage is full; saved what fits');
        lastProblem = 'storage full';
      } else {
        if (message !== lastProblem) log('music', 'saving paused: ' + message);
        lastProblem = message;
        if (CK.net.online) {  // offline: the 'net' event restarts us instead
          retryTimer = setTimeout(syncLibrary, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 15 * 60000);
        }
      }
    } finally {
      librarySyncing = false;
      updateRows();
      if (syncAgain) { syncAgain = false; setTimeout(syncLibrary, 1000); }
    }
  }

  /* ---- Wiring to app.js ---------------------------------------------------------- */
  CK.on('tracks', function (list) { baseList = list; applyLibrary(); });
  CK.on('sync', function () { syncLibrary(); });
  CK.on('net', function (online) {
    updateRows();
    if (!tracks[cur] && !flashTimer) renderNow();
    if (online) syncLibrary();
  });
  CK.on('tick', function (d) { if (isOpen) headerClock(d); });
  CK.on('view', function (v) {
    ui.fpHeadline.textContent = v.headline || '';
    ui.fpSwatch.hidden = v.state === 'calm' || !v.headline;
    ui.fpSwatch.style.background = v.color;
  });
  // First start with no song list saved yet: still show the songs picked in Search.
  document.addEventListener('DOMContentLoaded', function () { if (!tracks.length && added.length) applyLibrary(); });

  CK.player = {
    busy: function () { return isOpen || (!audio.paused && !audio.ended); },
    open: openFull,
    close: function () { closeFull(false); },
    // A kitchen timer going off pauses the music, and picks it up again after Stop.
    pauseForAlarm: function () {
      if (audio.paused) return false;
      audio.pause();
      return true;
    },
    resumeAfterAlarm: function () { if (audio.paused && loadedSrc()) start(); },
    describe: function () {
      var n = tracks.length, count = 0;
      var lines = tracks.map(function (t) {
        var u = songUrl(t);
        if (saved[u]) count++;
        return '  ' + (saved[u] ? 'saved   ' : saving[u] != null ? Math.floor(saving[u] * 100) + '%     ' : 'missing ') +
          t.title + (t.yt ? ' [YouTube ' + t.yt + ']' : '') + (durations[t.id] ? ' (' + fmt(durations[t.id]) + ')' : '');
      });
      return 'Music: ' + count + ' of ' + n + ' songs saved for offline' +
        (librarySyncing ? ', saving now' : '') + (lastProblem ? '; last problem: ' + lastProblem : '') +
        '\nSong server: ' + server.url + (server.token ? ' (with token)' : '') + '; ' + added.length +
        ' song' + (added.length === 1 ? '' : 's') + ' added from YouTube Music\n' + lines.join('\n');
    }
  };

  renderModes();
  renderVolume();
  renderNow();
})();
