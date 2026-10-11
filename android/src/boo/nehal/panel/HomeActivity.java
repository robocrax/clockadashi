package boo.nehal.panel;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.LauncherApps;
import android.content.pm.ShortcutInfo;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Process;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;
import java.util.List;

/**
 * The panel's home screen: the Jellyclock alarm clock, a short countdown, then the clock opens,
 * so a reboot, power cut or Home press always ends on the clock. A tap anywhere pauses the
 * countdown (it starts again after a minute untouched). The four corners hold the things that
 * used to need a power cycle: the speaker volume, restarting Bluetooth, restarting the clock,
 * and the panel's power menu. The keeper also opens this screen at 4 a.m. for a fresh start.
 */
public class HomeActivity extends Activity {
  static final String PREFS = "panel";
  // served by this app (LocalSite), not the internet; kept in step with https://clock.nehal.boo
  static final String CLOCK_URL = "http://localhost:" + LocalSite.PORT + "/";
  static final String CHROME = "com.android.chrome";
  static final String ACTION_FRESH_START = "boo.nehal.panel.FRESH_START";
  static final int COUNTDOWN_SEC = 4;
  static final int PAUSED_SEC = 60;  // after a tap: this long untouched, then the countdown starts again

  private final Handler h = new Handler();
  private TextView status, volumeText;
  private View bar, volumeSheet;
  private SeekBar volumeBar;
  private AudioManager am;
  private float dp;
  private long countdownStart;
  private boolean paused;

  // The bar and the seconds both follow one clock, so the bar fills exactly as the clock opens
  // (an animator would run at the panel's animation speed, which is set to half in Developer options).
  private final Runnable tick = new Runnable() {
    @Override public void run() {
      if (paused) return;
      long total = COUNTDOWN_SEC * 1000L, elapsed = SystemClock.uptimeMillis() - countdownStart;
      bar.setScaleX(Math.min(1f, elapsed / (float) total));
      if (elapsed >= total) { openClock(); return; }
      status.setText("Opening the clock in " + (int) Math.ceil((total - elapsed) / 1000.0) + "…");
      h.postDelayed(this, 16);
    }
  };
  private final Runnable resume = this::startCountdown;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    startForegroundService(new Intent(this, KeeperService.class));
    dp = getResources().getDisplayMetrics().density;
    am = getSystemService(AudioManager.class);

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(0xFF0D0D0F);

    LinearLayout middle = new LinearLayout(this);
    middle.setOrientation(LinearLayout.VERTICAL);
    middle.setGravity(Gravity.CENTER);
    root.addView(middle, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    ImageView clock = new ImageView(this);
    clock.setImageResource(R.drawable.ic_alarm_clock);
    middle.addView(clock, new LinearLayout.LayoutParams(px(250), px(250)));

    TextView title = new TextView(this);
    title.setText("Jellyclock");
    title.setTextColor(Color.WHITE);
    title.setTextSize(112);
    title.setTypeface(Typeface.create("sans-serif-black", Typeface.BOLD));
    title.setLetterSpacing(-0.03f);
    title.setIncludeFontPadding(false);
    title.setGravity(Gravity.CENTER);
    middle.addView(title);

    status = new TextView(this);
    status.setTextColor(0xB3FFFFFF);
    status.setTextSize(20);
    status.setGravity(Gravity.CENTER);
    status.setPadding(0, px(10), 0, px(12));
    middle.addView(status);

    // countdown bar: fills while the clock is about to open
    FrameLayout track = new FrameLayout(this);
    track.setBackground(rounded(0x26FFFFFF, 3));
    bar = new View(this);
    bar.setBackground(rounded(0xFFFFFFFF, 3));
    bar.setPivotX(0);
    track.addView(bar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(6)));
    LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(px(360), px(6));
    tp.bottomMargin = px(28);
    middle.addView(track, tp);

    LinearLayout row = new LinearLayout(this);
    row.setGravity(Gravity.CENTER);
    middle.addView(row);
    addTile(row, R.drawable.ic_clock, "Open clock", v -> openClock());
    addTile(row, R.drawable.ic_settings, "Settings", v -> leave(new Intent(Settings.ACTION_SETTINGS)));
    addTile(row, R.drawable.ic_wifi, "Wi‑Fi", v -> leave(new Intent(Settings.ACTION_WIFI_SETTINGS)));
    addTile(row, R.drawable.ic_bluetooth, "Bluetooth", v -> leave(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)));

    addCorner(root, Gravity.TOP | Gravity.START, R.drawable.ic_speaker, "Speaker", v -> showVolume());
    addCorner(root, Gravity.TOP | Gravity.END, R.drawable.ic_power, "Restart panel", v -> powerMenu());
    addCorner(root, Gravity.BOTTOM | Gravity.START, R.drawable.ic_refresh, "Refresh Bluetooth", v -> refreshBluetooth());
    addCorner(root, Gravity.BOTTOM | Gravity.END, R.drawable.ic_replay, "Restart clock", v -> restartClock());
    buildVolumeSheet(root);
    setContentView(root);
  }

  /* ---- Speaker volume: the panel's own control (the maker's speaker app is switched off) ---- */
  private void buildVolumeSheet(FrameLayout root) {
    FrameLayout scrim = new FrameLayout(this);
    scrim.setBackgroundColor(0xB3000000);
    scrim.setClickable(true);
    scrim.setOnClickListener(v -> hideVolume());
    scrim.setVisibility(View.GONE);

    LinearLayout card = new LinearLayout(this);
    card.setOrientation(LinearLayout.VERTICAL);
    card.setBackground(rounded(0xFF1E1E23, 28));
    card.setPadding(px(32), px(26), px(32), px(22));
    card.setClickable(true);  // taps on the card don't close it

    TextView title = label("Speaker volume", 24);
    title.setGravity(Gravity.START);
    card.addView(title);

    LinearLayout row = new LinearLayout(this);
    row.setGravity(Gravity.CENTER_VERTICAL);
    row.setPadding(0, px(18), 0, px(6));
    ImageView icon = new ImageView(this);
    icon.setImageResource(R.drawable.ic_speaker);
    row.addView(icon, new LinearLayout.LayoutParams(px(34), px(34)));
    volumeBar = new SeekBar(this);
    volumeBar.setMax(am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
    volumeBar.setProgressTintList(ColorStateList.valueOf(Color.WHITE));
    volumeBar.setThumbTintList(ColorStateList.valueOf(Color.WHITE));
    volumeBar.setPadding(px(22), px(14), px(22), px(14));
    volumeBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
      @Override public void onProgressChanged(SeekBar s, int v, boolean fromUser) {
        if (fromUser) am.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0);  // the keeper sets the amplifier
        showVolumeText();
      }
      @Override public void onStartTrackingTouch(SeekBar s) {}
      @Override public void onStopTrackingTouch(SeekBar s) {}
    });
    row.addView(volumeBar, new LinearLayout.LayoutParams(0, px(56), 1));
    volumeText = label("", 22);
    volumeText.setMinWidth(px(70));
    row.addView(volumeText);
    card.addView(row);

    TextView hint = label("The TV's volume buttons change this too while it plays here.", 15);
    hint.setTextColor(0xB3FFFFFF);
    hint.setGravity(Gravity.START);
    card.addView(hint);

    TextView done = label("Done", 18);
    done.setBackground(pressable(24));
    done.setPadding(px(30), 0, px(30), 0);
    done.setOnClickListener(v -> hideVolume());
    LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, px(52));
    dl.gravity = Gravity.END;
    dl.topMargin = px(20);
    card.addView(done, dl);

    scrim.addView(card, new FrameLayout.LayoutParams(px(600), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
    root.addView(scrim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    volumeSheet = scrim;
  }

  private void showVolume() {
    pause("Paused · tap Open clock when you're ready");
    volumeBar.setProgress(am.getStreamVolume(AudioManager.STREAM_MUSIC));
    showVolumeText();
    volumeSheet.setVisibility(View.VISIBLE);
  }

  private void hideVolume() { volumeSheet.setVisibility(View.GONE); }

  private void showVolumeText() {
    volumeText.setText(Math.round(volumeBar.getProgress() * 100f / Math.max(1, volumeBar.getMax())) + "%");
  }

  /* ---- Countdown: any tap pauses it ------------------------------------------- */
  private void startCountdown() {
    paused = false;
    countdownStart = SystemClock.uptimeMillis();
    h.removeCallbacks(tick);
    h.removeCallbacks(resume);
    bar.setScaleX(0);
    h.post(tick);
  }

  private void pause(String why) {
    paused = true;
    h.removeCallbacks(tick);
    h.removeCallbacks(resume);
    h.postDelayed(resume, PAUSED_SEC * 1000L);
    bar.setScaleX(0);
    status.setText(why);
  }

  @Override public boolean dispatchTouchEvent(MotionEvent e) {
    if (e.getActionMasked() == MotionEvent.ACTION_DOWN) pause("Paused · tap Open clock when you're ready");
    return super.dispatchTouchEvent(e);
  }

  @Override protected void onNewIntent(Intent i) {
    super.onNewIntent(i);
    setIntent(i);
  }

  @Override protected void onResume() {
    super.onResume();
    if (ACTION_FRESH_START.equals(getIntent().getAction())) {
      setIntent(new Intent());
      freshStart();
    } else {
      startCountdown();
    }
  }

  @Override protected void onPause() {
    super.onPause();
    h.removeCallbacks(tick);
    h.removeCallbacks(resume);
    hideVolume();
  }

  @Override public void onBackPressed() {  // this is the home screen: Back only closes the volume control
    hideVolume();
  }

  /** The keeper's nightly fresh start: it restarts Bluetooth; here the clock is closed and reopened. */
  private void freshStart() {
    pause("Nightly fresh start · Bluetooth and the clock are restarting");
    h.postDelayed(() -> getSystemService(ActivityManager.class).killBackgroundProcesses(CHROME), 1000);
    h.removeCallbacks(resume);
    h.postDelayed(resume, 15000);  // then the countdown, and the clock
  }

  /* ---- The corners ---------------------------------------------------------------- */

  /** Android's own power menu (Power off / Restart). */
  private void powerMenu() {
    if (PowerMenuService.show()) { status.setText("Choose Restart in the power menu"); return; }
    status.setText("Turn on “Jellyclock power menu” here once, then tap Restart panel again");
    try { startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); } catch (Exception ignored) {}
  }

  /** Bluetooth off and on again: clears a lagging or stuttering TV link without a power cycle. */
  private void refreshBluetooth() {
    startService(new Intent(this, KeeperService.class).setAction(KeeperService.ACTION_REFRESH_BT));
    pause("Restarting Bluetooth · the TV reconnects in about 15 seconds");
    h.removeCallbacks(resume);
    h.postDelayed(resume, 15000);  // then carry on to the clock
  }

  /** Closes the clock app completely and opens it fresh. */
  private void restartClock() {
    pause("Restarting the clock…");
    getSystemService(ActivityManager.class).killBackgroundProcesses(CHROME);
    h.postDelayed(this::openClock, 1500);
  }

  /* ---- Building blocks -------------------------------------------------------------- */
  private int px(int dips) { return Math.round(dips * dp); }

  private GradientDrawable rounded(int color, int radiusDp) {
    GradientDrawable g = new GradientDrawable();
    g.setColor(color);
    g.setCornerRadius(radiusDp * dp);
    return g;
  }

  private StateListDrawable pressable(int radiusDp) {
    StateListDrawable bg = new StateListDrawable();
    bg.addState(new int[] { android.R.attr.state_pressed }, rounded(0xFF34343A, radiusDp));
    bg.addState(new int[] {}, rounded(0xFF1E1E23, radiusDp));
    return bg;
  }

  private void leave(Intent i) { startActivity(i); }

  private TextView label(String text, float sp) {
    TextView t = new TextView(this);
    t.setText(text);
    t.setTextColor(Color.WHITE);
    t.setTextSize(sp);
    t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    t.setGravity(Gravity.CENTER);
    return t;
  }

  /** A large rounded tile: icon above its label. */
  private void addTile(LinearLayout row, int icon, String text, View.OnClickListener l) {
    LinearLayout tile = new LinearLayout(this);
    tile.setOrientation(LinearLayout.VERTICAL);
    tile.setGravity(Gravity.CENTER);
    tile.setBackground(pressable(22));
    tile.setClickable(true);
    tile.setFocusable(true);
    tile.setOnClickListener(l);

    ImageView img = new ImageView(this);
    img.setImageResource(icon);
    tile.addView(img, new LinearLayout.LayoutParams(px(40), px(40)));
    TextView t = label(text, 17);
    t.setPadding(0, px(8), 0, 0);
    tile.addView(t);

    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(px(140), px(108));
    lp.leftMargin = lp.rightMargin = px(8);
    row.addView(tile, lp);
  }

  /** A pill in one corner of the screen: icon beside its label. */
  private void addCorner(FrameLayout root, int gravity, int icon, String text, View.OnClickListener l) {
    LinearLayout pill = new LinearLayout(this);
    pill.setGravity(Gravity.CENTER_VERTICAL);
    pill.setBackground(pressable(32));
    pill.setPadding(px(18), 0, px(22), 0);
    pill.setClickable(true);
    pill.setFocusable(true);
    pill.setOnClickListener(l);

    ImageView img = new ImageView(this);
    img.setImageResource(icon);
    pill.addView(img, new LinearLayout.LayoutParams(px(30), px(30)));
    TextView t = label(text, 18);
    t.setPadding(px(10), 0, 0, 0);
    pill.addView(t);

    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, px(64), gravity);
    lp.setMargins(px(24), px(24), px(24), px(24));
    root.addView(pill, lp);
  }

  void openClock() {
    String problem = openClock(this);
    if (problem != null) status.setText(problem);
  }

  /**
   * The installed clock app (Chrome's shortcut: full screen, no address bar); else a normal
   * Chrome tab. Returns null, or what went wrong.
   */
  static String openClock(Context c) {
    LauncherApps la = c.getSystemService(LauncherApps.class);
    SharedPreferences sp = c.getSharedPreferences(PREFS, MODE_PRIVATE);
    String problem = null;
    try {
      if (la.hasShortcutHostPermission()) {
        // the shortcut Chrome pinned last ("Install" on the clock; PinActivity saves it). Launchers
        // can't see a shortcut's address, so if that's lost, take the newest pinned Chrome shortcut.
        String pkg = sp.getString("sc_pkg", null), id = sp.getString("sc_id", null);
        if (id == null) {
          LauncherApps.ShortcutQuery q = new LauncherApps.ShortcutQuery()
              .setPackage(CHROME).setQueryFlags(LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED);
          List<ShortcutInfo> list = la.getShortcuts(q, Process.myUserHandle());
          long newest = -1;
          if (list != null) for (ShortcutInfo si : list) {
            if (si.getLastChangedTimestamp() > newest) { newest = si.getLastChangedTimestamp(); pkg = si.getPackage(); id = si.getId(); }
          }
        }
        if (id != null) {
          la.startShortcut(pkg, id, null, null, Process.myUserHandle());
          return null;
        }
      }
    } catch (Exception e) {
      problem = "Shortcut failed (" + e.getMessage() + "), opened in Chrome";
    }
    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(CLOCK_URL));
    i.setPackage(CHROME);
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try { c.startActivity(i); } catch (Exception e) { problem = "Chrome not available: " + e.getMessage(); }
    return problem;
  }
}
