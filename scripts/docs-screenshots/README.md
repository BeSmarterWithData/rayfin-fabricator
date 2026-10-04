# Docs screenshots

Tooling for the screenshots in `website/public/screenshots/`. They come from a real
Fabricator instance with a sample project. Personal details are swapped for sample values
before every capture, and screens that are hard to reach live are rendered from the
app's own components with sample data.

Everything here is a maintainer tool. It isn't part of the app or of CI.

| File | What it does |
| --- | --- |
| `launch.ps1` | Starts an isolated debug build with its own app data, WebView2 profile and projects folder, plus a DevTools port |
| `cdp.mjs` | Drives the app over the DevTools protocol: list targets, evaluate, click, type, scrub, screenshot |
| `scrub.js` | Replaces personal details (names, emails, tenant, workspace and repo names, paths) in a page |
| `capture-window.ps1` | Captures the app window, including the native preview webview a DevTools screenshot can't see |
| `optimize.mjs` | Crops, resizes and converts a capture to WebP (uses `sharp` from `website/node_modules`) |
| `harness/` + `capture-harness.ps1` | Renders components with sample data (team overview, publish menu, Rayfin update popover, port-conflict dialog) and captures them with headless Edge |

## Before you start

- Windows with Microsoft Edge, Node.js 22+, Rust, and the Tauri prerequisites.
- Signed in to GitHub Copilot and the Azure CLI. The isolated instance shares these sign-ins
  (and the Rayfin CLI's Fabric sign-in) because those tools own their credentials.
- `npm install` in `website/` for `sharp`.
- A Fabric workspace you can deploy a sample app into and delete afterwards.
- Expect to use some Copilot requests: a few chat turns and one Advisor deep review.

## 1. Build an isolated instance

Build from a clean checkout of the release you're documenting, so the shots match what
users have and don't depend on a running dev server:

```powershell
git worktree add --detach $env:TEMP\fab-docs\wt v1.7.2
cd $env:TEMP\fab-docs\wt
npm ci
$env:CARGO_TARGET_DIR = "$env:TEMP\fab-docs\target"
npx tauri build --debug --no-bundle
```

`--debug` keeps `FABRICATOR_DEV_DATA_DIR` working, and `tauri build` embeds the frontend.

## 2. Capture live screens

```powershell
$shots = "$env:TEMP\fab-docs\shots"    # raw captures stay outside the repository
$app = ./launch.ps1                    # prints the process id; DevTools on port 9333
node cdp.mjs targets                   # the app window, plus the preview once an app runs
node cdp.mjs click "text:Enter Fabricator"
node cdp.mjs scrub $env:TEMP\fab-docs\scrub-map.json
node cdp.mjs --url fabricapps.net scrub $env:TEMP\fab-docs\scrub-map.json   # the preview
./capture-window.ps1 -ProcessId $app -Out $shots\setup.png -Width 1440 -Height 900
```

Keep the scrub map outside the repository. It maps your real values onto sample ones:

```json
{
  "jane@fabrikam.com": "avery.chen@contoso.com",
  "Jane Doe": "Avery Chen",
  "janedoe": "averychen",
  "C:\\Users\\jane": "C:\\Users\\avery",
  "=JD": "AC",
  "@initials": "AC"
}
```

Keys match case-insensitively, longest first. A key starting with `=` replaces only a whole
text node equal to it (for avatar initials), and `@initials` sets the badge drawn over
avatar images. Scrub right before each capture, because the app re-renders, and scrub every
target that's on screen (the app window and the preview are separate pages).

Always look at each capture before you use it, and discard any that still show personal
data, real tenant or workspace names, or other people from your directory.

## 3. Capture harness screens

```powershell
./capture-harness.ps1 -Checkout $env:TEMP\fab-docs\wt -Out $shots
```

This copies `harness/` into the checkout's `src/renderer`, serves it with Vite on port
1437, captures each `?shot=` with headless Edge, then removes the copied files. Add a shot
by adding a case to `harness/docs-harness.tsx`.

## 4. Optimize and place

```powershell
node optimize.mjs $shots\setup.png ..\..\website\public\screenshots\setup.webp
node optimize.mjs $shots\share.png ..\..\website\public\screenshots\share.webp --crop 400,240,640,420
```

`--crop x,y,width,height` is in window (CSS) pixels. Reference images in pages as
`![Alt text that describes the image](/screenshots/<id>.webp)`; see `website/AGENTS.md`.

## 5. Clean up

Stop the instance, delete the sample Fabric workspace, and remove
`$env:TEMP\fab-docs` (data, WebView2 profile, projects) and the worktree
(`git worktree remove $env:TEMP\fab-docs\wt`).
