<# Exercise the shipped Harness UI against a harmless text-file payload, no product installation. #>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $repoRoot ('.tmp/installer-validation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
$nsis = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
$ui = Join-Path $repoRoot 'src-tauri/installer/ui.nsh'
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
FunctionEnd
Function SkipIfPassive
FunctionEnd
Function RunMainBinary
  FileOpen $0 "$INSTDIR\launch-requested.txt" w
  FileWrite $0 "fixture launch only"
  FileClose $0
FunctionEnd
Section
  SetOutPath $INSTDIR
  FileOpen $0 "$INSTDIR\fixture.txt" w
  FileWrite $0 "Harmless installer UI test"
  FileClose $0
  StrCpy $1 0
  loop:
    DetailPrint "Fixture progress $1"
    Sleep 20
    IntOp $1 $1 + 1
    IntCmp $1 60 done loop done
  done:
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
  $finish = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $finish = [EAiInstallerProbe]::Control($window, '完成')
    if ($finish -ne [IntPtr]::Zero) { break }
    if ($attempt -eq 5) { [EAiInstallerProbe]::Capture($window, (Join-Path $fixture 'progress.png')) }
    Start-Sleep -Milliseconds 100
  }
  if ($finish -eq [IntPtr]::Zero) { throw 'Harness completion page was not shown' }
  if (-not (Test-Path -LiteralPath (Join-Path $fixture 'payload/fixture.txt'))) { throw 'Fixture installation section did not run' }
  if ([EAiInstallerProbe]::GetProp($window, 'EAiCodingInstaller.CompletedPercent') -eq [IntPtr]::Zero) { throw 'Successful completion did not paint 100%' }
  [EAiInstallerProbe]::Capture($window, (Join-Path $fixture 'finish.png'))
  [EAiInstallerProbe]::SendMessage($finish, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  if (-not $process.WaitForExit(10000)) { throw 'Finish did not exit the fixture' }
  Write-Output "PASS Harness native welcome/path/progress/finish, 600x600 frame and 120x44 install action. Captures: $fixture"
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
}
