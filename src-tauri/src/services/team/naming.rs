//! Names derived for team workspaces: folders, branches, Fabric items, GitHub
//! environments and federated-credential subjects. The workflow template derives
//! the preview item and environment the same way (`item_name` in
//! `templates::WORKFLOW`), so keep the two in sync.

use crate::commands::util::slugify;

pub const MANIFEST_FILE: &str = "fabricator.workspace.json";
pub const WORKFLOW_FILE: &str = "fabricator.yml";
pub const WORKFLOW_PATH: &str = ".github/workflows/fabricator.yml";
/// Repository topic that marks a team workspace (used to discover them).
pub const REPO_TOPIC: &str = "fabricator-workspace";
/// How Fabricator describes the repositories it creates. Invitations don't
/// include topics, so this is how invitations to team workspaces are told apart
/// from other repository invitations.
const REPO_DESCRIPTION_PREFIX: &str = "Fabricator team workspace";
pub const BRANCH_ROOT: &str = "fabricator/";
pub const DEFAULT_BRANCH: &str = "main";

const MAX_SLUG: usize = 40;
const MAX_ITEM: usize = 60;
/// Folder names (in slug form) a project can't take: repo plumbing
/// (`.github`, the `.repo` clone) or generated output.
const RESERVED: &[&str] = &["node-modules", "dist", "build", "out", "github", "repo", "fabricator"];

fn clip(s: &str, max: usize) -> String {
  s.chars().take(max).collect::<String>().trim_matches('-').to_string()
}

/// A short, folder- and URL-safe slug.
pub fn slug(name: &str) -> String {
  clip(&slugify(name), MAX_SLUG)
}

/// The repo folder (and production Fabric item name) for a new project.
pub fn project_folder(name: &str) -> Option<String> {
  let s = slug(name);
  (!s.is_empty() && !RESERVED.contains(&s.as_str())).then_some(s)
}

/// A folder name that's safe as one path segment and inside a branch name.
/// Apps added outside Fabricator needn't be slugs (e.g. `Lead_Tracker`).
pub fn is_app_folder(folder: &str) -> bool {
  !folder.is_empty()
    && folder.len() <= 100
    && !folder.starts_with('.')
    && !folder.contains("..")
    && folder.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// GitHub repository name for a new team workspace.
pub fn repo_name(name: &str) -> Option<String> {
  let s = slug(name);
  (!s.is_empty()).then_some(s)
}

/// GitHub logins are case-insensitive; names derived from them are lowercase.
pub fn login_slug(login: &str) -> String {
  login.trim().to_ascii_lowercase()
}

/// Timestamp used to keep session branch names unique.
pub fn stamp(now: chrono::DateTime<chrono::Utc>) -> String {
  now.format("%Y%m%d-%H%M%S").to_string()
}

/// Prefix shared by every session branch a user opens for one project.
pub fn branch_prefix(login: &str, folder: &str) -> String {
  format!("{BRANCH_ROOT}{}/{folder}-", login_slug(login))
}

/// A new working branch: `fabricator/<login>/<folder>-<stamp>`.
pub fn session_branch(login: &str, folder: &str, stamp: &str) -> String {
  format!("{}{stamp}", branch_prefix(login, folder))
}

/// True when `branch` is one of this user's working branches for exactly this
/// app (so `sales` doesn't match `sales-dashboard-…`).
pub fn is_session_branch(branch: &str, login: &str, folder: &str) -> bool {
  let Some(rest) = branch.to_ascii_lowercase().strip_prefix(&branch_prefix(login, &folder.to_ascii_lowercase())).map(String::from) else {
    return false;
  };
  is_stamp(&rest)
}

fn is_stamp(text: &str) -> bool {
  text.len() == 15 && text.char_indices().all(|(i, c)| if i == 8 { c == '-' } else { c.is_ascii_digit() })
}

/// The (login, folder) of a working branch, `fabricator/<login>/<folder>-<stamp>`.
pub fn parse_session_branch(branch: &str) -> Option<(String, String)> {
  let rest = branch.strip_prefix(BRANCH_ROOT)?;
  let (login, tail) = rest.split_once('/')?;
  // "-YYYYMMDD-HHMMSS" is 16 characters, all ASCII.
  if login.is_empty() || tail.len() <= 16 || !tail.is_char_boundary(tail.len() - 16) {
    return None;
  }
  let (folder, stamp) = tail.split_at(tail.len() - 16);
  let stamp = stamp.strip_prefix('-')?;
  (is_stamp(stamp) && is_app_folder(folder)).then(|| (login.to_string(), folder.to_string()))
}

/// Fabric item display name: lowercase letters, digits and hyphens, ≤ 60 chars.
pub fn item_name(raw: &str) -> String {
  let mapped: String = raw
    .to_ascii_lowercase()
    .chars()
    .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' })
    .collect();
  mapped.chars().take(MAX_ITEM).collect()
}

pub fn production_item(folder: &str) -> String {
  item_name(folder)
}

/// Start of every teammate's preview item name for an app (the workflow appends
/// the GitHub login).
pub fn preview_item_prefix(folder: &str) -> String {
  item_name(&format!("{folder}-pv-"))
}

/// A teammate's preview item name, as the workflow derives it.
#[cfg(test)]
pub fn preview_item(folder: &str, login: &str) -> String {
  item_name(&format!("{}{}", preview_item_prefix(folder), login_slug(login)))
}

pub fn production_environment(folder: &str) -> String {
  format!("production/{folder}")
}

pub fn preview_environment(folder: &str, login: &str) -> String {
  format!("preview/{folder}/{}", login_slug(login))
}

/// Display name for the workspace's Entra app registration that deploys
/// published apps.
pub fn app_display_name(team_name: &str) -> String {
  identity_name("Fabricator deploy", team_name)
}

/// Display name for the app registration that deploys previews.
pub fn preview_app_display_name(team_name: &str) -> String {
  identity_name("Fabricator previews", team_name)
}

/// An app registration Fabricator created (and may delete with the workspace).
pub fn is_managed_identity_name(display_name: &str) -> bool {
  display_name.starts_with("Fabricator deploy - ") || display_name.starts_with("Fabricator previews - ")
}

/// The description of a team workspace's GitHub repository.
pub fn repo_description(team_name: &str) -> String {
  format!("{REPO_DESCRIPTION_PREFIX}: {team_name}")
}

/// Whether a repository description marks a Fabricator team workspace.
pub fn is_workspace_description(description: Option<&str>) -> bool {
  description
    .map(str::trim_start)
    .and_then(|d| d.get(..REPO_DESCRIPTION_PREFIX.len()))
    .is_some_and(|start| start.eq_ignore_ascii_case(REPO_DESCRIPTION_PREFIX))
}

fn identity_name(prefix: &str, team_name: &str) -> String {
  let clean: String = team_name
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { ' ' })
    .collect();
  let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
  let label = if clean.is_empty() { "team workspace".to_string() } else { clean };
  format!("{prefix} - {label}").chars().take(120).collect()
}

/// The GitHub no-reply address that attributes commits to a user.
pub fn noreply_email(id: u64, login: &str) -> String {
  format!("{id}+{login}@users.noreply.github.com")
}

/// Federated identity credentials (name, subject) that let the workflow sign in.
///
/// GitHub uses `repo:<owner>/<repo>:…` subjects for repositories created before
/// 2026-07-15 and `repo:<owner>@<owner-id>/<repo>@<repo-id>:…` for newer, renamed
/// or transferred ones, so both forms are trusted. Pushes and manual runs on
/// `main` use the branch ref; pull-request runs use the `pull_request` subject.
pub fn main_subjects(full_name: &str, owner_id: u64, repo_id: u64) -> Vec<(String, String)> {
  let (legacy, immutable) = subject_prefixes(full_name, owner_id, repo_id);
  vec![
    ("fabricator-main".into(), format!("{legacy}:ref:refs/heads/{DEFAULT_BRANCH}")),
    ("fabricator-main-ids".into(), format!("{immutable}:ref:refs/heads/{DEFAULT_BRANCH}")),
  ]
}

pub fn pr_subjects(full_name: &str, owner_id: u64, repo_id: u64) -> Vec<(String, String)> {
  let (legacy, immutable) = subject_prefixes(full_name, owner_id, repo_id);
  vec![
    ("fabricator-pull-requests".into(), format!("{legacy}:pull_request")),
    ("fabricator-pull-requests-ids".into(), format!("{immutable}:pull_request")),
  ]
}

fn subject_prefixes(full_name: &str, owner_id: u64, repo_id: u64) -> (String, String) {
  let (owner, repo) = full_name.split_once('/').unwrap_or((full_name, ""));
  (format!("repo:{owner}/{repo}"), format!("repo:{owner}@{owner_id}/{repo}@{repo_id}"))
}

/// Subjects each identity trusts: (deploy identity, preview identity). Pull
/// requests can only sign in as the preview identity, which can only reach the
/// previews workspace, so changing the workflow in a pull request can't touch
/// published apps. The preview identity also trusts `main` so the workflow's
/// verify run can check it. With one shared identity it trusts everything.
pub fn identity_subjects(
  full_name: &str,
  owner_id: u64,
  repo_id: u64,
  separate: bool,
) -> (Vec<(String, String)>, Vec<(String, String)>) {
  let main = main_subjects(full_name, owner_id, repo_id);
  let mut preview = pr_subjects(full_name, owner_id, repo_id);
  preview.extend(main.iter().cloned());
  if separate {
    (main, preview)
  } else {
    (preview.clone(), preview)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn project_folders_are_safe_and_avoid_reserved_names() {
    assert_eq!(project_folder("Lead Tracker!").as_deref(), Some("lead-tracker"));
    assert_eq!(project_folder("  "), None);
    assert_eq!(project_folder("node_modules"), None);
    assert_eq!(project_folder("GitHub"), None);
    let long = project_folder(&"a".repeat(80)).unwrap();
    assert_eq!(long.len(), 40);
    assert!(!project_folder("ab - - - - - - - - - - - - - - - - - - - - - - - cd").unwrap().ends_with('-'));
  }

  #[test]
  fn existing_app_folders_need_only_be_safe() {
    for ok in ["lead-tracker", "Lead_Tracker", "app.v2", "A1"] {
      assert!(is_app_folder(ok), "{ok}");
    }
    for bad in ["", ".github", "a/b", "a\\b", "a..b", "x y", "é"] {
      assert!(!is_app_folder(bad), "{bad}");
    }
    assert!(!is_app_folder(&"a".repeat(101)));
  }

  #[test]
  fn branches_and_environments_follow_the_pipeline_convention() {
    assert_eq!(session_branch("Octo-Cat", "app", "20261003-010203"), "fabricator/octo-cat/app-20261003-010203");
    assert!(session_branch("Octo-Cat", "app", "x").starts_with(&branch_prefix("octo-cat", "app")));
    assert_eq!(production_environment("app"), "production/app");
    assert_eq!(preview_environment("app", "Octo-Cat"), "preview/app/octo-cat");
  }

  #[test]
  fn session_branches_belong_to_exactly_one_app() {
    let stamp = stamp(chrono::DateTime::from_timestamp(1_790_000_000, 0).unwrap());
    let mine = session_branch("amy", "sales", &stamp);
    assert!(is_session_branch(&mine, "Amy", "sales"));
    assert!(!is_session_branch(&session_branch("amy", "sales-dashboard", &stamp), "amy", "sales"));
    assert!(!is_session_branch(&session_branch("amy", "lead-tracker-2", &stamp), "amy", "lead-tracker"));
    assert!(!is_session_branch(&session_branch("bob", "sales", &stamp), "amy", "sales"));
    assert!(!is_session_branch("fabricator/amy/sales-latest", "amy", "sales"));
  }

  #[test]
  fn item_names_match_the_workflow_sanitizer() {
    // Workflow: tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-60
    assert_eq!(production_item("lead-tracker"), "lead-tracker");
    assert_eq!(preview_item("lead-tracker", "Octo_Cat"), "lead-tracker-pv-octo-cat");
    assert_eq!(item_name(&"x".repeat(90)).len(), 60);
  }

  #[test]
  fn display_names_are_plain_ascii() {
    assert_eq!(app_display_name("Acme · Ops!"), "Fabricator deploy - Acme Ops");
    assert_eq!(app_display_name("***"), "Fabricator deploy - team workspace");
    assert_eq!(preview_app_display_name("Acme"), "Fabricator previews - Acme");
    assert!(is_managed_identity_name(&app_display_name("Acme")));
    assert!(is_managed_identity_name(&preview_app_display_name("Acme")));
    assert!(!is_managed_identity_name("Contoso CI"));
  }

  #[test]
  fn federated_subjects_cover_both_github_formats() {
    let main: Vec<String> = main_subjects("Octo-Org/team-apps", 11, 22).into_iter().map(|(_, s)| s).collect();
    assert_eq!(
      main,
      vec!["repo:Octo-Org/team-apps:ref:refs/heads/main", "repo:Octo-Org@11/team-apps@22:ref:refs/heads/main"]
    );
    let prs: Vec<String> = pr_subjects("Octo-Org/team-apps", 11, 22).into_iter().map(|(_, s)| s).collect();
    assert_eq!(prs, vec!["repo:Octo-Org/team-apps:pull_request", "repo:Octo-Org@11/team-apps@22:pull_request"]);
  }

  #[test]
  fn pull_requests_can_only_sign_in_as_the_preview_identity() {
    let (deploy, preview) = identity_subjects("o/r", 1, 2, true);
    assert!(deploy.iter().all(|(_, s)| !s.ends_with(":pull_request")));
    assert!(preview.iter().any(|(_, s)| s == "repo:o/r:pull_request"));
    assert!(preview.iter().any(|(_, s)| s == "repo:o/r:ref:refs/heads/main"));
    let names: std::collections::HashSet<&str> = preview.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names.len(), preview.len(), "credential names are unique per app");
    let (shared_deploy, shared_preview) = identity_subjects("o/r", 1, 2, false);
    assert_eq!(shared_deploy, shared_preview);
    assert_eq!(shared_deploy.len(), 4);
  }

  #[test]
  fn noreply_email_attributes_commits() {
    assert_eq!(noreply_email(42, "octocat"), "42+octocat@users.noreply.github.com");
  }

  #[test]
  fn workspace_repositories_are_recognized_by_their_description() {
    assert_eq!(repo_description("SuperApps"), "Fabricator team workspace: SuperApps");
    assert!(is_workspace_description(Some(&repo_description("SuperApps"))));
    assert!(is_workspace_description(Some("  fabricator team workspace: Ops")));
    assert!(!is_workspace_description(Some("Proof-of-concept GitHub Copilot plugin for Rayfin")));
    assert!(!is_workspace_description(Some("Fabricator")));
    assert!(!is_workspace_description(Some("")));
    assert!(!is_workspace_description(Some("Fabricatör ✨")));
    assert!(!is_workspace_description(None));
  }

  #[test]
  fn working_branches_name_their_author_and_app() {
    let branch = session_branch("Amy", "sales-dashboard", "20261003-225801");
    assert_eq!(parse_session_branch(&branch), Some(("amy".into(), "sales-dashboard".into())));
    assert_eq!(
      parse_session_branch("fabricator/spatney/Lead_Tracker-20261003-225801"),
      Some(("spatney".into(), "Lead_Tracker".into()))
    );
    // Removal branches, other branches and malformed stamps aren't working branches.
    assert_eq!(parse_session_branch("fabricator/remove-trips-20261003-225801"), None);
    assert_eq!(parse_session_branch("main"), None);
    assert_eq!(parse_session_branch("fabricator/amy/trips-2026100-225801"), None);
    assert_eq!(parse_session_branch("fabricator/amy/-20261003-225801"), None);
    assert_eq!(parse_session_branch("fabricator/amy/é-20261003-22580é"), None);
  }
}
