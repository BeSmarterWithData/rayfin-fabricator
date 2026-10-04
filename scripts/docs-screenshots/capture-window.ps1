<#
.SYNOPSIS
  Captures a window of a running process to PNG, including native child webviews.

.DESCRIPTION
  Fabricator's app preview is a native WebView2 surface, not part of the app window's DOM,
  so a DevTools screenshot leaves it blank. This captures what is composited on screen.
  It first tries PrintWindow with PW_RENDERFULLCONTENT (works while the window is covered)
  and falls back to copying the screen area after bringing the window to the front.

.EXAMPLE
  ./capture-window.ps1 -ProcessId 1234 -Out shots/workbench.png -Width 1440 -Height 900
#>
param(
  [Parameter(Mandatory)] [int] $ProcessId,
  [Parameter(Mandatory)] [string] $Out,
  # Optional client-area size in logical (96 DPI) pixels; the window is resized first.
  [int] $Width = 0,
  [int] $Height = 0,
  # Skip PrintWindow and copy from the screen (the window must be visible and on top).
  [switch] $FromScreen
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ('DocsShot.Win' -as [type])) {
  Add-Type -Namespace DocsShot -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
'@
}
# Per-monitor DPI awareness so rectangles are in physical pixels.
[DocsShot.Win]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

$hwnd = (Get-Process -Id $ProcessId).MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "Process $ProcessId has no main window" }
[DocsShot.Win]::ShowWindow($hwnd, 9) | Out-Null # SW_RESTORE
$scale = [DocsShot.Win]::GetDpiForWindow($hwnd) / 96.0

if ($Width -gt 0 -and $Height -gt 0) {
  $win = New-Object DocsShot.Win+RECT
  $client = New-Object DocsShot.Win+RECT
  [DocsShot.Win]::GetWindowRect($hwnd, [ref]$win) | Out-Null
  [DocsShot.Win]::GetClientRect($hwnd, [ref]$client) | Out-Null
  $extraW = ($win.Right - $win.Left) - ($client.Right - $client.Left)
  $extraH = ($win.Bottom - $win.Top) - ($client.Bottom - $client.Top)
  $w = [int]([math]::Round($Width * $scale)) + $extraW
  $h = [int]([math]::Round($Height * $scale)) + $extraH
  # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
  [DocsShot.Win]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, $w, $h, 0x0002 -bor 0x0004 -bor 0x0010) | Out-Null
  Start-Sleep -Milliseconds 800
}

$rect = New-Object DocsShot.Win+RECT
[DocsShot.Win]::GetClientRect($hwnd, [ref]$rect) | Out-Null
$cw = $rect.Right - $rect.Left
$ch = $rect.Bottom - $rect.Top
$bitmap = New-Object System.Drawing.Bitmap $cw, $ch
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

$captured = $false
if (-not $FromScreen) {
  $hdc = $graphics.GetHdc()
  # PW_CLIENTONLY (1) | PW_RENDERFULLCONTENT (2)
  $captured = [DocsShot.Win]::PrintWindow($hwnd, $hdc, 3)
  $graphics.ReleaseHdc($hdc)
  if ($captured) {
    # PrintWindow can "succeed" with an all-black frame for GPU content; sample it.
    $dark = 0
    foreach ($fx in 0.25, 0.5, 0.75) {
      foreach ($fy in 0.25, 0.5, 0.75) {
        $px = $bitmap.GetPixel([int]($cw * $fx), [int]($ch * $fy))
        if ($px.R + $px.G + $px.B -eq 0) { $dark++ }
      }
    }
    if ($dark -eq 9) { $captured = $false }
  }
}
if (-not $captured) {
  [DocsShot.Win]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 500
  $origin = New-Object DocsShot.Win+POINT
  [DocsShot.Win]::ClientToScreen($hwnd, [ref]$origin) | Out-Null
  $graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, $bitmap.Size)
}

$outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
$dir = Split-Path -Parent $outPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output ("{0} ({1}x{2}, scale {3})" -f $Out, $cw, $ch, $scale)
