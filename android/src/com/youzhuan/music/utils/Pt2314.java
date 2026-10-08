package com.youzhuan.music.utils;

/**
 * Binding to the panel's amplifier driver library, libpt2314.so, taken from the vendor
 * firmware (see android/build.ps1). The package, class and method names must stay exactly
 * like this: the library's JNI functions are named after them.
 * Talks to /dev/pt2314 (the NPCA110 amplifier's volume and input selector).
 */
public class Pt2314 {
  static { System.loadLibrary("pt2314"); }

  public static final int AREA_1 = 13;  // the panel's own speakers

  /** Returns a handle for the area, or a negative number. */
  public native int open(int area);
  public native int close(int handle);
  public native int audioSwtich(int handle, int area, int channel, int unused);
  public native int getAudioSwtich(int handle);
  public native boolean getMuteFlag(int handle);
  /** value is the amplifier's own scale (see Amp.TABLE), not 0-100. */
  public native int setMasterVolume(int handle, int area, int value);
}
