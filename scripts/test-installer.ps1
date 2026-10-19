<# Exercise the shipped Harness UI against a harmless text-file payload, no product installation. #>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $repoRoot ('.tmp/installer-validation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
$nsis = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
$ui = Join-Path $repoRoot 'src-tauri/installer/ui.nsh'
# A large single file exercises percentage reporting within a file, unlike NSIS instruction counts.
$archiveSource = Join-Path $fixture 'archive-source'
New-Item -ItemType Directory -Path $archiveSource | Out-Null
$sample = [byte[]]::new(65536)
([Random]::new(42)).NextBytes($sample)
$stream = [IO.File]::Create((Join-Path $archiveSource 'fixture.bin'))
try { for ($i = 0; $i -lt 2048; $i++) { $stream.Write($sample, 0, $sample.Length) } } finally { $stream.Dispose() }
$archive = Join-Path $fixture 'fixture.7z'
& (Join-Path $repoRoot 'node_modules/7zip-bin/win/x64/7za.exe') a -t7z -mx=1 -ms=off $archive (Join-Path $archiveSource 'fixture.bin') -bsp0 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare extraction fixture' }
# Exercise the production pipe parser and progress gate with split/malformed output.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$visualStudio) { throw 'Installer tests require Visual Studio C++ Build Tools' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars32.bat'
$progressTest = Join-Path $fixture 'progress-test.exe'
$testCommand = Join-Path $fixture 'progress-test.cmd'
$lines = @('@echo off', ('call "{0}" >nul' -f $vcvars), 'if errorlevel 1 exit /b %errorlevel%', ('cl /nologo /std:c++17 /O2 /W4 /WX /EHsc "{0}" /Fo"{1}" /Fe"{2}"' -f (Join-Path $PSScriptRoot 'test-installer-progress.cpp'), (Join-Path $fixture 'progress-test.obj'), $progressTest))
[IO.File]::WriteAllLines($testCommand, $lines, [Text.Encoding]::Default)
& $env:ComSpec /d /c $testCommand
if ($LASTEXITCODE -ne 0) { throw 'Installer progress test compilation failed' }
& $progressTest
if ($LASTEXITCODE -ne 0) { throw 'Installer progress parser or completion gate failed' }
$source = @'
Unicode true
ManifestDPIAware true
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
Name "EAiCoding Installer Validation"
OutFile "__FIXTURE__\ui-probe.exe"
RequestExecutionLevel user
InstallDir "__FIXTURE__\payload"
!define PRODUCTNAME "EAiCoding"
!define MAINBINARYNAME "fixture-only"
!define UNINSTKEY "Software\EAiCodingInstallerValidation-NoWrites"
!define MANUPRODUCTKEY "Software\EAiCodingInstallerValidation-NoWrites\Product"
!define ESTIMATEDSIZE 1
Var PassiveMode
Var UpdateMode
Var ProbeFailure
!include "__UI__"
Page custom InstallerWelcome InstallerWelcomeLeave
!define MUI_PAGE_CUSTOMFUNCTION_SHOW InstallerProgressShow
!insertmacro MUI_PAGE_INSTFILES
Page custom InstallerFinish InstallerFinishLeave
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro EAICODING_INSTALLER_STRINGS
Function .onInit
  Call InstallerInitialize
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/FAIL" $R1
  ${IfNot} ${Errors}
    StrCpy $ProbeFailure "archive"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/MISSINGTOOL" $R1
  ${IfNot} ${Errors}
    StrCpy $ProbeFailure "tool"
  ${EndIf}
FunctionEnd
Function SkipIfPassive
FunctionEnd
Function RunMainBinary
  FileOpen $0 "$INSTDIR\launch-requested.txt" w
  FileWrite $0 "fixture launch only"
  FileClose $0
FunctionEnd
Section
  File /oname=$PLUGINSDIR\fixture.7z "__FIXTURE__\fixture.7z"
  ${If} $ProbeFailure != ""
    StrCpy $R0 "$PLUGINSDIR\7za.exe"
    StrCpy $R1 "$PLUGINSDIR\fixture.7z"
    ${If} $ProbeFailure == "tool"
      StrCpy $R0 "$PLUGINSDIR\missing-tool.exe"
    ${Else}
      StrCpy $R1 "$PLUGINSDIR\missing-archive.7z"
    ${EndIf}
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerExtract(p $HWNDPARENT, w R0, w R1, w "__FIXTURE__\failure-payload", w "$PLUGINSDIR\extract.log") i.r0 ?c'
    FileOpen $1 "__FIXTURE__\failure-$ProbeFailure.txt" w
    FileWrite $1 "$0"
    FileClose $1
    ${If} $0 == 0
      SetErrorLevel 10
      Quit
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetOutPath $INSTDIR
  !insertmacro InstallerPublishStage 1
  ; Deliberately block only the worker. The UI must continue painting and moving.
  Sleep 2500
  System::Store /NOUNLOAD "S"
  System::Call /NOUNLOAD '$PLUGINSDIR\window-frame.dll::InstallerExtract(p $HWNDPARENT, w "$PLUGINSDIR\7za.exe", w "$PLUGINSDIR\fixture.7z", w "$INSTDIR", w "$PLUGINSDIR\extract.log") i.s ?c'
  System::Store "L"
  Pop $R0
  ${If} $R0 != 0
    Abort "Extraction fixture failed"
  ${EndIf}
  System::Call 'user32::GetPropW(p $HWNDPARENT, w "EAiCodingInstaller.ExtractProgress") p.r2'
  FileOpen $1 "__FIXTURE__\extraction-state.txt" w
  FileWrite $1 "$HWNDPARENT $2 $R0"
  FileClose $1
  !insertmacro InstallerPublishStage 3
  Sleep 500
  !insertmacro InstallerPublishStage 4
SectionEnd
'@
$source = $source.Replace('__FIXTURE__', $fixture).Replace('__UI__', $ui)
$script = Join-Path $fixture 'ui-probe.nsi'
[IO.File]::WriteAllText($script, $source, [Text.UTF8Encoding]::new($false))
& $nsis /V2 $script
if ($LASTEXITCODE -ne 0) { throw 'Installer presentation fixture did not compile' }
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class EAiInstallerProbe {
  public delegate bool Callback(IntPtr w, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w, Callback cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w,StringBuilder b,int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w, out RECT r);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr w);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr w,IntPtr h,uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr w,uint m,IntPtr a,IntPtr b);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr w,string text);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr w,uint m,IntPtr a,IntPtr b,uint flags,uint ms,out IntPtr result);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr w,IntPtr after,int x,int y,int width,int height,uint flags);
  public static double Ping(IntPtr w) { var timer=System.Diagnostics.Stopwatch.StartNew();IntPtr result;if(SendMessageTimeout(w,0,IntPtr.Zero,IntPtr.Zero,2,250,out result)==IntPtr.Zero)throw new Exception("Installer UI blocked on worker");return timer.Elapsed.TotalMilliseconds; }
  public static void Move(IntPtr w,int offset) { RECT r;GetWindowRect(w,out r);if(!SetWindowPos(w,IntPtr.Zero,r.L+offset,r.T,0,0,0x15))throw new Exception("Cannot move fixture"); }
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr w,string key);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static IntPtr Window(int pid) { IntPtr found=IntPtr.Zero; EnumWindows((w,p)=>{uint owner;GetWindowThreadProcessId(w,out owner);if(owner==pid&&IsWindowVisible(w))found=w;return true;},IntPtr.Zero); return found; }
  public static string Text(IntPtr w) { var b=new StringBuilder(256);GetWindowText(w,b,256);return b.ToString(); }
  public static IntPtr Control(IntPtr w,string text) { IntPtr found=IntPtr.Zero;EnumChildWindows(w,(c,p)=>{if(IsWindowVisible(c)&&Text(c)==text)found=c;return true;},IntPtr.Zero);return found; }
  public static int[] Size(IntPtr w) { RECT r;GetWindowRect(w,out r);return new[]{r.R-r.L,r.B-r.T}; }
  public static double Scale(IntPtr w) { return GetDpiForWindow(w)/96.0; }
  public static void Capture(IntPtr w,string path) { var s=Size(w);using(var bmp=new Bitmap(s[0],s[1])) {using(var g=Graphics.FromImage(bmp)){var dc=g.GetHdc();PrintWindow(w,dc,2);g.ReleaseHdc(dc);}bmp.Save(path,ImageFormat.Png);} }
}
'@
[EAiInstallerProbe]::SetProcessDPIAware() | Out-Null
$process = Start-Process -FilePath (Join-Path $fixture 'ui-probe.exe') -WindowStyle Hidden -PassThru
try {
  $window = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $window = [EAiInstallerProbe]::Window($process.Id)
    if ($window -ne [IntPtr]::Zero -and [EAiInstallerProbe]::Control($window, '立即安装') -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 100
  }
  $button = [EAiInstallerProbe]::Control($window, '立即安装')
  if ($button -eq [IntPtr]::Zero) { throw 'Harness welcome install action was not shown' }
  $scale = [EAiInstallerProbe]::Scale($window)
  $size = [EAiInstallerProbe]::Size($window)
  if ([Math]::Abs($size[0] / $scale - 600) -gt 2 -or [Math]::Abs($size[1] / $scale - 600) -gt 2) { throw "Installer is not 600x600 logical pixels: $size" }
  $buttonSize = [EAiInstallerProbe]::Size($button)
  if ([Math]::Abs($buttonSize[0] / $scale - 120) -gt 2 -or [Math]::Abs($buttonSize[1] / $scale - 44) -gt 2) { throw 'Harness install button dimensions differ' }
  Start-Sleep -Milliseconds 200
  [EAiInstallerProbe]::Capture($window, (Join-Path $fixture 'welcome.png'))
  $choose = [EAiInstallerProbe]::Control($window, '选择安装位置')
  [EAiInstallerProbe]::SendMessage($choose, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 150
  if ([EAiInstallerProbe]::Control($window, '选择') -eq [IntPtr]::Zero) { throw 'Harness expandable path selector did not open' }
  [EAiInstallerProbe]::Capture($window, (Join-Path $fixture 'directory.png'))
  [EAiInstallerProbe]::SendMessage($button, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  $latencies = @()
  for ($sampleIndex = 0; $sampleIndex -lt 30; $sampleIndex++) {
    [EAiInstallerProbe]::Move($window, $(if ($sampleIndex % 2) { -1 } else { 1 }))
    $latencies += [EAiInstallerProbe]::Ping($window)
    if ([EAiInstallerProbe]::GetProp($window, 'EAiCodingInstaller.CompletedPercent') -ne [IntPtr]::Zero) { throw 'Installer claimed completion while worker was deliberately blocked' }
    Start-Sleep -Milliseconds 25
  }
  $finish = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $finish = [EAiInstallerProbe]::Control($window, '完成')
    if ($finish -ne [IntPtr]::Zero) { break }
    if ($attempt -eq 5) { [EAiInstallerProbe]::Capture($window, (Join-Path $fixture 'progress.png')) }
    Start-Sleep -Milliseconds 100
  }
  if ($finish -eq [IntPtr]::Zero) { throw 'Harness completion page was not shown' }
  if ((Get-FileHash -LiteralPath (Join-Path $fixture 'payload/fixture.bin')).Hash -ne (Get-FileHash -LiteralPath (Join-Path $archiveSource 'fixture.bin')).Hash) { throw 'Real 7-Zip payload differs' }
  if ([EAiInstallerProbe]::GetProp($window, 'EAiCodingInstaller.ExtractProgress').ToInt64() -ne 100) { throw ('7-Zip did not publish its work percentage: parent=' + $window + ' state=' + (Get-Content (Join-Path $fixture 'extraction-state.txt'))) }
  if ([EAiInstallerProbe]::GetProp($window, 'EAiCodingInstaller.CompletedPercent') -eq [IntPtr]::Zero) { throw 'Successful completion did not paint 100%' }
  [EAiInstallerProbe]::Capture($window, (Join-Path $fixture 'finish.png'))
  [EAiInstallerProbe]::SendMessage($finish, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  if (-not $process.WaitForExit(10000)) { throw 'Finish did not exit the fixture' }
  foreach ($case in @('archive', 'tool')) {
    $flag = if ($case -eq 'tool') { '/MISSINGTOOL' } else { '/FAIL' }
    $failure = Start-Process -FilePath (Join-Path $fixture 'ui-probe.exe') -ArgumentList @('/S', $flag) -WindowStyle Hidden -PassThru
    try {
      if (-not $failure.WaitForExit(15000)) { throw 'Failed extraction hung' }
      if ($failure.ExitCode -ne 2) { throw "Failed extraction reported success: $case" }
      $code = [int](Get-Content -LiteralPath (Join-Path $fixture "failure-$case.txt"))
      if (($case -eq 'archive' -and $code -le 0) -or ($case -eq 'tool' -and $code -ge 0)) { throw "Wrong extraction failure status: $case / $code" }
    } finally { if (-not $failure.HasExited) { Stop-Process -Id $failure.Id } }
  }
  $maxLatency = ($latencies | Measure-Object -Maximum).Maximum
  Write-Output "PASS Harness native welcome/path/progress/finish; 128 MiB real extraction/hash, missing archive/tool failures; UI move/ping during blocked worker: max $maxLatency ms. Captures: $fixture"
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
}
