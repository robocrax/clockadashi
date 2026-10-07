package boo.nehal.panel;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the keeper after a reboot or an app update. */
public class BootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context c, Intent i) {
    c.startForegroundService(new Intent(c, KeeperService.class));
  }
}
