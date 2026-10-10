#!/system/bin/sh
# Optional hardening for the wall panel. Run from this computer:
#   adb push android\panel-cleanup.sh /data/local/tmp/
#   adb shell sh /data/local/tmp/panel-cleanup.sh
# Undo any app with:  adb shell cmd package install-existing <package>
# Undo the Wi-Fi share block with:  adb shell pm enable com.android.settings/.wifi.dpp.WifiDppConfiguratorActivity

# 1. Vendor apps (removed for the user only; the firmware copy stays, so install-existing brings them back):
#    com.youzhuan.music            Tencent X5 + Bugly, Baidu P2P CDN + analytics, vendor cloud (sntpay.cn),
#                                  Bluetooth on/off toggling, the slow volume echo
#    ...remote.controlserver       LAN remote control (ports 8980/8982), uploads logs to log.sntpay.cn
#    ...dlnamusicservice, airplay  LAN media receivers (restart themselves even when disabled)
#    com.youzhuan.localupdate      firmware updater with root access
#    com.youzhuan.musiclauncher    the old home screen (needs com.youzhuan.music)
#    com.youzhuan.volume           the on-screen volume overlay
# The Jellyclock helper app already sets the amplifier volume, so nothing here is needed for sound.
# The home screen's Speaker button opens com.youzhuan.music, so that app and its old home screen are kept
# unless this script is run with "all":  adb shell sh /data/local/tmp/panel-cleanup.sh all
# (the Speaker button then has nothing to open; not tried: the speaker app without the other vendor apps)
apps="com.youzhuan.music.remote.controlserver com.youzhuan.music.dlnamusicservice com.youzhuan.music.airplay
      com.youzhuan.localupdate com.youzhuan.volume"
[ "$1" = all ] && apps="$apps com.youzhuan.music com.youzhuan.musiclauncher"
for p in $apps; do
  am force-stop $p
  pm uninstall -k --user 0 $p
done

# 2. Settings > Wi-Fi > network > Share shows the Wi-Fi password and a QR code of it
pm disable com.android.settings/.wifi.dpp.WifiDppConfiguratorActivity

# 3. The Bluetooth stack logs a line per audio packet: keep only its warnings
for t in bt_btif bt_l2cap bt_avp bt_btif_a2dp_sink bt_btm bt_hci bt_bta_av BluetoothAvrcpControllerJni; do
  setprop persist.log.tag.$t W
done
echo done
