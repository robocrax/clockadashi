# Builds android/out/clockpanel.apk without Gradle.
# Needs: JDK 17, Android build-tools 34 and platform 29 under %LOCALAPPDATA%\Android\Sdk.
# The signing key lives outside the repo: %USERPROFILE%\.clockadashi\panel.keystore (made on first build).
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$bt = (Get-ChildItem "$sdk\build-tools" -Directory | Sort-Object Name | Select-Object -Last 1).FullName
$jar = (Get-ChildItem "$sdk\platforms" -Recurse -Filter android.jar | Select-Object -First 1).FullName
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { (Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-17*' | Select-Object -Last 1).FullName }
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"

$out = "$here\out"
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\classes", "$out\dex" | Out-Null

New-Item -ItemType Directory -Force "$out\gen" | Out-Null
& "$bt\aapt2.exe" compile --dir "$here\res" -o "$out\res.zip"
if ($LASTEXITCODE) { throw 'aapt2 compile failed' }

# The clock web app, bundled so the panel serves it with no internet (LocalSite.java).
# Songs are not bundled: the panel fetches them from clock.nehal.boo when first asked and keeps them.
$site = (Resolve-Path "$here\..").Path
$siteFiles = @('index.html', 'style.css', 'app.js', 'player.js', 'intercom.js', 'timers.js', 'calendar.js', 'sw.js',
  'manifest.json', 'events.csv', 'tracks.json') +
  @(Get-ChildItem "$site\icons", "$site\fonts" -File | ForEach-Object { "$($_.Directory.Name)/$($_.Name)" })
New-Item -ItemType Directory -Force "$out\native\assets\site\icons", "$out\native\assets\site\fonts" | Out-Null
foreach ($f in $siteFiles) { Copy-Item "$site\$f" "$out\native\assets\site\$f" }

& "$bt\aapt2.exe" link -o "$out\base.apk" -I $jar --manifest "$here\AndroidManifest.xml" `
  --java "$out\gen" --min-sdk-version 26 --target-sdk-version 28 --version-code 5 --version-name 1.4 "$out\res.zip"
if ($LASTEXITCODE) { throw 'aapt2 link failed' }

$srcs = @(Get-ChildItem "$here\src", "$out\gen" -Recurse -Filter *.java | ForEach-Object FullName)
# UTF-8: the default on Windows (cp1252) turns "…" and "Wi‑Fi" into mojibake on the panel
& javac -nowarn -encoding UTF-8 -source 8 -target 8 -bootclasspath "$jar;$bt\core-lambda-stubs.jar" -d "$out\classes" @srcs
if ($LASTEXITCODE) { throw 'javac failed' }

$classes = Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object FullName
& "$bt\d8.bat" --release --min-api 26 --lib $jar --output "$out\dex" @classes
if ($LASTEXITCODE) { throw 'd8 failed' }

Push-Location "$out\dex"
& "$bt\aapt.exe" add "$out\base.apk" classes.dex | Out-Null
Pop-Location
if ($LASTEXITCODE) { throw 'aapt add failed' }

# The amplifier driver library comes from the panel's own firmware and is not kept in git.
# Fetch it once with:  adb pull /product/app/Music_player/Music_player.apk  and take
# lib/armeabi-v7a/libpt2314.so out of it into android\vendor\ .
$lib = "$here\vendor\libpt2314.so"
if (-not (Test-Path $lib)) { throw "missing $lib (see comment above)" }
New-Item -ItemType Directory -Force "$out\native\lib\armeabi-v7a" | Out-Null
Copy-Item $lib "$out\native\lib\armeabi-v7a\"
# (aapt add keeps the forward slashes Android needs; aapt2 -A writes backslashes on Windows)
Push-Location "$out\native"
& "$bt\aapt.exe" add "$out\base.apk" lib/armeabi-v7a/libpt2314.so @($siteFiles | ForEach-Object { "assets/site/$_" }) | Out-Null
Pop-Location
if ($LASTEXITCODE) { throw 'aapt add (lib, site) failed' }

& "$bt\zipalign.exe" -f 4 "$out\base.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'zipalign failed' }

$ks = "$env:USERPROFILE\.clockadashi\panel.keystore"
if (-not (Test-Path $ks)) {
  New-Item -ItemType Directory -Force (Split-Path $ks) | Out-Null
  & keytool -genkeypair -keystore $ks -storepass clockpanel -keypass clockpanel -alias panel `
    -keyalg RSA -keysize 2048 -validity 36500 -dname 'CN=Clock Panel' | Out-Null
}
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:clockpanel --key-pass pass:clockpanel `
  --out "$out\clockpanel.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'apksigner failed' }
Write-Output "Built $out\clockpanel.apk"
