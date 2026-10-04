//! Workspace settings and maintenance (owners): the review requirement, a
//! health checklist of everything setup created, and Repair.
//!
//! Privileged actions use [`TrustedTargets`]: the repository's Actions
//! variables (only repository admins can change them) or this computer's setup
//! record. `fabricator.workspace.json` is editable by any member, so it is never
//! used to decide which identities or Fabric workspaces to change; Repair puts
//! it back when it disagrees.

use tauri::{AppHandle, Manager};

use super::setup::verify_pipeline;
use super::{fail, with_workspace};
use crate::services::store;
use crate::services::team::{self, entra, fabric, gh, naming, repo, templates, TrustedTargets};
use crate::state::AppState;
use crate::types::{TeamActionResult, TeamDeployIdentity, TeamHealth, TeamHealthItem, TeamManifest, TeamWorkspace};

fn workspace(id: &str) -> Result<TeamWorkspace, String> {
  team::require_enabled()?;
  store::find_team_workspace(id).ok_or_else(|| "That team workspace is no longer on this computer.".into())
}

async fn require_owner(ws: &TeamWorkspace) -> Result<gh::RepoInfo, String> {
  match gh::repo(&ws.repo).await {
    Ok(info) if info.admin => Ok(info),
    Ok(_) => Err("Only the workspace's owners can change its settings.".into()),
    Err(e) => Err(e.describe("Check your access to the workspace")),
  }
}

/// The manifest on `main` (falling back to the copy on this computer).
async fn current_manifest(ws: &TeamWorkspace) -> Result<TeamManifest, String> {
  let _ = repo::fetch(ws).await;
  match repo::read_main_file(ws, naming::MANIFEST_FILE).await {
    Ok(Some(text)) => templates::parse_manifest(&text).ok_or_else(|| "The workspace's settings file is damaged.".to_string()),
    _ => ws.manifest.clone().ok_or_else(|| "The workspace's settings file is missing.".to_string()),
  }
}

async fn save_manifest(ws: &TeamWorkspace, manifest: &TeamManifest, message: &str) -> Result<(), String> {
  gh::put_main_file(&ws.repo, naming::MANIFEST_FILE, &templates::manifest_json(manifest), message)
    .await
    .map_err(|e| e.describe("Save the workspace settings"))?;
  let saved = manifest.clone();
  store::mutate_team_workspace(&ws.id, |w| w.manifest = Some(saved));
  Ok(())
}

/// Require (or stop requiring) a teammate's approval before publishing.
#[tauri::command]
pub async fn team_set_require_review(workspace_id: String, require: bool) -> TeamActionResult {
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return fail(e),
  };
  if let Err(e) = require_owner(&ws).await {
    return fail(e);
  }
  let mut manifest = match current_manifest(&ws).await {
    Ok(m) => m,
    Err(e) => return fail(e),
  };
  manifest.settings.require_review = require;
  let message = if require { "Require a review before publishing" } else { "Stop requiring reviews before publishing" };
  if let Err(e) = save_manifest(&ws, &manifest, message).await {
    return fail(e);
  }
  // Where GitHub enforces branch protection, keep it in step.
  if let Err(e) = gh::protect_main(&ws.repo, require).await {
    log::warn!("couldn't update branch protection for {}: {}", ws.repo, e.message);
  }
  with_workspace(store::find_team_workspace(&ws.id).unwrap_or(ws))
}

fn item(id: &str, label: &str, state: &str, detail: Option<String>, repairable: bool) -> TeamHealthItem {
  TeamHealthItem { id: id.into(), label: label.into(), state: state.into(), detail, repairable }
}

/// What the health check knows about one identity.
struct IdentityCheck {
  object_id: Option<String>,
  sp: Option<String>,
  error: Option<String>,
}

async fn check_identity(client_id: &str) -> IdentityCheck {
  match entra::app(client_id).await {
    Ok(Some(app)) => IdentityCheck {
      object_id: Some(app.object_id),
      sp: entra::service_principal(client_id).await.ok().flatten(),
      error: None,
    },
    Ok(None) => IdentityCheck { object_id: None, sp: None, error: None },
    Err(e) => IdentityCheck { object_id: None, sp: None, error: Some(e.describe("Check the deploy identity")) },
  }
}

/// Check everything setup created. Members see what they're allowed to read.
#[tauri::command]
pub async fn team_health(workspace_id: String) -> TeamHealth {
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return TeamHealth { ok: false, error: Some(e), items: vec![] },
  };
  let mut items = Vec::new();
  let info = match gh::repo(&ws.repo).await {
    Ok(info) => {
      let role = if info.admin { "You're an owner." } else if info.push { "You're a member." } else { "You can't change it." };
      items.push(item("repo", "GitHub repository", if info.push { "ok" } else { "error" }, Some(format!("{} — {role}", info.full_name)), false));
      Some(info)
    }
    Err(e) => {
      items.push(item("repo", "GitHub repository", "error", Some(e.describe("Open the repository")), false));
      None
    }
  };
  let owner = info.as_ref().is_some_and(|i| i.admin);
  let manifest = current_manifest(&ws).await.ok();

  let workflow = repo::read_main_file(&ws, naming::WORKFLOW_PATH).await.ok().flatten();
  items.push(match workflow {
    Some(text) if text == templates::workflow() => item("workflow", "Deploy pipeline", "ok", None, false),
    Some(_) => item("workflow", "Deploy pipeline", "warn", Some("An update to the pipeline is available, or it was edited.".into()), owner),
    None => item("workflow", "Deploy pipeline", "error", Some("The pipeline file is missing.".into()), owner),
  });

  // Only owners can read the repository variables, so the rest is for owners.
  if !owner {
    return TeamHealth { ok: true, error: None, items };
  }
  let targets = match team::trusted_targets(&ws).await {
    Ok(t) => t,
    Err(e) => {
      items.push(item("variables", "Pipeline settings", "error", Some(e), false));
      return TeamHealth { ok: true, error: None, items };
    }
  };
  items.push(match &manifest {
    Some(m) if targets.matches(m) => item("settings", "Workspace settings", "ok", None, false),
    Some(_) => item(
      "settings",
      "Workspace settings",
      "error",
      Some("fabricator.workspace.json names different identities or Fabric workspaces than the pipeline uses. It may have been edited.".into()),
      true,
    ),
    None => item("settings", "Workspace settings", "error", Some("The workspace's settings file is missing.".into()), true),
  });

  let separate = targets.separate();
  let deploy = check_identity(&targets.deploy_client_id).await;
  let preview = if separate { Some(check_identity(&targets.preview_client_id).await) } else { None };
  let identities: Vec<(&str, &IdentityCheck)> =
    std::iter::once(("deploy", &deploy)).chain(preview.as_ref().map(|c| ("preview", c))).collect();
  let label = if separate { "Deploy identities" } else { "Deploy identity" };
  items.push(match identities.iter().find_map(|(_, c)| c.error.clone()) {
    Some(e) => item("identity", label, "unknown", Some(e), false),
    None => {
      let missing: Vec<&str> = identities.iter().filter(|(_, c)| c.sp.is_none()).map(|(n, _)| *n).collect();
      if missing.is_empty() {
        item("identity", label, "ok", None, false)
      } else {
        item("identity", label, "error", Some(format!("The {} identity was deleted.", missing.join(" and "))), true)
      }
    }
  });

  if let Some(repo_info) = &info {
    let (deploy_subjects, preview_subjects) =
      naming::identity_subjects(&repo_info.full_name, repo_info.owner_id, repo_info.id, separate);
    let checks = std::iter::once((&deploy, &deploy_subjects)).chain(preview.as_ref().map(|c| (c, &preview_subjects)));
    let mut untrusted = false;
    let mut unknown = None;
    for (check, wanted) in checks {
      let Some(object_id) = &check.object_id else { continue };
      match entra::federated_credentials(object_id).await {
        Ok(existing) => {
          untrusted |= wanted.iter().any(|(n, s)| !existing.iter().any(|(en, es)| en == n && es == s));
        }
        Err(e) => unknown = Some(e.describe("Check the pipeline's sign-in")),
      }
    }
    items.push(if untrusted {
      item("trust", "Pipeline sign-in", "error", Some("The repository's pipeline isn't trusted (was the repository renamed?).".into()), true)
    } else if let Some(e) = unknown {
      item("trust", "Pipeline sign-in", "unknown", Some(e), false)
    } else {
      item("trust", "Pipeline sign-in", "ok", None, false)
    });
  }

  let preview_sp = preview.as_ref().map_or(&deploy.sp, |c| &c.sp);
  let mut missing = Vec::new();
  for (label, sp, ws_id) in [
    ("published apps", &deploy.sp, &targets.production_workspace_id),
    ("previews", preview_sp, &targets.previews_workspace_id),
  ] {
    let Some(sp_id) = sp else { continue };
    if let Ok(roles) = fabric::role_assignments(ws_id).await {
      if !roles.iter().any(|r| &r.principal_id == sp_id) {
        missing.push(label);
      }
    }
  }
  items.push(if missing.is_empty() {
    item("access", "Fabric access", "ok", None, false)
  } else {
    item("access", "Fabric access", "error", Some(format!("The pipeline can't reach the {} workspace.", missing.join(" and "))), true)
  });

  TeamHealth { ok: true, error: None, items }
}

/// The app registration for `client_id`, recreated when it was deleted.
/// Returns (registration, recreated).
async fn ensure_identity(client_id: &str, display: &str) -> Result<(entra::AppRegistration, bool), String> {
  match entra::app(client_id).await {
    Ok(Some(app)) => Ok((app, false)),
    Ok(None) => entra::create_app(display).await.map(|app| (app, true)).map_err(|e| e.describe("Recreate the deploy identity")),
    Err(e) => Err(e.describe("Check the deploy identity")),
  }
}

/// The manifest that matches the trusted settings, keeping the editable parts.
fn corrected_manifest(base: Option<TeamManifest>, ws: &TeamWorkspace, targets: &TrustedTargets) -> TeamManifest {
  let mut m = base.unwrap_or_default();
  if m.name.trim().is_empty() {
    m.name = ws.name.clone();
  }
  if m.schema == 0 {
    m.schema = 1;
  }
  m.tenant_id = targets.tenant_id.clone();
  if m.deploy_identity.client_id != targets.deploy_client_id {
    m.deploy_identity = TeamDeployIdentity { client_id: targets.deploy_client_id.clone(), ..Default::default() };
  }
  if targets.separate() {
    if m.preview_identity.client_id != targets.preview_client_id {
      m.preview_identity = TeamDeployIdentity { client_id: targets.preview_client_id.clone(), ..Default::default() };
    }
  } else {
    m.preview_identity = TeamDeployIdentity::default();
  }
  m.fabric.production.id = targets.production_workspace_id.clone();
  m.fabric.previews.id = targets.previews_workspace_id.clone();
  m.template_version = templates::TEMPLATE_VERSION;
  m
}

/// Fix whatever the health check found (owners), then verify the pipeline.
#[tauri::command]
pub async fn team_repair(app: AppHandle, workspace_id: String, scope: String) -> TeamActionResult {
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return fail(e),
  };
  let info = match require_owner(&ws).await {
    Ok(info) => info,
    Err(e) => return fail(e),
  };
  let mut targets = match team::trusted_targets(&ws).await {
    Ok(t) => t,
    Err(e) => return fail(e),
  };
  let separate = targets.separate();
  let team_name = ws.manifest.as_ref().map(|m| m.name.clone()).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| ws.name.clone());

  // The identities, recreated if they were deleted.
  let (deploy_app, _) = match ensure_identity(&targets.deploy_client_id, &naming::app_display_name(&team_name)).await {
    Ok(found) => found,
    Err(e) => return fail(e),
  };
  targets.deploy_client_id = deploy_app.app_id.clone();
  let preview_app = if separate {
    match ensure_identity(&targets.preview_client_id, &naming::preview_app_display_name(&team_name)).await {
      Ok((app, _)) => {
        targets.preview_client_id = app.app_id.clone();
        app
      }
      Err(e) => return fail(e),
    }
  } else {
    deploy_app.clone()
  };
  let deploy_sp = match entra::ensure_service_principal(&deploy_app.app_id).await {
    Ok(id) => id,
    Err(e) => return fail(e.describe("Create the service principal")),
  };
  let preview_sp = if separate {
    match entra::ensure_service_principal(&preview_app.app_id).await {
      Ok(id) => id,
      Err(e) => return fail(e.describe("Create the preview service principal")),
    }
  } else {
    deploy_sp.clone()
  };
  let (deploy_subjects, preview_subjects) = naming::identity_subjects(&info.full_name, info.owner_id, info.id, separate);
  if let Err(e) = entra::ensure_federated_credentials(&deploy_app.object_id, &deploy_subjects).await {
    return fail(e.describe("Trust the repository's pipeline"));
  }
  if separate {
    if let Err(e) = entra::ensure_federated_credentials(&preview_app.object_id, &preview_subjects).await {
      return fail(e.describe("Trust the repository's pull requests"));
    }
  }
  for (ws_id, principal) in [(&targets.production_workspace_id, &deploy_sp), (&targets.previews_workspace_id, &preview_sp)] {
    if let Err(e) = fabric::add_role(ws_id, principal, "ServicePrincipal", "Contributor").await {
      return fail(e.describe("Give the deploy identities access to Fabric"));
    }
  }
  if targets.tenant_id.is_empty() {
    if let Ok((tenant, _)) = entra::account().await {
      targets.tenant_id = tenant;
    }
  }
  for (name, value) in [
    ("AZURE_CLIENT_ID", targets.deploy_client_id.as_str()),
    ("AZURE_PREVIEW_CLIENT_ID", targets.preview_or_deploy()),
    ("AZURE_TENANT_ID", targets.tenant_id.as_str()),
    ("FABRIC_WORKSPACE_ID", targets.production_workspace_id.as_str()),
    ("FABRIC_PREVIEW_WORKSPACE_ID", targets.previews_workspace_id.as_str()),
  ] {
    if let Err(e) = gh::set_variable(&ws.repo, name, value).await {
      return fail(e.describe("Configure the pipeline"));
    }
  }
  let _ = gh::apply_merge_settings(&ws.repo).await;
  let _ = gh::set_topics(&ws.repo, &[naming::REPO_TOPIC]).await;

  // The managed pipeline.
  let current = repo::read_main_file(&ws, naming::WORKFLOW_PATH).await.ok().flatten();
  if current.as_deref() != Some(templates::workflow().as_str()) {
    if let Err(e) = gh::put_main_file(&ws.repo, naming::WORKFLOW_PATH, &templates::workflow(), "Update the Fabricator deploy pipeline").await {
      return fail(e.describe("Update the deploy pipeline"));
    }
  }
  // Put the settings file back in line with the trusted settings.
  let manifest = current_manifest(&ws).await.ok();
  let corrected = corrected_manifest(manifest.clone(), &ws, &targets);
  if manifest.as_ref() != Some(&corrected) {
    if let Err(e) = save_manifest(&ws, &corrected, "Update the workspace settings").await {
      return fail(e);
    }
  }

  let state = app.state::<AppState>();
  let cancel = state.begin_team_op(&scope);
  let verified = verify_pipeline(&app, &scope, &ws.repo, &cancel).await;
  state.end_team_op(&scope, &cancel);
  match verified {
    Ok(()) => with_workspace(store::find_team_workspace(&ws.id).unwrap_or(ws)),
    Err(p) => super::fail_with(p),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn repair_restores_tampered_targets_and_keeps_editable_settings() {
    let targets = TrustedTargets {
      tenant_id: "t".into(),
      deploy_client_id: "d".into(),
      preview_client_id: "p".into(),
      production_workspace_id: "w1".into(),
      previews_workspace_id: "w2".into(),
    };
    let ws = TeamWorkspace {
      id: "w".into(),
      name: "Team".into(),
      repo: "o/r".into(),
      default_branch: "main".into(),
      dir: String::new(),
      role: "owner".into(),
      added_at: String::new(),
      manifest: None,
      setup: None,
      fabric_members: Default::default(),
    };
    let mut tampered = TeamManifest { name: "Team".into(), ..Default::default() };
    tampered.settings.require_review = true;
    tampered.deploy_identity.client_id = "attacker".into();
    tampered.fabric.production.id = "elsewhere".into();
    let fixed = corrected_manifest(Some(tampered), &ws, &targets);
    assert!(targets.matches(&fixed));
    assert!(fixed.settings.require_review, "editable settings are kept");
    assert_eq!(fixed.tenant_id, "t");
  }
}
