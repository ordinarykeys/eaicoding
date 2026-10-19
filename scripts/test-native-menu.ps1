param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $repoRoot '.tmp/native-menu'
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$config = Join-Path $fixture 'tauri-validation.json'
'{"identifier":"com.eaicoding.menu-validation","build":{"beforeBuildCommand":""},"bundle":{"active":false}}' | Set-Content -LiteralPath $config -Encoding Ascii
$previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$previousDataFolder = $env:WEBVIEW2_USER_DATA_FOLDER
$probeProcess = $null
Push-Location $repoRoot
try {
  if (!$SkipBuild) {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    & npm run tauri -- build --debug --no-bundle --ci --config $config
    if ($LASTEXITCODE -ne 0) { throw 'Native menu fixture build failed' }
  }
  $profile = Join-Path $fixture ('profile-' + [guid]::NewGuid().ToString('N'))
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9336 --disable-gpu'
  $env:WEBVIEW2_USER_DATA_FOLDER = $profile
  $probeProcess = Start-Process -FilePath (Join-Path $repoRoot 'src-tauri/target/debug/tauri-app.exe') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardError (Join-Path $fixture 'stderr.txt') -PassThru
  $env:EAICODING_MENU_TEST_PID = [string]$probeProcess.Id
  & node scripts/test-native-menu.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Native menu regression failed' }
} finally {
  if ($probeProcess -and !$probeProcess.HasExited) { Stop-Process -Id $probeProcess.Id }
  if ($profile) { Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like ('*' + $profile + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
  $env:WEBVIEW2_USER_DATA_FOLDER = $previousDataFolder
  Remove-Item Env:\EAICODING_MENU_TEST_PID -ErrorAction SilentlyContinue
  Pop-Location
}
