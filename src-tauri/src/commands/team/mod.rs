//! Team workspace commands (experimental; Settings → Experiments). The flows
//! live here; GitHub, Entra ID, Fabric and git access live in `services::team`.

mod diagnose;
mod join;
mod map;
mod members;
mod projects;
mod publish;
mod session;
mod setup;
mod workspace;

pub use diagnose::*;
pub use join::*;
pub use map::*;
pub use members::*;
pub use projects::*;
pub use publish::*;
pub use session::*;
pub use setup::*;
pub use workspace::*;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

use crate::services::exec::CancelToken;
use crate::services::store;
use crate::services::team::{entra, fabric, gh, naming};
use crate::types::{
  FabricCapacitiesResult, ProcResult, StudioProject, TeamActionResult, TeamEnvStatus, TeamOwnersResult, TeamProblem,
  TeamProgressEvent, TeamWorkspace,
};

/// Event for streamed progress of long team operations.
pub const PROGRESS_EVENT: &str = "team:progress";

pub(crate) fn progress(app: &AppHandle, scope: &str, step: &str, state: &str, label: &str, detail: Option<String>) {
  let _ = app.emit(
    PROGRESS_EVENT,
    TeamProgressEvent {
      scope: scope.to_string(),
      step: step.to_string(),
      state: state.to_string(),
      label: label.to_string(),
      detail,
    },
  );
}

pub(crate) fn fail(message: impl Into<String>) -> TeamActionResult {
  TeamActionResult { ok: false, error: Some(message.into()), ..Default::default() }
}

pub(crate) fn fail_with(problem: TeamProblem) -> TeamActionResult {
  TeamActionResult { ok: false, error: Some(problem.message.clone()), problem: Some(problem), ..Default::default() }
}

pub(crate) fn with_project(project: Option<StudioProject>) -> TeamActionResult {
  TeamActionResult { ok: true, project: project.map(crate::commands::util::with_missing), ..Default::default() }
}

pub(crate) fn with_workspace(workspace: TeamWorkspace) -> TeamActionResult {
  TeamActionResult { ok: true, workspace: Some(workspace), ..Default::default() }
}

pub(crate) fn problem(step: &str, message: impl Into<String>) -> TeamProblem {
  TeamProblem { step: step.to_string(), message: message.into(), guidance: None, admin_note: None }
}

/// The signed-in GitHub user, cached for the session (cleared on failures).
static VIEWER: Lazy<Mutex<Option<gh::Viewer>>> = Lazy::new(|| Mutex::new(None));

pub(crate) async fn viewer() -> Result<gh::Viewer, String> {
  if let Some(v) = VIEWER.lock().unwrap().clone() {
    return Ok(v);
  }
  let v = gh::viewer().await.map_err(|e| e.describe("Check your GitHub sign-in"))?;
  *VIEWER.lock().unwrap() = Some(v.clone());
  Ok(v)
}

pub(crate) fn forget_viewer() {
  *VIEWER.lock().unwrap() = None;
}

/// (git user.name, user.email) that attribute commits to the GitHub user.
pub(crate) fn git_identity(v: &gh::Viewer) -> (String, String) {
  (v.name.clone().unwrap_or_else(|| v.login.clone()), naming::noreply_email(v.id, &v.login))
}

/// A folder under the projects root that doesn't exist yet.
pub(crate) fn unique_dir(base: &str) -> PathBuf {
  let root = PathBuf::from(store::get_state().workspace_root);
  let base = if base.is_empty() { "team" } else { base };
  let mut candidate = root.join(base);
  let mut n = 2;
  while candidate.exists() {
    candidate = root.join(format!("{base}-{n}"));
    n += 1;
  }
  candidate
}

/// Sleep, waking early when `cancel` fires. Returns true when cancelled.
pub(crate) async fn sleep_or_cancel(ms: u64, cancel: &CancelToken) -> bool {
  tokio::select! {
    _ = tokio::time::sleep(Duration::from_millis(ms)) => cancel.is_cancelled(),
    _ = cancel.wait_cancelled() => true,
  }
}

pub(crate) const CANCELLED: &str = "Stopped waiting. Your changes are safe; try again to continue.";

/// Callback for run status changes while waiting.
pub(crate) type OnRun<'a> = &'a (dyn Fn(&gh::Run) + Send + Sync);

/// Wait for the Fabricator workflow run for `sha` (triggered by `event`) to
/// finish. A run that a newer run for the same commit cancelled is replaced by
/// that newer run. `Ok(None)` when no run starts within three minutes.
pub(crate) async fn wait_for_run(
  full_name: &str,
  sha: &str,
  event: &str,
  cancel: &CancelToken,
  on_update: OnRun<'_>,
) -> Result<Option<gh::Run>, String> {
  let mut after: u64 = 0;
  let mut last: Option<gh::Run> = None;
  for attempt in 0..3 {
    let polls = if attempt == 0 { 36 } else { 12 };
    let mut found: Option<gh::Run> = None;
    for _ in 0..polls {
      if let Ok(runs) = gh::runs_for_sha(full_name, sha).await {
        found = runs.into_iter().find(|r| r.event == event && r.id > after);
      }
      if found.is_some() {
        break;
      }
      if sleep_or_cancel(5_000, cancel).await {
        return Err(CANCELLED.into());
      }
    }
    let Some(run) = found else { return Ok(last) };
    let finished = finish_run(full_name, run, cancel, on_update).await?;
    if finished.conclusion.as_deref() != Some("cancelled") {
      return Ok(Some(finished));
    }
    after = finished.id;
    last = Some(finished);
  }
  Ok(last)
}

/// Poll a run until it completes (up to 40 minutes).
pub(crate) async fn finish_run(
  full_name: &str,
  mut run: gh::Run,
  cancel: &CancelToken,
  on_update: OnRun<'_>,
) -> Result<gh::Run, String> {
  for _ in 0..400 {
    on_update(&run);
    if run.status == "completed" {
      return Ok(run);
    }
    if sleep_or_cancel(6_000, cancel).await {
      return Err(CANCELLED.into());
    }
    if let Ok(next) = gh::run(full_name, run.id).await {
      run = next;
    }
  }
  Err(format!("The pipeline run is taking unusually long. Follow it on GitHub: {}", run.url))
}

/* ------------------------------ prerequisites ----------------------------- */

#[tauri::command]
pub async fn team_env_status() -> TeamEnvStatus {
  let enabled = store::team_workspaces_enabled();
  let (who, scopes, account) = tokio::join!(gh::viewer(), gh::token_scopes(), entra::account());
  let mut status = TeamEnvStatus { enabled, gh_installed: true, ..Default::default() };
  match who {
    Ok(v) => {
      status.gh_signed_in = true;
      status.gh_user = Some(v.login.clone());
      *VIEWER.lock().unwrap() = Some(v);
    }
    Err(e) => {
      status.gh_installed = !e.missing_cli;
      forget_viewer();
    }
  }
  if status.gh_signed_in {
    status.gh_missing_scopes = match scopes {
      Ok(granted) => gh::missing_scopes(&granted),
      Err(_) => gh::REQUIRED_SCOPES.iter().map(|s| s.to_string()).collect(),
    };
  }
  if let Ok((tenant, user)) = account {
    status.az_signed_in = true;
    status.az_tenant = Some(tenant);
    status.az_user = Some(user);
  }
  status
}

/// Open a terminal to sign in to GitHub (or add missing permissions) with the
/// scopes team workspaces need. The renderer polls [`team_env_status`].
#[tauri::command]
pub fn team_github_signin(signed_in: bool) -> ProcResult {
  if which::which("gh").is_err() {
    return ProcResult {
      ok: false,
      exit_code: None,
      error: Some("The GitHub CLI (gh) isn't installed. Install it from setup, then try again.".into()),
    };
  }
  forget_viewer();
  let scopes = gh::REQUIRED_SCOPES.join(",");
  let gh_cmd = if signed_in {
    format!("gh auth refresh --hostname github.com --scopes {scopes}")
  } else {
    format!("gh auth login --web --git-protocol https --hostname github.com --scopes {scopes}")
  };
  #[cfg(target_os = "windows")]
  let cmd = format!("set \"GH_TOKEN=\" && set \"GITHUB_TOKEN=\" && {gh_cmd}");
  #[cfg(not(target_os = "windows"))]
  let cmd = format!("env -u GH_TOKEN -u GITHUB_TOKEN {gh_cmd}");
  let ok = crate::commands::github::launch_in_terminal(&cmd);
  ProcResult {
    ok,
    exit_code: None,
    error: (!ok).then(|| format!("Couldn't open a terminal. Run `{gh_cmd}` yourself, then come back.")),
  }
}

#[tauri::command]
pub async fn team_owners() -> TeamOwnersResult {
  match gh::owners().await {
    Ok(owners) => TeamOwnersResult { ok: true, error: None, owners },
    Err(e) => TeamOwnersResult { ok: false, error: Some(e.describe("List your GitHub accounts")), owners: vec![] },
  }
}

#[tauri::command]
pub async fn team_capacities() -> FabricCapacitiesResult {
  match fabric::capacities().await {
    Ok(capacities) => FabricCapacitiesResult { ok: true, capacities: Some(capacities), needs_login: None, error: None },
    Err(e) => FabricCapacitiesResult {
      ok: false,
      capacities: None,
      needs_login: e.needs_login.then_some(true),
      error: Some(e.describe("List your Fabric capacities")),
    },
  }
}
