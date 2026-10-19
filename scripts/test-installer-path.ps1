<# Test real NSIS preflight with isolated Tauri-format registry records and text-only payloads. #>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fixtureId = [guid]::NewGuid().ToString('N')
$fixture = Join-Path $repoRoot ('.tmp/installer-path-' + $fixtureId)
$registrySubkey = 'Software\EAiCodingInstallerValidation-' + $fixtureId
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
$source = @'
Unicode true
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
Name "EAiCoding Path Validation"
OutFile "__FIXTURE__\path-probe.exe"
RequestExecutionLevel user
SilentInstall silent
!define MAINBINARYNAME "tauri-app"
!define ESTIMATEDSIZE 1
!define MANUPRODUCTKEY "__REGISTRY__\Product"
!define UNINSTKEY "__REGISTRY__\Uninstall"
!include "__PATH_SOURCE__"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!include "__STRINGS_SOURCE__"
Var ResultFile
Var Failures
!macro Check LABEL EXPECTED
    Call InstallerPreflight
    ${If} $InstallerError == ""
        StrCpy $R0 "accept"
    ${Else}
        StrCpy $R0 "reject"
    ${EndIf}
    ${If} $R0 == "${EXPECTED}"
        FileWrite $ResultFile "PASS ${LABEL}$\r$\n"
    ${Else}
        FileWrite $ResultFile "FAIL ${LABEL}: expected ${EXPECTED}, got $R0 ($InstallerError)$\r$\n"
        IntOp $Failures $Failures + 1
    ${EndIf}
!macroend
Function .onInit
    SetSilent silent
    SetShellVarContext current
    StrCpy $Failures 0
    FileOpen $ResultFile "__FIXTURE__\results.txt" w
    ; All registry writes use a per-run test key, never the product's installation keys.
    SetRegView 32
    Call TestPaths
    DeleteRegKey SHCTX "__REGISTRY__"
    SetRegView 64
    Call TestPaths
    DeleteRegKey SHCTX "__REGISTRY__"
    FileClose $ResultFile
    SetErrorLevel $Failures
    Quit
FunctionEnd
Function TestPaths
    StrCpy $InstallerPath "__FIXTURE__\new"
    !insertmacro Check "new directory" "accept"
    CreateDirectory "__FIXTURE__\empty"
    StrCpy $InstallerPath "__FIXTURE__\empty"
    !insertmacro Check "existing empty directory" "accept"
    CreateDirectory "__FIXTURE__\installed"
    FileOpen $0 "__FIXTURE__\installed\tauri-app.exe" w
    FileWrite $0 "Harmless text-only executable placeholder"
    FileClose $0
    StrCpy $InstallerPath "__FIXTURE__\installed"
    !insertmacro Check "unregistered nonempty directory with matching filename" "reject"
    ; Exactly Tauri's schema: manufacturer default value plus quoted uninstall location.
    WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" "__FIXTURE__\installed"
    WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" '$\"__FIXTURE__\installed$\"'
    WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "tauri-app.exe"
    StrCpy $InstallerPath "__FIXTURE__\installed"
    !insertmacro Check "Tauri registered upgrade with absent uninstall default value" "accept"
    StrCpy $InstallerPath "__FIXTURE__\installed"
    !insertmacro Check "repeat upgrade to the same installation" "accept"
    ; A stale uninstall default must not authorize an unrelated nonempty directory.
    CreateDirectory "__FIXTURE__\unrelated"
    CopyFiles /SILENT "__FIXTURE__\installed\tauri-app.exe" "__FIXTURE__\unrelated\tauri-app.exe"
    WriteRegStr SHCTX "${UNINSTKEY}" "" "__FIXTURE__\unrelated"
    StrCpy $InstallerPath "__FIXTURE__\unrelated"
    !insertmacro Check "unrelated directory despite uninstall default value" "reject"
    Delete "__FIXTURE__\installed\tauri-app.exe"
    FileOpen $0 "__FIXTURE__\installed\notes.txt" w
    FileWrite $0 "Keep this unrelated file"
    FileClose $0
    StrCpy $InstallerPath "__FIXTURE__\installed"
    !insertmacro Check "registered nonempty directory missing the application" "reject"
    DeleteRegKey SHCTX "__REGISTRY__"
FunctionEnd
Section
SectionEnd
'@
$source = $source.Replace('__FIXTURE__', $fixture).Replace('__REGISTRY__', $registrySubkey).Replace('__PATH_SOURCE__', (Join-Path $repoRoot 'src-tauri/installer/path.nsh')).Replace('__STRINGS_SOURCE__', (Join-Path $repoRoot 'src-tauri/installer/strings.nsh'))
$script = Join-Path $fixture 'path-probe.nsi'
[IO.File]::WriteAllText($script, $source, [Text.UTF8Encoding]::new($false))
$nsis = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
& $nsis /V2 $script
if ($LASTEXITCODE -ne 0) { throw 'Installer path fixture did not compile' }
$process = $null
try {
  $process = Start-Process -FilePath (Join-Path $fixture 'path-probe.exe') -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(30000)) { throw 'Installer path fixture timed out' }
  $results = Get-Content -LiteralPath (Join-Path $fixture 'results.txt')
  $results | Write-Output
  if ($process.ExitCode -ne 0 -or @($results | Where-Object { $_ -like 'PASS *' }).Count -ne 14) { throw 'Installer path compatibility checks failed' }
  Write-Output 'PASS NSIS preflight in both registry views: fresh installation, registered upgrades and rejection of unrelated directories'
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
  # Remove only this run's registry subtree; no installed-product registry state is read or changed.
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $key = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try { $key.DeleteSubKeyTree($registrySubkey, $false) } finally { $key.Dispose() }
  }
}
