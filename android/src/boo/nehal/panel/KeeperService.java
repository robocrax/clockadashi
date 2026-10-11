package boo.nehal.panel;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothProfile;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.MediaPlayer;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.text.TextUtils;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs all the time:
 *  - sets the amplifier's hardware volume the moment Android's media volume changes (Amp)
 *  - reconnects the TV as a Bluetooth audio source whenever it isn't connected
 *  - turns Bluetooth back on if something leaves it off
 *  - watches the TV's audio around the clock and restarts Bluetooth when it keeps dropping;
 *    a fresh start of Bluetooth and the clock every night at 4 (see "Audio health")
 *  - holds a high-performance Wi-Fi lock (no Wi-Fi power saving)
 *  - intercom on http://127.0.0.1:8791 for the clock page:
 *      GET  /ping             -> {"ok":true}
 *      GET  /open-clock       reopen the clock as the full-screen app (page idle in a normal tab)
 *      POST /alarm/schedule   {"timers":[{"id","min","end"}]}: the kitchen timers' end times; rings
 *                             when one passes (TV + music paused, volume up) until it leaves the list
 *      GET  /alarm/status     timers restarted because the TV was played while they rang
 *      GET  /health           the TV link's recent trouble, and advice for the page to show
 *      GET  /intercom/begin   pause TV + music (temporary audio focus) while recording
 *      POST /intercom/play    body = recorded audio; plays it at full volume, then restores
 *                             the volume and hands audio back to the TV / music
 *      GET  /intercom/cancel  give the audio back without playing anything
 */
public class KeeperService extends Service {
  static final String TAG = "ClockPanel";
  static final int PORT = 8791;
  static final int A2DP_SINK = 11;           // BluetoothProfile.A2DP_SINK (hidden constant)
  static final long LOOP_MS = 5000;
  static final long RETRY_CONNECT_MS = 30000;        // TV off for a while: try every 30 s
  static final long RETRY_CONNECT_FAST_MS = 8000;    // just after it dropped or showed up: every 8 s
  static final long FAST_RETRY_FOR_MS = 180000;
  static final long RETURN_TO_CLOCK_MS = 10 * 60000; // another app left open this long: back to the clock
  static final long INTERCOM_SAFETY_MS = 90000;
  static final String[] ORIGINS = { "https://clock.nehal.boo", "http://localhost:8642", "http://127.0.0.1:8642" };

  private final Handler main = new Handler(Looper.getMainLooper());
  private BluetoothAdapter bt;
  private BluetoothProfile sink;
  private WifiManager.WifiLock wifiLock;
  private PowerManager.WakeLock cpuLock;
  private AudioManager am;
  private AudioFocusRequest focus;
  private MediaPlayer player;
  private int savedVolume = -1;
  private long lastConnectTry;
  private long tvLastSeen;  // when the TV last dropped, or reached us without audio
  private int btOffCount;
  private int loops;
  private ServerSocket server;

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public void onCreate() {
    super.onCreate();
    NotificationManager nm = getSystemService(NotificationManager.class);
    nm.createNotificationChannel(new NotificationChannel("keeper", "Panel keeper", NotificationManager.IMPORTANCE_MIN));
    Notification n = new Notification.Builder(this, "keeper")
        .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle("Jellyclock")
        .setContentText("Keeping the TV, Bluetooth and Wi‑Fi connected")
        .build();
    startForeground(1, n);

    am = getSystemService(AudioManager.class);
    WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "clockpanel");
    wifiLock.setReferenceCounted(false);
    wifiLock.acquire();
    cpuLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clockpanel:keeper");
    cpuLock.setReferenceCounted(false);
    cpuLock.acquire();

    bt = BluetoothAdapter.getDefaultAdapter();
    bindSink();
    IntentFilter tvFilter = new IntentFilter(BluetoothDevice.ACTION_ACL_CONNECTED);
    tvFilter.addAction(A2DP_SINK_STATE_CHANGED);
    registerReceiver(tvEvents, tvFilter, null, main);
    registerReceiver(bondChanged, new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED), null, main);
    registerReceiver(adapterState, new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), null, main);
    main.post(loop);
    main.post(streamWatch);
    startServer();
    new LocalSite(this).start();
    new SongServer(this).start();
    startAmp();
  }

  /* ---- The TV: react the moment it appears or drops, instead of waiting for the next try ---- */
  static final String A2DP_SINK_STATE_CHANGED = "android.bluetooth.a2dp-sink.profile.action.CONNECTION_STATE_CHANGED";

  private final BroadcastReceiver tvEvents = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) {
      BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
      BluetoothDevice tv = bt == null ? null : findTv();
      if (d == null || tv == null || !d.getAddress().equals(tv.getAddress())) return;
      String a = i.getAction();
      int state = i.getIntExtra(BluetoothProfile.EXTRA_STATE, -1);
      boolean wasConnected = i.getIntExtra(BluetoothProfile.EXTRA_PREVIOUS_STATE, -1) == BluetoothProfile.STATE_CONNECTED;
      if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(a)) {
        Log.i(TAG, "TV in range: connecting audio now");
        tvLastSeen = System.currentTimeMillis();
        lastConnectTry = 0;
        main.postDelayed(KeeperService.this::checkBluetooth, 1500);  // let the TV finish its own setup first
      } else if (A2DP_SINK_STATE_CHANGED.equals(a) && state == BluetoothProfile.STATE_DISCONNECTED && wasConnected) {
        // a real drop (a failed attempt while the TV is off goes CONNECTING -> DISCONNECTED: ignored)
        Log.i(TAG, "TV audio dropped: retrying every " + RETRY_CONNECT_FAST_MS / 1000 + " s for a while");
        tvLastSeen = System.currentTimeMillis();
        lastConnectTry = 0;
        // our own Bluetooth restart, Bluetooth crashing (counted on its own), or the TV being
        // switched off while silent, isn't link trouble
        if (tvLastSeen > refreshUntil && !crashedLately(60000) && wasStreamingLately()) {
          trouble(drops, DROP_WINDOW_MS, DROP_LIMIT, "TV audio dropped");
        }
      }
    }
  };

  private long retryInterval() {
    return System.currentTimeMillis() - tvLastSeen < FAST_RETRY_FOR_MS ? RETRY_CONNECT_FAST_MS : RETRY_CONNECT_MS;
  }

  /* ---- Which app is in front (usage access, granted with appops) ----------------- */
  static final String SETTINGS_APP = "com.android.settings";
  private String frontApp;  // null until known: nothing below acts on a guess
  private long frontSince, settingsLeftAt, usageSeen;

  private void updateFrontApp() {
    UsageStatsManager usm = getSystemService(UsageStatsManager.class);
    long now = System.currentTimeMillis();
    // the first time, far enough back to find whatever has been in front for days
    UsageEvents ev = usm.queryEvents(usageSeen == 0 ? now - 7 * 24 * 3600_000L : usageSeen - 2000, now);
    UsageEvents.Event e = new UsageEvents.Event();
    while (ev.hasNextEvent()) {
      ev.getNextEvent(e);
      if (e.getEventType() != UsageEvents.Event.MOVE_TO_FOREGROUND || e.getTimeStamp() < frontSince) continue;
      if (SETTINGS_APP.equals(frontApp) && !SETTINGS_APP.equals(e.getPackageName())) settingsLeftAt = e.getTimeStamp();
      frontApp = e.getPackageName();
      frontSince = e.getTimeStamp();
    }
    usageSeen = now;
  }

  /** Android's Settings is open, or was a moment ago (a pairing can finish just as it closes). */
  private boolean settingsInUse() {
    return SETTINGS_APP.equals(frontApp) || System.currentTimeMillis() - settingsLeftAt < 60000;
  }

  /* ---- Always back to the clock: another app left open for 10 minutes goes away ---- */
  private void returnToClockIfLeftOpen() {
    if (frontApp == null || frontApp.equals(getPackageName()) || frontApp.equals(HomeActivity.CHROME)) return;
    long open = System.currentTimeMillis() - frontSince;
    if (open < RETURN_TO_CLOCK_MS) return;
    Log.i(TAG, frontApp + " open for " + open / 60000 + " min: back to the clock");
    HomeActivity.openClock(this);
  }

  /* ---- Bluetooth stays private ----------------------------------------------------
     The panel is not discoverable, and only approved devices stay paired. A new device
     can only be added from Android's Bluetooth settings (its pairing screen makes the
     panel visible while it is open). Anything that pairs at any other time is unpaired
     again, and discovery is switched back off if something turns it on. The devices
     paired when this first runs are approved. */
  private void lockBluetooth() {
    if (bt == null || !bt.isEnabled() || frontApp == null) return;
    Set<BluetoothDevice> bonded = bt.getBondedDevices();
    if (bonded == null) return;
    SharedPreferences sp = getSharedPreferences(HomeActivity.PREFS, MODE_PRIVATE);
    Set<String> saved = sp.getStringSet("approved", null);
    boolean first = saved == null, inSettings = settingsInUse(), changed = first;
    Set<String> approved = first ? new HashSet<>() : new HashSet<>(saved);
    Set<String> paired = new HashSet<>();
    for (BluetoothDevice d : bonded) {
      String a = d.getAddress();
      paired.add(a);
      if (approved.contains(a)) continue;
      if (first || inSettings) {
        approved.add(a);
        changed = true;
        Log.i(TAG, "bluetooth: approved " + d.getName() + " (" + a + ")");
      } else {
        Log.i(TAG, "bluetooth: " + d.getName() + " (" + a + ") paired outside Settings: unpairing it");
        try { BluetoothDevice.class.getMethod("removeBond").invoke(d); } catch (Exception e) { Log.w(TAG, "unpair failed", e); }
      }
    }
    // forgetting a device (done in Settings) withdraws its approval
    if (SETTINGS_APP.equals(frontApp) && !paired.isEmpty() && approved.retainAll(paired)) changed = true;
    if (changed) sp.edit().putStringSet("approved", approved).apply();

    // visible only while Settings is actually in front (no grace period for this)
    if (!SETTINGS_APP.equals(frontApp) && bt.getScanMode() == BluetoothAdapter.SCAN_MODE_CONNECTABLE_DISCOVERABLE) {
      try {
        BluetoothAdapter.class.getMethod("setScanMode", int.class).invoke(bt, BluetoothAdapter.SCAN_MODE_CONNECTABLE);
        Log.i(TAG, "bluetooth: discovery switched off");
      } catch (Exception e) {
        Log.w(TAG, "could not switch discovery off", e);
      }
    }
  }

  private final BroadcastReceiver bondChanged = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) {  // check a new pairing at once, not at the next loop
      try { updateFrontApp(); lockBluetooth(); } catch (Exception e) { Log.w(TAG, "bond check", e); }
    }
  };

  /* ---- "Refresh Bluetooth" on the home screen: off, wait until it is off, on again ---- */
  static final String ACTION_REFRESH_BT = "boo.nehal.panel.REFRESH_BT";
  private long refreshUntil;

  private void refreshBluetooth() {
    if (bt == null || System.currentTimeMillis() < refreshUntil) return;
    Log.i(TAG, "Bluetooth refresh: turning it off");
    refreshUntil = System.currentTimeMillis() + 20000;
    bt.disable();
    main.postDelayed(new Runnable() {
      int waited;
      @Override public void run() {
        if (bt.getState() != BluetoothAdapter.STATE_OFF && ++waited < 12) { main.postDelayed(this, 1000); return; }
        Log.i(TAG, "Bluetooth refresh: turning it on, then reconnecting the TV");
        bt.enable();
        tvLastSeen = System.currentTimeMillis();  // retry the TV every few seconds for a while
        lastConnectTry = 0;
      }
    }, 2000);
  }

  /* ---- Audio health, around the clock ------------------------------------------------
     What an ordinary app can see of the TV link: the TV's audio dropping, Bluetooth stopping
     by itself (its process crashing), and the TV's stream stopping and starting again within
     a moment, over and over. Enough of these close together and Bluetooth is restarted, as
     "Refresh Bluetooth" does, at most every half hour. If three of those in two hours don't
     help, it stops trying and the clock page suggests restarting the panel (an app can't
     restart Android). Bluetooth crashing is counted apart: restarting it can't help (on this
     panel it is Android's CheckJNI check aborting on some TV titles), so nothing is restarted
     for a while after a crash and the clock page says what is happening instead.
     Every night at 4, with nothing playing and no timer about to ring, Bluetooth and the
     clock get a fresh start. */
  static final long DROP_WINDOW_MS = 10 * 60000;  // 2 drops in 10 minutes: unstable
  static final int DROP_LIMIT = 2;
  static final long BLIP_WINDOW_MS = 3 * 60000;   // 5 stream stop-starts in 3 minutes: unstable
  static final int BLIP_LIMIT = 5;
  static final long BLIP_GAP_MS = 3000;           // stopped and playing again within this: a blip
  static final long AUTO_REFRESH_GAP_MS = 30 * 60000;
  static final long GIVE_UP_WINDOW_MS = 2 * 3600_000L;
  static final int GIVE_UP_AFTER = 3;
  static final int NIGHTLY_HOUR = 4;

  static final long CRASH_WINDOW_MS = 30 * 60000;  // 2 Bluetooth crashes in 30 minutes: say so on the clock
  static final long QUIET_AFTER_CRASH_MS = 10 * 60000;

  private final ArrayDeque<Long> drops = new ArrayDeque<>(), blips = new ArrayDeque<>(), autoRefreshes = new ArrayDeque<>();
  private final ArrayDeque<Long> crashes = new ArrayDeque<>();
  private final ArrayDeque<String> healthLog = new ArrayDeque<>();
  private boolean streaming;
  private long streamStoppedAt;
  private Method isA2dpPlaying;
  private boolean lookedForIsPlaying;

  private static int recent(ArrayDeque<Long> q, long window, long now) {
    while (!q.isEmpty() && now - q.peekFirst() > window) q.removeFirst();
    return q.size();
  }

  private void note(String what) {
    healthLog.addLast(new SimpleDateFormat("d MMM HH:mm", Locale.ROOT).format(new Date()) + "  " + what);
    while (healthLog.size() > 12) healthLog.removeFirst();
    Log.i(TAG, "audio health: " + what);
  }

  private void trouble(ArrayDeque<Long> q, long window, int limit, String what) {
    long now = System.currentTimeMillis();
    q.addLast(now);
    int n = recent(q, window, now);
    note(what + " (" + n + " in " + window / 60000 + " min)");
    if (n < limit || now < refreshUntil || alarmTrack != null || player != null) return;
    if (crashedLately(QUIET_AFTER_CRASH_MS)) return;  // a crashing stack isn't helped by a restart
    if (!autoRefreshes.isEmpty() && now - autoRefreshes.peekLast() < AUTO_REFRESH_GAP_MS) return;
    if (recent(autoRefreshes, GIVE_UP_WINDOW_MS, now) >= GIVE_UP_AFTER) return;  // not helping: see advice()
    autoRefreshes.addLast(now);
    drops.clear();
    blips.clear();
    note("TV audio unstable: restarting Bluetooth");
    refreshBluetooth();
  }

  /** Shown on the clock page when Bluetooth keeps crashing, or restarting it hasn't helped. */
  private String advice() {
    long now = System.currentTimeMillis();
    if (recent(crashes, CRASH_WINDOW_MS, now) >= 2) return "Bluetooth keeps crashing · TV titles (see README)";
    if (recent(autoRefreshes, GIVE_UP_WINDOW_MS, now) < GIVE_UP_AFTER) return "";
    return "TV sound keeps dropping · restart the panel (Home, top-right)";
  }

  private boolean crashedLately(long within) {
    return !crashes.isEmpty() && System.currentTimeMillis() - crashes.peekLast() < within;
  }

  private boolean wasStreamingLately() {
    return isA2dpPlaying == null || streaming || System.currentTimeMillis() - streamStoppedAt < 60000;
  }

  /** Whether the TV is streaming sound to us right now (false if this Android can't tell). */
  private boolean tvPlaying() {
    if (sink == null) return false;
    List<BluetoothDevice> on = sink.getConnectedDevices();
    if (on.isEmpty()) return false;
    if (!lookedForIsPlaying) {
      lookedForIsPlaying = true;
      try { isA2dpPlaying = sink.getClass().getMethod("isA2dpPlaying", BluetoothDevice.class); }
      catch (Exception e) { Log.w(TAG, "can't tell whether the TV is streaming: " + e); }
    }
    if (isA2dpPlaying == null) return false;
    try {
      for (BluetoothDevice d : on) if (Boolean.TRUE.equals(isA2dpPlaying.invoke(sink, d))) return true;
    } catch (Exception ignored) {}
    return false;
  }

  private final Runnable streamWatch = new Runnable() {
    @Override public void run() {
      try {
        boolean on = tvPlaying();
        long now = System.currentTimeMillis();
        boolean ours = alarmTrack != null || player != null || now < refreshUntil || crashedLately(60000);
        if (on && !streaming && !ours && streamStoppedAt > 0 && now - streamStoppedAt < BLIP_GAP_MS)
          trouble(blips, BLIP_WINDOW_MS, BLIP_LIMIT, "TV stream stopped and started again");
        if (!on && streaming) streamStoppedAt = now;
        streaming = on;
      } catch (Exception e) {
        Log.w(TAG, "stream watch", e);
      }
      main.postDelayed(this, 1000);
    }
  };

  private final BroadcastReceiver adapterState = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) {
      long now = System.currentTimeMillis();
      if (i.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1) == BluetoothAdapter.STATE_TURNING_OFF && now > refreshUntil) {
        crashes.addLast(now);
        note("Bluetooth stopped by itself (" + recent(crashes, CRASH_WINDOW_MS, now) + " in 30 min)");
      }
    }
  };

  /** 4 in the morning, once a day: Bluetooth off and on, and the clock reopened fresh. */
  private void nightly() {
    Calendar c = Calendar.getInstance();
    if (c.get(Calendar.HOUR_OF_DAY) != NIGHTLY_HOUR) return;
    String day = c.get(Calendar.YEAR) + "-" + c.get(Calendar.DAY_OF_YEAR);
    SharedPreferences sp = getSharedPreferences(HomeActivity.PREFS, MODE_PRIVATE);
    if (day.equals(sp.getString("nightly", ""))) return;
    long now = System.currentTimeMillis();
    if (streaming || am.isMusicActive() || alarmTrack != null || player != null) return;  // try again shortly
    for (long end : timerEnds.values()) if (end - now < 30 * 60000L) return;
    sp.edit().putString("nightly", day).apply();
    note("nightly fresh start: Bluetooth and the clock");
    refreshBluetooth();
    try {
      startActivity(new Intent(this, HomeActivity.class).setAction(HomeActivity.ACTION_FRESH_START)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    } catch (Exception e) {
      Log.w(TAG, "nightly clock restart", e);
    }
  }

  private String healthJson() throws Exception {
    long now = System.currentTimeMillis();
    boolean connected = sink != null && !sink.getConnectedDevices().isEmpty();
    String tv = connected ? (streaming ? "TV connected and playing" : "TV connected") : "TV not connected";
    StringBuilder s = new StringBuilder(tv).append("; ")
        .append(recent(drops, DROP_WINDOW_MS, now)).append(" drops in 10 min, ")
        .append(recent(blips, BLIP_WINDOW_MS, now)).append(" stream restarts in 3 min, ")
        .append(recent(crashes, CRASH_WINDOW_MS, now)).append(" Bluetooth crashes in 30 min");
    if (isA2dpPlaying == null && lookedForIsPlaying) s.append(" (stream state not visible on this Android)");
    if (!healthLog.isEmpty()) s.append("; recent: ").append(TextUtils.join(" | ", healthLog));
    JSONObject j = new JSONObject();
    j.put("ok", true);
    j.put("connected", connected);
    j.put("playing", streaming);
    j.put("advice", advice());
    j.put("summary", s.toString());
    return j.toString();
  }

  /* ---- Amplifier volume follows Android's media volume immediately ------- */
  private final BroadcastReceiver volumeChanged = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) {
      if (i.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1) != AudioManager.STREAM_MUSIC) return;
      Amp.setVolume(musicVolumePercent(i.getIntExtra("android.media.EXTRA_VOLUME_STREAM_VALUE", 0)));
    }
  };

  private int musicVolumePercent(int index) {
    int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
    return max == 100 ? index : Math.round(index * 100f / max);
  }

  private void startAmp() {
    if (!Amp.open()) return;
    Amp.setVolume(musicVolumePercent(am.getStreamVolume(AudioManager.STREAM_MUSIC)));
    registerReceiver(volumeChanged, new IntentFilter("android.media.VOLUME_CHANGED_ACTION"), null, main);
  }

  @Override public int onStartCommand(Intent i, int flags, int id) {
    if (i != null && ACTION_REFRESH_BT.equals(i.getAction())) refreshBluetooth();
    return START_STICKY;
  }

  @Override public void onDestroy() {
    main.removeCallbacksAndMessages(null);
    try { unregisterReceiver(volumeChanged); } catch (IllegalArgumentException notRegistered) {}
    try { unregisterReceiver(tvEvents); } catch (IllegalArgumentException notRegistered) {}
    try { unregisterReceiver(bondChanged); } catch (IllegalArgumentException notRegistered) {}
    try { unregisterReceiver(adapterState); } catch (IllegalArgumentException notRegistered) {}
    try { if (server != null) server.close(); } catch (Exception ignored) {}
    endIntercom();
    if (alarmTrack != null) stopRinging();
    if (wifiLock != null) wifiLock.release();
    if (cpuLock != null) cpuLock.release();
    super.onDestroy();
  }

  /* ---- Bluetooth: stay on, keep the TV connected ------------------------- */
  private void bindSink() {
    if (bt == null || sink != null) return;
    bt.getProfileProxy(this, new BluetoothProfile.ServiceListener() {
      @Override public void onServiceConnected(int profile, BluetoothProfile proxy) { sink = proxy; Log.i(TAG, "A2DP sink proxy ready"); }
      @Override public void onServiceDisconnected(int profile) { sink = null; }
    }, A2DP_SINK);
  }

  private final Runnable loop = new Runnable() {
    @Override public void run() {
      try { checkBluetooth(); } catch (Exception e) { Log.w(TAG, "loop", e); }
      try { updateFrontApp(); lockBluetooth(); } catch (Exception e) { Log.w(TAG, "bluetooth lock", e); }
      if (++loops % 6 == 0) {
        try { returnToClockIfLeftOpen(); } catch (Exception e) { Log.w(TAG, "return to clock", e); }
        try { nightly(); } catch (Exception e) { Log.w(TAG, "nightly", e); }
      }
      if (!wifiLock.isHeld()) wifiLock.acquire();
      main.postDelayed(this, LOOP_MS);
    }
  };

  private void checkBluetooth() {
    if (bt == null) return;
    if (!bt.isEnabled()) {
      // the vendor music app turns Bluetooth off and on by itself; only step in if it stays off
      if (++btOffCount >= 4) { Log.i(TAG, "Bluetooth stayed off, turning it on"); bt.enable(); btOffCount = 0; }
      return;
    }
    btOffCount = 0;
    if (sink == null) { bindSink(); return; }
    if (player != null || alarmTrack != null) return;  // don't page the TV mid-announcement or alarm

    int[] busy = { BluetoothProfile.STATE_CONNECTED, BluetoothProfile.STATE_CONNECTING };
    if (!sink.getDevicesMatchingConnectionStates(busy).isEmpty()) return;  // TV or a phone is on already
    long now = System.currentTimeMillis();
    if (now - lastConnectTry < retryInterval()) return;
    BluetoothDevice tv = findTv();
    if (tv == null) return;
    lastConnectTry = now;
    try {
      Method setPriority = sink.getClass().getMethod("setPriority", BluetoothDevice.class, int.class);
      setPriority.invoke(sink, tv, 100);  // PRIORITY_ON, so the stack accepts the connection
    } catch (Exception ignored) {}
    try {
      Method connect = sink.getClass().getMethod("connect", BluetoothDevice.class);
      Object ok = connect.invoke(sink, tv);
      Log.i(TAG, "connect " + tv.getName() + " -> " + ok);
    } catch (Exception e) {
      Log.w(TAG, "connect failed", e);
    }
  }

  /** The device saved as "tv", else the first paired device with "TV" in its name. */
  private BluetoothDevice findTv() {
    String want = getSharedPreferences(HomeActivity.PREFS, MODE_PRIVATE).getString("tv", "");
    Set<BluetoothDevice> bonded = bt.getBondedDevices();
    if (bonded == null) return null;
    for (BluetoothDevice d : bonded) if (d.getAddress().equalsIgnoreCase(want)) return d;
    for (BluetoothDevice d : bonded) {
      String n = d.getName();
      if (n != null && n.toUpperCase(Locale.ROOT).matches(".*\\bTV\\b.*")) return d;
    }
    return null;
  }

  /* ---- Intercom ------------------------------------------------------------ */
  private void beginIntercom() {
    main.removeCallbacks(reassert);
    if (savedVolume < 0) savedVolume = am.getStreamVolume(AudioManager.STREAM_MUSIC);
    if (focus == null) {
      AudioAttributes attrs = new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
      // transient: the TV stream and Chrome's music pause now and resume when we let go
      focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(attrs).setOnAudioFocusChangeListener(c -> {}).build();
      am.requestAudioFocus(focus);
    }
    main.removeCallbacks(safety);
    main.postDelayed(safety, INTERCOM_SAFETY_MS);
  }

  private void playIntercom(File f) {
    beginIntercom();
    stopPlayer();
    am.setStreamVolume(AudioManager.STREAM_MUSIC, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC), 0);
    try {
      MediaPlayer mp = new MediaPlayer();
      mp.setAudioAttributes(new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
      mp.setDataSource(f.getAbsolutePath());
      mp.setVolume(1f, 1f);
      mp.setOnCompletionListener(p -> main.postDelayed(this::endIntercom, 300));
      mp.setOnErrorListener((p, what, extra) -> { Log.w(TAG, "playback error " + what + "/" + extra); endIntercom(); return true; });
      mp.prepare();
      mp.start();
      player = mp;
    } catch (Exception e) {
      Log.w(TAG, "intercom playback", e);
      endIntercom();
    }
  }

  private void stopPlayer() {
    if (player == null) return;
    try { player.stop(); } catch (Exception ignored) {}
    player.release();
    player = null;
  }

  /** Volume back to what it was, TV and music get the audio back. */
  private void endIntercom() {
    main.removeCallbacks(safety);
    stopPlayer();
    if (savedVolume >= 0) {
      am.setStreamVolume(AudioManager.STREAM_MUSIC, savedVolume, 0);
      restoredVolume = savedVolume;
      savedVolume = -1;
      // a connected TV syncs volume over AVRCP (0-127) and echoes back a rounded value; set it again
      main.postDelayed(reassert, 1500);
    }
    if (focus != null) { am.abandonAudioFocusRequest(focus); focus = null; }
  }

  private int restoredVolume = -1;
  private final Runnable safety = this::endIntercom;
  private final Runnable reassert = () -> {
    if (restoredVolume >= 0 && savedVolume < 0) am.setStreamVolume(AudioManager.STREAM_MUSIC, restoredVolume, 0);
    restoredVolume = -1;
  };

  /* ---- Kitchen timers: ring when one of the page's timers ends --------------
     Only one thing plays at a time: the ringing pauses the TV and the music, and if the
     TV is played again while a timer rings (or anything else takes the speaker), the
     ringing stops and that timer starts again for its full length. The page hears about
     it from /alarm/status. */
  static final int ALARM_VOLUME_PERCENT = 80;   // at least this loud while ringing
  static final long ALARM_MAX_MS = 10 * 60000;  // stop ringing by itself after 10 minutes (timers.js RING_MIN)
  static final long OTHER_AUDIO_GRACE_MS = 2500; // the TV takes a moment to pause when the ringing starts
  private final Map<String, Long> timerEnds = new HashMap<>();
  private final Map<String, Integer> timerMinutes = new HashMap<>();
  private final Map<String, Long> postponed = new HashMap<>();  // restarted for the TV: new end, until the page has it
  private final Set<String> timedOut = new HashSet<>();  // rang for 10 minutes unanswered: don't restart
  private AudioTrack alarmTrack;
  private AudioFocusRequest alarmFocus;
  private int alarmSavedVolume = -1, alarmSavedAlarmVolume = -1;
  private long ringingSince;
  private boolean quietSinceRinging;  // the TV and music fell silent after the ringing started

  /** The page sends every running timer's end time and length whenever anything changes. */
  private void scheduleTimers(Map<String, Long> ends, Map<String, Integer> minutes) {
    // a timer restarted for the TV keeps its new end until the page sends that end back
    postponed.keySet().retainAll(ends.keySet());
    for (Map.Entry<String, Long> p : new HashMap<>(postponed).entrySet()) {
      long sent = ends.get(p.getKey());
      if (Math.abs(sent - p.getValue()) < 2000) postponed.remove(p.getKey());
      else ends.put(p.getKey(), p.getValue());
    }
    timerEnds.clear();
    timerEnds.putAll(ends);
    timerMinutes.clear();
    timerMinutes.putAll(minutes);
    timedOut.retainAll(ends.keySet());
    checkTimers();
  }

  private final Runnable timerCheck = this::checkTimers;

  private void checkTimers() {
    main.removeCallbacks(timerCheck);
    long now = System.currentTimeMillis(), next = Long.MAX_VALUE;
    boolean due = false;
    for (Map.Entry<String, Long> e : timerEnds.entrySet()) {
      if (timedOut.contains(e.getKey())) continue;
      if (e.getValue() <= now) due = true;
      else next = Math.min(next, e.getValue());
    }
    if (due && alarmTrack == null) startRinging();
    if (!due && alarmTrack != null) stopRinging();
    if (alarmTrack != null) {
      // the ringing is the only stream on STREAM_ALARM, so music being active means the TV or Chrome
      boolean other = am.isMusicActive() || streaming;
      if (!other) quietSinceRinging = true;
      else if (quietSinceRinging && now - ringingSince > OTHER_AUDIO_GRACE_MS) { otherAudioStarted("the TV is playing"); return; }
    }
    if (alarmTrack != null && now - ringingSince > ALARM_MAX_MS) {
      for (Map.Entry<String, Long> e : timerEnds.entrySet()) if (e.getValue() <= now) timedOut.add(e.getKey());
      stopRinging();
    }
    long wait = alarmTrack != null ? 500 : next - now;
    if (wait < Long.MAX_VALUE / 2) main.postDelayed(timerCheck, Math.max(50, Math.min(wait, 60000)));
  }

  /** Something else took the speaker while a timer rang: stop, and restart the ringing timers in full. */
  private void otherAudioStarted(String why) {
    if (alarmTrack == null) return;
    long now = System.currentTimeMillis();
    for (Map.Entry<String, Long> e : timerEnds.entrySet()) {
      if (e.getValue() > now || timedOut.contains(e.getKey())) continue;
      Integer min = timerMinutes.get(e.getKey());
      long end = now + Math.max(1, min == null ? 1 : min) * 60000L;
      e.setValue(end);
      postponed.put(e.getKey(), end);
      Log.i(TAG, why + ": stopped ringing, timer " + e.getKey() + " restarted for " + (min == null ? 1 : min) + " min");
    }
    stopRinging();
    checkTimers();
  }

  private void startRinging() {
    Log.i(TAG, "timer done: ringing");
    ringingSince = System.currentTimeMillis();
    quietSinceRinging = false;
    // USAGE_ALARM: the chime is on its own stream, so music still playing is somebody else
    AudioAttributes attrs = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    alarmFocus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)  // TV + music pause
        .setAudioAttributes(attrs).setOnAudioFocusChangeListener(c -> {
          if (c == AudioManager.AUDIOFOCUS_LOSS || c == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            main.post(() -> otherAudioStarted("audio taken by another app"));
          }
        }, main).build();
    am.requestAudioFocus(alarmFocus);
    // the amplifier follows the media volume, so that goes up too; the chime plays at full alarm volume
    int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC), cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
    alarmSavedVolume = cur;
    am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(cur, max * ALARM_VOLUME_PERCENT / 100), 0);
    alarmSavedAlarmVolume = am.getStreamVolume(AudioManager.STREAM_ALARM);
    am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
    short[] pcm = chime();
    alarmTrack = new AudioTrack.Builder()
        .setAudioAttributes(attrs)
        .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(CHIME_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setTransferMode(AudioTrack.MODE_STATIC)
        .setBufferSizeInBytes(pcm.length * 2)
        .build();
    alarmTrack.write(pcm, 0, pcm.length);
    alarmTrack.setLoopPoints(0, pcm.length, -1);
    alarmTrack.play();
  }

  private void stopRinging() {
    Log.i(TAG, "timer alarm stopped");
    if (alarmTrack != null) {
      try { alarmTrack.stop(); } catch (Exception ignored) {}
      alarmTrack.release();
      alarmTrack = null;
    }
    if (alarmSavedVolume >= 0) { am.setStreamVolume(AudioManager.STREAM_MUSIC, alarmSavedVolume, 0); alarmSavedVolume = -1; }
    if (alarmSavedAlarmVolume >= 0) {
      am.setStreamVolume(AudioManager.STREAM_ALARM, alarmSavedAlarmVolume, 0);
      alarmSavedAlarmVolume = -1;
    }
    if (alarmFocus != null) { am.abandonAudioFocusRequest(alarmFocus); alarmFocus = null; }
  }

  private String alarmJson() throws Exception {
    JSONArray moved = new JSONArray();
    for (Map.Entry<String, Long> p : postponed.entrySet()) moved.put(new JSONObject().put("id", p.getKey()).put("end", p.getValue()));
    return new JSONObject().put("ok", true).put("ringing", alarmTrack != null).put("postponed", moved).toString();
  }

  static final int CHIME_RATE = 44100;

  /** A rising three-note chime (C6 E6 G6) and a pause: 2 s, played in a loop. */
  private static short[] chime() {
    double[] notes = { 1046.5, 1318.5, 1568.0 };
    short[] pcm = new short[CHIME_RATE * 2];
    for (int k = 0; k < notes.length; k++) {
      int start = (int) (k * 0.22 * CHIME_RATE), len = (int) (0.7 * CHIME_RATE);
      for (int i = 0; i < len && start + i < pcm.length; i++) {
        double t = (double) i / CHIME_RATE;
        double env = Math.min(1, t / 0.01) * Math.exp(-t / 0.16);
        double s = Math.sin(2 * Math.PI * notes[k] * t) + 0.25 * Math.sin(4 * Math.PI * notes[k] * t);
        int v = pcm[start + i] + (int) (s / 1.25 * env * 0.5 * 32767);
        pcm[start + i] = (short) Math.max(-32768, Math.min(32767, v));
      }
    }
    return pcm;
  }

  /* ---- Tiny HTTP server on 127.0.0.1 --------------------------------------- */
  private void startServer() {
    Thread t = new Thread(() -> {
      while (true) {
        try {
          server = new ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1"));
          Log.i(TAG, "listening on 127.0.0.1:" + PORT);
          while (true) {
            Socket s = server.accept();
            new Thread(() -> handle(s), "panel-http").start();
          }
        } catch (Exception e) {
          Log.w(TAG, "server", e);
          try { Thread.sleep(5000); } catch (InterruptedException ie) { return; }
        }
      }
    }, "panel-server");
    t.setDaemon(true);
    t.start();
  }

  private void handle(Socket s) {
    try (Socket sock = s) {
      sock.setSoTimeout(20000);
      InputStream in = sock.getInputStream();
      String head = readHead(in);
      if (head == null) return;
      String[] lines = head.split("\r\n");
      String[] req = lines[0].split(" ");
      if (req.length < 2) return;
      String method = req[0], path = req[1];
      int q = path.indexOf('?');
      if (q >= 0) path = path.substring(0, q);
      String origin = "";
      int length = 0;
      for (String l : lines) {
        int c = l.indexOf(':');
        if (c < 0) continue;
        String k = l.substring(0, c).trim().toLowerCase(Locale.ROOT), v = l.substring(c + 1).trim();
        if (k.equals("origin")) origin = v;
        if (k.equals("content-length")) length = Integer.parseInt(v);
      }
      boolean allowed = origin.isEmpty();
      for (String o : ORIGINS) if (o.equals(origin)) allowed = true;
      OutputStream out = sock.getOutputStream();
      if (!allowed) { reply(out, 403, origin, "{\"error\":\"origin not allowed\"}"); return; }
      if (method.equals("OPTIONS")) { reply(out, 204, origin, null); return; }

      switch (path) {
        case "/ping":
          reply(out, 200, origin, "{\"ok\":true,\"app\":\"clockpanel\"}");
          break;
        case "/open-clock":
          // the page found itself in a normal Chrome tab and idle: reopen it as the full-screen app
          main.post(() -> {
            String problem = HomeActivity.openClock(this);
            Log.i(TAG, "open-clock" + (problem == null ? "" : ": " + problem));
          });
          reply(out, 200, origin, "{\"ok\":true}");
          break;
        case "/alarm/schedule": {
          if (length <= 0 || length > 65536) { reply(out, 400, origin, "{\"error\":\"no timers\"}"); break; }
          JSONArray list = new JSONObject(new String(readBody(in, length), StandardCharsets.UTF_8)).getJSONArray("timers");
          Map<String, Long> ends = new HashMap<>();
          Map<String, Integer> minutes = new HashMap<>();
          for (int i = 0; i < list.length(); i++) {
            JSONObject t = list.getJSONObject(i);
            ends.put(t.getString("id"), t.getLong("end"));
            minutes.put(t.getString("id"), t.optInt("min", 1));
          }
          main.post(() -> scheduleTimers(ends, minutes));
          reply(out, 200, origin, "{\"ok\":true,\"timers\":" + ends.size() + "}");
          break;
        }
        case "/alarm/status":
        case "/health": {
          String p = path;
          String[] json = new String[1];
          java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
          main.post(() -> {  // the timer and health state belong to the main thread
            try { json[0] = p.equals("/health") ? healthJson() : alarmJson(); }
            catch (Exception e) { Log.w(TAG, p, e); }
            done.countDown();
          });
          done.await(3, java.util.concurrent.TimeUnit.SECONDS);
          reply(out, json[0] == null ? 500 : 200, origin, json[0] == null ? "{\"error\":\"busy\"}" : json[0]);
          break;
        }
        case "/intercom/begin":
          main.post(this::beginIntercom);
          reply(out, 200, origin, "{\"ok\":true}");
          break;
        case "/intercom/cancel":
          main.post(this::endIntercom);
          reply(out, 200, origin, "{\"ok\":true}");
          break;
        case "/intercom/play":
          if (length <= 0 || length > 20 * 1024 * 1024) { reply(out, 400, origin, "{\"error\":\"no audio\"}"); break; }
          byte[] body = readBody(in, length);
          File f = new File(getCacheDir(), "intercom.webm");
          try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(body); }
          main.post(() -> playIntercom(f));
          reply(out, 200, origin, "{\"ok\":true,\"bytes\":" + body.length + "}");
          break;
        default:
          reply(out, 404, origin, "{\"error\":\"not found\"}");
      }
    } catch (Exception e) {
      Log.w(TAG, "request", e);
    }
  }

  private static String readHead(InputStream in) throws Exception {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    int c, match = 0;
    while ((c = in.read()) != -1) {
      b.write(c);
      match = (c == '\r' && (match == 0 || match == 2)) || (c == '\n' && (match == 1 || match == 3)) ? match + 1 : 0;
      if (match == 4) return b.toString("ISO-8859-1");
      if (b.size() > 16384) return null;
    }
    return null;
  }

  private static byte[] readBody(InputStream in, int length) throws Exception {
    byte[] buf = new byte[length];
    int off = 0;
    while (off < length) {
      int n = in.read(buf, off, length - off);
      if (n < 0) break;
      off += n;
    }
    return buf;
  }

  private static void reply(OutputStream out, int code, String origin, String json) throws Exception {
    byte[] body = json == null ? new byte[0] : json.getBytes(StandardCharsets.UTF_8);
    StringBuilder h = new StringBuilder("HTTP/1.1 " + code + (code < 300 ? " OK" : " Error") + "\r\n");
    if (!origin.isEmpty()) {
      h.append("Access-Control-Allow-Origin: ").append(origin).append("\r\n");
      h.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
      h.append("Access-Control-Allow-Headers: Content-Type\r\n");
      h.append("Access-Control-Allow-Private-Network: true\r\n");
      h.append("Vary: Origin\r\n");
    }
    h.append("Content-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\n");
    h.append("Content-Length: ").append(body.length).append("\r\n\r\n");
    out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
    out.write(body);
    out.flush();
  }
}
