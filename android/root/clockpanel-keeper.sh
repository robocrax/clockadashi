#!/system/bin/sh
# Started by init at boot (clockpanel.rc), runs as root.
# Keeps Wi-Fi and Bluetooth from sleeping, and adb reachable over Wi-Fi for the song server tunnel.
setprop persist.adb.tcp.port 5555
setprop service.adb.tcp.port 5555
while true; do
  # Wi-Fi power save: Android turns it back on after reconnects
  if iw dev wlan0 get power_save 2>/dev/null | grep -q ' on'; then
    iw dev wlan0 set power_save off
  fi
  # Bluetooth low-power (sleep) mode: re-enabled every time Bluetooth restarts
  if grep -q 'lpm enable: 1' /proc/bluetooth/sleep/lpm 2>/dev/null; then
    echo 0 > /proc/bluetooth/sleep/lpm
  fi
  sleep 15
done
