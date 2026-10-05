//! Abandoning an unfinished setup: delete what it created so far, then forget
//! the workspace on this computer.
//!
//! Everything deleted comes from this computer's setup record, which only holds
//! what setup itself created, and is looked up first so sign-in and permission
//! problems show before anything changes. The deploy identities and Fabric
//! workspaces go first and the GitHub repository last: until everything else is
//! gone the workspace stays listed, each removal is saved as it happens, and
//! trying again picks up what's left.

use std::path::Path;

use serde_json::Value;
use tauri::AppHandle;

use super::{fail, fail_with, problem, progress};
use crate::services::store;
use crate::services::team::{self, entra, fabric, gh, naming};
use crate::types::{TeamAbandonItem, TeamAbandonPlan, TeamActionResult, TeamProblem, TeamSetupState, TeamWorkspace};

/// Abandon steps in order: (id, label). The renderer shows the same checklist.
pub const ABANDON_STEPS: &[(&str, &str)] = &[
  ("check", "Look up what setup created"),
  ("identity", "Delete the deploy identities"),
  ("fabric", "Delete the Fabric workspaces"),
  ("github", "Delete the GitHub repository"),
  ("local", "Remove the workspace from this computer"),
];

fn label(step: &str) -> &'static str {
  ABANDON_STEPS.iter().find(|(id, _)| *id == step).map(|(_, l)| *l).unwrap_or("Abandon setup")
}

const WRONG_TENANT: &str =
  "The Azure CLI is signed in to a different organization than the one this workspace was set up in.";
const SIGN_IN_AS_OWNER: &str =
  "Sign in to GitHub with the account that set up the workspace (in the GitHub CLI), then try again.";

/// The workspace and its setup record, when its setup can be abandoned.
fn unfinished(workspace_id: &str) -> Result<(TeamWorkspace, TeamSetupState), String> {
  team::require_enabled()?;
  let ws = store::find_team_workspace(workspace_id).ok_or("That team workspace is no longer on this computer.")?;
  let setup = ws.setup.clone().ok_or("This workspace was joined, not set up, on this computer. Leave it instead.")?;
  if setup.done {
    return Err("This workspace's setup finished. Delete it from its settings instead.".into());
  }
  Ok((ws, setup))
}

fn present(value: &Option<String>) -> Option<String> {
  value.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// Client IDs of the deploy identities setup registered, and notes on any
/// recorded identity that stays.
fn recorded_identities(setup: &TeamSetupState) -> (Vec<String>, Vec<String>) {
  let mut ids = Vec::new();
  let mut kept = Vec::new();
  match &setup.request.existing_client_id {
    // An administrator's app registration serves both; it isn't Fabricator's to delete.
    Some(_) if setup.app_id.is_some() => kept.push(
      "The app registration your administrator provided stays. They can delete it when it's no longer needed.".into(),
    ),
    Some(_) => {}
    None => ids.extend(present(&setup.app_id)),
  }
  ids.extend(present(&setup.preview_app_id));
  (ids, kept)
}

fn recorded_fabric(setup: &TeamSetupState) -> Vec<String> {
  [&setup.production_workspace_id, &setup.previews_workspace_id].into_iter().filter_map(present).collect()
}

/// What an unfinished setup created that still exists.
#[derive(Default)]
struct Found {
  identities: Vec<entra::AppRegistration>,
  /// (id, display name)
  fabric: Vec<(String, String)>,
  repo: Option<gh::RepoInfo>,
  kept: Vec<String>,
  needs_delete_permission: bool,
}

async fn inventory(ws: &TeamWorkspace, setup: &TeamSetupState) -> Result<Found, TeamProblem> {
  let (identity_ids, mut kept) = recorded_identities(setup);
  let fabric_ids = recorded_fabric(setup);
  let (repo, azure) = tokio::join!(find_repo(ws), find_azure(setup, &identity_ids, &fabric_ids));
  let (repo, needs_delete_permission) = repo?;
  let (identities, also_kept, fabric) = azure?;
  kept.extend(also_kept);
  Ok(Found { identities, fabric, repo, kept, needs_delete_permission })
}

/// (deploy identities to delete, notes on identities that stay, Fabric workspaces to delete)
type AzureFound = (Vec<entra::AppRegistration>, Vec<String>, Vec<(String, String)>);

async fn find_azure(setup: &TeamSetupState, identity_ids: &[String], fabric_ids: &[String]) -> Result<AzureFound, TeamProblem> {
  if identity_ids.is_empty() && fabric_ids.is_empty() {
    return Ok(Default::default());
  }
  // Looked up by ID in another organization, everything would seem deleted.
  let (tenant, _) = entra::account().await.map_err(|e| problem("check", e.describe("Check your Azure sign-in")))?;
  if setup.tenant_id.as_deref().is_some_and(|t| !t.eq_ignore_ascii_case(&tenant)) {
    let mut p = problem("check", WRONG_TENANT);
    p.guidance = Some("Sign in to that organization from setup, then try again.".into());
    return Err(p);
  }
  let (identities, fabric) = tokio::join!(find_identities(identity_ids), find_fabric(fabric_ids));
  let (identities, kept) = identities?;
  Ok((identities, kept, fabric?))
}

async fn find_identities(ids: &[String]) -> Result<(Vec<entra::AppRegistration>, Vec<String>), TeamProblem> {
  let mut found = Vec::new();
  let mut kept = Vec::new();
  for id in ids {
    match entra::app(id).await {
      Ok(Some(app)) if naming::is_managed_identity_name(&app.display_name) => found.push(app),
      Ok(Some(app)) => kept.push(format!(
        "\"{}\" stays: Fabricator only deletes deploy identities that still have the name it gave them.",
        app.display_name
      )),
      Ok(None) => {}
      Err(e) => return Err(problem("check", e.describe("Look up a deploy identity"))),
    }
  }
  Ok((found, kept))
}

async fn find_fabric(ids: &[String]) -> Result<Vec<(String, String)>, TeamProblem> {
  let mut found = Vec::new();
  for id in ids {
    match fabric::get(&format!("workspaces/{id}")).await {
      Ok(v) => {
        let name = v.get("displayName").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).unwrap_or(id);
        found.push((id.clone(), name.to_string()));
      }
      Err(e) if e.status == Some(404) => {}
      Err(e) => return Err(problem("check", e.describe("Look up a Fabric workspace"))),
    }
  }
  Ok(found)
}

/// The repository, when it still exists, and whether deleting it needs the
/// `delete_repo` permission first.
async fn find_repo(ws: &TeamWorkspace) -> Result<(Option<gh::RepoInfo>, bool), TeamProblem> {
  if ws.repo.is_empty() {
    return Ok((None, false));
  }
  match gh::repo(&ws.repo).await {
    Ok(info) if info.admin => {
      // No scopes header (not a classic token) leaves it to the delete itself.
      let needs = gh::token_scopes().await.is_ok_and(|s| !s.is_empty() && !gh::can_delete_repos(&s));
      Ok((Some(info), needs))
    }
    Ok(info) => {
      let mut p = problem("github", format!("Only an owner of {} can delete it.", info.full_name));
      p.guidance = Some(SIGN_IN_AS_OWNER.into());
      Err(p)
    }
    // GitHub also answers 404 for private repositories an account can't see, so
    // it only counts as deleted when this account would see it. The account is
    // read fresh: `gh` may have switched accounts since it was cached.
    Err(e) if e.is_not_found() => {
      let me = gh::viewer().await.map_err(|e| problem("github", e.describe("Check your GitHub sign-in")))?;
      let owner = ws.repo.split('/').next().unwrap_or_default();
      let would_see = me.login.eq_ignore_ascii_case(owner)
        || gh::is_org_member(owner).await.map_err(|e| problem("github", e.describe("Check your GitHub organizations")))?;
      if would_see {
        return Ok((None, false));
      }
      let mut p = problem("github", format!("GitHub doesn't show {} to {}.", ws.repo, me.login));
      p.guidance = Some(SIGN_IN_AS_OWNER.into());
      Err(p)
    }
    Err(e) => Err(problem("github", e.describe("Look up the GitHub repository"))),
  }
}

fn item(kind: &str, id: &str, name: &str, url: Option<String>) -> TeamAbandonItem {
  TeamAbandonItem { kind: kind.into(), id: id.into(), name: name.into(), url }
}

/// What will be deleted, in order.
fn items(ws: &TeamWorkspace, found: &Found) -> Vec<TeamAbandonItem> {
  let mut items: Vec<TeamAbandonItem> =
    found.identities.iter().map(|a| item("identity", &a.app_id, &a.display_name, None)).collect();
  for (id, name) in &found.fabric {
    items.push(item("fabric", id, name, Some(format!("https://app.fabric.microsoft.com/groups/{id}/"))));
  }
  if let Some(info) = &found.repo {
    items.push(item("github", &info.full_name, &info.full_name, Some(info.html_url.clone()).filter(|u| !u.is_empty())));
  }
  if !ws.dir.is_empty() && Path::new(&ws.dir).exists() {
    items.push(item("local", &ws.dir, &ws.dir, None));
  }
  items
}

/// What abandoning a workspace's unfinished setup would delete. Changes nothing.
#[tauri::command]
pub async fn team_abandon_plan(workspace_id: String) -> TeamAbandonPlan {
  let (ws, setup) = match unfinished(&workspace_id) {
    Ok(found) => found,
    Err(e) => return TeamAbandonPlan { ok: false, error: Some(e), ..Default::default() },
  };
  match gh::as_account(ws.account.clone(), inventory(&ws, &setup)).await {
    Ok(found) => TeamAbandonPlan {
      ok: true,
      items: items(&ws, &found),
      needs_delete_permission: found.needs_delete_permission,
      kept: found.kept,
      ..Default::default()
    },
    Err(p) => TeamAbandonPlan { ok: false, error: Some(p.message.clone()), problem: Some(p), ..Default::default() },
  }
}

/// Abandon a workspace's unfinished setup: delete the deploy identities
/// Fabricator registered, the Fabric workspaces and the GitHub repository, then
/// forget the workspace here. Progress streams on `team:progress` with `scope`.
#[tauri::command]
pub async fn team_abandon_setup(app: AppHandle, workspace_id: String, scope: String) -> TeamActionResult {
  let (ws, setup) = match unfinished(&workspace_id) {
    Ok(found) => found,
    Err(e) => return fail(e),
  };
  let result = gh::as_account(ws.account.clone(), abandon(&Steps { app: &app, scope: &scope }, &ws, &setup)).await;
  crate::services::telemetry::track_team(crate::commands::auth::get_cached_identity().as_ref(), "abandon", result.ok);
  result
}

struct Steps<'a> {
  app: &'a AppHandle,
  scope: &'a str,
}

impl Steps<'_> {
  fn set(&self, step: &str, state: &str, detail: Option<String>) {
    progress(self.app, self.scope, step, state, label(step), detail);
  }

  /// Mark `step` failed and return `p`, with the workspace as it now stands.
  fn stop(&self, step: &str, p: TeamProblem, workspace_id: &str) -> TeamActionResult {
    self.set(step, "error", Some(p.message.clone()));
    let mut result = fail_with(p);
    result.workspace = store::find_team_workspace(workspace_id);
    result
  }
}

async fn abandon(steps: &Steps<'_>, ws: &TeamWorkspace, setup: &TeamSetupState) -> TeamActionResult {
  steps.set("check", "running", None);
  let found = match inventory(ws, setup).await {
    Ok(found) => found,
    Err(p) => return steps.stop("check", p, &ws.id),
  };
  if let (true, Some(info)) = (found.needs_delete_permission, &found.repo) {
    return steps.stop("check", permission_problem(&info.full_name), &ws.id);
  }
  steps.set("check", "done", None);

  let mut problems = Vec::new();
  steps.set("identity", "running", None);
  let mut failed = Vec::new();
  for app in &found.identities {
    if let Err(e) = entra::delete_app(&app.app_id).await {
      failed.push(app.app_id.clone());
      let mut p = problem("identity", e.describe(&format!("Delete the deploy identity \"{}\"", app.display_name)));
      if e.kind == entra::AzErrorKind::Blocked {
        p.guidance = Some("Ask an administrator to delete it in Microsoft Entra ID, then try again.".into());
      }
      problems.push(p);
    }
  }
  store::mutate_team_workspace(&ws.id, |w| {
    if let Some(s) = w.setup.as_mut() {
      forget_identities(s, &failed);
    }
  });
  finish_step(steps, "identity", &problems);

  let before = problems.len();
  steps.set("fabric", "running", None);
  let mut failed = Vec::new();
  for (id, name) in &found.fabric {
    if let Err(e) = fabric::delete_workspace(id).await {
      failed.push(id.clone());
      let mut p = problem("fabric", e.describe(&format!("Delete the Fabric workspace \"{name}\"")));
      if matches!(e.status, Some(401) | Some(403)) && !e.needs_login {
        p.guidance = Some("Make sure you're an Admin of the Fabric workspace, or delete it in Fabric yourself, then try again.".into());
      }
      problems.push(p);
    }
  }
  store::mutate_team_workspace(&ws.id, |w| {
    if let Some(s) = w.setup.as_mut() {
      forget_fabric(s, &failed);
    }
  });
  finish_step(steps, "fabric", &problems[before..]);

  // The repository goes last, so the workspace stays listed while anything else is left.
  if !problems.is_empty() {
    let mut result = fail_with(merge(problems));
    result.workspace = store::find_team_workspace(&ws.id);
    return result;
  }
  if let Some(info) = &found.repo {
    steps.set("github", "running", None);
    if let Err(e) = gh::delete_repo(&info.full_name).await {
      return steps.stop("github", repo_problem(info, &e), &ws.id);
    }
  }
  steps.set("github", "done", None);

  steps.set("local", "running", None);
  super::join::forget_workspace(ws).await;
  steps.set("local", "done", None);
  TeamActionResult { ok: true, ..Default::default() }
}

fn finish_step(steps: &Steps<'_>, step: &str, problems: &[TeamProblem]) {
  if problems.is_empty() {
    steps.set(step, "done", None);
  } else {
    steps.set(step, "error", Some(problems.iter().map(|p| p.message.as_str()).collect::<Vec<_>>().join(" ")));
  }
}

/// One problem standing for several.
fn merge(problems: Vec<TeamProblem>) -> TeamProblem {
  let mut first = problems.first().cloned().unwrap_or_else(|| problem("check", "Abandoning the setup stopped."));
  if problems.len() > 1 {
    first.message = problems.iter().map(|p| p.message.as_str()).collect::<Vec<_>>().join(" ");
    first.guidance = problems.iter().find_map(|p| p.guidance.clone());
  }
  first
}

fn permission_problem(repo: &str) -> TeamProblem {
  let mut p = problem("github", format!("Fabricator needs your permission to delete {repo} on GitHub."));
  p.guidance = Some("Select Grant GitHub access, approve deleting repositories in your browser, then try again.".into());
  p
}

fn repo_problem(info: &gh::RepoInfo, e: &gh::GhError) -> TeamProblem {
  let mut p = problem("github", e.describe(&format!("Delete {}", info.full_name)));
  if e.status == Some(403) && !e.message.contains("SAML") {
    p.message = format!("GitHub didn't let you delete {}: {}", info.full_name, e.message);
    p.guidance = Some(
      "Organizations can limit deleting repositories to their owners. Ask an owner to delete it on GitHub, then try again, or remove the workspace from this computer and keep the repository.".into(),
    );
  }
  p
}

/// Drop the recorded deploy identities, except ones whose deletion failed (so
/// trying again retries them). Steps that depend on them run again if setup is
/// ever finished instead.
fn forget_identities(setup: &mut TeamSetupState, failed: &[String]) {
  let keep = |id: &Option<String>| id.as_ref().is_some_and(|id| failed.contains(id));
  let mut changed = false;
  if setup.app_id.is_some() && !keep(&setup.app_id) {
    setup.app_id = None;
    setup.app_object_id = None;
    setup.sp_object_id = None;
    changed = true;
  }
  if setup.preview_app_id.is_some() && !keep(&setup.preview_app_id) {
    setup.preview_app_id = None;
    setup.preview_app_object_id = None;
    setup.preview_sp_object_id = None;
    changed = true;
  }
  if changed {
    setup.completed.retain(|s| !matches!(s.as_str(), "identity" | "trust" | "access" | "verify"));
  }
}

/// Drop the recorded Fabric workspaces, except ones whose deletion failed.
fn forget_fabric(setup: &mut TeamSetupState, failed: &[String]) {
  let mut changed = false;
  for slot in [&mut setup.production_workspace_id, &mut setup.previews_workspace_id] {
    if slot.as_ref().is_some_and(|id| !failed.contains(id)) {
      *slot = None;
      changed = true;
    }
  }
  if changed {
    setup.completed.retain(|s| !matches!(s.as_str(), "fabric" | "access" | "verify"));
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::TeamCreateRequest;

  fn setup(existing_client_id: Option<&str>) -> TeamSetupState {
    TeamSetupState {
      request: TeamCreateRequest {
        name: "Sales".into(),
        existing_client_id: existing_client_id.map(String::from),
        ..Default::default()
      },
      completed: ["github", "fabric", "identity", "trust", "access", "files"].map(String::from).to_vec(),
      app_id: Some("deploy".into()),
      app_object_id: Some("deploy-object".into()),
      sp_object_id: Some("deploy-sp".into()),
      preview_app_id: existing_client_id.is_none().then(|| "preview".into()),
      preview_app_object_id: existing_client_id.is_none().then(|| "preview-object".into()),
      preview_sp_object_id: existing_client_id.is_none().then(|| "preview-sp".into()),
      production_workspace_id: Some("prod".into()),
      previews_workspace_id: Some("previews".into()),
      ..Default::default()
    }
  }

  #[test]
  fn every_step_has_a_label() {
    let ids: Vec<&str> = ABANDON_STEPS.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, vec!["check", "identity", "fabric", "github", "local"]);
    assert_eq!(label("github"), "Delete the GitHub repository");
  }

  #[test]
  fn only_identities_fabricator_registered_are_deleted() {
    let (ids, kept) = recorded_identities(&setup(None));
    assert_eq!(ids, vec!["deploy", "preview"]);
    assert!(kept.is_empty());

    let (ids, kept) = recorded_identities(&setup(Some("admin-app")));
    assert!(ids.is_empty(), "an administrator's app registration is never deleted");
    assert_eq!(kept.len(), 1);
    assert!(kept[0].contains("administrator"));

    let mut early = setup(Some("admin-app"));
    early.app_id = None;
    assert_eq!(recorded_identities(&early), (vec![], vec![]), "nothing to mention before setup used it");
    assert_eq!(recorded_fabric(&setup(None)), vec!["prod", "previews"]);
  }

  #[test]
  fn deleted_resources_are_forgotten_and_failed_ones_kept_for_another_try() {
    let mut s = setup(None);
    forget_identities(&mut s, &["preview".to_string()]);
    assert_eq!((s.app_id.as_deref(), s.sp_object_id.as_deref()), (None, None));
    assert_eq!(s.preview_app_id.as_deref(), Some("preview"));
    assert_eq!(s.completed, vec!["github", "fabric", "files"]);

    forget_fabric(&mut s, &[]);
    assert_eq!((s.production_workspace_id.as_deref(), s.previews_workspace_id.as_deref()), (None, None));
    assert_eq!(s.completed, vec!["github", "files"]);

    let mut untouched = setup(None);
    forget_fabric(&mut untouched, &["prod".to_string(), "previews".to_string()]);
    assert_eq!(untouched.production_workspace_id.as_deref(), Some("prod"));
    assert!(untouched.completed.contains(&"fabric".to_string()), "nothing removed, nothing to redo");
  }

  #[test]
  fn the_plan_lists_items_in_the_order_they_are_deleted() {
    let dir = std::env::temp_dir().join(format!("fab-abandon-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let ws = TeamWorkspace {
      id: "w".into(),
      name: "Sales".into(),
      repo: "octo/sales".into(),
      default_branch: "main".into(),
      dir: dir.to_string_lossy().to_string(),
      role: "owner".into(),
      added_at: String::new(),
      manifest: None,
      setup: Some(setup(None)),
      account: None,
      fabric_members: Default::default(),
    };
    let found = Found {
      identities: vec![entra::AppRegistration {
        app_id: "deploy".into(),
        object_id: "o".into(),
        display_name: "Fabricator deploy - Sales".into(),
      }],
      fabric: vec![("prod".into(), "Sales".into())],
      repo: gh::repo_info(&serde_json::json!({ "full_name": "octo/sales", "html_url": "https://github.com/octo/sales" })),
      ..Default::default()
    };
    let listed = items(&ws, &found);
    let kinds: Vec<&str> = listed.iter().map(|i| i.kind.as_str()).collect();
    assert_eq!(kinds, vec!["identity", "fabric", "github", "local"]);
    assert_eq!((listed[0].id.as_str(), listed[0].name.as_str()), ("deploy", "Fabricator deploy - Sales"));
    assert_eq!(listed[1].id, "prod");
    assert_eq!(listed[1].url.as_deref(), Some("https://app.fabric.microsoft.com/groups/prod/"));
    assert_eq!(listed[2].url.as_deref(), Some("https://github.com/octo/sales"));
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(items(&ws, &Found::default()).len(), 0, "a missing folder isn't listed");
  }

  #[test]
  fn problems_explain_what_to_do() {
    let merged = merge(vec![
      problem("identity", "Delete the deploy identity \"A\": boom."),
      TeamProblem { guidance: Some("Ask an admin.".into()), ..problem("fabric", "Delete the Fabric workspace \"B\": bang.") },
    ]);
    assert_eq!(merged.step, "identity");
    assert!(merged.message.contains("boom") && merged.message.contains("bang"));
    assert_eq!(merged.guidance.as_deref(), Some("Ask an admin."));

    let info = gh::repo_info(&serde_json::json!({ "full_name": "contoso/sales", "html_url": "u" })).unwrap();
    let forbidden = gh::GhError { status: Some(403), message: "Must have admin rights to Repository.".into(), missing_cli: false };
    let p = repo_problem(&info, &forbidden);
    assert!(p.message.starts_with("GitHub didn't let you delete contoso/sales"));
    assert!(p.guidance.unwrap().contains("owners"));
    assert!(permission_problem("contoso/sales").guidance.unwrap().contains("Grant GitHub access"));
  }
}
