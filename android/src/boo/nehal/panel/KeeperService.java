package boo.nehal.panel;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
import java.util.HashMap;
import java.util.HashSet;
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
 *  - holds a high-performance Wi-Fi lock (no Wi-Fi power saving)
 *  - intercom on http://127.0.0.1:8791 for the clock page:
 *      GET  /ping             -> {"ok":true}
 *      GET  /open-clock       reopen the clock as the full-screen app (page idle in a normal tab)
 *      POST /alarm/schedule   {"timers":[{"id","end"}]}: the kitchen timers' end times; rings when
 *                             one passes (TV + music paused, volume up) until it leaves the list
 *      GET  /intercom/begin   pause TV + music (temporary audio focus) while recording
 *      POST /intercom/play    body = recorded audio; plays it at full volume, then restores
 *                             the volume and hands audio back to the TV / music
 *      GET  /intercom/cancel  give the audio back without playing anything
 */
public class KeeperService extends Service {
  static final String TAG = "ClockPanel";
  static final int PORT = 8791;
  static final int A2DP_SINK = 11;           // BluetoothProfile.A2DP_SINK (hidden constant)
  static final long LOOP_MS = 15000;
  static final long RETRY_CONNECT_MS = 30000;
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
  private int btOffCount;
  private ServerSocket server;

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public void onCreate() {
    super.onCreate();
    NotificationManager nm = getSystemService(NotificationManager.class);
    nm.createNotificationChannel(new NotificationChannel("keeper", "Panel keeper", NotificationManager.IMPORTANCE_MIN));
    Notification n = new Notification.Builder(this, "keeper")
        .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle("Clock panel")
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
    main.post(loop);
    startServer();
    startAmp();
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

  @Override public int onStartCommand(Intent i, int flags, int id) { return START_STICKY; }

  @Override public void onDestroy() {
    main.removeCallbacksAndMessages(null);
    try { unregisterReceiver(volumeChanged); } catch (IllegalArgumentException notRegistered) {}
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
      if (!wifiLock.isHeld()) wifiLock.acquire();
      main.postDelayed(this, LOOP_MS);
    }
  };

  private void checkBluetooth() {
    if (bt == null) return;
    if (!bt.isEnabled()) {
      // the vendor music app turns Bluetooth off and on by itself; only step in if it stays off
      if (++btOffCount >= 2) { Log.i(TAG, "Bluetooth stayed off, turning it on"); bt.enable(); btOffCount = 0; }
      return;
    }
    btOffCount = 0;
    if (sink == null) { bindSink(); return; }
    if (player != null || alarmTrack != null) return;  // don't page the TV mid-announcement or alarm

    int[] busy = { BluetoothProfile.STATE_CONNECTED, BluetoothProfile.STATE_CONNECTING };
    if (!sink.getDevicesMatchingConnectionStates(busy).isEmpty()) return;  // TV or a phone is on already
    long now = System.currentTimeMillis();
    if (now - lastConnectTry < RETRY_CONNECT_MS) return;
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

  /* ---- Kitchen timers: ring when one of the page's timers ends -------------- */
  static final int ALARM_VOLUME_PERCENT = 80;   // at least this loud while ringing
  static final long ALARM_MAX_MS = 180000;      // stop ringing by itself after 3 minutes
  private final Map<String, Long> timerEnds = new HashMap<>();
  private final Set<String> timedOut = new HashSet<>();  // rang for 3 minutes unanswered: don't restart
  private AudioTrack alarmTrack;
  private AudioFocusRequest alarmFocus;
  private int alarmSavedVolume = -1;
  private long ringingSince;

  /** The page sends every running timer's end time whenever anything changes. */
  private void scheduleTimers(Map<String, Long> ends) {
    timerEnds.clear();
    timerEnds.putAll(ends);
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
    if (alarmTrack != null && now - ringingSince > ALARM_MAX_MS) {
      for (Map.Entry<String, Long> e : timerEnds.entrySet()) if (e.getValue() <= now) timedOut.add(e.getKey());
      stopRinging();
    }
    long wait = alarmTrack != null ? 1000 : next - now;
    if (wait < Long.MAX_VALUE / 2) main.postDelayed(timerCheck, Math.max(50, Math.min(wait, 60000)));
  }

  private void startRinging() {
    Log.i(TAG, "timer done: ringing");
    ringingSince = System.currentTimeMillis();
    AudioAttributes attrs = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    alarmFocus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)  // TV + music pause
        .setAudioAttributes(attrs).setOnAudioFocusChangeListener(c -> {}).build();
    am.requestAudioFocus(alarmFocus);
    int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC), cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
    alarmSavedVolume = cur;
    am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(cur, max * ALARM_VOLUME_PERCENT / 100), 0);
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
    if (alarmFocus != null) { am.abandonAudioFocusRequest(alarmFocus); alarmFocus = null; }
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
          for (int i = 0; i < list.length(); i++) {
            JSONObject t = list.getJSONObject(i);
            ends.put(t.getString("id"), t.getLong("end"));
          }
          main.post(() -> scheduleTimers(ends));
          reply(out, 200, origin, "{\"ok\":true,\"timers\":" + ends.size() + "}");
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
