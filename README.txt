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
                               its countdown bar appears (default: 8)
  TIME_FORMAT_24H            — false = 12h clock with AM/PM (default),
                               true = 24h clock
  DATA_REFRESH_INTERVAL_MS   — how often events.csv/tracks.json are
                               re-checked (default: 24 hours)
  PLAYER_IDLE_HIDE_MS        — how long the music card stays visible with
                               no touch input before it hides (default:
                               2 minutes). Any tap anywhere brings it back.
  CLOCK_FIT_MARGIN_PX        — the buffer the auto-sized clock leaves
                               before it would touch the fullscreen icon
                               or either bottom corner (default: 20px)

events.csv FORMAT
------------------
  Date,Event,Type
  2026-06-11,Kamla Ekadashi,ProgressBar

- "Type" is optional — leave it blank for a normal day-of event that just
  shows the name on the day itself.
- A day can have more than one row/event — all of them are listed,
  stacked, in the bottom-left corner.
- Use "ProgressBar" as the Type for events that should also get a
  countdown bar in the days leading up to them (Ekadashis). It's shown
  separately, under the current day's own event(s), and progresses
  hour by hour (not just once at midnight). More than one can be active
  at once — they stack, soonest on top, each labelled with the day of
  the week it lands on (e.g. "Kamla Ekadashi — Friday") rather than a
  day count.

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

MUSIC PLAYER
------------
- Floating card, bottom-right corner: art, title, and a single play/pause
  button (icons swap on the same button — no separate play and pause
  buttons). No seek bar; tracks always start fresh.
- Tap anywhere on the card body (not the play/pause button) to slide out
  the full track list, in the same order as tracks.json. Tap any track
  to start it from the beginning and the list collapses back down. Tap
  anywhere outside the card also collapses it.
- The whole card hides itself after PLAYER_IDLE_HIDE_MS (default 2
  minutes) of no touch input, so it can't sit there distracting from the
  clock if the room is empty. Any tap anywhere on screen brings it back
  and resets the timer.

LAYOUT
------
- Bottom-left corner: today's event(s), then any active Ekadashi
  countdown bar(s) underneath. Plain text over the background — no
  card/border — since it's informational, not interactive. Its width is
  capped so it never reaches toward the music card's corner.
- Bottom-right corner: the music player (see above).
- Everything else is the clock. On load, and whenever the screen size
  or the bottom-left content changes, app.js measures the fullscreen
  icon and both bottom corners, then grows the clock's font size (via
  a quick binary search) until it's as large as possible while stopping
  CLOCK_FIT_MARGIN_PX short of touching any of them.

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
- No cards, shadows or rounded-card kit anywhere except the interactive
  music player — the bottom-left info block is plain text, so nothing
  but the clock competes for attention.

NOT YET BUILT (per our conversation — flagged for later)
-----------------------------------------------------------
- IVR-style loudspeaker button (hold to record from mic, release to
  play back at max volume) — intentionally left out of this version.
  Note for later: a web page can only control the in-app media volume,
  not the Android system volume — true system-volume control needs a
  native wrapper, not just Chrome.
