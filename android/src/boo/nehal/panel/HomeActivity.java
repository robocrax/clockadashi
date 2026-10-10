package boo.nehal.panel;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.LauncherApps;
import android.content.pm.ShortcutInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Process;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.List;

/**
 * The panel's home screen: the Jellyclock alarm clock, a short countdown, then the clock opens,
 * so a reboot, power cut or Home press always ends on the clock. A tap anywhere pauses the
 * countdown (it starts again after a minute untouched). The four corners hold the things that
 * used to need a power cycle: the speaker app, restarting Bluetooth, restarting the clock,
 * and the panel's power menu.
 */
public class HomeActivity extends Activity {
  static final String PREFS = "panel";
  // served by this app (LocalSite), not the internet; kept in step with https://clock.nehal.boo
  static final String CLOCK_URL = "http://localhost:" + LocalSite.PORT + "/";
  static final String CHROME = "com.android.chrome";
  static final String SPEAKER_APP = "com.youzhuan.music";          // the panel maker's speaker / music app
  static final String SPEAKER_HOME = "com.youzhuan.musiclauncher"; // its old home screen, as a fallback
  static final int COUNTDOWN_SEC = 4;
  static final int PAUSED_SEC = 60;  // after a tap: this long untouched, then the countdown starts again

  private final Handler h = new Handler();
  private TextView status;
  private View bar;
  private float dp;
  private int left;
  private boolean paused;

  private final Runnable tick = new Runnable() {
    @Override public void run() {
      if (paused) return;
      if (left <= 0) { openClock(); return; }
      status.setText("Opening the clock in " + left + "…");
      left--;
      h.postDelayed(this, 1000);
    }
  };
  private final Runnable resume = this::startCountdown;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    startForegroundService(new Intent(this, KeeperService.class));
    dp = getResources().getDisplayMetrics().density;

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

    addCorner(root, Gravity.TOP | Gravity.START, R.drawable.ic_speaker, "Speaker", v -> openSpeakerApp());
    addCorner(root, Gravity.TOP | Gravity.END, R.drawable.ic_power, "Restart panel", v -> powerMenu());
    addCorner(root, Gravity.BOTTOM | Gravity.START, R.drawable.ic_refresh, "Refresh Bluetooth", v -> refreshBluetooth());
    addCorner(root, Gravity.BOTTOM | Gravity.END, R.drawable.ic_replay, "Restart clock", v -> restartClock());
    setContentView(root);
  }

  /* ---- Countdown: any tap pauses it ------------------------------------------- */
  private void startCountdown() {
    paused = false;
    left = COUNTDOWN_SEC;
    h.removeCallbacks(tick);
    h.removeCallbacks(resume);
    h.post(tick);
    bar.animate().cancel();
    bar.setScaleX(0);
    bar.animate().scaleX(1).setDuration(COUNTDOWN_SEC * 1000L).setInterpolator(new LinearInterpolator()).start();
  }

  private void pause(String why) {
    paused = true;
    h.removeCallbacks(tick);
    h.removeCallbacks(resume);
    h.postDelayed(resume, PAUSED_SEC * 1000L);
    bar.animate().cancel();
    bar.setScaleX(0);
    status.setText(why);
  }

  @Override public boolean dispatchTouchEvent(MotionEvent e) {
    if (e.getActionMasked() == MotionEvent.ACTION_DOWN) pause("Paused · tap Open clock when you're ready");
    return super.dispatchTouchEvent(e);
  }

  @Override protected void onResume() {
    super.onResume();
    startCountdown();
  }

  @Override protected void onPause() {
    super.onPause();
    h.removeCallbacks(tick);
    h.removeCallbacks(resume);
    bar.animate().cancel();
  }

  @Override public void onBackPressed() { /* this is the home screen: nowhere to go back to */ }

  /* ---- The corners ---------------------------------------------------------------- */
  private void openSpeakerApp() {
    Intent i = getPackageManager().getLaunchIntentForPackage(SPEAKER_APP);
    if (i == null) {
      i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
          .setComponent(new ComponentName(SPEAKER_HOME, SPEAKER_HOME + ".MainActivity")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }
    try { startActivity(i); } catch (Exception e) { status.setText("The speaker app isn't installed on this panel"); }
  }

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
