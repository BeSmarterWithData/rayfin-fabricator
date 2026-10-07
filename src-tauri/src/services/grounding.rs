//! Grounding for the Help assistant: a local copy of Fabricator's own source
//! and its published documentation.
//!
//! The assistant answers questions like "why did my deploy fail?". To do that
//! well it needs to read the message the user saw *in the code that produced
//! it*, and the docs page that explains the fix. Both are cached on disk under
//! `<dataDir>/assistant/` so the assistant works offline after the first fetch
//! and never pays a network round-trip mid-answer.
//!
//! **The source is pinned to the running build.** Fabricator tags every release
//! `v<version>`, so a packaged build clones that exact tag and the code the
//! assistant reads is the code the user is running. A development build (whose
//! version is not yet tagged) falls back to the default branch.
//!
//! Everything here is best-effort: if the clone or the fetch fails, the
//! assistant still runs with the logs and the user's project, and simply says
//! less about internals.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{exec, git, paths};

/// The public repository the source is cloned from.
const REPO_URL: &str = "https://github.com/spatney/rayfin-fabricator.git";
/// Where the published documentation lives.
const DOCS_BASE: &str = "https://spatney.github.io/rayfin-fabricator";
/// Refresh the cached docs once a day; they change independently of the app.
const DOCS_MAX_AGE_SECS: u64 = 24 * 60 * 60;
/// Give the clone a generous but bounded window; it is ~15 MB over a shallow fetch.
const CLONE_TIMEOUT_MS: u64 = 180_000;
/// Per-request timeout when fetching a docs page.
const DOCS_TIMEOUT_SECS: u64 = 20;
/// Directories inside the clone that carry no debugging value but a lot of bytes.
const PRUNE_DIRS: &[&str] = &[".git", ".github/ISSUE_TEMPLATE", "website/public", "build", "analytics"];
/// Binary file extensions stripped after cloning.
const PRUNE_EXTS: &[&str] =
  &["png", "jpg", "jpeg", "webp", "gif", "ico", "icns", "woff", "woff2", "ttf", "otf", "mp4", "zip"];

/// Root of the assistant's cached grounding.
pub fn root() -> PathBuf {
  let d = paths::data_dir().join("assistant");
  let _ = std::fs::create_dir_all(&d);
  d
}

/// Where the Fabricator source checkout lives.
pub fn source_dir() -> PathBuf {
  root().join("source")
}

/// Where the mirrored documentation lives.
pub fn docs_dir() -> PathBuf {
  root().join("docs")
}

/// Records which revision the cached source came from, so a version upgrade
/// invalidates it without re-cloning on every launch.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceStamp {
  /// The git ref that was cloned (`v1.9.5`, or a branch name).
  pub reference: String,
  /// App version at the time of the clone.
  pub app_version: String,
  /// RFC 3339 timestamp.
  pub fetched_at: String,
  /// True when `reference` is the exact release tag for `app_version`.
  pub pinned: bool,
}

fn stamp_file() -> PathBuf {
  root().join("source.json")
}

fn read_stamp() -> Option<SourceStamp> {
  let raw = std::fs::read_to_string(stamp_file()).ok()?;
  serde_json::from_str(&raw).ok()
}

fn write_stamp(stamp: &SourceStamp) {
  if let Ok(body) = serde_json::to_string_pretty(stamp) {
    let _ = std::fs::write(stamp_file(), body);
  }
}

/// What the assistant currently has available, for the UI's status line.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroundingStatus {
  pub source_ready: bool,
  pub docs_ready: bool,
  /// The git ref backing the cached source, when present.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reference: Option<String>,
  /// True when the cached source matches the running build exactly.
  pub pinned: bool,
}

pub fn status(app_version: &str) -> GroundingStatus {
  let stamp = read_stamp();
  let fresh = stamp.as_ref().is_some_and(|s| s.app_version == app_version);
  GroundingStatus {
    source_ready: fresh && source_dir().join("src-tauri").is_dir(),
    docs_ready: docs_dir().join("llms-full.txt").is_file(),
    reference: stamp.as_ref().map(|s| s.reference.clone()),
    pinned: stamp.as_ref().is_some_and(|s| s.pinned),
  }
}

/// Whether the remote has a `v<version>` tag, so a release build can pin to the
/// exact code it is running.
async fn tag_exists(version: &str) -> bool {
  let tag = format!("v{version}");
  let out = git::run(
    &["ls-remote", "--tags", "--refs", REPO_URL, &format!("refs/tags/{tag}")],
    exec::RunOptions { timeout_ms: Some(30_000), ..Default::default() },
  )
  .await;
  out.ok && out.stdout.contains(&tag)
}

/// Remove bulk that is useless for debugging (git metadata, binary assets) so
/// the cache stays small and the agent's searches stay fast.
fn prune_clone(dir: &Path) {
  for rel in PRUNE_DIRS {
    let target = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if target.is_dir() {
      let _ = std::fs::remove_dir_all(&target);
    }
  }
  prune_binaries(dir);
}

fn prune_binaries(dir: &Path) {
  let Ok(rd) = std::fs::read_dir(dir) else {
    return;
  };
  for entry in rd.flatten() {
    let path = entry.path();
    if path.is_dir() {
      prune_binaries(&path);
    } else if path
      .extension()
      .and_then(|e| e.to_str())
      .map(|e| e.to_ascii_lowercase())
      .is_some_and(|e| PRUNE_EXTS.contains(&e.as_str()))
    {
      let _ = std::fs::remove_file(&path);
    }
  }
}

/// Ensure a source checkout matching `app_version` exists, cloning it if the
/// cache is missing or stale. Returns the ref that is now on disk.
///
/// Prefers the exact release tag so the assistant never reasons about code the
/// user isn't running; falls back to the default branch for untagged
/// development builds.
pub async fn ensure_source(app_version: &str, force: bool) -> Result<SourceStamp, String> {
  let dir = source_dir();
  if !force {
    if let Some(stamp) = read_stamp() {
      if stamp.app_version == app_version && dir.join("src-tauri").is_dir() {
        return Ok(stamp);
      }
    }
  }

  let pinned = tag_exists(app_version).await;
  let reference = if pinned { format!("v{app_version}") } else { "master".to_string() };

  // Clone into a sibling directory and swap, so an interrupted fetch can never
  // leave a half-populated cache that later looks valid.
  let staging = root().join(format!("source.tmp-{}", uuid::Uuid::new_v4()));
  let _ = std::fs::remove_dir_all(&staging);

  let out = git::run(
    &[
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--branch",
      &reference,
      REPO_URL,
      &staging.to_string_lossy(),
    ],
    exec::RunOptions { timeout_ms: Some(CLONE_TIMEOUT_MS), ..Default::default() },
  )
  .await;

  if !out.ok {
    let _ = std::fs::remove_dir_all(&staging);
    let detail = if out.stderr.trim().is_empty() { out.stdout } else { out.stderr };
    return Err(format!("Couldn't download the Fabricator source: {}", detail.trim()));
  }

  prune_clone(&staging);
  let _ = std::fs::remove_dir_all(&dir);
  if let Err(e) = std::fs::rename(&staging, &dir) {
    let _ = std::fs::remove_dir_all(&staging);
    return Err(format!("Couldn't store the Fabricator source: {e}"));
  }

  let stamp = SourceStamp {
    reference,
    app_version: app_version.to_string(),
    fetched_at: chrono::Utc::now().to_rfc3339(),
    pinned,
  };
  write_stamp(&stamp);
  Ok(stamp)
}

/// Mirror the published documentation locally.
///
/// The site publishes `/llms-full.txt` (every page flattened into one file) and
/// `/llms.txt` (an index). Together they are a few hundred kilobytes, so the
/// whole corpus is cached as two files rather than crawled page by page.
pub async fn ensure_docs(force: bool) -> Result<(), String> {
  let dir = docs_dir();
  let _ = std::fs::create_dir_all(&dir);
  let full = dir.join("llms-full.txt");

  if !force && is_fresh(&full, DOCS_MAX_AGE_SECS) {
    return Ok(());
  }

  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(DOCS_TIMEOUT_SECS))
    .user_agent("rayfin-fabricator-help")
    .build()
    .map_err(|e| e.to_string())?;

  let mut failures: Vec<String> = Vec::new();
  for (name, url) in [
    ("llms-full.txt", format!("{DOCS_BASE}/llms-full.txt")),
    ("llms.txt", format!("{DOCS_BASE}/llms.txt")),
  ] {
    match fetch_text(&client, &url).await {
      Ok(body) => {
        let _ = std::fs::write(dir.join(name), body);
      }
      Err(e) => failures.push(format!("{name}: {e}")),
    }
  }

  if full.is_file() {
    // The index is a nicety; the flattened corpus is what matters.
    return Ok(());
  }
  Err(format!("Couldn't download the documentation ({}).", failures.join("; ")))
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
  let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
  if !resp.status().is_success() {
    return Err(format!("HTTP {}", resp.status().as_u16()));
  }
  resp.text().await.map_err(|e| e.to_string())
}

fn is_fresh(path: &Path, max_age_secs: u64) -> bool {
  std::fs::metadata(path)
    .and_then(|m| m.modified())
    .map(|m| m.elapsed().map(|age| age.as_secs() < max_age_secs).unwrap_or(false))
    .unwrap_or(false)
}

/// Fetch both halves of the grounding, reporting whichever failed. Source and
/// docs are independent, so one failing must not block the other.
pub async fn ensure_all(app_version: &str, force: bool) -> GroundingStatus {
  let (source, docs) = futures::future::join(ensure_source(app_version, force), ensure_docs(force)).await;
  if let Err(e) = &source {
    log::warn!("Help assistant source grounding unavailable: {e}");
  }
  if let Err(e) = &docs {
    log::warn!("Help assistant docs grounding unavailable: {e}");
  }
  status(app_version)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rayfin-grounding-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn prune_removes_binaries_and_bulk_directories() {
    let dir = tmp_dir("prune");
    std::fs::create_dir_all(dir.join(".git").join("objects")).unwrap();
    std::fs::write(dir.join(".git").join("objects").join("blob"), "x").unwrap();
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src").join("main.rs"), "fn main() {}").unwrap();
    std::fs::write(dir.join("src").join("logo.png"), [0u8, 1, 2]).unwrap();

    prune_clone(&dir);

    assert!(!dir.join(".git").exists(), "git metadata is removed");
    assert!(!dir.join("src").join("logo.png").exists(), "binaries are removed");
    assert!(dir.join("src").join("main.rs").is_file(), "source is kept");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn freshness_tracks_file_age() {
    let dir = tmp_dir("fresh");
    let file = dir.join("llms-full.txt");
    std::fs::write(&file, "docs").unwrap();
    assert!(is_fresh(&file, 60), "a file just written is fresh");
    assert!(!is_fresh(&file, 0), "a zero window is never fresh");
    assert!(!is_fresh(&dir.join("missing.txt"), 60), "a missing file is not fresh");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn stamp_round_trips() {
    let stamp = SourceStamp {
      reference: "v1.9.5".into(),
      app_version: "1.9.5".into(),
      fetched_at: chrono::Utc::now().to_rfc3339(),
      pinned: true,
    };
    let json = serde_json::to_string(&stamp).unwrap();
    let back: SourceStamp = serde_json::from_str(&json).unwrap();
    assert_eq!(back.reference, "v1.9.5");
    assert!(back.pinned);
    assert!(json.contains("appVersion"), "serialises camelCase for the renderer");
  }
}
