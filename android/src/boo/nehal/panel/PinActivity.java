package boo.nehal.panel;

import android.app.Activity;
import android.content.pm.LauncherApps;
import android.content.pm.ShortcutInfo;
import android.os.Bundle;
import android.widget.Toast;

/** Chrome's "Add to Home screen" lands here; the shortcut is kept and launched by HomeActivity. */
public class PinActivity extends Activity {
  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    try {
      LauncherApps la = getSystemService(LauncherApps.class);
      LauncherApps.PinItemRequest req = la.getPinItemRequest(getIntent());
      if (req != null && req.isValid() && req.getRequestType() == LauncherApps.PinItemRequest.REQUEST_TYPE_SHORTCUT) {
        ShortcutInfo si = req.getShortcutInfo();
        if (req.accept()) {
          getSharedPreferences(HomeActivity.PREFS, MODE_PRIVATE).edit()
              .putString("sc_pkg", si.getPackage()).putString("sc_id", si.getId()).apply();
          Toast.makeText(this, "Clock shortcut saved: " + si.getShortLabel(), Toast.LENGTH_LONG).show();
        }
      }
    } catch (Exception e) {
      Toast.makeText(this, "Could not save shortcut: " + e, Toast.LENGTH_LONG).show();
    }
    finish();
  }
}
