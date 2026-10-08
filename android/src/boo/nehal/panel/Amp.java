package boo.nehal.panel;

import android.util.Log;
import com.youzhuan.music.utils.Pt2314;

/**
 * The amplifier's hardware volume, kept in step with Android's media volume.
 *
 * The panel has two volume stages: Android's digital volume and the NPCA110 amplifier.
 * The vendor music app copied one to the other only every ~1.5 s, so TV volume changes
 * reached the speakers late and in jumps. This does it the moment Android's volume changes.
 */
final class Amp {
  // Android volume 0-100 -> amplifier value; the vendor's table for this model (YZ500, AP6203).
  static final int[] TABLE = {
      0, 8, 34, 53, 67, 74, 86, 99, 115, 133, 144, 157, 164, 178, 189, 194, 198, 204, 208, 212,
      217, 222, 225, 230, 235, 238, 241, 244, 248, 250, 253, 256, 260, 263, 265, 269, 273, 277, 280, 283,
      286, 289, 292, 295, 297, 300, 303, 306, 309, 312, 314, 316, 318, 320, 322, 324, 326, 327, 328, 329,
      330, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349,
      350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369,
      371 };

  private static Pt2314 chip;
  private static int handle = -1;  // the library's handle is a pointer: any value but -1 is valid
  private static int lastValue = -1;

  // The input the driver reports while Bluetooth/Chrome audio plays (seen with the vendor app
  // still running). Its numbering doesn't match the vendor app's constants, so only this
  // observed value is ever restored, and only if a reboot leaves the amplifier on another input.
  static final int KNOWN_GOOD_INPUT = 0;

  /** Opens the amplifier and makes sure it listens to Android audio. */
  static synchronized boolean open() {
    if (handle != -1) return true;
    try {
      chip = new Pt2314();
      handle = chip.open(Pt2314.AREA_1);
      if (handle == -1) { Log.w(KeeperService.TAG, "amp: open failed"); return false; }
      int input = chip.getAudioSwtich(handle);
      Log.i(KeeperService.TAG, "amp: open, input " + input);
      if (input != KNOWN_GOOD_INPUT) {
        chip.audioSwtich(handle, Pt2314.AREA_1, KNOWN_GOOD_INPUT, 0);
        Log.i(KeeperService.TAG, "amp: input " + input + " -> " + KNOWN_GOOD_INPUT);
      }
      return true;
    } catch (Throwable e) {  // library missing or the driver changed
      Log.w(KeeperService.TAG, "amp unavailable", e);
      handle = -1;
      return false;
    }
  }

  /** Sets the amplifier for Android volume 0-100. */
  static synchronized void setVolume(int androidVolume) {
    if (handle == -1) return;
    int v = TABLE[Math.max(0, Math.min(100, androidVolume))];
    if (v == lastValue) return;
    chip.setMasterVolume(handle, Pt2314.AREA_1, v);
    lastValue = v;
  }
}
