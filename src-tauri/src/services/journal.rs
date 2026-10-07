//! The activity journal — a record of what the app actually did, good and bad,
//! so the in-app Help assistant can answer questions about it.
//!
//! This started as an error log, and that was the wrong shape. A journal of
//! only failures can only tell a story of failure: asked "how did setup go?"
//! on a machine where setup had just succeeded, the assistant found four
//! render errors from minutes earlier and reported that setup was broken. It
//! had no way to know those errors were followed by success.
//!
//! So notable successes are recorded too. A failure followed by a later
//! success is self-evidently resolved, and the assistant can see that ordering
//! without being told.
//!
//! Design goals mirror `diagnostics.rs`:
//!   * **Never break the app.** Every write is best-effort; nothing here
//!     panics or returns an error to its caller.
//!   * **Milestones, not a firehose.** One line per thing a person would
//!     recognise as an event — signed in, installed, deployed — not per click.
//!   * **No secrets.** Values are masked before they are written.
//!
//! Records land in `<dataDir>/logs/activity-<day>.jsonl` and are pruned on the
//! same schedule as the rest of the logs directory.

use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::paths;

/// Cap on any single free-text field, so a runaway stack trace or process dump
/// can't bloat the journal.
const MAX_FIELD: usize = 4000;
/// Most lines [`recent`] will return to the assistant in one read.
const MAX_RECENT: usize = 400;

/// How a record should be read. The assistant weighs these against each other:
/// an `Error` followed later by an `Info` for the same area is resolved.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
  /// Something went right, and is worth remembering.
  Info,
  /// Something is off but the user can carry on.
  Warn,
  /// Something failed.
  Error,
}

/// Where a record came from. Kept coarse on purpose: the assistant uses it to
/// narrow a search, and a long tail of one-off values would make that harder.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Area {
  /// Prerequisite checks and tool installs.
  Setup,
  /// Copilot or Fabric sign-in.
  Auth,
  /// A Build chat turn.
  Chat,
  /// The local preview / dev server.
  Preview,
  /// Deploying to Microsoft Fabric.
  Deploy,
  /// Git and team workspace sync.
  Git,
  /// Team workspaces.
  Team,
  /// The Advisor.
  Advisor,
  /// Project create / open / delete.
  Project,
  /// An unhandled renderer (UI) error.
  Ui,
  /// App startup, updates, and anything that doesn't fit above.
  App,
}

impl Area {
  /// Parse the renderer's string form. Unknown values fall back to [`Area::App`]
  /// so a typo in the UI can never drop a record on the floor.
  pub fn parse(raw: &str) -> Self {
    match raw.trim().to_ascii_lowercase().as_str() {
      "setup" => Self::Setup,
      "auth" => Self::Auth,
      "chat" => Self::Chat,
      "preview" => Self::Preview,
      "deploy" => Self::Deploy,
      "git" => Self::Git,
      "team" => Self::Team,
      "advisor" => Self::Advisor,
      "project" => Self::Project,
      "ui" => Self::Ui,
      _ => Self::App,
    }
  }
}

impl Level {
  pub fn parse(raw: &str) -> Self {
    match raw.trim().to_ascii_lowercase().as_str() {
      "info" | "ok" | "success" => Self::Info,
      "warn" | "warning" => Self::Warn,
      _ => Self::Error,
    }
  }
}

/// How a failure reached the user. Only meaningful for warnings and errors.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Surface {
  /// Shown as an error toast.
  Toast,
  /// Shown inline in a view (a banner, an error card).
  Inline,
  /// Caught by the React error boundary.
  Boundary,
  /// An unhandled exception or promise rejection in the renderer.
  Unhandled,
  /// Logged by the backend without a direct UI counterpart.
  Backend,
  /// A Rust panic.
  Panic,
}

impl Surface {
  pub fn parse(raw: &str) -> Self {
    match raw.trim().to_ascii_lowercase().as_str() {
      "inline" => Self::Inline,
      "boundary" => Self::Boundary,
      "unhandled" => Self::Unhandled,
      "backend" => Self::Backend,
      "panic" => Self::Panic,
      _ => Self::Toast,
    }
  }
}

/// One journal entry, serialized as a single JSON line.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Record {
  /// RFC 3339 timestamp.
  pub time: String,
  pub level: Level,
  pub area: Area,
  /// A stable key for what happened, such as `setup.completed` or
  /// `deploy.failed`. Lets the assistant match a failure to the success that
  /// resolved it without parsing prose.
  pub event: String,
  /// Short, human-readable summary — for a failure, the text the user saw.
  pub message: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub surface: Option<Surface>,
  /// The operation involved, such as `deploy_run` or `auth_login_copilot`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub operation: Option<String>,
  /// Longer context: a stack trace, stderr, or a failing command's output.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub project_id: Option<String>,
  /// True when this came from a development build run from source. Those are
  /// a developer's own half-finished edits, not faults in the installed app.
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub dev: bool,
  pub app_version: String,
  pub os: String,
}

fn day() -> String {
  chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Trim a field to [`MAX_FIELD`] characters. Multi-byte safe.
fn clip(text: &str) -> String {
  if text.chars().count() <= MAX_FIELD {
    return text.to_string();
  }
  let head: String = text.chars().take(MAX_FIELD).collect();
  format!("{head}… (truncated)")
}

/// The app version, read from the compile-time crate version so a record is
/// self-describing without threading an `AppHandle` through every call site.
fn app_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

/// Everything a caller can say about one event. Built with [`entry`] and the
/// `with_*` helpers so the common cases stay one line.
#[derive(Clone, Debug)]
pub struct Entry {
  pub level: Level,
  pub area: Area,
  pub event: String,
  pub message: String,
  pub surface: Option<Surface>,
  pub operation: Option<String>,
  pub detail: Option<String>,
  pub project_id: Option<String>,
  pub dev: Option<bool>,
}

/// Start an entry. `event` is a stable dotted key; `message` is what a person
/// would read.
pub fn entry(level: Level, area: Area, event: &str, message: &str) -> Entry {
  Entry {
    level,
    area,
    event: event.to_string(),
    message: message.to_string(),
    surface: None,
    operation: None,
    detail: None,
    project_id: None,
    dev: None,
  }
}

impl Entry {
  pub fn surface(mut self, surface: Surface) -> Self {
    self.surface = Some(surface);
    self
  }

  pub fn operation(mut self, operation: impl Into<String>) -> Self {
    self.operation = Some(operation.into());
    self
  }

  pub fn detail(mut self, detail: Option<String>) -> Self {
    self.detail = detail;
    self
  }

  pub fn project(mut self, project_id: Option<String>) -> Self {
    self.project_id = project_id;
    self
  }

  pub fn dev(mut self, dev: bool) -> Self {
    self.dev = Some(dev);
    self
  }

  /// Build the record, masking secrets and clipping long fields.
  pub fn build(self) -> Record {
    let mask = |s: &str| clip(&crate::commands::advisor::mask_secrets(s));
    Record {
      time: chrono::Utc::now().to_rfc3339(),
      level: self.level,
      area: self.area,
      event: self.event,
      message: mask(&self.message),
      surface: self.surface,
      operation: self.operation,
      detail: self.detail.as_deref().map(mask),
      project_id: self.project_id,
      dev: self.dev.unwrap_or(cfg!(debug_assertions)),
      app_version: app_version(),
      os: std::env::consts::OS.to_string(),
    }
  }

  /// Build and write in one step.
  pub fn write(self) {
    write(&self.build());
  }
}

/// Append one record as a JSON line into `dir`. Best-effort.
fn append_to(dir: &Path, rec: &Record) {
  let Ok(line) = serde_json::to_string(rec) else {
    return;
  };
  let path = dir.join(format!("activity-{}.jsonl", day()));
  if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = writeln!(f, "{line}");
  }
}

/// Record one entry. The single entry point used by both Rust and (through
/// `diagnostics_record`) the renderer.
pub fn write(rec: &Record) {
  append_to(&paths::logs_dir(), rec);
}

/// The most recent lines, oldest first, capped at `max_lines`. Returns raw
/// JSONL so the caller can hand it straight to the model — and so the ordering
/// that makes a later success meaningful is preserved.
pub fn recent(max_lines: usize) -> String {
  recent_in(&paths::logs_dir(), max_lines)
}

fn recent_in(dir: &Path, max_lines: usize) -> String {
  let max_lines = max_lines.min(MAX_RECENT);
  let mut files: Vec<std::path::PathBuf> = match std::fs::read_dir(dir) {
    Ok(rd) => rd
      .flatten()
      .map(|e| e.path())
      .filter(|p| {
        p.is_file()
          && p
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("activity-") && n.ends_with(".jsonl"))
      })
      .collect(),
    Err(_) => return String::new(),
  };
  // `activity-YYYY-MM-DD.jsonl` sorts chronologically, so the newest sorts last.
  files.sort();
  let mut lines: Vec<String> = Vec::new();
  for path in files.iter().rev().take(3).rev() {
    if let Ok(content) = std::fs::read_to_string(path) {
      lines.extend(content.lines().map(str::to_string));
    }
  }
  let start = lines.len().saturating_sub(max_lines);
  lines[start..].join("\n")
}

/// Delete journals older than the retention window. Called from
/// [`super::diagnostics::prune`] so the logs directory stays bounded.
pub fn prune(retention_days: i64) {
  let dir = paths::logs_dir();
  let cutoff = (chrono::Utc::now() - chrono::Duration::days(retention_days))
    .format("%Y-%m-%d")
    .to_string();
  let Ok(rd) = std::fs::read_dir(&dir) else {
    return;
  };
  for entry in rd.flatten() {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
      continue;
    };
    // `errors-*` is the journal's former name; clean those up too.
    let dated = name
      .strip_prefix("activity-")
      .or_else(|| name.strip_prefix("errors-"))
      .and_then(|s| s.strip_suffix(".jsonl"));
    if let Some(date) = dated {
      if date < cutoff.as_str() || name.starts_with("errors-") {
        let _ = std::fs::remove_file(&path);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rayfin-journal-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn failure(message: &str) -> Record {
    entry(Level::Error, Area::Deploy, "deploy.failed", message)
      .surface(Surface::Toast)
      .operation("deploy_run")
      .project(Some("proj-1".into()))
      .build()
  }

  #[test]
  fn appends_a_parseable_jsonl_line() {
    let dir = tmp_dir("append");
    append_to(&dir, &failure("The deploy failed."));

    let file = dir.join(format!("activity-{}.jsonl", day()));
    let content = std::fs::read_to_string(&file).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
    assert_eq!(parsed["level"], "error");
    assert_eq!(parsed["area"], "deploy");
    assert_eq!(parsed["event"], "deploy.failed");
    assert_eq!(parsed["surface"], "toast");
    assert_eq!(parsed["projectId"], "proj-1");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn records_what_went_right_too() {
    let dir = tmp_dir("success");
    append_to(&dir, &entry(Level::Info, Area::Setup, "setup.completed", "Setup finished.").build());

    let content =
      std::fs::read_to_string(dir.join(format!("activity-{}.jsonl", day()))).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
    assert_eq!(parsed["level"], "info");
    assert_eq!(parsed["event"], "setup.completed");
    // A success has no failure surface to report.
    assert!(parsed.get("surface").is_none());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_failure_followed_by_a_success_reads_in_order() {
    // This is the whole point: the assistant must be able to see that the
    // errors came first and the success came after.
    let dir = tmp_dir("resolved");
    append_to(&dir, &failure("Setup screen crashed."));
    append_to(&dir, &entry(Level::Info, Area::Setup, "setup.completed", "Setup finished.").build());

    let recent = recent_in(&dir, 10);
    let lines: Vec<&str> = recent.lines().collect();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("\"level\":\"error\""));
    assert!(lines[1].contains("setup.completed"), "the resolution is last");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn masks_secrets_in_message_and_detail() {
    let rec = entry(Level::Error, Area::Auth, "auth.failed", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789")
      .detail(Some("Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789".into()))
      .build();
    assert!(!rec.message.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    assert!(!rec.detail.unwrap().contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  }

  #[test]
  fn a_dev_build_is_flagged_so_help_can_discount_it() {
    assert!(entry(Level::Error, Area::Ui, "ui.crashed", "x is not defined").dev(true).build().dev);
    assert!(!entry(Level::Error, Area::Ui, "ui.crashed", "boom").dev(false).build().dev);
  }

  #[test]
  fn recent_caps_the_number_of_lines_and_keeps_the_newest() {
    let dir = tmp_dir("cap");
    for i in 0..30 {
      append_to(&dir, &failure(&format!("error {i}")));
    }
    let out = recent_in(&dir, 5);
    assert_eq!(out.lines().count(), 5);
    assert!(out.contains("error 29"));
    assert!(!out.contains("error 0"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn clip_truncates_long_text() {
    let long = "x".repeat(MAX_FIELD + 50);
    assert!(clip(&long).ends_with("(truncated)"));
    assert_eq!(clip("short"), "short");
  }

  #[test]
  fn parsing_falls_back_for_unknown_values() {
    assert_eq!(Area::parse("deploy"), Area::Deploy);
    assert_eq!(Area::parse("DEPLOY"), Area::Deploy);
    assert_eq!(Area::parse("nonsense"), Area::App);
    assert_eq!(Level::parse("info"), Level::Info);
    assert_eq!(Level::parse("success"), Level::Info);
    assert_eq!(Level::parse("warn"), Level::Warn);
    assert_eq!(Level::parse("nonsense"), Level::Error);
    assert_eq!(Surface::parse("boundary"), Surface::Boundary);
    assert_eq!(Surface::parse("nonsense"), Surface::Toast);
  }

  #[test]
  fn append_to_a_bad_dir_does_not_panic() {
    let bad = std::env::temp_dir().join("rayfin-journal-missing").join(uuid::Uuid::new_v4().to_string()).join("nested");
    append_to(&bad, &failure("ignored"));
  }
}
