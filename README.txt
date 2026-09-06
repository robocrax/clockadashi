CLOCKADASHI — deployment notes
================================

FOLDER STRUCTURE (upload all of this as-is to your web server, no build step):

  clockadashi/
    index.html
    style.css
    app.js
    player.js
    sw.js
    manifest.json
    events.csv
    tracks.json
    music/
      fagva.mp3   fagva.jpg
      jamta.mp3   jamta.jpg
      aaj_mare.mp3
      naath.mp3   naath.jpg
      chesta.mp3

Add your actual .mp3/.jpg files into music/ — that folder is currently empty.
Paths must match tracks.json exactly (case-sensitive on most servers).

HOW IT WORKS
------------
- First load MUST have an internet connection once, so the service worker
  can cache the app shell and the player can start downloading music.
  After that first successful load, the whole thing works fully offline,
  including after a power cycle/reboot.
- events.csv and tracks.json are re-fetched at most every 24 hours
  (DATA_REFRESH_INTERVAL_MS in app.js). If a refresh fails (offline), the
  previously cached version keeps being used — nothing goes blank.
- If the device reconnects to the internet, a refresh is attempted
  immediately (in addition to the 24h schedule).
- Music files download one at a time in the background after load, to
  keep memory/network usage low on the device. A small "Downloading
  offline music X/Y" note appears near the player bar while this happens,
  and disappears once done. Tracks no longer listed in tracks.json are
  automatically deleted from the offline cache.

KEY SETTINGS (top of app.js)
-----------------------------
  PROGRESS_BAR_DAYS_BEFORE   — how many days before a "ProgressBar" event
                               the countdown strip appears (default: 8)
  TIME_FORMAT_24H            — false = 12h clock with AM/PM (default),
                               true = 24h clock
  DATA_REFRESH_INTERVAL_MS   — how often events.csv/tracks.json are
                               re-checked (default: 24 hours)

events.csv FORMAT
------------------
  Date,Event,Type
  2026-06-11,Kamla Ekadashi,ProgressBar

- "Type" is optional — leave it blank for a normal day-of event that just
  shows the name on the day itself.
- Use "ProgressBar" as the Type for events that should also get a
  countdown strip in the days leading up to them (Ekadashis). The
  countdown strip is shown separately from the current day's own event
  text — it never replaces or competes with it.

FULLSCREEN BEHAVIOR — IMPORTANT CAVEAT
----------------------------------------
- Tapping anywhere on screen requests fullscreen.
- The small icon (top-right) explicitly exits fullscreen when tapped.
- After 2 minutes of no touch input while NOT in fullscreen, the app
  tries to re-enter fullscreen automatically.

  Caveat: browsers require a fullscreen request to originate from a
  direct user tap/click. The 2-minute idle auto-re-fullscreen call is
  included as requested and works on some Android WebViews/kiosk
  browsers, but stock Chrome may silently block it since no tap
  triggered it. If it doesn't work reliably on your Youzhan tablet,
  the robust fix is launching Chrome with a kiosk flag, using Android's
  built-in kiosk/lock-task mode, or wrapping this page in a small native
  WebView app — happy to help with any of those if needed.

DESIGN NOTES
------------
- Palette is a deep indigo-night background with warm ivory text and a
  marigold/saffron accent — a nod to the devotional subject matter
  (Ekadashi, poojas) rather than a generic dark-mode UI. Dark background
  also helps a 24/7-running screen and keeps the bright bold clock as
  the clear visual anchor from a distance.
- Deliberately uses the system font stack (no downloaded webfont) —
  on an always-on low-power kiosk, this avoids an extra network
  dependency/cache entry and renders instantly, and system sans fonts
  are already clean and highly legible at large sizes.
- No cards, shadows or rounded-card kit anywhere — flat surfaces and a
  single hairline divider above the player bar, so nothing competes
  with the clock.
- The Ekadashi countdown strip sits at the very top of the screen with
  a thin bar, deliberately separate in position and style from the
  current day's event line, which sits directly under the clock.

NOT YET BUILT (per our conversation — flagged for later)
-----------------------------------------------------------
- IVR-style loudspeaker button (hold to record from mic, release to
  play back at max volume) — intentionally left out of this version.
  Note for later: a web page can only control the in-app media volume,
  not the Android system volume — true system-volume control needs a
  native wrapper, not just Chrome.
