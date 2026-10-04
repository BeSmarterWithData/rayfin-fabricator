<#
.SYNOPSIS
  Starts an isolated Fabricator instance for documentation screenshots.

.DESCRIPTION
  Uses a debug build (only debug builds honor FABRICATOR_DEV_DATA_DIR) with its own app
  data folder, WebView2 profile and projects folder, so your real projects, chats and
  settings are never touched. Copilot, Azure CLI and Rayfin sign-ins are shared with your
  normal environment because those tools own their credentials.

  Build the instance from a clean checkout so the shots match a release and don't depend
  on a dev server (port 1420):
    git worktree add --detach $env:TEMP\fab-docs\wt v1.7.2
    cd $env:TEMP\fab-docs\wt; npm ci
    $env:CARGO_TARGET_DIR = "$env:TEMP\fab-docs\target"; npx tauri build --debug --no-bundle

  Prints the process id; drive the app with cdp.mjs on the DevTools port and capture the
  window with capture-window.ps1.
#>
param(
  [string] $Exe = (Join-Path $env:TEMP 'fab-docs\target\debug\rayfin-fabricator.exe'),
  [string] $Root = (Join-Path $env:TEMP 'fab-docs\instance'),
  [int] $Port = 9333,
  [ValidateSet('dark', 'light', 'system')] [string] $Theme = 'dark',
  [switch] $TeamWorkspaces
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Exe)) { throw "No debug build at $Exe" }

$data = Join-Path $Root 'data'
$webview = Join-Path $Root 'webview'
$projects = Join-Path $Root 'projects'
foreach ($dir in $data, $webview, $projects) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$store = Join-Path $data 'studio.json'
if (-not (Test-Path $store)) {
  $json = @{
    workspaceRoot = $projects
    projects = @()
    settings = @{
      theme = $Theme
      uiScale = 1
      experiments = @{ teamWorkspaces = [bool]$TeamWorkspaces }
      fullDiagnostics = $false
    }
  } | ConvertTo-Json -Depth 5
  # No byte-order mark: the app's JSON parser rejects one and would silently fall back to
  # the default projects folder (your real ~/RayfinProjects).
  [System.IO.File]::WriteAllText($store, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$env:FABRICATOR_DEV_DATA_DIR = $data
$env:WEBVIEW2_USER_DATA_FOLDER = $webview
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$process = Start-Process -FilePath $Exe -PassThru
Write-Output $process.Id
