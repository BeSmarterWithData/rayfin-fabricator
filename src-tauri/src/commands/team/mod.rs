//! Team workspace commands (experimental; Settings → Experiments). The flows
//! live here; GitHub, Entra ID, Fabric and git access live in `services::team`.

mod abandon;
mod diagnose;
mod join;
mod map;
mod members;
mod projects;
mod publish;
mod session;
mod setup;
mod workspace;

pub use abandon::*;
pub use diagnose::*;
pub use join::*;
pub use map::*;
pub use members::*;
pub use projects::*;
pub use publish::*;
pub use session::*;
pub use setup::*;
pub use workspace::*;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

use crate::services::exec::CancelToken;
use crate::services::store;
use crate::services::team::{entra, fabric, gh, naming};
use crate::types::{
  FabricCapacitiesResult, ProcResult, StudioProject, TeamActionResult, TeamEnvStatus, TeamGhAccount, TeamOwnersResult,
  TeamProblem, TeamProgressEvent, TeamWorkspace,
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
/// Signed-in GitHub users by account (lowercase login; empty for the CLI's
/// active account), cached for the session (cleared on sign-in changes).
static VIEWER: Lazy<Mutex<HashMap<String, gh::Viewer>>> = Lazy::new(Default::default);

/// The GitHub user the current task acts as (see [`gh::as_account`]).
pub(crate) async fn viewer() -> Result<gh::Viewer, String> {
  let key = gh::current_account().map(|a| a.to_ascii_lowercase()).unwrap_or_default();
  if let Some(v) = VIEWER.lock().unwrap().get(&key).cloned() {
    return Ok(v);
  }
  let v = gh::viewer().await.map_err(|e| e.describe("Check your GitHub sign-in"))?;
  VIEWER.lock().unwrap().insert(key, v.clone());
  Ok(v)
}

pub(crate) fn forget_viewer() {
  VIEWER.lock().unwrap().clear();
  gh::forget_tokens();
}

/// The GitHub account workspace `workspace_id` uses (`None`: the CLI's active one).
pub(crate) fn workspace_account(workspace_id: &str) -> Option<String> {
  store::find_team_workspace(workspace_id).and_then(|w| w.account)
}

/// The GitHub account the workspace of team project `project_id` uses.
pub(crate) fn project_account(project_id: &str) -> Option<String> {
  let workspace_id = store::find_project(project_id)?.team?.workspace_id;
  workspace_account(&workspace_id)
}

/// Remember the account a workspace from before accounts were remembered
/// works with: the active one, after it read the workspace.
pub(crate) async fn pin_account(ws: &TeamWorkspace) {
  if ws.account.is_some() || gh::current_account().is_some() {
    return;
  }
  if let Ok(me) = viewer().await {
    store::mutate_team_workspace(&ws.id, |w| {
      w.account.get_or_insert(me.login);
    });
  }
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

/// GitHub and Azure sign-ins. `account` picks which GitHub account the `gh_*`
/// fields describe (the CLI's active account when absent); `gh_accounts` lists
/// every account the CLI is signed in to.
#[tauri::command]
pub async fn team_env_status(account: Option<String>) -> TeamEnvStatus {
  let enabled = store::team_workspaces_enabled();
  let (accounts, azure) = tokio::join!(gh::accounts(), entra::account());
  let mut status = TeamEnvStatus { enabled, gh_installed: true, ..Default::default() };
  match accounts {
    Ok(list) => {
      status.gh_accounts = list
        .iter()
        .map(|a| TeamGhAccount {
          login: a.login.clone(),
          active: a.active,
          signed_in: a.signed_in,
          missing_scopes: gh::missing_scopes(&a.scopes),
          can_delete_repos: gh::can_delete_repos(&a.scopes),
        })
        .collect();
      let wanted = account.as_deref().map(str::trim).filter(|a| !a.is_empty());
      let chosen = match wanted {
        Some(login) => status.gh_accounts.iter().find(|a| a.login.eq_ignore_ascii_case(login)),
        None => status.gh_accounts.iter().find(|a| a.active),
      };
      if let Some(chosen) = chosen.filter(|a| a.signed_in).cloned() {
        status.gh_signed_in = true;
        status.gh_user = Some(chosen.login);
        status.gh_missing_scopes = chosen.missing_scopes;
        status.gh_can_delete_repos = chosen.can_delete_repos;
      }
    }
    Err(e) => {
      status.gh_installed = !e.missing_cli;
      status.error = Some(e.describe("Check your GitHub sign-in"));
    }
  }
  if let Ok((tenant, user)) = azure {
    status.az_signed_in = true;
    status.az_tenant = Some(tenant);
    status.az_user = Some(user);
  }
  status
}

/// The terminal command that signs in to GitHub with `scopes`: refreshes
/// `refresh`'s sign-in (switching to it first when another account is active),
/// or signs in to an account, adding it. Either way the CLI's `active` account
/// is active again afterwards, since other workspaces and the terminal use it.
fn signin_command(refresh: Option<&str>, active: Option<&str>, scopes: &str, windows: bool) -> String {
  let switch = |login: &str| format!("gh auth switch --hostname github.com --user {login}");
  let refresh_cmd = format!("gh auth refresh --hostname github.com --scopes {scopes}");
  let (steps, back) = match refresh {
    Some(login) if active.is_some_and(|a| a.eq_ignore_ascii_case(login)) => (vec![refresh_cmd], None),
    Some(login) => (vec![switch(login), refresh_cmd], active),
    None => (vec![format!("gh auth login --web --git-protocol https --hostname github.com --scopes {scopes}")], active),
  };
  let (clear, then, always) =
    if windows { ("set \"GH_TOKEN=\" && set \"GITHUB_TOKEN=\" && ", " && ", " & ") } else { ("unset GH_TOKEN GITHUB_TOKEN; ", " && ", "; ") };
  let mut cmd = format!("{clear}{}", steps.join(then));
  if let Some(back) = back {
    cmd.push_str(always);
    cmd.push_str(&switch(back));
  }
  cmd
}

/// Open a terminal to sign in to GitHub with the scopes team workspaces need,
/// plus `delete_repo` when `delete_repo` is set (abandoning an unfinished setup).
/// With `account`, that account's sign-in is refreshed (or signed in again when
/// the CLI no longer has it); otherwise `signed_in` refreshes the active
/// account, and `false` signs in to another account. The renderer polls
/// [`team_env_status`].
#[tauri::command]
pub async fn team_github_signin(signed_in: bool, delete_repo: Option<bool>, account: Option<String>) -> ProcResult {
  if which::which("gh").is_err() {
    return ProcResult {
      ok: false,
      exit_code: None,
      error: Some("The GitHub CLI (gh) isn't installed. Install it from setup, then try again.".into()),
    };
  }
  forget_viewer();
  let mut scopes = gh::REQUIRED_SCOPES.to_vec();
  if delete_repo.unwrap_or(false) {
    scopes.push(gh::DELETE_REPO_SCOPE);
  }
  let accounts = gh::accounts().await.unwrap_or_default();
  let active = accounts.iter().find(|a| a.active).map(|a| a.login.clone());
  // A broken sign-in can't be refreshed: signing in again replaces it.
  let refresh = match account.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
    Some(wanted) => accounts.iter().find(|a| a.signed_in && a.login.eq_ignore_ascii_case(wanted)).map(|a| a.login.clone()),
    None if signed_in => accounts.iter().find(|a| a.active && a.signed_in).map(|a| a.login.clone()),
    None => None,
  };
  let cmd = signin_command(
    refresh.as_deref().filter(|l| gh::is_login(l)),
    active.as_deref().filter(|l| gh::is_login(l)),
    &scopes.join(","),
    cfg!(target_os = "windows"),
  );
  let ok = crate::commands::github::launch_in_terminal(&cmd);
  ProcResult {
    ok,
    exit_code: None,
    error: (!ok).then(|| format!("Couldn't open a terminal. Run `{cmd}` yourself, then come back.")),
  }
}

/// Accounts that can own a workspace set up as `account` (the CLI's active
/// account when absent): the user and their organizations.
#[tauri::command]
pub async fn team_owners(account: Option<String>) -> TeamOwnersResult {
  gh::as_account(account, async {
    match gh::owners().await {
      Ok(owners) => TeamOwnersResult { ok: true, error: None, owners },
      Err(e) => TeamOwnersResult { ok: false, error: Some(e.describe("List your GitHub accounts")), owners: vec![] },
    }
  })
  .await
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

#[cfg(test)]
mod tests {
  use super::*;

  const SCOPES: &str = "repo,read:org,workflow";

  #[test]
  fn signing_in_keeps_the_active_account_active() {
    // Refreshing the active account is just a refresh.
    assert_eq!(
      signin_command(Some("Octo"), Some("octo"), SCOPES, true),
      "set \"GH_TOKEN=\" && set \"GITHUB_TOKEN=\" && gh auth refresh --hostname github.com --scopes repo,read:org,workflow"
    );
    // Another account: switch to it, refresh, then always switch back.
    assert_eq!(
      signin_command(Some("octo_work"), Some("octo"), SCOPES, true),
      "set \"GH_TOKEN=\" && set \"GITHUB_TOKEN=\" && gh auth switch --hostname github.com --user octo_work && gh auth refresh --hostname github.com --scopes repo,read:org,workflow & gh auth switch --hostname github.com --user octo"
    );
    // Adding an account makes it active; the previous one comes back.
    assert_eq!(
      signin_command(None, Some("octo"), SCOPES, false),
      "unset GH_TOKEN GITHUB_TOKEN; gh auth login --web --git-protocol https --hostname github.com --scopes repo,read:org,workflow; gh auth switch --hostname github.com --user octo"
    );
    // The first account has nothing to switch back to.
    assert_eq!(
      signin_command(None, None, SCOPES, false),
      "unset GH_TOKEN GITHUB_TOKEN; gh auth login --web --git-protocol https --hostname github.com --scopes repo,read:org,workflow"
    );
  }

  #[tokio::test]
  async fn the_account_scope_reaches_spawned_tasks_only_when_passed_on() {
    gh::as_account(Some(" octo_work ".into()), async {
      assert_eq!(gh::current_account().as_deref(), Some("octo_work"));
      let passed = tokio::spawn(gh::as_account(gh::current_account(), async { gh::current_account() })).await.unwrap();
      assert_eq!(passed.as_deref(), Some("octo_work"));
      let plain = tokio::spawn(async { gh::current_account() }).await.unwrap();
      assert_eq!(plain, None, "spawned tasks don't inherit the scope by themselves");
    })
    .await;
    assert_eq!(gh::current_account(), None);
    gh::as_account(Some("  ".into()), async { assert_eq!(gh::current_account(), None) }).await;
  }
}
