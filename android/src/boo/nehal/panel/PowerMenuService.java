package boo.nehal.panel;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Opens Android's own power menu (Power off / Restart) for the home screen's "Restart panel"
 * button. An ordinary app may not reboot the device; asking the system to show its power menu
 * is the supported way, and Android only allows that from an accessibility service.
 * It listens to no events and cannot read the screen (see res/xml/power_menu.xml).
 * Switched on in Settings > Accessibility, or:
 *   adb shell settings put secure enabled_accessibility_services boo.nehal.panel/.PowerMenuService
 *   adb shell settings put secure accessibility_enabled 1
 */
public class PowerMenuService extends AccessibilityService {
  private static PowerMenuService instance;

  @Override protected void onServiceConnected() { instance = this; }
  @Override public boolean onUnbind(Intent i) { instance = null; return super.onUnbind(i); }
  @Override public void onAccessibilityEvent(AccessibilityEvent e) {}
  @Override public void onInterrupt() {}

  /** Shows the power menu; false if the service isn't switched on. */
  static boolean show() {
    PowerMenuService s = instance;
    return s != null && s.performGlobalAction(GLOBAL_ACTION_POWER_DIALOG);
  }
}
