param([string]$EasyLanguageRoot = 'D:\e')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fixtureDir = Join-Path $repoRoot ('.tmp\native-gui-' + [guid]::NewGuid().ToString('N'))
$env:EAICODING_GUI_SMOKE_DIR = $fixtureDir
Push-Location (Join-Path $repoRoot 'src-tauri')
try {
  & cargo test --offline --lib native_gui_fixture -- --ignored
  if ($LASTEXITCODE -ne 0) { throw 'Failed to generate native GUI fixture' }
} finally { Pop-Location; Remove-Item Env:\EAICODING_GUI_SMOKE_DIR -ErrorAction SilentlyContinue }
$toolsDir = Join-Path $repoRoot 'src-tauri\resources\eagent-tools'
$sourceFile = $fixtureDir + '.e'
$exeFile = $fixtureDir + '.exe'
& (Join-Path $toolsDir 'e2txt\e2txt.exe') -log -enc UTF-8 -ns 2 -e -src $fixtureDir -dst $sourceFile -mode t2e | Out-Null
for ($i=0; $i -lt 50 -and !(Test-Path -LiteralPath $sourceFile); $i++) { Start-Sleep -Milliseconds 100 }
if (!(Test-Path -LiteralPath $sourceFile)) { throw 'e2txt did not create .e' }
& (Join-Path $toolsDir 'ecl\ecl.exe') make $sourceFile $exeFile -epath (Join-Path $EasyLanguageRoot 'e.exe') -nologo -s | Out-Null
if (!(Test-Path -LiteralPath $exeFile)) { throw 'ecl did not create EXE' }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class EAiGuiSmoke {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h,EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint processId);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr ReadText(IntPtr h,int message,IntPtr w,StringBuilder text);
 [DllImport("user32.dll",EntryPoint="SendMessageW")] public static extern IntPtr SendMessage(IntPtr h,int message,IntPtr w,IntPtr l);
 public static string Text(IntPtr h) {var s=new StringBuilder(2048);ReadText(h,0xD,(IntPtr)2048,s);return s.ToString();}
}
'@
$probeProcess = Start-Process -FilePath $exeFile -WindowStyle Hidden -PassThru
try {
  $children = [System.Collections.Generic.List[IntPtr]]::new()
  for ($attempt=0; $attempt -lt 50; $attempt++) {
    $children.Clear()
    [EAiGuiSmoke]::EnumWindows({param($h,$p)
      $windowProcessId=0
      [EAiGuiSmoke]::GetWindowThreadProcessId($h,[ref]$windowProcessId) | Out-Null
      if ($windowProcessId -eq $probeProcess.Id -and [EAiGuiSmoke]::Text($h) -eq 'EAiCoding 窗口测试') {
        [EAiGuiSmoke]::EnumChildWindows($h,{param($child,$unused) $children.Add($child); return $true},[IntPtr]::Zero) | Out-Null
      }
      return $true
    },[IntPtr]::Zero) | Out-Null
    if (($children | Where-Object { [EAiGuiSmoke]::Text($_) -eq 'Ready' }).Count -gt 0) { break }
    if ($probeProcess.HasExited) { throw 'Generated GUI exited before creating its window' }
    Start-Sleep -Milliseconds 100
  }
  $button = $children | Where-Object { [EAiGuiSmoke]::Text($_) -eq 'Click' } | Select-Object -First 1
  $edit = $children | Where-Object { [EAiGuiSmoke]::Text($_) -eq 'Ready' } | Select-Object -First 1
  if (!$button -or !$edit) { throw 'Expected window title, button and edit content were not created' }
  foreach ($caption in @('Label','Checkbox','Radio')) {
    if (!($children | Where-Object { [EAiGuiSmoke]::Text($_) -eq $caption })) { throw ('Missing native control: ' + $caption) }
  }
  [EAiGuiSmoke]::SendMessage($button,0xF5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
  if ([EAiGuiSmoke]::Text($edit) -ne 'Clicked') { throw 'Button event did not update edit content' }
  Write-Output 'PASS native window, Chinese title, five control types and button event'
  Write-Output ('Generated fixture: ' + $sourceFile)
} finally { if (!$probeProcess.HasExited) { Stop-Process -Id $probeProcess.Id } }
