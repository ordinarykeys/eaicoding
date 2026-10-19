param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fixtureDir = Join-Path $repoRoot ('.tmp\native-workbench-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDir -Force | Out-Null
$configPath = Join-Path $fixtureDir 'tauri-validation.json'
'{"identifier":"com.eaicoding.workbench-validation","build":{"beforeBuildCommand":""},"bundle":{"active":false}}' | Set-Content -LiteralPath $configPath -Encoding Ascii
Push-Location $repoRoot
$probeProcess = $null
$previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$previousDataFolder = $env:WEBVIEW2_USER_DATA_FOLDER
try {
  if (!$SkipBuild) {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    & npx tauri build --debug --no-bundle --config $configPath --ci
    if ($LASTEXITCODE -ne 0) { throw 'Isolated native test build failed' }
  }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9334 --disable-gpu'
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $fixtureDir 'webview-profile'
  $env:EAICODING_CDP_URL = 'http://127.0.0.1:9334'
  $env:EAICODING_WORKBENCH_SMOKE_DIR = $fixtureDir
  $probeProcess = Start-Process -FilePath (Join-Path $repoRoot 'src-tauri\target\debug\tauri-app.exe') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardError (Join-Path $fixtureDir 'native-stderr.txt') -PassThru
  & node scripts/test-native-workbench.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Native workbench smoke failed' }
} finally {
  if ($probeProcess -and !$probeProcess.HasExited) { Stop-Process -Id $probeProcess.Id }
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like ('*' + $fixtureDir + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
  $env:WEBVIEW2_USER_DATA_FOLDER = $previousDataFolder
  Remove-Item Env:\EAICODING_CDP_URL -ErrorAction SilentlyContinue
  Remove-Item Env:\EAICODING_WORKBENCH_SMOKE_DIR -ErrorAction SilentlyContinue
  Pop-Location
}
