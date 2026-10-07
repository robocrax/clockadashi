package boo.nehal.panel;

import android.app.Notification;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import java.util.Locale;

/**
 * Dismisses nag notifications as soon as they appear: anything about Google Play / Play services /
 * Play Protect (this panel's Play services are too old to update and are switched off), and
 * Android's "Configure physical keyboard" prompt.
 * Enabled with: adb shell cmd notification allow_listener boo.nehal.panel/.PromptBlocker
 */
public class PromptBlocker extends NotificationListenerService {
  private static final String[] WORDS = { "google play", "play services", "play protect", "physical keyboard" };

  @Override public void onListenerConnected() {
    StatusBarNotification[] all = getActiveNotifications();
    if (all != null) for (StatusBarNotification sbn : all) check(sbn);
  }

  @Override public void onNotificationPosted(StatusBarNotification sbn) { check(sbn); }

  private void check(StatusBarNotification sbn) {
    Notification n = sbn.getNotification();
    String channel = n.getChannelId() == null ? "" : n.getChannelId();
    CharSequence title = n.extras.getCharSequence(Notification.EXTRA_TITLE);
    CharSequence text = n.extras.getCharSequence(Notification.EXTRA_TEXT);
    String all = (title + " " + text).toLowerCase(Locale.ROOT);
    boolean nag = channel.startsWith("com.google.android.gms") || channel.equals("PHYSICAL_KEYBOARD");
    for (String w : WORDS) if (all.contains(w)) nag = true;
    if (!nag) return;
    Log.i(KeeperService.TAG, "dismissed: " + sbn.getPackageName() + " / " + title);
    try {
      if (sbn.isClearable()) cancelNotification(sbn.getKey());
      else snoozeNotification(sbn.getKey(), 365L * 24 * 3600 * 1000);
    } catch (Exception e) {
      Log.w(KeeperService.TAG, "dismiss failed", e);
    }
  }
}
