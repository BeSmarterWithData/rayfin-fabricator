//! Joining, listing, leaving and deleting team workspaces.

use std::path::Path;

use tauri::AppHandle;

use super::{fail, git_identity, unique_dir, viewer, with_workspace};
use crate::commands::util::{annotate_state, now_iso};
use crate::services::store;
use crate::services::team::{self, entra, fabric, gh, naming, repo, templates};
use crate::services::history;
use crate::types::{
  ProjectsState, TeamActionResult, TeamDiscovered, TeamJoinOptions, TeamRepoProject, TeamWorkspace, TeamWorkspaceDetail,
};

fn joined(full_name: &str) -> Option<TeamWorkspace> {
  store::team_workspaces().into_iter().find(|w| w.repo.eq_ignore_ascii_case(full_name))
}

const DELETED: &str = "This team workspace was deleted: its GitHub repository is archived.";

/// Accept the user's pending invitation to a repository, if there is one.
async fn accept_pending_invitation(full_name: &str) -> Result<bool, gh::GhError> {
  let invitations = gh::user_invitations().await?;
  let Some(invite) = invitations.iter().find(|i| i.repo.eq_ignore_ascii_case(full_name)) else {
    return Ok(false);
  };
  gh::accept_invitation(invite.id).await?;
  Ok(true)
}

/// Invitations to team workspaces waiting for the user, and team workspaces
/// they can join. Other repository invitations and deleted (archived)
/// workspaces aren't listed.
#[tauri::command]
pub async fn team_join_options() -> TeamJoinOptions {
  if let Err(e) = team::require_enabled() {
    return TeamJoinOptions { ok: false, error: Some(e), invitations: vec![], discovered: vec![] };
  }
  let (invitations, repos) = tokio::join!(gh::user_invitations(), gh::workspace_repos());
  let mut error = None;
  let invitations = invitations
    .map(|list| {
      list
        .into_iter()
        .filter(|i| naming::is_workspace_description(i.description.as_deref()) && joined(&i.repo).is_none())
        .collect()
    })
    .unwrap_or_else(|e| {
      error = Some(e.describe("List your GitHub invitations"));
      vec![]
    });
  let discovered = repos
    .map(|repos| {
      repos
        .into_iter()
        .filter(|r| r.push && !r.archived && joined(&r.full_name).is_none())
        .map(|r| TeamDiscovered { repo: r.full_name, description: r.description })
        .collect()
    })
    .unwrap_or_else(|e| {
      error.get_or_insert(e.describe("Find your team workspaces"));
      vec![]
    });
  TeamJoinOptions { ok: error.is_none(), error, invitations, discovered }
}

/// Accept a repository invitation, then join it as a team workspace.
#[tauri::command]
pub async fn team_accept_invitation(invitation_id: u64, repo: String) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  if let Err(e) = gh::accept_invitation(invitation_id).await {
    return fail(e.describe("Accept the invitation"));
  }
  join_repo(&repo).await
}

/// Join a team workspace you already have access to (`owner/name`).
#[tauri::command]
pub async fn team_join(repo: String) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  join_repo(repo.trim()).await
}

async fn join_repo(full_name: &str) -> TeamActionResult {
  let result = join_repo_inner(full_name).await;
  crate::services::telemetry::track_team(crate::commands::auth::get_cached_identity().as_ref(), "join", result.ok);
  result
}

async fn join_repo_inner(full_name: &str) -> TeamActionResult {
  if let Some(existing) = joined(full_name) {
    return with_workspace(existing);
  }
  let info = match gh::repo(full_name).await {
    Ok(info) => info,
    // A private repository stays hidden until its invitation is accepted.
    Err(e) if e.is_not_found() => match accept_pending_invitation(full_name).await {
      Ok(true) => match gh::repo(full_name).await {
        Ok(info) => info,
        Err(e) => return fail(e.describe("Open the repository")),
      },
      Ok(false) => return fail(e.describe("Open the repository")),
      Err(e) => return fail(e.describe("Accept the invitation")),
    },
    Err(e) => return fail(e.describe("Open the repository")),
  };
  if info.archived {
    return fail(DELETED);
  }
  if !info.push {
    return fail("You can view this repository but not change it. Ask its owner to give you write access.");
  }
  let me = match viewer().await {
    Ok(v) => v,
    Err(e) => return fail(e),
  };
  let short = info.full_name.split('/').nth(1).unwrap_or("team").to_string();
  let dir = unique_dir(&naming::slug(&short));
  let mut ws = TeamWorkspace {
    id: uuid::Uuid::new_v4().to_string(),
    name: short,
    repo: info.full_name.clone(),
    default_branch: info.default_branch.clone(),
    dir: dir.to_string_lossy().to_string(),
    role: if info.admin { "owner".into() } else { "member".into() },
    added_at: now_iso(),
    manifest: None,
    setup: None,
    fabric_members: Default::default(),
  };
  let cleanup = |dir: &Path| {
    let _ = std::fs::remove_dir_all(dir);
  };
  if let Err(e) = repo::ensure_clone(&ws, None).await {
    cleanup(&dir);
    return fail(e);
  }
  let manifest = match repo::read_main_file(&ws, naming::MANIFEST_FILE).await {
    Ok(Some(text)) => templates::parse_manifest(&text),
    _ => None,
  };
  let Some(manifest) = manifest else {
    cleanup(&dir);
    return fail("That repository isn't a Fabricator team workspace (it has no fabricator.workspace.json).");
  };
  if !manifest.name.trim().is_empty() {
    ws.name = manifest.name.clone();
  }
  ws.manifest = Some(manifest);
  let (name, email) = git_identity(&me);
  if let Err(e) = repo::set_identity(&ws, &name, &email).await {
    cleanup(&dir);
    return fail(e);
  }
  store::upsert_team_workspace(ws.clone());
  with_workspace(ws)
}

/// The workspace's apps (published, plus your unpublished new ones), refreshed
/// from GitHub.
#[tauri::command]
pub async fn team_detail(workspace_id: String) -> TeamWorkspaceDetail {
  let empty = |error: String| TeamWorkspaceDetail { ok: false, error: Some(error), workspace: None, projects: vec![] };
  if let Err(e) = team::require_enabled() {
    return empty(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return empty("That team workspace is no longer on this computer.".into());
  };
  let mut error = None;
  if let Err(e) = repo::ensure_clone(&ws, None).await {
    error = Some(e);
  }
  let manifest = match repo::read_main_file(&ws, naming::MANIFEST_FILE).await {
    Ok(Some(text)) => templates::parse_manifest(&text),
    _ => None,
  };
  let info = gh::repo(&ws.repo).await.ok();
  if info.as_ref().is_some_and(|r| r.archived) {
    error = Some(format!("{DELETED} Leave it to remove it from this computer."));
  }
  let role = info.map(|r| if r.admin { "owner" } else { "member" });
  let ws = store::mutate_team_workspace(&ws.id, |w| {
    if let Some(m) = manifest {
      if !m.name.trim().is_empty() {
        w.name = m.name.clone();
      }
      w.manifest = Some(m);
    }
    if let Some(role) = role {
      w.role = role.to_string();
    }
  })
  .unwrap_or(ws);

  let local: Vec<_> = store::get_state()
    .projects
    .into_iter()
    .filter(|p| p.team.as_ref().is_some_and(|t| t.workspace_id == ws.id))
    .collect();
  let local_for = |folder: &str| local.iter().find(|p| p.team.as_ref().is_some_and(|t| t.folder == folder));
  let mut projects: Vec<TeamRepoProject> = match repo::list_projects(&ws).await {
    Ok(list) => list
      .into_iter()
      .map(|(folder, name)| TeamRepoProject { project_id: local_for(&folder).map(|p| p.id.clone()), folder, name })
      .collect(),
    Err(e) => {
      error.get_or_insert(e);
      vec![]
    }
  };
  // New apps that exist only on your branch so far.
  for p in &local {
    let folder = p.team.as_ref().map(|t| t.folder.clone()).unwrap_or_default();
    if !projects.iter().any(|r| r.folder == folder) {
      projects.push(TeamRepoProject { folder, name: p.name.clone(), project_id: Some(p.id.clone()) });
    }
  }
  projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  TeamWorkspaceDetail { ok: error.is_none(), error, workspace: Some(ws), projects }
}

/// Forget a workspace on this computer: remove its local files and projects.
/// Work on branches stays on GitHub.
#[tauri::command]
pub async fn team_leave(app: AppHandle, workspace_id: String) -> Result<ProjectsState, String> {
  let _ = app;
  team::require_enabled()?;
  let ws = store::find_team_workspace(&workspace_id).ok_or("That team workspace is no longer on this computer.")?;
  forget_workspace(&ws).await;
  Ok(annotate_state(store::get_state()))
}

async fn forget_workspace(ws: &TeamWorkspace) {
  for p in store::get_state().projects {
    if p.team.as_ref().is_some_and(|t| t.workspace_id == ws.id) {
      history::clear_history(&p.id);
    }
  }
  store::remove_team_workspace(&ws.id);
  let dir = std::path::PathBuf::from(&ws.dir);
  if dir.exists() {
    let _ = tokio::task::spawn_blocking(move || trash::delete(&dir)).await;
  }
}

/// Delete a workspace (owners): remove its deploy identity, archive the
/// repository, optionally delete its Fabric workspaces (and every app in them),
/// and forget it here. Problems are reported but don't stop the rest.
#[tauri::command]
pub async fn team_delete(workspace_id: String, delete_fabric: bool) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail("That team workspace is no longer on this computer.");
  };
  match gh::repo(&ws.repo).await {
    Ok(info) if !info.admin => return fail("Only the workspace's owners can delete it. You can leave it instead."),
    Err(e) if !e.is_not_found() => return fail(e.describe("Check your access to the workspace")),
    _ => {}
  }
  let mut problems: Vec<String> = Vec::new();
  // Trusted IDs only (admin-only repository settings or this computer's setup),
  // never the editable manifest.
  match team::trusted_targets(&ws).await {
    Ok(targets) => {
      let mut identities = vec![targets.deploy_client_id.clone()];
      if targets.separate() {
        identities.push(targets.preview_client_id.clone());
      }
      for client_id in identities.into_iter().filter(|c| !c.is_empty()) {
        // Only identities Fabricator created; an administrator's app registration stays.
        match entra::app(&client_id).await {
          Ok(Some(app)) if naming::is_managed_identity_name(&app.display_name) => {
            if let Err(e) = entra::delete_app(&client_id).await {
              problems.push(e.describe("Remove a deploy identity"));
            }
          }
          Ok(_) => {}
          Err(e) => problems.push(e.describe("Check a deploy identity")),
        }
      }
      if delete_fabric {
        for target in [&targets.production_workspace_id, &targets.previews_workspace_id] {
          if !target.is_empty() {
            if let Err(e) = fabric::delete_workspace(target).await {
              problems.push(e.describe("Delete a Fabric workspace"));
            }
          }
        }
      }
    }
    Err(e) => problems.push(format!("The deploy identities and Fabric workspaces weren't removed: {e}")),
  }
  if let Err(e) = gh::archive_repo(&ws.repo).await {
    if !e.is_not_found() {
      problems.push(e.describe("Archive the GitHub repository"));
    }
  }
  forget_workspace(&ws).await;
  TeamActionResult {
    ok: true,
    error: (!problems.is_empty()).then(|| problems.join(" ")),
    ..Default::default()
  }
}
