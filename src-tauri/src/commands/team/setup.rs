//! Creating a team workspace: every step is automatic, idempotent and
//! resumable, with plain-language problems (and admin instructions) when the
//! directory, Fabric or GitHub settings block a step.

use serde_json::json;
use tauri::{AppHandle, Manager, State};

use super::{fail, fail_with, git_identity, problem, progress, sleep_or_cancel, unique_dir, viewer, CANCELLED};
use crate::commands::util::now_iso;
use crate::services::exec::CancelToken;
use crate::services::store;
use crate::services::team::{self, entra, fabric, gh, naming, repo, templates};
use crate::state::AppState;
use crate::types::{
  TeamActionResult, TeamCreateRequest, TeamDeployIdentity, TeamFabricTargets, TeamFabricWorkspace, TeamManifest,
  TeamProblem, TeamSettings, TeamSetupState, TeamWorkspace,
};

/// Setup steps in order: (id, label). The renderer shows the same checklist.
pub const SETUP_STEPS: &[(&str, &str)] = &[
  ("github", "Create the private GitHub repository"),
  ("fabric", "Create the production and preview Fabric workspaces"),
  ("identity", "Create the deploy identities (service principals)"),
  ("trust", "Let the repository's pipeline sign in as those identities"),
  ("access", "Give the deploy identities access to Fabric"),
  ("files", "Add the deploy pipeline to the repository"),
  ("protection", "Protect the main branch"),
  ("clone", "Download the workspace to this computer"),
  ("verify", "Check that the pipeline can reach Fabric"),
];

fn label(step: &str) -> &'static str {
  SETUP_STEPS.iter().find(|(id, _)| *id == step).map(|(_, l)| *l).unwrap_or("Set up the workspace")
}

pub(crate) const FABRIC_SP_NOTE: &str = "In the Fabric admin portal, open Tenant settings → Developer settings and turn on \"Service principals can call Fabric public APIs\" (for the organization, or for a security group that includes the workspace's deploy identity).";

struct Setup<'a> {
  app: &'a AppHandle,
  scope: String,
  ws: TeamWorkspace,
  state: TeamSetupState,
}

impl Setup<'_> {
  fn done(&self, step: &str) -> bool {
    self.state.completed.iter().any(|s| s == step)
  }

  fn start(&self, step: &str) {
    progress(self.app, &self.scope, step, "running", label(step), None);
  }

  fn finish(&mut self, step: &str) {
    if !self.done(step) {
      self.state.completed.push(step.to_string());
    }
    progress(self.app, &self.scope, step, "done", label(step), None);
    self.save();
  }

  fn save(&mut self) {
    self.ws.setup = Some(self.state.clone());
    if !self.ws.repo.is_empty() {
      store::upsert_team_workspace(self.ws.clone());
    }
  }

  fn fail(mut self, p: TeamProblem) -> TeamActionResult {
    progress(self.app, &self.scope, &p.step, "error", label(&p.step), Some(p.message.clone()));
    self.state.problem = Some(p.clone());
    self.save();
    let mut result = fail_with(p);
    if !self.ws.repo.is_empty() {
      result.workspace = Some(self.ws);
    }
    result
  }
}

fn github_problem(step: &str, action: &str, e: &gh::GhError) -> TeamProblem {
  let mut p = problem(step, e.describe(action));
  if e.status == Some(403) && !e.message.contains("SAML") {
    p.guidance = Some(
      "Your GitHub organization may not allow you to do this. Choose your personal account, or ask an organization owner for permission.".into(),
    );
  } else if e.message.to_ascii_lowercase().contains("workflow") {
    p.guidance = Some("Give Fabricator the GitHub \"workflow\" permission (Grant GitHub access in this window), then retry.".into());
  }
  p
}

fn azure_problem(step: &str, action: &str, e: &entra::AzError, admin_note: Option<String>) -> TeamProblem {
  let mut p = problem(step, e.describe(action));
  if e.kind == entra::AzErrorKind::Blocked {
    p.message = "Your organization doesn't let you create or change app registrations in Microsoft Entra ID.".into();
    p.guidance = Some(
      "Ask an administrator to create the deploy identity with the instructions below, then retry setup and choose \"Use an existing app registration\" with its client ID.".into(),
    );
    p.admin_note = admin_note;
  }
  p
}

fn fabric_problem(step: &str, action: &str, e: &fabric::FabricError) -> TeamProblem {
  let mut p = problem(step, e.describe(action));
  if matches!(e.status, Some(401) | Some(403)) {
    p.guidance = Some(if step == "fabric" {
      "Make sure you can create workspaces on the chosen capacity, or pick another capacity.".into()
    } else {
      "Make sure you're an Admin or Member of both Fabric workspaces.".into()
    });
    if step == "access" {
      p.admin_note = Some(FABRIC_SP_NOTE.into());
    }
  }
  p
}

/// Create a team workspace. `scope` tags the `team:progress` events.
#[tauri::command]
pub async fn team_create(app: AppHandle, request: TeamCreateRequest, scope: String) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let mut request = request;
  request.name = request.name.trim().to_string();
  if request.name.is_empty() {
    return fail("Enter a name for the team workspace.");
  }
  if request.owner.trim().is_empty() {
    return fail("Choose the GitHub account that will own the workspace.");
  }
  if request.capacity_id.trim().is_empty() {
    return fail("Choose a Fabric capacity for the workspace's apps.");
  }
  request.existing_client_id = request.existing_client_id.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
  let dir = unique_dir(&naming::slug(&request.name));
  let ws = TeamWorkspace {
    id: uuid::Uuid::new_v4().to_string(),
    name: request.name.clone(),
    repo: String::new(),
    default_branch: naming::DEFAULT_BRANCH.to_string(),
    dir: dir.to_string_lossy().to_string(),
    role: "owner".into(),
    added_at: now_iso(),
    manifest: None,
    setup: Some(TeamSetupState { request, ..Default::default() }),
    fabric_members: Default::default(),
  };
  run_setup(&app, ws, &scope).await
}

/// Continue an interrupted or failed setup. A new `existing_client_id` lets the
/// owner finish with an app registration an administrator created.
#[tauri::command]
pub async fn team_resume_setup(
  app: AppHandle,
  workspace_id: String,
  scope: String,
  existing_client_id: Option<String>,
) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(mut ws) = store::find_team_workspace(&workspace_id) else {
    return fail("That team workspace is no longer on this computer.");
  };
  let Some(setup) = ws.setup.as_mut() else {
    return fail("This workspace was joined, not set up, on this computer.");
  };
  if let Some(client) = existing_client_id.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
    setup.request.existing_client_id = Some(client);
    setup.app_id = None;
    setup.app_object_id = None;
    setup.sp_object_id = None;
    setup.preview_app_id = None;
    setup.preview_app_object_id = None;
    setup.preview_sp_object_id = None;
    setup.completed.retain(|s| !matches!(s.as_str(), "identity" | "trust" | "access" | "files" | "verify"));
  }
  run_setup(&app, ws, &scope).await
}

/// Stop waiting on a long team operation (setup verification or publish).
#[tauri::command]
pub fn team_cancel(state: State<'_, AppState>, key: String) -> bool {
  state.cancel_team_op(&key)
}

async fn run_setup(app: &AppHandle, ws: TeamWorkspace, scope: &str) -> TeamActionResult {
  let state = app.state::<AppState>();
  // Keyed by the caller's scope: the renderer doesn't know a new workspace's id yet.
  let cancel = state.begin_team_op(scope);
  let result = provision(app, ws, scope, &cancel).await;
  state.end_team_op(scope, &cancel);
  crate::services::telemetry::track_team(crate::commands::auth::get_cached_identity().as_ref(), "create", result.ok);
  result
}

async fn provision(app: &AppHandle, ws: TeamWorkspace, scope: &str, cancel: &CancelToken) -> TeamActionResult {
  let state = ws.setup.clone().unwrap_or_default();
  let mut s = Setup { app, scope: scope.to_string(), ws, state };
  s.state.problem = None;
  let req = s.state.request.clone();
  let name = req.name.clone();

  let me = match viewer().await {
    Ok(v) => v,
    Err(e) => return s.fail(problem("github", e)),
  };
  let (git_name, git_email) = git_identity(&me);

  let tenant = match entra::account().await {
    Ok((t, _)) => t,
    Err(e) => return s.fail(azure_problem("identity", "Check your Azure sign-in", &e, None)),
  };
  if s.state.tenant_id.as_deref().is_some_and(|t| t != tenant) {
    return s.fail(problem(
      "identity",
      "The Azure CLI is signed in to a different organization than the one this workspace was set up in. Sign in to that organization from setup, then retry.",
    ));
  }
  s.state.tenant_id = Some(tenant.clone());

  // 1. The private repository.
  s.start("github");
  let info = if s.ws.repo.is_empty() {
    let base = naming::repo_name(&name).unwrap_or_else(|| "team-apps".into());
    let mut created = None;
    let mut last_error = None;
    for n in 1..=5 {
      let candidate = if n == 1 { base.clone() } else { format!("{base}-{n}") };
      match gh::create_repo(&req.owner, req.owner_is_org, &candidate, &naming::repo_description(&name)).await {
        Ok(info) => {
          created = Some(info);
          break;
        }
        Err(e) if e.status == Some(422) && e.message.to_ascii_lowercase().contains("already exists") => last_error = Some(e),
        Err(e) => {
          last_error = Some(e);
          break;
        }
      }
    }
    match created {
      Some(info) => info,
      None => {
        let e = last_error.unwrap_or_else(|| gh::GhError { status: None, message: "No name was available.".into(), missing_cli: false });
        return s.fail(github_problem("github", "Create the GitHub repository", &e));
      }
    }
  } else {
    match gh::repo(&s.ws.repo).await {
      Ok(info) => info,
      Err(e) => return s.fail(github_problem("github", "Open the GitHub repository", &e)),
    }
  };
  s.ws.repo = info.full_name.clone();
  if let Err(e) = gh::set_topics(&info.full_name, &[naming::REPO_TOPIC]).await {
    log::warn!("couldn't tag {} as a team workspace: {}", info.full_name, e.message);
  }
  s.finish("github");

  // 2. Fabric workspaces for published apps and previews.
  s.start("fabric");
  if s.state.production_workspace_id.is_none() {
    match fabric::create_workspace(&name, &req.capacity_id).await {
      Ok((id, _)) => s.state.production_workspace_id = Some(id),
      Err(e) => return s.fail(fabric_problem("fabric", "Create the Fabric workspace", &e)),
    }
    s.save();
  }
  if s.state.previews_workspace_id.is_none() {
    match fabric::create_workspace(&format!("{name} previews"), &req.capacity_id).await {
      Ok((id, _)) => s.state.previews_workspace_id = Some(id),
      Err(e) => return s.fail(fabric_problem("fabric", "Create the previews workspace", &e)),
    }
  }
  s.finish("fabric");
  let prod_ws = s.state.production_workspace_id.clone().unwrap_or_default();
  let preview_ws = s.state.previews_workspace_id.clone().unwrap_or_default();

  // 3. The deploy identities: one for published apps and one for previews, so a
  // pull request can't reach the published apps. An administrator's app
  // registration serves both.
  let separate = req.existing_client_id.is_none();
  let display = naming::app_display_name(&name);
  let preview_display = naming::preview_app_display_name(&name);
  let (deploy_subjects, preview_subjects) = naming::identity_subjects(&info.full_name, info.owner_id, info.id, separate);
  let all_subjects = naming::identity_subjects(&info.full_name, info.owner_id, info.id, false).0;
  let note = entra::admin_note(&display, &info.full_name, &all_subjects);
  s.start("identity");
  if s.state.app_id.is_none() || s.state.app_object_id.is_none() {
    let registration = match &req.existing_client_id {
      Some(client) => match entra::app(client).await {
        Ok(Some(app)) => app,
        Ok(None) => {
          return s.fail(problem("identity", format!("There's no app registration with client ID {client} in your organization.")))
        }
        Err(e) => return s.fail(azure_problem("identity", "Find the app registration", &e, Some(note.clone()))),
      },
      None => match entra::create_app(&display).await {
        Ok(app) => app,
        Err(e) => return s.fail(azure_problem("identity", "Create the deploy identity", &e, Some(note.clone()))),
      },
    };
    s.state.app_id = Some(registration.app_id);
    s.state.app_object_id = Some(registration.object_id);
    s.save();
  }
  let app_id = s.state.app_id.clone().unwrap_or_default();
  let app_object_id = s.state.app_object_id.clone().unwrap_or_default();
  if s.state.sp_object_id.is_none() {
    match entra::ensure_service_principal(&app_id).await {
      Ok(id) => s.state.sp_object_id = Some(id),
      Err(e) => return s.fail(azure_problem("identity", "Create the service principal", &e, Some(note.clone()))),
    }
    s.save();
  }
  let sp_id = s.state.sp_object_id.clone().unwrap_or_default();
  if separate {
    if s.state.preview_app_id.is_none() || s.state.preview_app_object_id.is_none() {
      match entra::create_app(&preview_display).await {
        Ok(app) => {
          s.state.preview_app_id = Some(app.app_id);
          s.state.preview_app_object_id = Some(app.object_id);
        }
        Err(e) => return s.fail(azure_problem("identity", "Create the preview identity", &e, Some(note.clone()))),
      }
      s.save();
    }
    if s.state.preview_sp_object_id.is_none() {
      let preview_app = s.state.preview_app_id.clone().unwrap_or_default();
      match entra::ensure_service_principal(&preview_app).await {
        Ok(id) => s.state.preview_sp_object_id = Some(id),
        Err(e) => return s.fail(azure_problem("identity", "Create the preview service principal", &e, Some(note.clone()))),
      }
    }
  }
  s.finish("identity");
  let (preview_app_id, preview_app_object_id, preview_sp_id) = if separate {
    (
      s.state.preview_app_id.clone().unwrap_or_default(),
      s.state.preview_app_object_id.clone().unwrap_or_default(),
      s.state.preview_sp_object_id.clone().unwrap_or_default(),
    )
  } else {
    (app_id.clone(), app_object_id.clone(), sp_id.clone())
  };

  // 4. Trust the repository's pipeline (GitHub OIDC; no secrets).
  s.start("trust");
  if let Err(e) = entra::ensure_federated_credentials(&app_object_id, &deploy_subjects).await {
    return s.fail(azure_problem("trust", "Trust the repository's pipeline", &e, Some(note.clone())));
  }
  if separate {
    if let Err(e) = entra::ensure_federated_credentials(&preview_app_object_id, &preview_subjects).await {
      return s.fail(azure_problem("trust", "Trust the repository's pull requests", &e, Some(note.clone())));
    }
  }
  s.finish("trust");

  // 5. Fabric access: published apps for the deploy identity, previews for the
  // preview identity.
  s.start("access");
  for (ws_id, principal) in [(&prod_ws, &sp_id), (&preview_ws, &preview_sp_id)] {
    if let Err(e) = fabric::add_role(ws_id, principal, "ServicePrincipal", "Contributor").await {
      return s.fail(fabric_problem("access", "Give the deploy identities access to Fabric", &e));
    }
  }
  s.finish("access");

  // 6. Pipeline settings, manifest and workflow.
  s.start("files");
  let manifest = TeamManifest {
    schema: 1,
    name: name.clone(),
    tenant_id: tenant.clone(),
    deploy_identity: TeamDeployIdentity { client_id: app_id.clone(), display_name: display.clone() },
    preview_identity: if separate {
      TeamDeployIdentity { client_id: preview_app_id.clone(), display_name: preview_display.clone() }
    } else {
      TeamDeployIdentity::default()
    },
    fabric: TeamFabricTargets {
      production: TeamFabricWorkspace { id: prod_ws.clone(), name: name.clone() },
      previews: TeamFabricWorkspace { id: preview_ws.clone(), name: format!("{name} previews") },
    },
    settings: TeamSettings::default(),
    template_version: templates::TEMPLATE_VERSION,
  };
  for (var, value) in [
    ("AZURE_CLIENT_ID", app_id.as_str()),
    ("AZURE_PREVIEW_CLIENT_ID", preview_app_id.as_str()),
    ("AZURE_TENANT_ID", tenant.as_str()),
    ("FABRIC_WORKSPACE_ID", prod_ws.as_str()),
    ("FABRIC_PREVIEW_WORKSPACE_ID", preview_ws.as_str()),
  ] {
    if let Err(e) = gh::set_variable(&info.full_name, var, value).await {
      return s.fail(github_problem("files", "Configure the pipeline", &e));
    }
  }
  if !s.done("files") {
    let files = vec![
      ("README.md".to_string(), templates::readme(&name)),
      (".gitignore".to_string(), templates::gitignore().to_string()),
      (naming::MANIFEST_FILE.to_string(), templates::manifest_json(&manifest)),
      (naming::WORKFLOW_PATH.to_string(), templates::workflow()),
    ];
    if let Err(e) = repo::seed_repository(&info.full_name, &files, &git_name, &git_email).await {
      let lower = e.to_ascii_lowercase();
      let already = lower.contains("rejected") || lower.contains("fetch first") || lower.contains("non-fast-forward");
      if !already {
        let mut p = problem("files", e.clone());
        if lower.contains("workflow") {
          p.guidance = Some("Give Fabricator the GitHub \"workflow\" permission (Grant GitHub access in this window), then retry.".into());
        }
        return s.fail(p);
      }
    }
  }
  s.ws.name = name.clone();
  s.ws.manifest = Some(manifest.clone());
  s.finish("files");

  // 7. Ask GitHub to require pull requests into main (paid plans).
  s.start("protection");
  s.state.protection = Some(match gh::protect_main(&info.full_name, false).await {
    Ok(true) => "enforced".into(),
    Ok(false) => "app".into(),
    Err(e) => {
      log::warn!("couldn't protect main on {}: {}", info.full_name, e.message);
      "app".into()
    }
  });
  let protection_note = (s.state.protection.as_deref() == Some("app"))
    .then(|| "GitHub doesn't offer branch protection for this private repository on your plan, so Fabricator enforces the publish flow itself.".to_string());
  progress(app, &s.scope, "protection", "done", label("protection"), protection_note);
  if !s.done("protection") {
    s.state.completed.push("protection".into());
  }
  s.save();

  // 8. Local clone.
  s.start("clone");
  if let Err(e) = repo::ensure_clone(&s.ws, None).await {
    return s.fail(problem("clone", e));
  }
  if let Err(e) = repo::set_identity(&s.ws, &git_name, &git_email).await {
    return s.fail(problem("clone", e));
  }
  s.finish("clone");

  // 9. Prove the pipeline can sign in and reach both workspaces.
  s.start("verify");
  if let Err(p) = verify_pipeline(app, &s.scope, &info.full_name, cancel).await {
    let mut p = p;
    if p.admin_note.is_none() && p.guidance.as_deref().is_some_and(|g| g.contains("administrator")) {
      p.admin_note = Some(FABRIC_SP_NOTE.into());
    }
    return s.fail(p);
  }
  s.finish("verify");
  s.state.done = true;
  s.save();
  super::with_workspace(s.ws)
}

/// Explain a failed verification run. Returns (problem, worth retrying).
fn verify_problem(log: &str, url: &str) -> (TeamProblem, bool) {
  let lower = log.to_ascii_lowercase();
  if ["aadsts70021", "no matching federated identity record", "aadsts700016", "aadsts700213"].iter().any(|k| lower.contains(k)) {
    let mut p = problem("verify", "Microsoft Entra ID didn't accept the pipeline's sign-in yet.");
    p.guidance = Some("New trust settings can take a few minutes to apply. Retry setup in a few minutes; if it keeps failing, use Repair in the workspace settings.".into());
    return (p, true);
  }
  if lower.contains("returned http 401") || lower.contains("returned http 403") {
    let mut p = problem("verify", "The pipeline signed in, but Fabric refused it.");
    p.guidance = Some("A Fabric administrator may need to allow service principals to call Fabric APIs, then retry setup.".into());
    p.admin_note = Some(FABRIC_SP_NOTE.into());
    return (p, false);
  }
  if lower.contains("returned http 404") {
    let mut p = problem("verify", "The pipeline can't see the Fabric workspaces.");
    p.guidance = Some("Use Repair in the workspace settings to give the deploy identity access again.".into());
    return (p, false);
  }
  let mut p = problem("verify", "The verification run failed.");
  p.guidance = Some(format!("Open the run on GitHub to see what happened: {url}"));
  (p, false)
}

/// Dispatch the workflow's `verify` action and wait for it.
pub(crate) async fn verify_pipeline(app: &AppHandle, scope: &str, full_name: &str, cancel: &CancelToken) -> Result<(), TeamProblem> {
  for attempt in 0..2 {
    let since = chrono::Utc::now() - chrono::Duration::seconds(20);
    // A just-pushed workflow takes a moment before it can be dispatched.
    let mut dispatched = false;
    for _ in 0..10 {
      match gh::dispatch(full_name, json!({ "action": "verify" })).await {
        Ok(()) => {
          dispatched = true;
          break;
        }
        Err(e) if e.is_not_found() || e.status == Some(422) => {
          if sleep_or_cancel(8_000, cancel).await {
            return Err(problem("verify", CANCELLED));
          }
        }
        Err(e) => return Err(problem("verify", e.describe("Start the verification run"))),
      }
    }
    if !dispatched {
      return Err(problem("verify", "GitHub didn't start the verification run. Check that GitHub Actions is enabled for the repository, then retry."));
    }
    let mut run = None;
    for _ in 0..30 {
      if let Ok(runs) = gh::dispatch_runs(full_name).await {
        run = runs.into_iter().find(|r| {
          r.created_at
            .as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| t >= since)
        });
      }
      if run.is_some() {
        break;
      }
      if sleep_or_cancel(4_000, cancel).await {
        return Err(problem("verify", CANCELLED));
      }
    }
    let Some(run) = run else {
      return Err(problem("verify", "The verification run didn't start. Check GitHub Actions for the repository, then retry."));
    };
    let on = |r: &gh::Run| progress(app, scope, "verify", "running", label("verify"), Some(r.status.replace('_', " ")));
    let finished = super::finish_run(full_name, run, cancel, &on).await.map_err(|e| problem("verify", e))?;
    if finished.conclusion.as_deref() == Some("success") {
      return Ok(());
    }
    let log = gh::run_log(full_name, finished.id, 8_000).await.unwrap_or_default();
    let (p, retry) = verify_problem(&log, &finished.url);
    if retry && attempt == 0 {
      progress(app, scope, "verify", "running", label("verify"), Some("Waiting for the new trust settings to apply…".into()));
      if sleep_or_cancel(45_000, cancel).await {
        return Err(problem("verify", CANCELLED));
      }
      continue;
    }
    return Err(p);
  }
  Err(problem("verify", "The verification run failed."))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn every_step_has_a_label() {
    let ids: Vec<&str> = SETUP_STEPS.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, vec!["github", "fabric", "identity", "trust", "access", "files", "protection", "clone", "verify"]);
    assert_eq!(label("trust"), "Let the repository's pipeline sign in as those identities");
  }

  #[test]
  fn verification_failures_are_explained() {
    let (p, retry) = verify_problem("Error: AADSTS70021: No matching federated identity record found", "u");
    assert!(retry && p.message.contains("didn't accept"));
    let (p, retry) = verify_problem("::error title=Fabric access::Workspace x returned HTTP 403: {}", "u");
    assert!(!retry && p.admin_note.unwrap().contains("Service principals can call Fabric public APIs"));
    let (p, _) = verify_problem("Workspace x returned HTTP 404", "u");
    assert!(p.guidance.unwrap().contains("Repair"));
    let (p, _) = verify_problem("boom", "https://github.com/o/r/actions/runs/1");
    assert!(p.guidance.unwrap().ends_with("/runs/1"));
  }
}
