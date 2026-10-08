CLOCKADASHI — wall clock with Ekadashi countdowns and offline music
=====================================================================

Static site, no build step. Hosted on GitHub Pages (clock.nehal.boo):
pushing to main deploys it, and the tablet picks the change up by itself.

  index.html     markup
  style.css      all styling
  app.js         clock, calendar, alert colours, offline data, updates, activity log
  player.js      music: mini player, full player, offline song library
  intercom.js    hold-to-talk microphone next to the mini player
  timers.js      kitchen timers (button left of the mini player)
  fonts/         Manrope, served with the site so it works offline
  sw.js          service worker (makes everything work without Wi-Fi)
  manifest.json  lets Android install it as a full-screen app
  icons/         app icons
  events.csv     the calendar
  tracks.json    the song list
  music/         songs (.mp3) and artwork (.jpg)
  server/        song server for the Search tab (YouTube Music + yt-dlp);
                 runs on a computer or the tablet, not on GitHub Pages
  android/       "Clock Panel" helper app for the wall panel (see THE PANEL)


WHAT THE SCREEN DOES
--------------------
Today's events across the top, the clock filling the middle, the date
under it, countdown bars along the bottom, music player bottom-right.

The whole background is the Ekadashi alert (any "ProgressBar" event):

  most days            black
  4 to 2 days before   purple, deepening each day
  the day before       red (#830300), bar label reads "Tomorrow is ..."
  the day itself       saffron (#ed6d19), event name large at the top

A countdown bar appears 8 days before each ProgressBar event and fills
hour by hour. If two overlap, the soonest gets the big bar and the later
one a smaller bar underneath.


EVENTS.CSV
----------
  Date,Event,Type
  2026-10-22,Pashankusha Ekadashi,ProgressBar
  2026-10-21,Dashera

- Type "ProgressBar" = countdown bar + coloured days. Leave it blank for
  an event that just shows on its day.
- Several events on one day are all listed; a ProgressBar event leads.
- Names containing commas need quotes: 2026-01-01,"Name, with comma"


MUSIC
-----
Always visible bottom-right. Tap the song name or artwork to open the full
player (YouTube Music style): big artwork, seek bar, previous/next,
shuffle, repeat (all / one / off), volume, and the "Up next" list where a
tick means the song is saved on the tablet. The Android back button or
the arrow top-left closes it; it also closes itself after 90 seconds.

To add a song: put the .mp3 (and a .jpg) in music/, add an entry to
tracks.json, push. Within 30 minutes the tablet downloads it in the
background and keeps it for offline. Removing an entry removes the song
from the tablet too. Replacing a file under the same name is detected
within a day.

  { "id": "fagva", "sort_id": 10, "path": "music/fagva.mp3",
    "title": "Fagva", "author": "SSTW Festival of Golden Hearts",
    "image": "music/fagva.jpg" }

Square art and 16:9 video thumbnails both work.


SEARCH AND SAVE SONGS FROM YOUTUBE MUSIC
----------------------------------------
The full player's Search tab finds songs (or videos) on YouTube Music.
Tapping one sends its link to the song server, which downloads the audio
with yt-dlp; the clock then saves it like any other song and plays it.
It stays through refreshes, restarts and Wi-Fi drops. Songs added this
way have a bin icon in "Up next": tap it twice to remove the song.

The song server (server/ytdl_server.py) must be reachable from the
browser as http://localhost:8790 (an https page may only call plain http
on localhost).

  First time, on the computer (Python 3.10+, plus Deno or Node.js):
    cd server
    python -m venv .venv
    .venv\Scripts\pip install -r requirements.txt
  Start it:
    .venv\Scripts\python ytdl_server.py

  For the tablet, either:
  - with the tablet on USB or wireless debugging:
        adb reverse tcp:8790 tcp:8790
  - or run the same script on the tablet itself (Termux), or
  - give it another address over https: open the clock once with
        ?songserver=https://YOUR-SERVER&songtoken=SECRET
    and start the server with
        --host 0.0.0.0 --token SECRET --origin https://clock.nehal.boo

  To keep it running on this computer and the tunnel up through Wi-Fi drops
  and panel reboots, run server\panel-link.ps1 (starts the server, re-does
  "adb connect" + "adb reverse" every 30 s; log in server\panel-link.log).
  To start it at every logon, run once in PowerShell:
    $a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\Tom\Documents\GitHub\clockadashi\server\panel-link.ps1"'
    Register-ScheduledTask -TaskName 'Clockadashi panel link' -Action $a -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)

Chrome may ask once to let the clock reach "apps and services on this
device"; allow it. Downloads also stay in server/downloads (safe to
delete; the tablet keeps its own copies). When downloads start failing,
YouTube has changed something: update yt-dlp with
    .venv\Scripts\pip install -U "yt-dlp[default]"


OFFLINE AND WI-FI DROPS
-----------------------
- The first visit needs internet. After that the clock, calendar, alert
  colours and every saved song keep working with no network, including
  after a reboot.
- Songs download in 1 MB pieces. If Wi-Fi drops mid-download, only the
  piece in flight is lost and it resumes from there when Wi-Fi returns.
  The top-left corner shows "Saving songs for offline" while this runs.
- "Offline" in the top-left corner means the server can't be reached.
  The app checks every 2 minutes (every 30 seconds while offline) and
  catches up as soon as it's back.
- The calendar and song list are re-checked every 30 minutes.
- Android can clear website storage when space runs low. Installing the
  app (below) makes it far more likely Chrome keeps it permanently.


UPDATES
-------
The tablet re-checks the app files every 30 minutes. When something
changed it reloads itself, but only once nobody has touched the screen
for 90 seconds and no song is playing.

First deploy of this version: the old version can't update itself, so
reload the page on the tablet twice (the first reload installs it, the
second shows it).


INSTALLING ON THE TABLET
------------------------
Chrome menu > Add to Home screen > Install. Open it from the home screen
icon: it runs full screen with no browser bar, with no tap needed. In a
normal Chrome tab, tap anywhere to go full screen; the faint icon in the
top-right corner leaves full screen. The screen is kept awake while the
app is open.


In a normal Chrome tab on the panel, after 60 seconds untouched (and no
song playing) the page asks the panel helper app to reopen it as the
installed full-screen app (a web page can't go full screen without a tap).


KITCHEN TIMERS
--------------
The "Timer" button in the bottom-left corner (the first tap of each visit
throws a "Let's BAKE!" shower of cookies and cupcakes). Tap it for the sheet:
a new timer starts at the length used last time (20 minutes the first time),
−1 / +1 changes it a minute at a time, Start runs it. Run as many as you
like; each can be paused, given or lose a minute, or removed. While timers
run, the corner shows the next one in digits readable across the kitchen, and
a card beside it the two after that (+N more); the clock shrinks a little and
the Ekadashi bars move up a row to make room.
When one finishes the screen turns red with "Timer N is done": Stop, or
+1 min for a little longer. On the panel the helper app rings (TV and music
pause, volume at least 80%, everything put back afterwards; it stops by
itself after 3 minutes) and it rings on time even if the page is in the
background. Elsewhere the page chimes by itself. Timers survive reloads.


INTERCOM
--------
The round microphone right of the mini player: hold to record, let go and
it plays through the panel at full volume, then the volume goes back. On
the panel the helper app does the playing, so the TV's Bluetooth audio and
the music pause while you talk and carry on afterwards. The button hides
itself on devices whose microphone can't be opened (the wall panel's
built-in mic is switched off in its firmware; a USB microphone works) and
comes back when one works.


THE PANEL (android/)
--------------------
The "Clock Panel" helper app is the panel's home screen and runs a small
background service:
  - Serves the clock itself on http://localhost:8642: the copy bundled in the
    app to start with, replaced by any newer one published to clock.nehal.boo
    (so pushing to main still updates the panel). Songs come from
    clock.nehal.boo the first time and are kept on the panel. It opens with no
    internet and doesn't depend on GitHub Pages; "Offline" still means the
    internet can't be reached.
  - Home / boot: a 4-second countdown, then the clock opens as the installed
    full-screen app (Chrome menu > Install on http://localhost:8642, accepted
    by this app). "Stay here" reaches Settings, Wi-Fi and Bluetooth.
  - Reconnects the TV ("Living Room TV", any paired device with "TV" in its
    name) as the Bluetooth audio source whenever nothing is connected: at
    once when the TV appears, every 8 s for 3 minutes after it drops, every
    30 s otherwise. Turns Bluetooth back on if it is left off.
  - Brings the clock back if another app is left in front for 10 minutes.
  - Sets the amplifier's hardware volume the instant Android's volume changes
    (the vendor music app only copied it across every ~1.5 s, so TV volume
    changes reached the speakers late). Uses the panel's own driver library,
    libpt2314.so, which is not in git: build.ps1 explains how to fetch it.
  - Holds a high-performance Wi-Fi lock (no Wi-Fi power saving).
  - Dismisses "Google Play services" / Play Protect / physical keyboard
    notifications.
  - Intercom, timer alarms and full-screen requests from the page on
    http://127.0.0.1:8791.
android/panel-cleanup.sh removes the vendor apps (trackers, LAN remote control,
the slow volume echo) and the Wi-Fi password "Share" screen; see its comments.
Build: powershell -File android\build.ps1 (JDK 17 + Android build-tools 34 and
platform 29; signing key kept in %USERPROFILE%\.clockadashi). Install:
  adb install -r android\out\clockpanel.apk
  adb shell cmd package set-home-activity boo.nehal.panel/.HomeActivity
  adb shell appops set boo.nehal.panel SYSTEM_ALERT_WINDOW allow
  adb shell appops set boo.nehal.panel GET_USAGE_STATS allow
  adb shell cmd notification allow_listener boo.nehal.panel/.PromptBlocker
  adb shell settings put global hidden_api_policy 1
Undo: adb shell cmd package set-home-activity com.youzhuan.musiclauncher/.MainActivity
android/root/ holds an optional boot script that also switches off the Wi-Fi
driver's power saving and Bluetooth sleep (needs adb remount; not installed).


TESTING AND DIAGNOSTICS
-----------------------
- Preview any moment by adding ?now= to the address, for example
  clock.nehal.boo/?now=2026-10-21T20:00 shows the red day before
  Pashankusha Ekadashi. The clock runs on from there. Nothing is saved.
- Long-press the clock (1.5 s) for diagnostics: network history, which
  songs are saved, storage used, screen size, browser version, and an
  activity log (Wi-Fi lost/back, screen on/off, updates, errors) that
  survives reboots. From remote DevTools: CK.readLog() or CK.diag().


SETTINGS
--------
Top of app.js:
  COUNTDOWN_DAYS     8    days before a ProgressBar event its bar appears
  APPROACH_DAYS      4    purple tint starts this many days before
  PAD_HOURS          true 08:05:09 instead of 8:05:09 (keeps width fixed)
  SYNC_EVERY_MIN     30   calendar / song list / app update checks
  RELOAD_IDLE_SEC    90   idle time before an update is applied
  FULLSCREEN_IDLE_SEC 60  idle time before a browser tab reopens full screen
Top of player.js:
  CLOSE_AFTER_SEC    90   full player closes itself after this long
  SONG_SERVER        http://localhost:8790   default song server address

If you change sw.js, bump VERSION inside it.
