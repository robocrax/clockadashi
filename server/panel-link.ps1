# Keeps the Search tab working on the panel:
#  - runs the song server (ytdl_server.py) on this computer, restarting it if it stops
#  - keeps adb connected to the panel over Wi-Fi and "adb reverse tcp:8790" in place,
#    so the clock's http://localhost:8790 reaches this computer (redone after Wi-Fi drops / reboots)
# Started at logon by the "Clockadashi panel link" scheduled task (see README), or run it by hand:
#   powershell -ExecutionPolicy Bypass -File server\panel-link.ps1
param(
  [string]$Panel = '192.168.1.127:5555',
  [int]$Port = 8790,
  [int]$EverySec = 30
)
$here = $PSScriptRoot
$python = Join-Path $here '.venv\Scripts\python.exe'
$adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $adb) {
  $adb = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter adb.exe -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
$logFile = Join-Path $here 'panel-link.log'
function Say($m) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m
  Add-Content -Path $logFile -Value $line
  if ((Get-Item $logFile).Length -gt 1MB) { Get-Content $logFile -Tail 2000 | Set-Content $logFile }
}

Say "starting (panel $Panel, port $Port)"
$server = $null
$linked = $false
while ($true) {
  # 1. song server
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    Say 'song server not running: starting it'
    $server = Start-Process -FilePath $python -ArgumentList @('ytdl_server.py', '--port', $Port) `
      -WorkingDirectory $here -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $here 'server.log') -RedirectStandardError (Join-Path $here 'server.err.log')
  }

  # 2. adb link to the panel
  $state = (& $adb -s $Panel get-state 2>$null)
  if ($state -ne 'device') {
    if ($linked) { Say 'panel unreachable: reconnecting' }
    $linked = $false
    & $adb disconnect $Panel 2>$null | Out-Null
    & $adb connect $Panel 2>$null | Out-Null
    $state = (& $adb -s $Panel get-state 2>$null)
  }
  if ($state -eq 'device') {
    $have = (& $adb -s $Panel reverse --list 2>$null) -join ' '
    if ($have -notmatch "tcp:$Port tcp:$Port") {
      & $adb -s $Panel reverse "tcp:$Port" "tcp:$Port" 2>$null | Out-Null
      Say "tunnel up: panel localhost:$Port -> this computer"
    }
    $linked = $true
  }
  Start-Sleep -Seconds $EverySec
}
