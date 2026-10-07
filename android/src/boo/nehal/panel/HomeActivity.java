package boo.nehal.panel;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.LauncherApps;
import android.content.pm.ShortcutInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Process;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
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

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    startForegroundService(new Intent(this, KeeperService.class));

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setGravity(Gravity.CENTER);
    root.setBackgroundColor(Color.BLACK);
    root.setPadding(48, 48, 48, 48);

    TextView title = new TextView(this);
    title.setText("Clockadashi panel");
    title.setTextColor(Color.WHITE);
    title.setTextSize(28);
    title.setGravity(Gravity.CENTER);
    root.addView(title);

    status = new TextView(this);
    status.setTextColor(0xB3FFFFFF);
    status.setTextSize(18);
    status.setGravity(Gravity.CENTER);
    status.setPadding(0, 16, 0, 32);
    root.addView(status);

    LinearLayout row = new LinearLayout(this);
    row.setGravity(Gravity.CENTER);
    root.addView(row);
    addButton(row, "Open clock", v -> openClock());
    addButton(row, "Stay here", v -> { stay = true; h.removeCallbacks(tick); status.setText("Staying on this screen"); });
    addButton(row, "Settings", v -> { stay = true; startActivity(new Intent(Settings.ACTION_SETTINGS)); });
    addButton(row, "Wi‑Fi", v -> { stay = true; startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)); });
    addButton(row, "Bluetooth", v -> { stay = true; startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); });
    addButton(row, "Music app", v -> {
      stay = true;
      Intent i = getPackageManager().getLaunchIntentForPackage("com.youzhuan.music");
      if (i != null) startActivity(i);
    });
    setContentView(root);
  }

  private void addButton(LinearLayout row, String label, View.OnClickListener l) {
    Button btn = new Button(this);
    btn.setText(label);
    btn.setAllCaps(false);
    btn.setOnClickListener(l);
    row.addView(btn);
  }

  @Override protected void onResume() {
    super.onResume();
    stay = false;
    left = COUNTDOWN_SEC;
    h.removeCallbacks(tick);
    h.post(tick);
  }

  @Override protected void onPause() {
    super.onPause();
    h.removeCallbacks(tick);
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
