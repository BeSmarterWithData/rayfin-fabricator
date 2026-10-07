//! The error journal — one structured record for every error the app shows or
//! swallows, so the in-app Help assistant can explain what actually went wrong.
//!
//! `crashlog.rs` already records panics and fatal errors as free text. That is
//! fine for a human reading a file, but the assistant needs to *filter* ("what
//! failed in the last ten minutes?", "has this deploy failed before?"), so every
//! record here is a JSON line with a stable shape.
//!
//! Design goals mirror `diagnostics.rs`:
//!   * **Never break the app.** Every write is best-effort; nothing here panics
//!     or returns an error to its caller.
//!   * **Cheap.** One short line appended per error. Errors are rare by nature,
//!     so there is no batching or background thread to get wrong.
//!   * **No secrets.** Values are masked before they are written.
//!
//! Records land in `<dataDir>/logs/errors-<day>.jsonl` and are pruned on the
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

/// Where an error came from. Kept coarse on purpose: the assistant uses it to
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
  /// so a typo in the UI can never drop an error on the floor.
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

/// How the error reached the user.
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

/// One error, serialized as a single JSON line.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ErrorRecord {
  /// RFC 3339 timestamp.
  pub time: String,
  pub area: Area,
  pub surface: Surface,
  /// Short, human-readable summary — usually the exact text the user saw.
  pub message: String,
  /// The operation that failed, such as `deploy_run` or `auth_login_copilot`.
  /// Lets the assistant tie a message back to one code path.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub operation: Option<String>,
  /// Longer context: a stack trace, stderr, or a failing command's output.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub project_id: Option<String>,
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

/// Build a record, masking secrets and clipping long fields.
pub fn record(
  area: Area,
  surface: Surface,
  message: &str,
  operation: Option<String>,
  detail: Option<String>,
  project_id: Option<String>,
) -> ErrorRecord {
  let mask = |s: &str| clip(&crate::commands::advisor::mask_secrets(s));
  ErrorRecord {
    time: chrono::Utc::now().to_rfc3339(),
    area,
    surface,
    message: mask(message),
    operation,
    detail: detail.as_deref().map(mask),
    project_id,
    app_version: app_version(),
    os: std::env::consts::OS.to_string(),
  }
}

/// Append one record as a JSON line into `dir`. Best-effort.
fn append_to(dir: &Path, rec: &ErrorRecord) {
  let Ok(line) = serde_json::to_string(rec) else {
    return;
  };
  let path = dir.join(format!("errors-{}.jsonl", day()));
  if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = writeln!(f, "{line}");
  }
}

/// Record one error. The single entry point used by both Rust and (through
/// `diagnostics_record`) the renderer.
pub fn write(rec: &ErrorRecord) {
  append_to(&paths::logs_dir(), rec);
}

/// The most recent error lines, oldest first, capped at `max_lines`.
/// Returns raw JSONL so the caller can hand it straight to the model.
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
            .is_some_and(|n| n.starts_with("errors-") && n.ends_with(".jsonl"))
      })
      .collect(),
    Err(_) => return String::new(),
  };
  // `errors-YYYY-MM-DD.jsonl` sorts chronologically, so the newest sorts last.
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

/// Delete error journals older than the retention window. Called from
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
    if let Some(date) = name.strip_prefix("errors-").and_then(|s| s.strip_suffix(".jsonl")) {
      if date < cutoff.as_str() {
        let _ = std::fs::remove_file(&path);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rayfin-errorlog-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn sample(message: &str) -> ErrorRecord {
    record(Area::Deploy, Surface::Toast, message, Some("deploy_run".into()), None, Some("proj-1".into()))
  }

  #[test]
  fn appends_a_parseable_jsonl_line() {
    let dir = tmp_dir("append");
    append_to(&dir, &sample("The deploy failed."));

    let file = dir.join(format!("errors-{}.jsonl", day()));
    let content = std::fs::read_to_string(&file).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
    assert_eq!(parsed["area"], "deploy");
    assert_eq!(parsed["surface"], "toast");
    assert_eq!(parsed["operation"], "deploy_run");
    assert_eq!(parsed["projectId"], "proj-1");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn masks_secrets_in_message_and_detail() {
    let rec = record(
      Area::Auth,
      Surface::Backend,
      "failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      None,
      Some("Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789".into()),
      None,
    );
    assert!(!rec.message.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    assert!(!rec.detail.unwrap().contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  }

  #[test]
  fn recent_returns_newest_lines_last() {
    let dir = tmp_dir("recent");
    append_to(&dir, &sample("first"));
    append_to(&dir, &sample("second"));

    let out = recent_in(&dir, 10);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("first"));
    assert!(lines[1].contains("second"), "newest is last");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn recent_caps_the_number_of_lines() {
    let dir = tmp_dir("cap");
    for i in 0..30 {
      append_to(&dir, &sample(&format!("error {i}")));
    }
    let out = recent_in(&dir, 5);
    assert_eq!(out.lines().count(), 5);
    assert!(out.contains("error 29"), "keeps the newest");
    assert!(!out.contains("error 0"), "drops the oldest");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn clip_truncates_long_text() {
    let long = "x".repeat(MAX_FIELD + 50);
    assert!(clip(&long).ends_with("(truncated)"));
    assert_eq!(clip("short"), "short");
  }

  #[test]
  fn area_and_surface_fall_back_for_unknown_values() {
    assert_eq!(Area::parse("deploy"), Area::Deploy);
    assert_eq!(Area::parse("DEPLOY"), Area::Deploy);
    assert_eq!(Area::parse("nonsense"), Area::App);
    assert_eq!(Surface::parse("boundary"), Surface::Boundary);
    assert_eq!(Surface::parse("nonsense"), Surface::Toast);
  }

  #[test]
  fn append_to_a_bad_dir_does_not_panic() {
    let bad = std::env::temp_dir().join("rayfin-errorlog-missing").join(uuid::Uuid::new_v4().to_string()).join("nested");
    append_to(&bad, &sample("ignored"));
  }
}
