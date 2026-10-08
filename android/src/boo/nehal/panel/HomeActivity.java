package boo.nehal.panel;

import android.app.Activity;
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
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.List;

/**
 * The panel's home screen. Opens the clock after a short countdown, so a reboot,
 * power cut or Home press always ends on the clock. Tap "Stay here" to reach Settings.
 */
public class HomeActivity extends Activity {
  static final String PREFS = "panel";
  static final String CLOCK_URL = "https://clock.nehal.boo/";
  static final String CHROME = "com.android.chrome";
  static final int COUNTDOWN_SEC = 4;

  private final Handler h = new Handler();
  private TextView status;
  private int left;
  private boolean stay;

  private final Runnable tick = new Runnable() {
    @Override public void run() {
      if (stay) return;
      if (left <= 0) { openClock(); return; }
      status.setText("Opening the clock in " + left + "…");
      left--;
      h.postDelayed(this, 1000);
    }
  };

  private View bar;
  private float dp;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    startForegroundService(new Intent(this, KeeperService.class));
    dp = getResources().getDisplayMetrics().density;

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setGravity(Gravity.CENTER);
    root.setBackgroundColor(0xFF0D0D0F);
    root.setPadding(px(48), px(48), px(48), px(48));

    TextView title = new TextView(this);
    title.setText("Clockadashi");
    title.setTextColor(Color.WHITE);
    title.setTextSize(40);
    title.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
    title.setGravity(Gravity.CENTER);
    root.addView(title);

    status = new TextView(this);
    status.setTextColor(0xB3FFFFFF);
    status.setTextSize(20);
    status.setGravity(Gravity.CENTER);
    status.setPadding(0, px(12), 0, px(14));
    root.addView(status);

    // countdown bar: fills while the clock is about to open
    FrameLayout track = new FrameLayout(this);
    track.setBackground(rounded(0x26FFFFFF, 3));
    bar = new View(this);
    bar.setBackground(rounded(0xFFFFFFFF, 3));
    bar.setPivotX(0);
    track.addView(bar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(6)));
    LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(px(320), px(6));
    tp.bottomMargin = px(36);
    root.addView(track, tp);

    LinearLayout row = new LinearLayout(this);
    row.setGravity(Gravity.CENTER);
    root.addView(row);
    addTile(row, R.drawable.ic_clock, "Open clock", v -> openClock());
    addTile(row, R.drawable.ic_pause, "Stay here", v -> {
      stay = true;
      h.removeCallbacks(tick);
      bar.animate().cancel();
      status.setText("Staying on this screen");
    });
    addTile(row, R.drawable.ic_settings, "Settings", v -> leave(new Intent(Settings.ACTION_SETTINGS)));
    addTile(row, R.drawable.ic_wifi, "Wi‑Fi", v -> leave(new Intent(Settings.ACTION_WIFI_SETTINGS)));
    addTile(row, R.drawable.ic_bluetooth, "Bluetooth", v -> leave(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)));
    setContentView(root);
  }

  private int px(int dips) { return Math.round(dips * dp); }

  private GradientDrawable rounded(int color, int radiusDp) {
    GradientDrawable g = new GradientDrawable();
    g.setColor(color);
    g.setCornerRadius(radiusDp * dp);
    return g;
  }

  private void leave(Intent i) {
    stay = true;
    startActivity(i);
  }

  /** A large rounded tile: icon above its label. */
  private void addTile(LinearLayout row, int icon, String label, View.OnClickListener l) {
    LinearLayout tile = new LinearLayout(this);
    tile.setOrientation(LinearLayout.VERTICAL);
    tile.setGravity(Gravity.CENTER);
    StateListDrawable bg = new StateListDrawable();
    bg.addState(new int[] { android.R.attr.state_pressed }, rounded(0xFF34343A, 22));
    bg.addState(new int[] {}, rounded(0xFF1E1E23, 22));
    tile.setBackground(bg);
    tile.setClickable(true);
    tile.setFocusable(true);
    tile.setOnClickListener(l);

    ImageView img = new ImageView(this);
    img.setImageResource(icon);
    tile.addView(img, new LinearLayout.LayoutParams(px(44), px(44)));

    TextView text = new TextView(this);
    text.setText(label);
    text.setTextColor(Color.WHITE);
    text.setTextSize(17);
    text.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    text.setGravity(Gravity.CENTER);
    text.setPadding(0, px(10), 0, 0);
    tile.addView(text);

    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(px(140), px(128));
    lp.leftMargin = lp.rightMargin = px(8);
    row.addView(tile, lp);
  }

  @Override protected void onResume() {
    super.onResume();
    stay = false;
    left = COUNTDOWN_SEC;
    h.removeCallbacks(tick);
    h.post(tick);
    bar.animate().cancel();
    bar.setScaleX(0);
    bar.animate().scaleX(1).setDuration(COUNTDOWN_SEC * 1000L).setInterpolator(new LinearInterpolator()).start();
  }

  @Override protected void onPause() {
    super.onPause();
    h.removeCallbacks(tick);
    bar.animate().cancel();
  }

  @Override public void onBackPressed() { /* this is the home screen: nowhere to go back to */ }

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
        String pkg = sp.getString("sc_pkg", null), id = sp.getString("sc_id", null);
        if (id == null) {  // pinned before this app was installed, or prefs lost: look it up
          LauncherApps.ShortcutQuery q = new LauncherApps.ShortcutQuery()
              .setPackage(CHROME).setQueryFlags(LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED);
          List<ShortcutInfo> list = la.getShortcuts(q, Process.myUserHandle());
          if (list != null) for (ShortcutInfo si : list) {
            Intent in = si.getIntent();
            String data = in == null ? "" : String.valueOf(in.getDataString()) + in.getExtras();
            if (data.contains("clock.nehal.boo")) { pkg = si.getPackage(); id = si.getId(); break; }
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
