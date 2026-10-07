//! Minimal crash/error logging — the Rust counterpart to
//! `src/main/services/crashlog.ts`. Fatal errors (Rust panics) are appended to a
//! dated file under `<dataDir>/logs/`. Logging is local-only; nothing is sent.

use std::io::Write;

use super::paths;

fn log_file() -> std::path::PathBuf {
  let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
  paths::logs_dir().join(format!("main-{day}.log"))
}

/// Map a call site's label to an error-journal area, so the Help assistant can
/// filter by what the user was doing rather than by log text. Labels come from
/// a small, fixed set of call sites; anything new lands in `App` until it is
/// added here.
fn area_for(label: &str) -> super::errorlog::Area {
  use super::errorlog::Area;
  match label {
    "deploy" | "settings-push" => Area::Deploy,
    "preview" => Area::Preview,
    "fabric-login" | "copilot-login" | "fabric-refresh" => Area::Auth,
    _ if label.contains("login") || label.contains("auth") => Area::Auth,
    _ => Area::App,
  }
}

/// Append a labelled, timestamped error record; never panics.
///
/// Also mirrors the record into the structured error journal
/// ([`super::errorlog`]), which is what the in-app Help assistant reads. The
/// free-text file stays as-is for humans reading it directly.
pub fn log_error(label: &str, detail: &str) {
  let line = format!("[{}] {label}: {detail}\n", chrono::Utc::now().to_rfc3339());
  if let Ok(mut f) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(log_file())
  {
    let _ = f.write_all(line.as_bytes());
  }
  eprintln!("{}", line.trim_end());

  use super::errorlog::{self, Surface};
  let surface = if label == "panic" { Surface::Panic } else { Surface::Backend };
  errorlog::write(&errorlog::record(
    area_for(label),
    surface,
    label,
    Some(label.to_string()),
    Some(detail.to_string()),
    None,
  ));
}

/// Install a panic hook that records otherwise-fatal errors to the log file.
pub fn install_panic_hook() {
  let default = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |info| {
    let detail = match info.location() {
      Some(loc) => format!("{info} (at {}:{})", loc.file(), loc.line()),
      None => format!("{info}"),
    };
    log_error("panic", &detail);
    default(info);
  }));
}
