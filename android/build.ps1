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

& "$bt\aapt2.exe" link -o "$out\base.apk" -I $jar --manifest "$here\AndroidManifest.xml" `
  --min-sdk-version 26 --target-sdk-version 28 --version-code 1 --version-name 1.0
if ($LASTEXITCODE) { throw 'aapt2 link failed' }

$srcs = Get-ChildItem "$here\src" -Recurse -Filter *.java | ForEach-Object FullName
& javac -nowarn -source 8 -target 8 -bootclasspath "$jar;$bt\core-lambda-stubs.jar" -d "$out\classes" @srcs
if ($LASTEXITCODE) { throw 'javac failed' }

$classes = Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object FullName
& "$bt\d8.bat" --release --min-api 26 --lib $jar --output "$out\dex" @classes
if ($LASTEXITCODE) { throw 'd8 failed' }

Push-Location "$out\dex"
& "$bt\aapt.exe" add "$out\base.apk" classes.dex | Out-Null
Pop-Location
if ($LASTEXITCODE) { throw 'aapt add failed' }

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
