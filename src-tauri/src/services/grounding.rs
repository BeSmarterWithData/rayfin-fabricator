//! Grounding for the Help assistant: a local copy of Fabricator's own source,
//! its published documentation, and its release notes.
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
//! **The release notes follow the running build too.** They are published on
//! GitHub rather than on the docs site, and fetched again after every update,
//! so "what's new?" finds the version the user has just been given.
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
/// Where Fabricator's releases, and the notes for each, are published.
pub const RELEASES_URL: &str = "https://github.com/spatney/rayfin-fabricator/releases";
/// The same releases from GitHub's API, which returns every release's notes in
/// one response. The newest thirty are the history anyone asks "what's new?"
/// about, and keep the response to a few hundred kilobytes.
const RELEASES_API: &str = "https://api.github.com/repos/spatney/rayfin-fabricator/releases?per_page=30";
/// Refresh the cached docs once a day; they change independently of the app.
const DOCS_MAX_AGE_SECS: u64 = 24 * 60 * 60;
/// How often to look again for release notes that don't cover the running
/// version yet — a development build, or a release fetched the moment it was
/// published — instead of every time Help opens.
const NOTES_MAX_AGE_SECS: u64 = 24 * 60 * 60;
/// Give the clone a generous but bounded window; it is ~15 MB over a shallow fetch.
const CLONE_TIMEOUT_MS: u64 = 180_000;
/// Per-request timeout when fetching the docs or the release notes.
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

/// Where the mirrored release notes live: recent releases in one Markdown
/// file, newest first, beside the documentation.
pub fn release_notes_file() -> PathBuf {
  docs_dir().join("release-notes.md")
}

/// The tag Fabricator publishes `version` under.
fn release_tag(version: &str) -> String {
  format!("v{version}")
}

/// The page with one release's notes.
pub fn release_page(version: &str) -> String {
  format!("{RELEASES_URL}/tag/{}", release_tag(version))
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

/// Records which app version the release notes were fetched under, so
/// updating the app fetches the notes for the version it brought.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct NotesStamp {
  app_version: String,
  /// RFC 3339 timestamp.
  fetched_at: String,
}

fn notes_stamp_file() -> PathBuf {
  root().join("release-notes.json")
}

fn read_notes_stamp() -> Option<NotesStamp> {
  let raw = std::fs::read_to_string(notes_stamp_file()).ok()?;
  serde_json::from_str(&raw).ok()
}

fn write_notes_stamp(stamp: &NotesStamp) {
  if let Ok(body) = serde_json::to_string_pretty(stamp) {
    let _ = std::fs::write(notes_stamp_file(), body);
  }
}

/// Whether the text of mirrored release notes has a section for `version`.
fn notes_include(notes: &str, version: &str) -> bool {
  let heading = format!("# {}", release_tag(version));
  notes.lines().any(|line| line.trim_end() == heading)
}

/// Whether the mirrored release notes have a section for `version`.
pub fn notes_cover(version: &str) -> bool {
  std::fs::read_to_string(release_notes_file()).is_ok_and(|notes| notes_include(&notes, version))
}

/// Whether the release notes in `file` are current for `app_version`: fetched
/// since the app was last updated, and either covering this version or recent
/// enough that fetching again would likely find nothing new.
fn notes_current_in(file: &Path, stamp: Option<&NotesStamp>, app_version: &str, max_age_secs: u64) -> bool {
  stamp.is_some_and(|s| s.app_version == app_version)
    && std::fs::read_to_string(file)
      .is_ok_and(|notes| notes_include(&notes, app_version) || is_fresh(file, max_age_secs))
}

fn notes_current(app_version: &str) -> bool {
  notes_current_in(&release_notes_file(), read_notes_stamp().as_ref(), app_version, NOTES_MAX_AGE_SECS)
}

/// What the assistant currently has available, for the UI's status line.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroundingStatus {
  pub source_ready: bool,
  pub docs_ready: bool,
  /// The release notes are mirrored and current for the running version.
  pub notes_ready: bool,
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
    notes_ready: notes_current(app_version),
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

  let client = http_client()?;

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

/// One release as GitHub's API describes it: only the fields the mirror keeps.
#[derive(Deserialize, Debug)]
struct Release {
  tag_name: String,
  #[serde(default)]
  body: Option<String>,
  #[serde(default)]
  published_at: Option<String>,
  #[serde(default)]
  draft: bool,
  #[serde(default)]
  prerelease: bool,
}

/// Flatten releases into the file the assistant reads: a `# v<version>`
/// heading per release, newest first, then its date and page, then its notes
/// exactly as published.
fn render_release_notes(releases: &[Release]) -> String {
  let mut s = format!(
    "Fabricator's release notes, newest first, as published at {RELEASES_URL}. Each release \
starts with a `# v<version>` heading.\n"
  );
  for release in releases.iter().filter(|r| !r.draft) {
    let tag = release.tag_name.trim();
    if tag.is_empty() {
      continue;
    }
    s.push_str(&format!("\n# {tag}\n\n"));
    let mut about = Vec::new();
    if let Some(date) = release.published_at.as_deref().and_then(|d| d.get(..10)) {
      about.push(format!("Released {date}"));
    }
    if release.prerelease {
      about.push("pre-release".to_string());
    }
    about.push(format!("{RELEASES_URL}/tag/{tag}"));
    s.push_str(&about.join(" · "));
    s.push_str("\n\n");
    let body = release.body.as_deref().unwrap_or_default().replace("\r\n", "\n");
    match body.trim() {
      "" => s.push_str("No notes were published for this release.\n"),
      notes => {
        s.push_str(notes);
        s.push('\n');
      }
    }
  }
  s
}

/// Mirror the notes for recent releases, so "what's new?" is answered from
/// what was actually published for the version the user is running.
///
/// The cache is keyed to the app version, like the source: updating the app
/// fetches it again, so the notes for the version the update brought are there
/// the first time Help opens afterwards.
pub async fn ensure_release_notes(app_version: &str, force: bool) -> Result<(), String> {
  if !force && notes_current(app_version) {
    return Ok(());
  }

  let resp = http_client()?
    .get(RELEASES_API)
    .header(reqwest::header::ACCEPT, "application/vnd.github+json")
    .header("X-GitHub-Api-Version", "2022-11-28")
    .send()
    .await
    .map_err(|e| format!("Couldn't download the release notes: {e}"))?;
  if !resp.status().is_success() {
    return Err(format!("Couldn't download the release notes (HTTP {}).", resp.status().as_u16()));
  }
  let releases: Vec<Release> =
    resp.json().await.map_err(|e| format!("Couldn't read the release notes: {e}"))?;
  if releases.is_empty() {
    // Keep whatever was mirrored before rather than replacing it with nothing.
    return Err("GitHub listed no releases.".to_string());
  }

  let _ = std::fs::create_dir_all(docs_dir());
  std::fs::write(release_notes_file(), render_release_notes(&releases))
    .map_err(|e| format!("Couldn't store the release notes: {e}"))?;
  write_notes_stamp(&NotesStamp {
    app_version: app_version.to_string(),
    fetched_at: chrono::Utc::now().to_rfc3339(),
  });
  Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(DOCS_TIMEOUT_SECS))
    .user_agent("rayfin-fabricator-help")
    .build()
    .map_err(|e| e.to_string())
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

/// Fetch every part of the grounding, reporting whichever failed. The parts
/// are independent, so one failing must not block the others.
pub async fn ensure_all(app_version: &str, force: bool) -> GroundingStatus {
  let (source, docs, notes) = futures::future::join3(
    ensure_source(app_version, force),
    ensure_docs(force),
    ensure_release_notes(app_version, force),
  )
  .await;
  if let Err(e) = &source {
    log::warn!("Help assistant source grounding unavailable: {e}");
  }
  if let Err(e) = &docs {
    log::warn!("Help assistant docs grounding unavailable: {e}");
  }
  if let Err(e) = &notes {
    log::warn!("Help assistant release notes unavailable: {e}");
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

  fn release(tag: &str, body: Option<&str>) -> Release {
    Release {
      tag_name: tag.into(),
      body: body.map(str::to_string),
      published_at: Some("2026-10-10T09:52:04Z".into()),
      draft: false,
      prerelease: false,
    }
  }

  #[test]
  fn the_releases_api_response_is_read_ignoring_what_the_mirror_does_not_keep() {
    let json = r###"[{
      "tag_name": "v1.14.0",
      "name": "v1.14.0",
      "body": "## Ray takes you through your deploys",
      "published_at": "2026-10-10T09:52:04Z",
      "draft": false,
      "prerelease": false,
      "assets": [{ "name": "latest.json" }],
      "author": { "login": "spatney" }
    }, { "tag_name": "v0.37.0", "body": null, "published_at": null }]"###;
    let releases: Vec<Release> = serde_json::from_str(json).unwrap();
    assert_eq!(releases.len(), 2);
    assert_eq!(releases[0].tag_name, "v1.14.0");
    assert!(releases[1].body.is_none());
  }

  #[test]
  fn release_notes_are_flattened_newest_first_with_a_heading_per_release() {
    let text = render_release_notes(&[
      release("v1.14.0", Some("## Ray takes you through your deploys\r\n\r\nThe deploy screen is Ray's now.")),
      release("v1.13.0", Some("## Ray\n")),
    ]);
    let newer = text.find("\n# v1.14.0\n").expect("each release has its own heading");
    let older = text.find("\n# v1.13.0\n").unwrap();
    assert!(newer < older, "newest first, as the API lists them");
    assert!(text.contains("Released 2026-10-10"));
    assert!(text.contains(&format!("{RELEASES_URL}/tag/v1.14.0")), "each release links to its page");
    assert!(text.contains("## Ray takes you through your deploys\n\nThe deploy screen"), "notes kept as published");
    assert!(!text.contains('\r'), "line endings are normalised");
  }

  #[test]
  fn drafts_are_left_out_and_empty_or_pre_releases_are_called_out() {
    let mut draft = release("v9.9.9", Some("Unannounced"));
    draft.draft = true;
    let mut pre = release("v1.3.4-experimental.mac-sso.1", Some("Try it"));
    pre.prerelease = true;
    let text = render_release_notes(&[draft, pre, release("v0.37.0", None)]);
    assert!(!text.contains("v9.9.9"), "a draft is not published");
    assert!(text.contains("pre-release"));
    assert!(text.contains("# v0.37.0\n"));
    assert!(text.contains("No notes were published for this release."));
  }

  #[test]
  fn coverage_matches_the_exact_version_heading() {
    let text = render_release_notes(&[release("v1.14.0", Some("Notes"))]);
    assert!(notes_include(&text, "1.14.0"));
    assert!(!notes_include(&text, "1.14"), "a prefix is a different version");
    assert!(!notes_include(&text, "1.4.0"));
    assert!(!notes_include("Mentions # v1.14.0 in passing", "1.14.0"), "only a heading counts");
  }

  #[test]
  fn a_release_page_is_the_tag_under_the_releases_url() {
    assert_eq!(release_page("1.14.0"), format!("{RELEASES_URL}/tag/v1.14.0"));
  }

  fn notes_stamp(version: &str) -> NotesStamp {
    NotesStamp { app_version: version.into(), fetched_at: chrono::Utc::now().to_rfc3339() }
  }

  #[test]
  fn release_notes_from_before_an_update_are_fetched_again() {
    let dir = tmp_dir("notes-update");
    let file = dir.join("release-notes.md");
    std::fs::write(&file, render_release_notes(&[release("v1.13.0", Some("Ray"))])).unwrap();

    // Just written, but under the previous version: the update's notes aren't in it.
    assert!(!notes_current_in(&file, Some(&notes_stamp("1.13.0")), "1.14.0", 3600));
    assert!(!notes_current_in(&file, None, "1.14.0", 3600), "no stamp, no trust");
    assert!(notes_current_in(&file, Some(&notes_stamp("1.13.0")), "1.13.0", 3600));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn release_notes_covering_this_version_stay_current_however_old() {
    let dir = tmp_dir("notes-covered");
    let file = dir.join("release-notes.md");
    std::fs::write(&file, render_release_notes(&[release("v1.14.0", Some("Ray"))])).unwrap();
    assert!(notes_current_in(&file, Some(&notes_stamp("1.14.0")), "1.14.0", 0));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn release_notes_missing_this_version_are_retried_once_they_age() {
    // A development build, or a release fetched the moment it was published.
    let dir = tmp_dir("notes-uncovered");
    let file = dir.join("release-notes.md");
    std::fs::write(&file, render_release_notes(&[release("v1.13.0", Some("Ray"))])).unwrap();
    assert!(notes_current_in(&file, Some(&notes_stamp("1.14.0")), "1.14.0", 3600), "not every time Help opens");
    assert!(!notes_current_in(&file, Some(&notes_stamp("1.14.0")), "1.14.0", 0), "but again once they age");
    assert!(!notes_current_in(&dir.join("missing.md"), Some(&notes_stamp("1.14.0")), "1.14.0", 3600));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
