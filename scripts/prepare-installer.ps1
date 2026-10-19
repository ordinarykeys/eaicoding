<# Build Harness's native NSIS presentation with EAiCoding branding. #>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'src-tauri/installer/window-frame.cpp'
$output = Join-Path $repoRoot 'src-tauri/target/installer-ui'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Installer requires Visual Studio C++ Build Tools and Windows SDK.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ Build Tools are missing.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars32.bat'
$compileScript = Join-Path $output 'compile-frame.cmd'
$compileLines = @('@echo off', ('call "{0}" >nul' -f $vcvars), 'if errorlevel 1 exit /b %errorlevel%', ('cl /nologo /LD /MT /O1 /W4 /WX /EHsc "{0}" /Fo"{1}" /link /OUT:"{2}" /IMPLIB:"{3}" user32.lib comctl32.lib dwmapi.lib gdiplus.lib ole32.lib' -f $source, (Join-Path $output 'window-frame.obj'), (Join-Path $output 'window-frame.dll'), (Join-Path $output 'window-frame.lib')))
[IO.File]::WriteAllLines($compileScript, $compileLines, [Text.Encoding]::Default)
& $env:ComSpec /d /c $compileScript
if ($LASTEXITCODE -ne 0) { throw 'Native installer helper compilation failed.' }

# Generate only our own icon and wordmark; Harness's brand artwork is not included.
Add-Type -AssemblyName System.Drawing
$icon = [Drawing.Icon]::new((Join-Path $repoRoot 'src-tauri/icons/icon.ico'), 96, 96)
try {
  foreach ($dark in @($false, $true)) {
    foreach ($scale in @(1, 2)) {
      $bitmap = [Drawing.Bitmap]::new((600 * $scale), (196 * $scale), [Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      $font = [Drawing.Font]::new('Segoe UI', (46 * $scale), [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
      $brush = [Drawing.SolidBrush]::new($(if ($dark) { [Drawing.Color]::FromArgb(249,250,251) } else { [Drawing.Color]::FromArgb(15,17,21) }))
      try {
        $graphics.Clear($(if ($dark) { [Drawing.Color]::FromArgb(21,21,23) } else { [Drawing.Color]::White }))
        $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $textSize = $graphics.MeasureString('EAiCoding', $font)
        $width = 66 * $scale + $textSize.Width
        $left = (600 * $scale - $width) / 2
        $graphics.DrawIcon($icon, [Drawing.Rectangle]::new([int]$left, (68 * $scale), (52 * $scale), (52 * $scale)))
        $graphics.DrawString('EAiCoding', $font, $brush, ($left + 66 * $scale), (64 * $scale))
        $asset = 'brand' + $(if ($dark) { '-dark' } else { '' }) + $(if ($scale -eq 2) { '-2x' } else { '' })
        $bitmap.Save((Join-Path $output "$asset.bmp"), [Drawing.Imaging.ImageFormat]::Bmp)
      } finally { $brush.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
    }
  }
} finally { $icon.Dispose() }
Write-Output "Prepared EAiCoding native installer resources: $output"
