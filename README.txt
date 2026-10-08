CLOCKADASHI — wall clock with Ekadashi countdowns and offline music
=====================================================================

Static site, no build step. Hosted on GitHub Pages (clock.nehal.boo):
pushing to main deploys it, and the tablet picks the change up by itself.

  index.html     markup
  style.css      all styling
  app.js         clock, calendar, alert colours, offline data, updates, activity log
  player.js      music: mini player, full player, offline song library
  timers.js      kitchen timers
  sw.js          service worker (makes everything work without Wi-Fi)
  manifest.json  lets Android install it as a full-screen app
  fonts/         Google Sans Flex, cut down for this app (OFL licence)
  icons/         app icons
  events.csv     the calendar
  tracks.json    the song list
  music/         songs (.mp3) and artwork (.jpg)
  server/        song server for the Search tab (YouTube Music + yt-dlp);
                 runs on a computer or the tablet, not on GitHub Pages


WHAT THE SCREEN DOES
--------------------
Today's events across the top, the clock filling the middle, the date
under it, countdown bars along the bottom, then the kitchen timer button
and the music player bottom-right.

Type is Google Sans Flex, kept with the app so it works offline: the
clock uses a slightly narrow, slightly rounded setting so its digits can
be as tall as possible for reading across the room.

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


KITCHEN TIMERS
--------------
Tap the round timer button (left of the music player). A new timer
starts at the length of the last one started; 20 minutes the very first
time. Tap - or + to change it a minute at a time, or hold to change it
quickly. Start timer goes straight back to the clock, where the button
counts down the next timer to finish (+1, +2... when more are running).

Any number can run at once. In the timer screen each one has -1 and +1,
pause, and cancel (tap twice, so a stray touch can't cancel it).

When a timer finishes, the whole screen pulses blue and beeps, and any
music pauses. Stop ends it (the music carries on); +1 min gives it
another minute. Beeping stops after 10 minutes; the blue screen stays
until Stop. Timers survive a reload or restart, and the app never
applies an update while one is running.

Sound needs one tap on the screen after the app opens (a browser rule).
Starting a timer counts, so it only matters after a restart.


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
Top of player.js:
  CLOSE_AFTER_SEC    90   full player closes itself after this long
  SONG_SERVER        http://localhost:8790   default song server address
Top of timers.js:
  DEFAULT_MIN        20   first timer length, before one has been started
  MAX_MIN            720  longest timer (12 hours)
  RING_MIN           10   minutes of beeping before it goes quiet

If you change sw.js, bump VERSION inside it.
