---
agent: 'agent'
description: 'Plan a comprehensive dependency upgrade for rayfin-fabricator (Tauri/wry/Rust backend + React/Vite/TS JS toolchain). Re-discovers current vs latest versions, respects the vendored-wry pinning constraints, and produces a risk-tiered upgrade plan. PLANNING ONLY — does not bump versions or modify code unless explicitly told to implement.'
---

# Dependency upgrade — planning run

You are planning a **comprehensive dependency upgrade** for this repo (`rayfin-fabricator`,
a Tauri v2 desktop app: Rust backend in `src-tauri/`, React + Vite renderer in
`src/renderer/`). This is a **recurring (bi-weekly) review**.

**PLANNING ONLY.** Do not bump any version, edit any manifest, or run any installer
unless I explicitly reply "implement" / "do it". Your single deliverable this run is a
written, risk-tiered upgrade plan saved to your session `plan.md`, plus a short summary.

Always **re-discover live versions** — do not trust the baseline snapshot at the bottom
of this file; it is only a reference point from a previous run.

---

## The two dependency surfaces

1. **Node / renderer** — `package.json` (root). React, react-dom, Vite,
   `@vitejs/plugin-react`, TypeScript, ESLint + `@eslint/js` + `typescript-eslint`,
   `@tauri-apps/api` + `@tauri-apps/plugin-*`, monaco-editor + `@monaco-editor/react`,
   react-markdown, remark-gfm, highlight.js, yaml, prettier, globals, `@types/*`.
2. **Rust / Tauri backend** — `src-tauri/Cargo.toml` (+ `src-tauri/Cargo.lock` for
   resolved versions). `tauri` + `tauri-build` + `tauri-plugin-*`, `github-copilot-sdk`,
   `wry` (vendored — see below), `webview2-com` / `windows` (Windows), `objc2` /
   `block2` / `objc2-*` (macOS), `reqwest`, `tokio`, `serde`, etc.

---

## Step 1 — Inventory current versions

- Read `package.json` for the declared (caret) JS versions.
- Read `src-tauri/Cargo.toml` for declared crate versions, and extract the **resolved**
  versions from `src-tauri/Cargo.lock` for at least: `tauri`, `tauri-runtime-wry`,
  `wry`, `tao`, `github-copilot-sdk`, `webview2-com`, `windows`, `objc2`,
  `tauri-plugin-updater`, `reqwest`, `tokio`. Example:
  ```powershell
  cd src-tauri
  Select-String -Path Cargo.lock -Pattern '^name = "(tauri|wry|github-copilot-sdk|webview2-com|windows|objc2|tao|tauri-runtime-wry|reqwest|tokio)"' -Context 0,1
  ```

## Step 2 — Discover the latest available versions

- **crates.io** (use `.crate.max_stable_version`, ignore pre-releases unless I ask):
  ```powershell
  Invoke-RestMethod -Uri "https://crates.io/api/v1/crates/<name>" -Headers @{ 'User-Agent' = 'rayfin-dep-check' }
  ```
  Check: `tauri`, `tauri-build`, `wry`, `github-copilot-sdk`, `webview2-com`,
  `windows`, `objc2`, `tauri-plugin-updater`, `tauri-plugin-dialog`,
  `tauri-plugin-opener`, `tauri-plugin-log`, `reqwest`, `tokio`.
- **npm**: `npm view <pkg> version` for each JS dependency/devDependency.
- Note whether a **new Tauri minor/major** exists — that is the trigger for the
  expensive vendored-wry re-vendor path (see Hard Constraints).

## Step 3 — HARD CONSTRAINTS (a plan that violates any of these is wrong)

1. **`wry` is vendored and version-pinned to whatever Tauri pins.** It lives at
   `src-tauri/vendor/wry/` (the upstream crate plus the patch files in
   `src-tauri/vendor/wry-patches/`) and is wired via
   `[patch.crates-io] wry = { path = "vendor/wry" }` in `src-tauri/Cargo.toml`. The
   override only applies because the vendored crate has the **exact same version** Tauri
   pins. Because `tauri = "2"`, a bare `cargo update` can pull in a Tauri that pins a newer
   wry; Cargo then only warns and silently builds the unpatched registry crate.
   `src-tauri/src/vendor_guard.rs` makes `cargo test --lib` fail when that happens.
2. **`webview2-com`, `windows`, `windows-core`, `objc2`, `block2`, `objc2-*` MUST match
   the versions the vendored `wry` requires.** Read `src-tauri/vendor/wry/Cargo.toml`
   for its required versions (e.g. wry 0.57.0 needs `webview2-com = 0.39`,
   `windows`/`windows-core = 0.62`, `objc2 = 0.6.4+`). Bumping these in `src-tauri/Cargo.toml`
   **independently of wry** creates a *second copy* of the crate, breaks Cargo's
   unification, and breaks `src-tauri/src/services/preview.rs` (which shares WebView2 /
   WKWebView types with wry). Only move them as part of a coordinated Tauri→wry bump.
3. **If Tauri's bump changes the pinned `wry` version**, the plan MUST include:
   re-vendoring that exact wry version with `node scripts/wry/vendor-wry.mjs update <version>`,
   which re-applies **both local patches** (`0001` WebView2 device-compliance SSO, `0002`
   macOS child-webview title-bar inset) and stops if one no longer applies. Follow
   `docs/VENDORED-WRY-PATCH.md` step-by-step. Verify the override stays live:
   `cargo test --lib vendor_guard` passes, `npm run vendor:wry -- verify` passes, and the
   `wry` entry in `src-tauri/Cargo.lock` has **no `source = "registry+..."`** line. If both
   patches ever become unnecessary upstream, the plan may instead delete the vendored tree,
   the patches, the guard + verify step, and the `[patch.crates-io]` entry.
4. **`github-copilot-sdk` is an edition-2024 crate → requires Rust ≥ 1.94.** This sets
   `rust-version` in `src-tauri/Cargo.toml`. If a newer SDK raises the floor, bump
   `rust-version` and confirm CI still satisfies it (CI uses
   `dtolnay/rust-toolchain@stable` in both `.github/workflows/ci.yml` and
   `release.yml`). Note the SDK's `bundled-cli` feature downloads a pinned Copilot CLI
   at build time (needs network / `BUNDLED_CLI_CACHE_DIR` in CI).
5. **`@types/node` tracks the Node *runtime*, not "newest".** CI builds on Node 24 LTS
   (`.github/workflows/ci.yml`, `release.yml`, `docs.yml`). Keep `@types/node` on that
   Node major (`^24`) — do not jump to the newest major just because it exists. Moving CI
   to a new Node major is its own change; Vitest 5 and later need Node ≥ 22.12.
6. **monaco offline constraint.** The app runs from `file://`; any renderer component
   using `@monaco-editor/react` must import the `../monaco` side-effect module
   (`loader.config({ monaco })`) or Monaco hangs fetching the CDN
   (`src/renderer/src/monacoOffline.test.ts` enforces this). Keep `monaco-editor`
   and `@monaco-editor/react` compatible, and don't introduce a CDN-loading path.
   Since 0.56, `monaco-editor` only exposes files through its `exports` map
   (`"./*"` → `./esm/vs/*.js`), so `src/renderer/src/monaco.ts` imports workers as
   `monaco-editor/editor/editor.worker?worker` and
   `monaco-editor/languages/features/<lang>/<worker>?worker` (never `monaco-editor/esm/...`),
   and the language services live on top-level namespaces (`monaco.typescript`, not
   `monaco.languages.typescript`). `npm run check:build` fails if a worker stops being
   bundled. `getWorker` routes on the worker `label` (the language id); confirm those
   labels in `esm/vs/languages/features/*/workerManager.js` after a bump.

## Step 4 — Categorize every available update

For each dependency with an update, classify and record:
- **Tier A — safe** (patch/minor, no breaking changes): batch together.
- **Tier B — major / breaking** (e.g. React 18→19, Vite 5→8, TypeScript 5→6,
  ESLint 9→10, `@vitejs/plugin-react` 4→6): each gets its own todo. For each, briefly
  research and list the **known breaking changes** relevant to this codebase
  (e.g. React 19 ref/`forwardRef` & `act` changes; Vite config/Rollup/Node-floor
  changes; TS 6 lib/strictness changes; ESLint 10 flat-config/Node-floor changes).
- **Tier C — coordinated/blocked**: anything gated by a Hard Constraint (Tauri↔wry↔
  windows/webview2-com/objc2). Mark blocked-by and the re-vendor work.
- **Skip**: already-latest or intentionally pinned. Say so explicitly so the review is
  complete.

## Step 5 — Validation gates (cite these in the plan; run only when implementing)

- **JS:** `npm run typecheck` && `npm test` && `npm run lint` && `npm run build:renderer`
  && `npm run check:build` (relative asset URLs, the CSP, and every Monaco worker bundled)
- **Rust:** from `src-tauri/`: `cargo check` and `cargo test --lib`
  (e.g. `cargo test --lib commands::git`, `cargo test --lib agent_`). CI runs the Rust
  tests on Windows **and** macOS.
- **Vendored wry:** `npm run vendor:wry -- verify` and `cargo test --lib vendor_guard`.
- On this machine `cargo` may not be on `PATH`; use
  `& "$env:USERPROFILE\.cargo\bin\cargo.exe"` and run from `src-tauri/`.
- After a Tauri/wry bump, also do a real `npm run tauri build` (or `cargo build`) and
  the two manual smoke tests from `docs/VENDORED-WRY-PATCH.md`: (1) sign in inside the
  preview against a device-compliance-gated app (Windows); (2) in a normal (not
  fullscreen) macOS window, confirm the preview sits right below its toolbar.

## Step 6 — Deliverable (this run)

Write `plan.md` containing:
1. **Summary table**: dependency | current | latest | tier | recommendation.
2. **Ordered todos**, grouped by tier, each with: what to bump, why, the breaking
   changes to handle, the exact validation command(s) to gate it, and rollback notes.
   Put the Tauri→wry→windows re-vendor work as one coordinated, clearly-sequenced unit.
3. **Risk & sequencing notes**: do Tier A first (fast win, separate commit), then each
   Tier B major on its own branch/commit with its own validation, then Tier C only if a
   Tauri bump is in scope this cycle.
4. **What was intentionally skipped** and why (already-latest / pinned-to-wry).

Then reflect the todos into the session SQL `todos` table for tracking and give me a
short summary. **Stop there.** Do not implement until I say so.

---

## Reference baseline (from the last manual review — re-verify, do not trust)

> Snapshot only; **always re-run Steps 1–2** for live numbers.

- **Already latest (skip):** `tauri` 2.11.3, `wry` 0.55.1 (vendored), `objc2` 0.6.x,
  `tauri-plugin-*` (caret `2`), `tokio`, all `@tauri-apps/*` JS packages,
  `@monaco-editor/react`, react-markdown, remark-gfm, highlight.js, yaml.
- **Pinned-to-wry (do NOT bump alone):** `webview2-com` 0.38, `windows` 0.61,
  `objc2`/`block2` 0.6 — newer exist on crates.io but wry 0.55.1 requires these exact.
- **Rust updates that were available:** `github-copilot-sdk` 1.0.3 → 1.0.4 (patch);
  `reqwest` 0.12 → 0.13 (optional; a 0.13.x copy is already pulled transitively).
- **JS majors that were available (Tier B):** React/react-dom 18 → 19, Vite 5 → 8,
  `@vitejs/plugin-react` 4 → 6, TypeScript 5 → 6, ESLint 9 → 10 (+ `@eslint/js`).
- **JS minors (Tier A):** `typescript-eslint`, `prettier`, `monaco-editor`, `globals`;
  keep `@types/node` aligned to Node 20/22 (not newest).
