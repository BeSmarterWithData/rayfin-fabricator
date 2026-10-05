//! GitHub access for team workspaces through the GitHub CLI. REST calls go
//! through `gh api` so they use the CLI's stored sign-in (inherited
//! `GH_TOKEN`/`GITHUB_TOKEN` are stripped, as for Clone from GitHub). Git network
//! operations use gh as a per-command credential helper, so the user's global
//! git configuration is never changed.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

use super::naming;
use crate::commands::github::gh_options;
use crate::services::exec::{self, RunResult};
use crate::types::{TeamDeployRecord, TeamInvitation, TeamMapFile, TeamMapJob, TeamMapRun, TeamOwner, TeamPullRequest, TeamRunStep};

/// Classic OAuth scopes team workspaces need. `workflow` lets Fabricator write
/// the managed workflow and lets members push merges that carry workflow changes.
pub const REQUIRED_SCOPES: &[&str] = &["repo", "read:org", "workflow"];

/// The extra scope deleting a repository needs. Fabricator asks for it only
/// when an owner abandons an unfinished setup.
pub const DELETE_REPO_SCOPE: &str = "delete_repo";

#[derive(Debug, Clone)]
pub struct GhError {
  pub status: Option<u16>,
  pub message: String,
  /// The `gh` executable wasn't found.
  pub missing_cli: bool,
}

static HTTP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\(HTTP (\d{3})\)").unwrap());
static AUTH_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)bad credentials|requires authentication|gh auth login|authentication (?:failed|required)").unwrap()
});

impl GhError {
  fn new(message: impl Into<String>) -> Self {
    GhError { status: None, message: message.into(), missing_cli: false }
  }

  pub fn is_auth(&self) -> bool {
    self.status == Some(401) || AUTH_RE.is_match(&self.message)
  }

  pub fn is_not_found(&self) -> bool {
    self.status == Some(404)
  }

  /// GitHub withholds the feature on this plan (e.g. branch protection on a
  /// private repo with GitHub Free).
  pub fn needs_upgrade(&self) -> bool {
    let m = self.message.to_ascii_lowercase();
    self.status == Some(403) && (m.contains("upgrade") || m.contains("not available") || m.contains("github pro"))
  }

  /// Plain-language description, prefixed with what was being attempted.
  pub fn describe(&self, action: &str) -> String {
    if self.missing_cli {
      return format!("{action}: the GitHub CLI (gh) isn't installed.");
    }
    if self.is_auth() {
      return format!("{action}: your GitHub sign-in has expired. Sign in to GitHub again.");
    }
    if self.message.contains("SAML") {
      return format!(
        "{action}: your organization requires single sign-on for this GitHub token. Authorize the GitHub CLI for the organization on github.com (Settings → Applications), then try again."
      );
    }
    format!("{action}: {}", self.message)
  }
}

fn error_message(body: &Value) -> Option<String> {
  let base = body.get("message")?.as_str()?.to_string();
  let details: Vec<String> = body
    .get("errors")
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(|e| e.get("message").and_then(Value::as_str).or_else(|| e.as_str()).map(String::from))
        .collect()
    })
    .unwrap_or_default();
  Some(if details.is_empty() { base } else { format!("{base}: {}", details.join("; ")) })
}

fn parse_error(res: &RunResult) -> GhError {
  if res.not_found {
    return GhError { status: None, message: "The GitHub CLI (gh) isn't installed.".into(), missing_cli: true };
  }
  let status = HTTP_RE.captures(&res.stderr).and_then(|c| c[1].parse().ok());
  let message = serde_json::from_str::<Value>(res.stdout.trim())
    .ok()
    .and_then(|v| error_message(&v))
    .unwrap_or_else(|| {
      let text = res.stderr.trim().trim_start_matches("gh:").trim();
      let text = HTTP_RE.replace(text, "").trim().to_string();
      if text.is_empty() { "GitHub request failed.".to_string() } else { text }
    });
  GhError { status, message, missing_cli: false }
}

/// Percent-encode a query-string value.
pub fn encode(value: &str) -> String {
  let mut out = String::with_capacity(value.len());
  for b in value.bytes() {
    if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
      out.push(b as char);
    } else {
      out.push_str(&format!("%{b:02X}"));
    }
  }
  out
}

/// Run `gh` with the sanitized environment and return its result.
async fn gh(args: &[&str], timeout_ms: u64) -> RunResult {
  exec::run("gh", args, gh_options(timeout_ms)).await
}

/// Call the GitHub REST API. `body` is sent as JSON.
pub async fn api(method: &str, path: &str, body: Option<&Value>) -> Result<Value, GhError> {
  let mut args: Vec<String> = vec![
    "api".into(),
    "--hostname".into(),
    "github.com".into(),
    "-X".into(),
    method.into(),
    "-H".into(),
    "Accept: application/vnd.github+json".into(),
    "-H".into(),
    "X-GitHub-Api-Version: 2022-11-28".into(),
  ];
  let input = match body {
    Some(value) => {
      let file = std::env::temp_dir().join(format!("fabricator-gh-{}.json", uuid::Uuid::new_v4()));
      std::fs::write(&file, serde_json::to_vec(value).unwrap_or_default())
        .map_err(|e| GhError::new(format!("Could not prepare the GitHub request: {e}")))?;
      args.push("--input".into());
      args.push(file.to_string_lossy().to_string());
      Some(file)
    }
    None => None,
  };
  args.push(path.trim_start_matches('/').to_string());
  let refs: Vec<&str> = args.iter().map(String::as_str).collect();
  let res = gh(&refs, 60_000).await;
  if let Some(file) = input {
    let _ = std::fs::remove_file(file);
  }
  if !res.ok {
    return Err(parse_error(&res));
  }
  let text = res.stdout.trim();
  if text.is_empty() {
    return Ok(Value::Null);
  }
  serde_json::from_str(text).map_err(|e| GhError::new(format!("Unexpected GitHub response: {e}")))
}

/// GET every page of a list endpoint (`--paginate` concatenates the pages).
pub async fn api_list(path: &str) -> Result<Vec<Value>, GhError> {
  let res = gh(
    &[
      "api",
      "--hostname",
      "github.com",
      "--paginate",
      "-H",
      "Accept: application/vnd.github+json",
      path.trim_start_matches('/'),
    ],
    120_000,
  )
  .await;
  if !res.ok {
    return Err(parse_error(&res));
  }
  Ok(concat_pages(&res.stdout))
}

/// Flatten concatenated JSON pages (`[..][..]` or `{"items":[..]}{..}`).
fn concat_pages(stdout: &str) -> Vec<Value> {
  let mut out = Vec::new();
  for page in serde_json::Deserializer::from_str(stdout.trim()).into_iter::<Value>().flatten() {
    match page {
      Value::Array(items) => out.extend(items),
      Value::Object(map) => {
        // Wrapped lists, e.g. `{ "total_count": n, "workflow_runs": [...] }`.
        if let Some(items) = map.values().find_map(|v| v.as_array()) {
          out.extend(items.iter().cloned());
        }
      }
      _ => {}
    }
  }
  out
}

fn str_of(v: &Value, key: &str) -> Option<String> {
  v.get(key).and_then(Value::as_str).map(String::from)
}

fn u64_of(v: &Value, key: &str) -> u64 {
  v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/* ---------------------------------- user ---------------------------------- */

#[derive(Debug, Clone, PartialEq)]
pub struct Viewer {
  pub login: String,
  pub id: u64,
  pub name: Option<String>,
}

pub async fn viewer() -> Result<Viewer, GhError> {
  let v = api("GET", "user", None).await?;
  let login = str_of(&v, "login").ok_or_else(|| GhError::new("GitHub didn't return your account."))?;
  Ok(Viewer { login, id: u64_of(&v, "id"), name: str_of(&v, "name").filter(|n| !n.trim().is_empty()) })
}

/// Scopes granted to the CLI's token (from the `X-OAuth-Scopes` header).
pub async fn token_scopes() -> Result<Vec<String>, GhError> {
  let res = gh(&["api", "--hostname", "github.com", "-i", "user"], 30_000).await;
  if !res.ok {
    return Err(parse_error(&res));
  }
  Ok(parse_scopes(&res.stdout))
}

fn parse_scopes(text: &str) -> Vec<String> {
  for line in text.lines() {
    let lower = line.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("x-oauth-scopes:") {
      return rest.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    }
  }
  Vec::new()
}

/// Required scopes the token lacks (broader scopes satisfy narrower ones).
pub fn missing_scopes(granted: &[String]) -> Vec<String> {
  let has = |s: &str| granted.iter().any(|g| g == s);
  REQUIRED_SCOPES
    .iter()
    .filter(|scope| match **scope {
      "read:org" => !(has("read:org") || has("write:org") || has("admin:org")),
      other => !has(other),
    })
    .map(|s| s.to_string())
    .collect()
}

/// Whether the token may delete repositories.
pub fn can_delete_repos(granted: &[String]) -> bool {
  granted.iter().any(|g| g == DELETE_REPO_SCOPE)
}

/// Whether the signed-in user is an active member of the organization `org`.
pub async fn is_org_member(org: &str) -> Result<bool, GhError> {
  match api("GET", &format!("user/memberships/orgs/{}", encode(org)), None).await {
    Ok(v) => Ok(str_of(&v, "state").as_deref() == Some("active")),
    Err(e) if e.is_not_found() || e.status == Some(403) => Ok(false),
    Err(e) => Err(e),
  }
}

/// Accounts that can own a team repo: the user and their organizations.
pub async fn owners() -> Result<Vec<TeamOwner>, GhError> {
  let me = api("GET", "user", None).await?;
  let mut owners = vec![TeamOwner {
    login: str_of(&me, "login").unwrap_or_default(),
    is_org: false,
    avatar_url: str_of(&me, "avatar_url"),
  }];
  for org in api_list("user/orgs?per_page=100").await? {
    if let Some(login) = str_of(&org, "login") {
      owners.push(TeamOwner { login, is_org: true, avatar_url: str_of(&org, "avatar_url") });
    }
  }
  Ok(owners)
}

/// A user by login, or `None` when it doesn't exist.
pub async fn user(login: &str) -> Result<Option<(String, Option<String>)>, GhError> {
  match api("GET", &format!("users/{}", encode(login)), None).await {
    Ok(v) => Ok(str_of(&v, "login").map(|l| (l, str_of(&v, "avatar_url")))),
    Err(e) if e.is_not_found() => Ok(None),
    Err(e) => Err(e),
  }
}

/* ---------------------------------- repos --------------------------------- */

#[derive(Debug, Clone, PartialEq)]
pub struct RepoInfo {
  /// `owner/name` in GitHub's canonical case.
  pub full_name: String,
  pub id: u64,
  pub owner_id: u64,
  pub private: bool,
  pub default_branch: String,
  pub admin: bool,
  pub push: bool,
  pub html_url: String,
  pub description: Option<String>,
  pub topics: Vec<String>,
  /// Archived repositories are read-only; Fabricator archives a workspace's
  /// repository when the workspace is deleted.
  pub archived: bool,
}

pub fn repo_info(v: &Value) -> Option<RepoInfo> {
  let perms = v.get("permissions");
  let perm = |k: &str| perms.and_then(|p| p.get(k)).and_then(Value::as_bool).unwrap_or(false);
  Some(RepoInfo {
    full_name: str_of(v, "full_name")?,
    id: u64_of(v, "id"),
    owner_id: v.get("owner").map(|o| u64_of(o, "id")).unwrap_or(0),
    private: v.get("private").and_then(Value::as_bool).unwrap_or(true),
    default_branch: str_of(v, "default_branch").unwrap_or_else(|| naming::DEFAULT_BRANCH.into()),
    admin: perm("admin"),
    push: perm("push") || perm("admin"),
    html_url: str_of(v, "html_url").unwrap_or_default(),
    description: str_of(v, "description").filter(|d| !d.trim().is_empty()),
    topics: v
      .get("topics")
      .and_then(Value::as_array)
      .map(|t| t.iter().filter_map(Value::as_str).map(String::from).collect())
      .unwrap_or_default(),
    archived: v.get("archived").and_then(Value::as_bool).unwrap_or(false),
  })
}

pub async fn repo(full_name: &str) -> Result<RepoInfo, GhError> {
  let v = api("GET", &format!("repos/{full_name}"), None).await?;
  repo_info(&v).ok_or_else(|| GhError::new("GitHub returned an unexpected repository."))
}

/// Merge settings every team repo uses: squash merges, branches deleted after merge.
fn merge_settings() -> Value {
  json!({
    "allow_squash_merge": true,
    "allow_merge_commit": false,
    "allow_rebase_merge": false,
    "delete_branch_on_merge": true,
    "allow_auto_merge": true,
    "squash_merge_commit_title": "PR_TITLE",
    "squash_merge_commit_message": "PR_BODY"
  })
}

/// Create a private repository for a team workspace.
pub async fn create_repo(owner: &str, is_org: bool, name: &str, description: &str) -> Result<RepoInfo, GhError> {
  let mut body = merge_settings();
  if let Value::Object(map) = &mut body {
    map.insert("name".into(), json!(name));
    map.insert("description".into(), json!(description));
    map.insert("private".into(), json!(true));
    map.insert("has_wiki".into(), json!(false));
    map.insert("has_projects".into(), json!(false));
    map.insert("auto_init".into(), json!(false));
  }
  let path = if is_org { format!("orgs/{owner}/repos") } else { "user/repos".to_string() };
  let v = api("POST", &path, Some(&body)).await?;
  repo_info(&v).ok_or_else(|| GhError::new("GitHub returned an unexpected repository."))
}

/// Re-apply the merge settings (idempotent).
pub async fn apply_merge_settings(full_name: &str) -> Result<(), GhError> {
  api("PATCH", &format!("repos/{full_name}"), Some(&merge_settings())).await.map(|_| ())
}

pub async fn set_topics(full_name: &str, topics: &[&str]) -> Result<(), GhError> {
  api("PUT", &format!("repos/{full_name}/topics"), Some(&json!({ "names": topics }))).await.map(|_| ())
}

/// Create or update a repository Actions variable.
pub async fn set_variable(full_name: &str, name: &str, value: &str) -> Result<(), GhError> {
  let body = json!({ "name": name, "value": value });
  match api("POST", &format!("repos/{full_name}/actions/variables"), Some(&body)).await {
    Ok(_) => Ok(()),
    Err(e) if e.status == Some(409) => api(
      "PATCH",
      &format!("repos/{full_name}/actions/variables/{name}"),
      Some(&body),
    )
    .await
    .map(|_| ()),
    Err(e) => Err(e),
  }
}

/// A repository Actions variable, or `None` when it isn't set.
pub async fn variable(full_name: &str, name: &str) -> Result<Option<String>, GhError> {
  match api("GET", &format!("repos/{full_name}/actions/variables/{name}"), None).await {
    Ok(v) => Ok(str_of(&v, "value")),
    Err(e) if e.is_not_found() => Ok(None),
    Err(e) => Err(e),
  }
}

/// Ask GitHub to require pull requests into `main` (plus one approval when
/// reviews are required). Returns `false` when the plan doesn't offer branch
/// protection for this repository (private repos on GitHub Free); Fabricator
/// still follows the same flow itself.
pub async fn protect_main(full_name: &str, require_review: bool) -> Result<bool, GhError> {
  let body = json!({
    "required_status_checks": null,
    "enforce_admins": false,
    "required_pull_request_reviews": {
      "required_approving_review_count": if require_review { 1 } else { 0 },
      "dismiss_stale_reviews": false
    },
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false
  });
  match api("PUT", &format!("repos/{full_name}/branches/{}/protection", naming::DEFAULT_BRANCH), Some(&body)).await {
    Ok(_) => Ok(true),
    Err(e) if e.needs_upgrade() => Ok(false),
    Err(e) => Err(e),
  }
}

/// Team workspaces the user can access: tagged repositories that haven't been
/// archived (deleted workspaces).
pub async fn workspace_repos() -> Result<Vec<RepoInfo>, GhError> {
  let repos = api_list("user/repos?affiliation=owner,collaborator,organization_member&per_page=100").await?;
  Ok(
    repos
      .iter()
      .filter_map(repo_info)
      .filter(|r| !r.archived && r.topics.iter().any(|t| t == naming::REPO_TOPIC))
      .collect(),
  )
}

/* --------------------------------- members -------------------------------- */

/// Invite (or re-invite) a collaborator. `permission` is `push` or `admin`.
pub async fn invite(full_name: &str, login: &str, permission: &str) -> Result<(), GhError> {
  api(
    "PUT",
    &format!("repos/{full_name}/collaborators/{}", encode(login)),
    Some(&json!({ "permission": permission })),
  )
  .await
  .map(|_| ())
}

/// (login, avatar, is_admin) for every collaborator.
pub async fn collaborators(full_name: &str) -> Result<Vec<(String, Option<String>, bool)>, GhError> {
  let list = api_list(&format!("repos/{full_name}/collaborators?affiliation=all&per_page=100")).await?;
  Ok(
    list
      .iter()
      .filter_map(|c| {
        let admin = c.get("permissions").and_then(|p| p.get("admin")).and_then(Value::as_bool).unwrap_or(false);
        Some((str_of(c, "login")?, str_of(c, "avatar_url"), admin))
      })
      .collect(),
  )
}

/// Pending invitations to the repo: (invitation id, login, avatar, admin). Only
/// repository admins can list them; others get an empty list.
pub async fn repo_invitations(full_name: &str) -> Result<Vec<(u64, String, Option<String>, bool)>, GhError> {
  match api_list(&format!("repos/{full_name}/invitations?per_page=100")).await {
    Ok(list) => Ok(
      list
        .iter()
        .filter_map(|i| {
          let invitee = i.get("invitee")?;
          let admin = str_of(i, "permissions").is_some_and(|p| p == "admin");
          Some((u64_of(i, "id"), str_of(invitee, "login")?, str_of(invitee, "avatar_url"), admin))
        })
        .collect(),
    ),
    Err(e) if e.status == Some(403) || e.is_not_found() => Ok(Vec::new()),
    Err(e) => Err(e),
  }
}

pub async fn cancel_invitation(full_name: &str, id: u64) -> Result<(), GhError> {
  api("DELETE", &format!("repos/{full_name}/invitations/{id}"), None).await.map(|_| ())
}

pub async fn remove_collaborator(full_name: &str, login: &str) -> Result<(), GhError> {
  api("DELETE", &format!("repos/{full_name}/collaborators/{}", encode(login)), None).await.map(|_| ())
}

/// Repository invitations waiting for the signed-in user, to any repository.
pub async fn user_invitations() -> Result<Vec<TeamInvitation>, GhError> {
  let list = api_list("user/repository_invitations?per_page=100").await?;
  Ok(list.iter().filter_map(invitation).collect())
}

pub fn invitation(v: &Value) -> Option<TeamInvitation> {
  let repository = v.get("repository")?;
  Some(TeamInvitation {
    id: u64_of(v, "id"),
    repo: str_of(repository, "full_name")?,
    inviter: v.get("inviter").and_then(|u| str_of(u, "login")),
    created_at: str_of(v, "created_at"),
    description: str_of(repository, "description").filter(|d| !d.trim().is_empty()),
  })
}

pub async fn accept_invitation(id: u64) -> Result<(), GhError> {
  api("PATCH", &format!("user/repository_invitations/{id}"), None).await.map(|_| ())
}

/* ---------------------------------- pulls --------------------------------- */

pub fn pull_request(v: &Value) -> Option<TeamPullRequest> {
  let merged = v.get("merged_at").is_some_and(|m| !m.is_null()) || v.get("merged").and_then(Value::as_bool) == Some(true);
  let state = if merged { "merged".to_string() } else { str_of(v, "state").unwrap_or_else(|| "open".into()) };
  Some(TeamPullRequest {
    number: v.get("number")?.as_u64()?,
    url: str_of(v, "html_url").unwrap_or_default(),
    draft: v.get("draft").and_then(Value::as_bool).unwrap_or(false),
    state,
    title: str_of(v, "title").unwrap_or_default(),
    author: v.get("user").and_then(|u| str_of(u, "login")).unwrap_or_default(),
    head_sha: v.get("head").and_then(|h| str_of(h, "sha")),
    approvals: 0,
  })
}

/// Open a pull request, as a draft where the plan supports drafts.
pub async fn create_pr(full_name: &str, head: &str, title: &str, body: &str) -> Result<TeamPullRequest, GhError> {
  let mut request = json!({
    "title": title, "head": head, "base": naming::DEFAULT_BRANCH, "body": body, "draft": true
  });
  let path = format!("repos/{full_name}/pulls");
  let created = match api("POST", &path, Some(&request)).await {
    Ok(v) => v,
    Err(e) if e.status == Some(422) && e.message.to_ascii_lowercase().contains("draft") => {
      request["draft"] = json!(false);
      api("POST", &path, Some(&request)).await?
    }
    Err(e) => return Err(e),
  };
  pull_request(&created).ok_or_else(|| GhError::new("GitHub returned an unexpected pull request."))
}

/// The open pull request whose head is `branch`, if any.
pub async fn open_pr_for_branch(full_name: &str, branch: &str) -> Result<Option<TeamPullRequest>, GhError> {
  let owner = full_name.split('/').next().unwrap_or_default();
  let list = api_list(&format!(
    "repos/{full_name}/pulls?state=open&per_page=10&head={}",
    encode(&format!("{owner}:{branch}"))
  ))
  .await?;
  Ok(list.iter().find_map(pull_request))
}

/// Every open pull request in the repo.
pub async fn open_prs(full_name: &str) -> Result<Vec<(TeamPullRequest, String)>, GhError> {
  let list = api_list(&format!("repos/{full_name}/pulls?state=open&per_page=100")).await?;
  Ok(
    list
      .iter()
      .filter_map(|v| Some((pull_request(v)?, v.get("head").and_then(|h| str_of(h, "ref"))?)))
      .collect(),
  )
}

pub async fn get_pr(full_name: &str, number: u64) -> Result<TeamPullRequest, GhError> {
  let v = api("GET", &format!("repos/{full_name}/pulls/{number}"), None).await?;
  pull_request(&v).ok_or_else(|| GhError::new("GitHub returned an unexpected pull request."))
}

/// Mark a draft pull request as ready for review (GraphQL-only, via gh).
pub async fn mark_ready(full_name: &str, number: u64) -> Result<(), GhError> {
  let n = number.to_string();
  let res = gh(&["pr", "ready", &n, "--repo", full_name], 60_000).await;
  if res.ok || res.stderr.to_ascii_lowercase().contains("already") {
    Ok(())
  } else {
    Err(parse_error(&res))
  }
}

/// Approvals from people other than the author, counting each reviewer's
/// latest decisive review.
pub fn count_approvals(reviews: &[Value], author: &str) -> u32 {
  let mut latest: std::collections::HashMap<String, String> = std::collections::HashMap::new();
  for r in reviews {
    let Some(login) = r.get("user").and_then(|u| str_of(u, "login")) else { continue };
    let state = str_of(r, "state").unwrap_or_default();
    if login.eq_ignore_ascii_case(author) || !matches!(state.as_str(), "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED") {
      continue;
    }
    latest.insert(login, state);
  }
  latest.values().filter(|s| *s == "APPROVED").count() as u32
}

pub async fn approvals(full_name: &str, number: u64, author: &str) -> Result<u32, GhError> {
  let reviews = api_list(&format!("repos/{full_name}/pulls/{number}/reviews?per_page=100")).await?;
  Ok(count_approvals(&reviews, author))
}

pub async fn approve(full_name: &str, number: u64) -> Result<(), GhError> {
  api(
    "POST",
    &format!("repos/{full_name}/pulls/{number}/reviews"),
    Some(&json!({ "event": "APPROVE", "body": "Approved in Fabricator." })),
  )
  .await
  .map(|_| ())
}

/// Squash-merge a pull request; returns the merge commit SHA.
pub async fn merge_pr(full_name: &str, number: u64, title: &str) -> Result<String, GhError> {
  let v = api(
    "PUT",
    &format!("repos/{full_name}/pulls/{number}/merge"),
    Some(&json!({ "merge_method": "squash", "commit_title": format!("{title} (#{number})") })),
  )
  .await?;
  str_of(&v, "sha").ok_or_else(|| GhError::new("GitHub didn't return the merge commit."))
}

pub async fn close_pr(full_name: &str, number: u64) -> Result<(), GhError> {
  api("PATCH", &format!("repos/{full_name}/pulls/{number}"), Some(&json!({ "state": "closed" })))
    .await
    .map(|_| ())
}

/// Delete a branch on GitHub (missing branches are fine).
pub async fn delete_branch(full_name: &str, branch: &str) -> Result<(), GhError> {
  match api("DELETE", &format!("repos/{full_name}/git/refs/heads/{branch}"), None).await {
    Ok(_) => Ok(()),
    Err(e) if e.status == Some(422) || e.is_not_found() => Ok(()),
    Err(e) => Err(e),
  }
}

/* ---------------------------------- runs ---------------------------------- */

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Run {
  pub id: u64,
  pub event: String,
  pub status: String,
  pub conclusion: Option<String>,
  pub url: String,
  pub head_sha: String,
  pub head_branch: Option<String>,
  pub created_at: Option<String>,
  pub workflow_path: Option<String>,
  pub updated_at: Option<String>,
  pub run_started_at: Option<String>,
  /// The commit message or pull request title GitHub shows for the run.
  pub title: Option<String>,
  pub actor: Option<String>,
  pub actor_avatar: Option<String>,
  pub pr_number: Option<u64>,
}

pub fn run_of(v: &Value) -> Option<Run> {
  let actor = v.get("triggering_actor").filter(|a| !a.is_null()).or_else(|| v.get("actor"));
  Some(Run {
    id: v.get("id")?.as_u64()?,
    event: str_of(v, "event").unwrap_or_default(),
    status: str_of(v, "status").unwrap_or_default(),
    conclusion: str_of(v, "conclusion"),
    url: str_of(v, "html_url").unwrap_or_default(),
    head_sha: str_of(v, "head_sha").unwrap_or_default(),
    head_branch: str_of(v, "head_branch"),
    created_at: str_of(v, "created_at"),
    workflow_path: str_of(v, "path"),
    updated_at: str_of(v, "updated_at"),
    run_started_at: str_of(v, "run_started_at"),
    title: str_of(v, "display_title"),
    actor: actor.and_then(|a| str_of(a, "login")),
    actor_avatar: actor.and_then(|a| str_of(a, "avatar_url")),
    pr_number: v
      .get("pull_requests")
      .and_then(Value::as_array)
      .and_then(|prs| prs.first())
      .and_then(|pr| pr.get("number"))
      .and_then(Value::as_u64),
  })
}

/// One workflow run.
pub async fn run(full_name: &str, run_id: u64) -> Result<Run, GhError> {
  let v = api("GET", &format!("repos/{full_name}/actions/runs/{run_id}"), None).await?;
  run_of(&v).ok_or_else(|| GhError::new("GitHub returned an unexpected run."))
}

/// Runs of the Fabricator workflow for a commit, newest first.
pub async fn runs_for_sha(full_name: &str, sha: &str) -> Result<Vec<Run>, GhError> {
  let v = api(
    "GET",
    &format!("repos/{full_name}/actions/workflows/{}/runs?head_sha={sha}&per_page=20", naming::WORKFLOW_FILE),
    None,
  )
  .await?;
  Ok(
    v.get("workflow_runs")
      .and_then(Value::as_array)
      .map(|runs| runs.iter().filter_map(run_of).collect())
      .unwrap_or_default(),
  )
}

/// Recent manual (workflow_dispatch) runs of the Fabricator workflow.
pub async fn dispatch_runs(full_name: &str) -> Result<Vec<Run>, GhError> {
  let v = api(
    "GET",
    &format!("repos/{full_name}/actions/workflows/{}/runs?event=workflow_dispatch&per_page=10", naming::WORKFLOW_FILE),
    None,
  )
  .await?;
  Ok(
    v.get("workflow_runs")
      .and_then(Value::as_array)
      .map(|runs| runs.iter().filter_map(run_of).collect())
      .unwrap_or_default(),
  )
}

/// The Fabricator workflow's most recent runs, newest first. A workspace whose
/// pipeline hasn't been added yet has none.
pub async fn recent_runs(full_name: &str, count: u32) -> Result<Vec<Run>, GhError> {
  match api(
    "GET",
    &format!("repos/{full_name}/actions/workflows/{}/runs?per_page={count}", naming::WORKFLOW_FILE),
    None,
  )
  .await
  {
    Ok(v) => Ok(
      v.get("workflow_runs")
        .and_then(Value::as_array)
        .map(|runs| runs.iter().filter_map(run_of).collect())
        .unwrap_or_default(),
    ),
    Err(e) if e.is_not_found() => Ok(Vec::new()),
    Err(e) => Err(e),
  }
}

/// Run a GraphQL query. GitHub reports query errors with HTTP 200, so those
/// are turned into errors here.
pub async fn graphql(query: &str, variables: Value) -> Result<Value, GhError> {
  let body = json!({ "query": query, "variables": variables });
  let v = api("POST", "graphql", Some(&body)).await?;
  if let Some(errors) = v.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty()) {
    let message = errors
      .iter()
      .filter_map(|e| e.get("message").and_then(Value::as_str))
      .collect::<Vec<_>>()
      .join(" ");
    return Err(GhError::new(if message.is_empty() { "GitHub couldn't answer the query.".to_string() } else { message }));
  }
  Ok(v.get("data").cloned().unwrap_or(Value::Null))
}

/// A pull request's changed files, with their patches (GitHub omits patches
/// for binary and very large files).
pub async fn pr_files(full_name: &str, number: u64) -> Result<Vec<Value>, GhError> {
  api_list(&format!("repos/{full_name}/pulls/{number}/files?per_page=100")).await
}

/// (job name, status, conclusion, steps) for a run.
pub async fn run_jobs(full_name: &str, run_id: u64) -> Result<Vec<Value>, GhError> {
  let v = api("GET", &format!("repos/{full_name}/actions/runs/{run_id}/jobs?per_page=100"), None).await?;
  Ok(v.get("jobs").and_then(Value::as_array).cloned().unwrap_or_default())
}

/// Steps that say nothing about the deploy itself: the setup and cleanup GitHub
/// adds to every job, and unnamed action steps (shown as "Run actions/checkout@v7").
pub fn is_housekeeping_step(name: &str) -> bool {
  name.starts_with("Set up job")
    || name.starts_with("Post ")
    || name == "Complete job"
    || name
      .strip_prefix("Run ")
      .is_some_and(|action| action.contains('/') && action.contains('@') && !action.contains(char::is_whitespace))
}

/// Whether a step belongs in a run's checklist: the pipeline's own steps, plus
/// any housekeeping step that failed, so a failure is never hidden.
pub fn shows_step(step: &TeamRunStep) -> bool {
  !is_housekeeping_step(&step.name) || step.conclusion.as_deref() == Some("failure")
}

/// A job of a Fabricator pipeline run, with its meaningful steps.
pub fn map_job(job: &Value) -> Option<TeamMapJob> {
  let name = str_of(job, "name")?;
  let folder = name
    .strip_prefix("Preview ")
    .or_else(|| name.strip_prefix("Deploy "))
    .map(str::trim)
    .filter(|f| naming::is_app_folder(f))
    .map(String::from);
  let steps = job
    .get("steps")
    .and_then(Value::as_array)
    .map(|steps| {
      steps
        .iter()
        .filter_map(|s| {
          Some(TeamRunStep {
            name: str_of(s, "name")?,
            status: str_of(s, "status").unwrap_or_default(),
            conclusion: str_of(s, "conclusion"),
            started_at: str_of(s, "started_at"),
            completed_at: str_of(s, "completed_at"),
          })
        })
        .filter(shows_step)
        .collect()
    })
    .unwrap_or_default();
  Some(TeamMapJob {
    name,
    folder,
    status: str_of(job, "status").unwrap_or_default(),
    conclusion: str_of(job, "conclusion"),
    started_at: str_of(job, "started_at"),
    completed_at: str_of(job, "completed_at"),
    url: str_of(job, "html_url"),
    steps,
  })
}

/// A pipeline run for the map. `jobs` are the run's jobs when they were fetched.
pub fn map_run(run: &Run, jobs: &[Value]) -> TeamMapRun {
  let jobs: Vec<TeamMapJob> = jobs.iter().filter_map(map_job).collect();
  let deploys = jobs.iter().any(|j| j.name.starts_with("Deploy ") && j.conclusion.as_deref() != Some("skipped"));
  let kind = match run.event.as_str() {
    "pull_request" => "preview",
    "push" => "production",
    "workflow_dispatch" if deploys => "production",
    "workflow_dispatch" if !jobs.is_empty() => "verify",
    "workflow_dispatch" => "manual",
    _ => "other",
  };
  TeamMapRun {
    id: run.id,
    kind: kind.to_string(),
    status: run.status.clone(),
    conclusion: run.conclusion.clone(),
    url: run.url.clone(),
    sha: run.head_sha.clone(),
    branch: run.head_branch.clone(),
    title: run.title.clone(),
    actor: run.actor.clone(),
    actor_avatar: run.actor_avatar.clone(),
    pr_number: run.pr_number,
    started_at: run.run_started_at.clone().or_else(|| run.created_at.clone()),
    updated_at: run.updated_at.clone(),
    jobs,
  }
}

/// The failed steps' log (or the whole log), trimmed to the last `max` chars.
pub async fn run_log(full_name: &str, run_id: u64, max: usize) -> Result<String, GhError> {
  let id = run_id.to_string();
  let mut res = gh(&["run", "view", &id, "--repo", full_name, "--log-failed"], 120_000).await;
  if res.ok && res.stdout.trim().is_empty() {
    res = gh(&["run", "view", &id, "--repo", full_name, "--log"], 120_000).await;
  }
  if !res.ok {
    return Err(parse_error(&res));
  }
  let text = res.stdout;
  let skip = text.chars().count().saturating_sub(max);
  Ok(text.chars().skip(skip).collect())
}

/// Start the Fabricator workflow manually on `main`.
pub async fn dispatch(full_name: &str, inputs: Value) -> Result<(), GhError> {
  api(
    "POST",
    &format!("repos/{full_name}/actions/workflows/{}/dispatches", naming::WORKFLOW_FILE),
    Some(&json!({ "ref": naming::DEFAULT_BRANCH, "inputs": inputs })),
  )
  .await
  .map(|_| ())
}

/* ------------------------------- deployments ------------------------------ */

/// Build a record from a deployment and its latest status.
pub fn deploy_record(environment: &str, deployment: &Value, status: Option<&Value>) -> TeamDeployRecord {
  let payload = deployment.get("payload").cloned().unwrap_or(Value::Null);
  let pay = |k: &str| payload.get(k).and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty());
  let status_str = |k: &str| status.and_then(|s| str_of(s, k)).filter(|s| !s.is_empty());
  TeamDeployRecord {
    environment: environment.to_string(),
    state: status_str("state").unwrap_or_else(|| "pending".into()),
    sha: pay("headSha").or_else(|| str_of(deployment, "sha")),
    url: status_str("environment_url").or_else(|| pay("hostingUrl")),
    api_url: pay("apiUrl"),
    portal_url: pay("portalUrl"),
    item_id: pay("itemId"),
    workspace_id: pay("workspaceId"),
    log_url: status_str("log_url").or_else(|| status_str("target_url")),
    reason: pay("reason").or_else(|| {
      status_str("description").filter(|d| d.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
    }),
    updated_at: status_str("created_at").or_else(|| str_of(deployment, "created_at")),
    public_env: public_env(payload.get("publicEnv")),
  }
}

/// The `RAYFIN_PUBLIC_*` settings a deployment recorded. Anything else (or a
/// value that would break a `.env` line) is ignored.
pub fn public_env(value: Option<&Value>) -> std::collections::BTreeMap<String, String> {
  static KEY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^RAYFIN_PUBLIC_[A-Z0-9_]+$").unwrap());
  value
    .and_then(Value::as_object)
    .map(|map| {
      map
        .iter()
        .filter(|(k, _)| KEY.is_match(k) && k.as_str() != "RAYFIN_PUBLIC_FRONTEND_PORT")
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
        .filter(|(_, v)| !v.contains(['\n', '\r', '\0']) && v.len() <= 4096)
        .collect()
    })
    .unwrap_or_default()
}

/// GraphQL returns a deployment's payload as JSON text, encoded twice (a JSON
/// string holding the JSON object). Accepts either form.
pub fn decode_payload(text: &str) -> Value {
  let mut value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
  for _ in 0..2 {
    let next = match &value {
      Value::String(inner) => serde_json::from_str(inner).unwrap_or(Value::Null),
      _ => break,
    };
    value = next;
  }
  if value.is_object() {
    value
  } else {
    Value::Null
  }
}

/// A deployment node from the GraphQL API, as a record.
pub fn graphql_deploy_record(environment: &str, node: &Value) -> TeamDeployRecord {
  let payload = node.get("payload").and_then(Value::as_str).map(decode_payload).unwrap_or(Value::Null);
  let deployment = json!({ "payload": payload, "sha": node.get("commitOid"), "created_at": node.get("createdAt") });
  let status = node.get("latestStatus").filter(|s| s.is_object()).map(|s| {
    json!({
      "state": s.get("state").and_then(Value::as_str).map(str::to_ascii_lowercase),
      "environment_url": s.get("environmentUrl"),
      "log_url": s.get("logUrl"),
      "description": s.get("description"),
      "created_at": s.get("createdAt"),
    })
  });
  deploy_record(environment, &deployment, status.as_ref())
}

/// GitHub's change kinds (REST `status`, GraphQL `changeType`) in the map's words.
pub fn change_kind(raw: &str) -> String {
  match raw.to_ascii_lowercase().as_str() {
    "added" | "copied" => "added",
    "deleted" | "removed" => "deleted",
    "renamed" => "renamed",
    _ => "modified",
  }
  .to_string()
}

/// An open pull request from the GraphQL API, with what it changes.
#[derive(Debug, Clone, PartialEq)]
pub struct PrSummary {
  pub pr: TeamPullRequest,
  pub head: String,
  pub avatar_url: Option<String>,
  pub additions: u32,
  pub deletions: u32,
  pub changed_files: u32,
  pub commits: u32,
  pub review: Option<String>,
  pub updated_at: Option<String>,
  pub files: Vec<TeamMapFile>,
}

pub fn pr_summary(node: &Value) -> Option<PrSummary> {
  let count = |v: Option<&Value>| v.and_then(Value::as_u64).unwrap_or(0).min(u64::from(u32::MAX)) as u32;
  let author = node.get("author").filter(|a| a.is_object());
  let files = node
    .pointer("/files/nodes")
    .and_then(Value::as_array)
    .map(|nodes| {
      nodes
        .iter()
        .filter_map(|f| {
          Some(TeamMapFile {
            path: str_of(f, "path")?,
            change: change_kind(f.get("changeType").and_then(Value::as_str).unwrap_or_default()),
            additions: count(f.get("additions")),
            deletions: count(f.get("deletions")),
          })
        })
        .collect()
    })
    .unwrap_or_default();
  Some(PrSummary {
    pr: TeamPullRequest {
      number: node.get("number")?.as_u64()?,
      url: str_of(node, "url").unwrap_or_default(),
      draft: node.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
      state: "open".into(),
      title: str_of(node, "title").unwrap_or_default(),
      author: author.and_then(|a| str_of(a, "login")).unwrap_or_default(),
      head_sha: str_of(node, "headRefOid"),
      approvals: 0,
    },
    head: str_of(node, "headRefName")?,
    avatar_url: author.and_then(|a| str_of(a, "avatarUrl")),
    additions: count(node.get("additions")),
    deletions: count(node.get("deletions")),
    changed_files: count(node.get("changedFiles")),
    commits: count(node.pointer("/commits/totalCount")),
    review: str_of(node, "reviewDecision"),
    updated_at: str_of(node, "updatedAt"),
    files,
  })
}

/// Open pull requests with their changes, newest activity first.
pub async fn open_pr_summaries(full_name: &str) -> Result<Vec<PrSummary>, GhError> {
  const QUERY: &str = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title url isDraft updatedAt headRefName headRefOid additions deletions changedFiles reviewDecision author { login avatarUrl } commits { totalCount } files(first: 100) { nodes { path additions deletions changeType } } } } } }";
  let (owner, name) = full_name.split_once('/').ok_or_else(|| GhError::new("Unexpected repository name."))?;
  let data = graphql(QUERY, json!({ "owner": owner, "name": name })).await?;
  Ok(
    data
      .pointer("/repository/pullRequests/nodes")
      .and_then(Value::as_array)
      .map(|nodes| nodes.iter().filter_map(pr_summary).collect())
      .unwrap_or_default(),
  )
}

/// GraphQL that asks for the latest deployment of each of `count` environments
/// (variables `$e0`, `$e1`, …) in one request.
pub fn deployments_query(count: usize) -> String {
  let vars: Vec<String> = (0..count).map(|i| format!("$e{i}: [String!]")).collect();
  let fields: Vec<String> = (0..count)
    .map(|i| format!("e{i}: deployments(environments: $e{i}, first: 1, orderBy: {{field: CREATED_AT, direction: DESC}}) {{ nodes {{ ...D }} }}"))
    .collect();
  format!(
    "query($owner: String!, $name: String!, {}) {{ repository(owner: $owner, name: $name) {{ {} }} }} fragment D on Deployment {{ environment commitOid createdAt payload latestStatus {{ state environmentUrl logUrl description createdAt }} }}",
    vars.join(", "),
    fields.join(" ")
  )
}

/// The latest deployment of each environment that has one.
pub async fn latest_deployments(full_name: &str, environments: &[String]) -> Result<HashMap<String, TeamDeployRecord>, GhError> {
  const CHUNK: usize = 40;
  let (owner, name) = full_name.split_once('/').ok_or_else(|| GhError::new("Unexpected repository name."))?;
  let mut out = HashMap::new();
  for chunk in environments.chunks(CHUNK) {
    let mut variables = json!({ "owner": owner, "name": name });
    for (i, env) in chunk.iter().enumerate() {
      variables[format!("e{i}")] = json!([env]);
    }
    let data = graphql(&deployments_query(chunk.len()), variables).await?;
    for (i, env) in chunk.iter().enumerate() {
      if let Some(node) = data.pointer(&format!("/repository/e{i}/nodes/0")) {
        out.insert(env.clone(), graphql_deploy_record(env, node));
      }
    }
  }
  Ok(out)
}

/// The latest deployment recorded for `environment`, if any.
pub async fn latest_deployment(full_name: &str, environment: &str) -> Result<Option<TeamDeployRecord>, GhError> {
  let list = api(
    "GET",
    &format!("repos/{full_name}/deployments?environment={}&per_page=1", encode(environment)),
    None,
  )
  .await?;
  let Some(deployment) = list.as_array().and_then(|a| a.first()).cloned() else {
    return Ok(None);
  };
  let id = u64_of(&deployment, "id");
  let statuses = api("GET", &format!("repos/{full_name}/deployments/{id}/statuses?per_page=1"), None).await?;
  let status = statuses.as_array().and_then(|a| a.first()).cloned();
  Ok(Some(deploy_record(environment, &deployment, status.as_ref())))
}

/// The newest of `deployments` (newest first) that recorded its Fabric app. A
/// run that fails records none, while the app an earlier run deployed stays
/// live. Its status isn't read, so its `state` is "pending".
pub fn newest_deployed(environment: &str, deployments: &Value) -> Option<TeamDeployRecord> {
  deployments
    .as_array()?
    .iter()
    .map(|deployment| deploy_record(environment, deployment, None))
    .find(|record| record.item_id.is_some() && record.workspace_id.is_some())
}

/// [`newest_deployed`] among the recent deployments of `environment`.
pub async fn last_deployed(full_name: &str, environment: &str) -> Result<Option<TeamDeployRecord>, GhError> {
  let list = api(
    "GET",
    &format!("repos/{full_name}/deployments?environment={}&per_page=50", encode(environment)),
    None,
  )
  .await?;
  Ok(newest_deployed(environment, &list))
}

/* ------------------------------- git helpers ------------------------------ */

/// Standard base64 (RFC 4648) for the contents API.
pub fn base64(bytes: &[u8]) -> String {
  const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for chunk in bytes.chunks(3) {
    let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
    let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
    out.push(TABLE[(n >> 18) as usize & 63] as char);
    out.push(TABLE[(n >> 12) as usize & 63] as char);
    out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
    out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
  }
  out
}

/// Create or replace one file on `main` with a single commit (owner settings
/// and workflow updates). Writing under `.github/workflows` needs the
/// `workflow` scope.
pub async fn put_main_file(full_name: &str, path: &str, content: &str, message: &str) -> Result<(), GhError> {
  let url = format!("repos/{full_name}/contents/{path}");
  let sha = match api("GET", &format!("{url}?ref={}", naming::DEFAULT_BRANCH), None).await {
    Ok(v) => str_of(&v, "sha"),
    Err(e) if e.is_not_found() => None,
    Err(e) => return Err(e),
  };
  let mut body = json!({
    "message": message,
    "content": base64(content.as_bytes()),
    "branch": naming::DEFAULT_BRANCH
  });
  if let Some(sha) = sha {
    body["sha"] = json!(sha);
  }
  api("PUT", &url, Some(&body)).await.map(|_| ())
}

/// Archive a repository (read-only on GitHub; reversible by an owner).
pub async fn archive_repo(full_name: &str) -> Result<(), GhError> {
  api("PATCH", &format!("repos/{full_name}"), Some(&json!({ "archived": true }))).await.map(|_| ())
}

/// Delete a repository (needs admin rights and the `delete_repo` scope). One
/// that's already gone counts as deleted.
pub async fn delete_repo(full_name: &str) -> Result<(), GhError> {
  match api("DELETE", &format!("repos/{full_name}"), None).await {
    Ok(_) => Ok(()),
    Err(e) if e.is_not_found() => Ok(()),
    Err(e) => Err(e),
  }
}

/// `git -c …` arguments that make git authenticate to GitHub with the gh
/// sign-in for this one command (no global configuration is changed).
pub fn git_credential_args() -> Vec<String> {
  let gh = which::which("gh")
    .map(|p| p.to_string_lossy().replace('\\', "/"))
    .unwrap_or_else(|_| "gh".to_string());
  vec![
    "-c".into(),
    "credential.helper=".into(),
    "-c".into(),
    format!("credential.helper=!'{gh}' auth git-credential"),
  ]
}

#[cfg(test)]
mod tests {
  use super::*;

  fn result(ok: bool, stdout: &str, stderr: &str) -> RunResult {
    RunResult { ok, exit_code: Some(if ok { 0 } else { 1 }), stdout: stdout.into(), stderr: stderr.into(), not_found: false }
  }

  #[test]
  fn errors_carry_status_and_github_message() {
    let e = parse_error(&result(
      false,
      r#"{"message":"Validation Failed","errors":[{"message":"name already exists on this account"}]}"#,
      "gh: Validation Failed (HTTP 422)",
    ));
    assert_eq!(e.status, Some(422));
    assert_eq!(e.message, "Validation Failed: name already exists on this account");
    let e = parse_error(&result(false, "", "gh: Not Found (HTTP 404)"));
    assert!(e.is_not_found());
    assert_eq!(e.message, "Not Found");
    let e = parse_error(&result(false, r#"{"message":"Bad credentials"}"#, "gh: Bad credentials (HTTP 401)"));
    assert!(e.is_auth());
    assert!(e.describe("Create repo").contains("Sign in to GitHub again"));
    let upgrade = parse_error(&result(
      false,
      r#"{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}"#,
      "gh: Upgrade to GitHub Pro (HTTP 403)",
    ));
    assert!(upgrade.needs_upgrade());
  }

  #[test]
  fn scopes_come_from_the_oauth_header_and_broader_scopes_count() {
    let headers = "HTTP/2.0 200 OK\r\nX-Oauth-Scopes: gist, read:org, repo, workflow\r\nX-Accepted-Oauth-Scopes: \r\n\r\n{}";
    let granted = parse_scopes(headers);
    assert_eq!(granted, vec!["gist", "read:org", "repo", "workflow"]);
    assert!(missing_scopes(&granted).is_empty());
    let narrow = vec!["repo".to_string(), "admin:org".to_string()];
    assert_eq!(missing_scopes(&narrow), vec!["workflow".to_string()]);
    assert_eq!(missing_scopes(&[]).len(), 3);
    assert!(!can_delete_repos(&granted), "repo doesn't include deleting repositories");
    let with_delete = parse_scopes("X-Oauth-Scopes: delete_repo, read:org, repo, workflow\r\n");
    assert!(can_delete_repos(&with_delete));
    assert!(missing_scopes(&with_delete).is_empty());
  }

  #[test]
  fn pages_are_flattened() {
    let items = concat_pages("[{\"a\":1},{\"a\":2}]\n[{\"a\":3}]");
    assert_eq!(items.len(), 3);
    let wrapped = concat_pages("{\"total_count\":2,\"workflow_runs\":[{\"id\":1},{\"id\":2}]}");
    assert_eq!(wrapped.len(), 2);
  }

  #[test]
  fn query_values_are_encoded() {
    assert_eq!(encode("production/app"), "production%2Fapp");
    assert_eq!(encode("octo:fabricator/x-1"), "octo%3Afabricator%2Fx-1");
  }

  #[test]
  fn approvals_use_each_reviewers_latest_decision_and_skip_the_author() {
    let reviews: Vec<Value> = serde_json::from_value(json!([
      {"user":{"login":"amy"},"state":"APPROVED"},
      {"user":{"login":"bob"},"state":"APPROVED"},
      {"user":{"login":"bob"},"state":"CHANGES_REQUESTED"},
      {"user":{"login":"amy"},"state":"COMMENTED"},
      {"user":{"login":"Author"},"state":"APPROVED"}
    ]))
    .unwrap();
    assert_eq!(count_approvals(&reviews, "author"), 1);
  }

  #[test]
  fn deploy_records_read_payload_and_status() {
    let deployment = json!({
      "id": 7, "sha": "merge", "created_at": "2026-10-01T00:00:00Z",
      "payload": {"headSha":"head","itemId":"item","workspaceId":"ws","apiUrl":"https://api","hostingUrl":"https://app","portalUrl":"https://portal","reason":null}
    });
    let status = json!({"state":"success","environment_url":"https://app","log_url":"https://run","description":"Deployed","created_at":"2026-10-01T00:05:00Z"});
    let record = deploy_record("production/app", &deployment, Some(&status));
    assert_eq!(record.state, "success");
    assert_eq!(record.sha.as_deref(), Some("head"));
    assert_eq!(record.url.as_deref(), Some("https://app"));
    assert_eq!(record.item_id.as_deref(), Some("item"));
    assert_eq!(record.reason, None);
    let failed = json!({"state":"failure","description":"data-loss","log_url":"https://run"});
    assert_eq!(deploy_record("production/app", &deployment, Some(&failed)).reason.as_deref(), Some("data-loss"));
    assert_eq!(deploy_record("production/app", &deployment, None).state, "pending");
    assert!(record.public_env.is_empty());
  }

  #[test]
  fn the_newest_deployment_that_recorded_its_app_is_the_live_one() {
    // Newest first: two failed runs (no app recorded) after one that deployed.
    let deployments = json!([
      {"id": 9, "payload": {"headSha": "c", "itemId": null, "workspaceId": null, "portalUrl": null, "reason": "failed"}},
      {"id": 8, "payload": {"headSha": "b", "itemId": "", "workspaceId": "ws"}},
      {"id": 7, "payload": {"headSha": "a", "itemId": "item", "workspaceId": "ws", "portalUrl": "https://portal"}},
      {"id": 6, "payload": {"headSha": "z", "itemId": "older", "workspaceId": "ws"}}
    ]);
    let live = newest_deployed("preview/app/amy", &deployments).unwrap();
    assert_eq!(live.environment, "preview/app/amy");
    assert_eq!(live.sha.as_deref(), Some("a"));
    assert_eq!(live.item_id.as_deref(), Some("item"));
    assert_eq!(live.portal_url.as_deref(), Some("https://portal"));
    assert_eq!(newest_deployed("preview/app/amy", &json!([deployments[0].clone()])), None);
    assert_eq!(newest_deployed("preview/app/amy", &json!({"message": "Not Found"})), None);
  }

  #[test]
  fn deploy_records_keep_only_safe_public_settings() {
    let deployment = json!({
      "sha": "head",
      "payload": {"publicEnv": {
        "RAYFIN_PUBLIC_API_URL": "https://api.example",
        "RAYFIN_PUBLIC_PUBLISHABLE_KEY": "pk_123",
        "RAYFIN_PUBLIC_FRONTEND_PORT": "5173",
        "RAYFIN_PUBLIC_BAD": "line\nINJECTED=1",
        "SECRET_TOKEN": "nope",
        "rayfin_public_lower": "nope",
        "RAYFIN_PUBLIC_NUMBER": 5
      }}
    });
    let record = deploy_record("preview/app/amy", &deployment, None);
    let keys: Vec<&str> = record.public_env.keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["RAYFIN_PUBLIC_API_URL", "RAYFIN_PUBLIC_PUBLISHABLE_KEY"]);
    assert_eq!(record.public_env["RAYFIN_PUBLIC_PUBLISHABLE_KEY"], "pk_123");
  }

  #[test]
  fn pull_requests_report_merged_state() {
    let pr = pull_request(&json!({
      "number": 4, "html_url": "https://github.com/o/r/pull/4", "draft": true, "state": "closed",
      "merged_at": "2026-10-01T00:00:00Z", "title": "App: change", "user": {"login": "amy"}, "head": {"sha": "abc"}
    }))
    .unwrap();
    assert_eq!(pr.state, "merged");
    assert!(pr.draft);
    assert_eq!(pr.head_sha.as_deref(), Some("abc"));
  }

  #[test]
  fn repo_info_reads_ids_permissions_and_topics() {
    let info = repo_info(&json!({
      "full_name": "Octo/Team", "id": 22, "owner": {"id": 11}, "private": true, "default_branch": "main",
      "permissions": {"admin": false, "push": true}, "html_url": "https://github.com/Octo/Team",
      "description": "", "topics": ["fabricator-workspace"]
    }))
    .unwrap();
    assert_eq!((info.id, info.owner_id), (22, 11));
    assert!(info.push && !info.admin);
    assert_eq!(info.description, None);
    assert_eq!(info.topics, vec!["fabricator-workspace"]);
    assert!(!info.archived);
    let deleted = repo_info(&json!({"full_name": "Octo/Old", "archived": true})).unwrap();
    assert!(deleted.archived);
  }

  #[test]
  fn invitations_carry_the_repository_description() {
    // Invitations list a minimal repository: a description, but no topics.
    let invite = invitation(&json!({
      "id": 7, "created_at": "2026-10-01T00:00:00Z", "inviter": {"login": "spatney"},
      "repository": {"full_name": "spatney/superapps", "description": "Fabricator team workspace: SuperApps"}
    }))
    .unwrap();
    assert_eq!((invite.id, invite.repo.as_str(), invite.inviter.as_deref()), (7, "spatney/superapps", Some("spatney")));
    assert!(naming::is_workspace_description(invite.description.as_deref()));
    let other = invitation(&json!({"id": 8, "repository": {"full_name": "petcu40/MemoryHouse", "description": null}})).unwrap();
    assert_eq!(other.description, None);
    assert!(!naming::is_workspace_description(other.description.as_deref()));
  }

  #[test]
  fn git_uses_gh_as_a_per_command_credential_helper() {
    let args = git_credential_args();
    assert_eq!(args[0], "-c");
    assert_eq!(args[1], "credential.helper=");
    assert!(args[3].starts_with("credential.helper=!'"));
    assert!(args[3].ends_with("' auth git-credential"));
  }

  #[test]
  fn graphql_payloads_decode_whether_encoded_once_or_twice() {
    let once = r#"{"project":"trips","hostingUrl":"https://app"}"#;
    let twice = serde_json::to_string(&once).unwrap();
    assert_eq!(decode_payload(once)["project"], "trips");
    assert_eq!(decode_payload(&twice)["hostingUrl"], "https://app");
    assert_eq!(decode_payload("not json"), Value::Null);
    assert_eq!(decode_payload("\"just text\""), Value::Null);
  }

  #[test]
  fn graphql_deployments_become_records() {
    let payload = serde_json::to_string(
      &serde_json::to_string(&json!({"headSha":"head","itemId":"item","publicEnv":{"RAYFIN_PUBLIC_API_URL":"https://api"}})).unwrap(),
    )
    .unwrap();
    let node: Value = serde_json::from_str(&format!(
      r#"{{"environment":"preview/trips/amy","commitOid":"merge","createdAt":"2026-10-03T23:03:00Z","payload":{payload},
          "latestStatus":{{"state":"IN_PROGRESS","environmentUrl":"https://trips.app","logUrl":"https://run","description":"deploying","createdAt":"2026-10-03T23:03:30Z"}}}}"#
    ))
    .unwrap();
    let record = graphql_deploy_record("preview/trips/amy", &node);
    assert_eq!(record.state, "in_progress");
    assert_eq!(record.sha.as_deref(), Some("head"));
    assert_eq!(record.url.as_deref(), Some("https://trips.app"));
    assert_eq!(record.item_id.as_deref(), Some("item"));
    assert_eq!(record.public_env["RAYFIN_PUBLIC_API_URL"], "https://api");
    let bare = graphql_deploy_record("production/trips", &json!({"commitOid":"abc","latestStatus":null}));
    assert_eq!((bare.state.as_str(), bare.sha.as_deref()), ("pending", Some("abc")));
  }

  #[test]
  fn deployment_queries_alias_each_environment() {
    let query = deployments_query(2);
    assert!(query.contains("$e0: [String!], $e1: [String!]"));
    assert!(query.contains("e1: deployments(environments: $e1, first: 1"));
    assert!(query.contains("fragment D on Deployment"));
  }

  #[test]
  fn pull_request_summaries_carry_their_changes() {
    let node = json!({
      "number": 4, "title": "Trips: add a map", "url": "https://github.com/o/r/pull/4", "isDraft": true,
      "updatedAt": "2026-10-03T23:00:00Z", "headRefName": "fabricator/amy/trips-20261003-225801", "headRefOid": "abc",
      "additions": 30, "deletions": 4, "changedFiles": 2, "reviewDecision": "APPROVED",
      "author": {"login": "Amy", "avatarUrl": "https://avatars/amy"}, "commits": {"totalCount": 3},
      "files": {"nodes": [
        {"path": "trips/src/Map.tsx", "additions": 28, "deletions": 0, "changeType": "ADDED"},
        {"path": "trips/src/App.tsx", "additions": 2, "deletions": 4, "changeType": "MODIFIED"}
      ]}
    });
    let summary = pr_summary(&node).unwrap();
    assert_eq!(summary.pr.number, 4);
    assert!(summary.pr.draft);
    assert_eq!(summary.pr.author, "Amy");
    assert_eq!(summary.head, "fabricator/amy/trips-20261003-225801");
    assert_eq!((summary.additions, summary.deletions, summary.changed_files, summary.commits), (30, 4, 2, 3));
    assert_eq!(summary.files[0].change, "added");
    assert_eq!(summary.files[1].change, "modified");
    // A deleted account shows as no author.
    assert_eq!(pr_summary(&json!({"number": 5, "headRefName": "x", "author": null})).unwrap().pr.author, "");
    assert_eq!(change_kind("removed"), "deleted");
  }

  #[test]
  fn runs_map_to_the_apps_their_jobs_deploy() {
    let run = run_of(&json!({
      "id": 37, "event": "pull_request", "status": "in_progress", "html_url": "https://run/37", "head_sha": "abc",
      "head_branch": "fabricator/amy/trips-20261003-225801", "display_title": "Trips: add a map",
      "run_started_at": "2026-10-03T23:02:37Z", "actor": {"login": "amy", "avatar_url": "https://avatars/amy"},
      "triggering_actor": null, "pull_requests": [{"number": 4}]
    }))
    .unwrap();
    assert_eq!((run.actor.as_deref(), run.pr_number), (Some("amy"), Some(4)));
    let jobs = vec![
      json!({"name": "Plan", "status": "completed", "conclusion": "success", "steps": [{"name": "Set up job", "status": "completed"}]}),
      json!({"name": "Preview trips", "status": "in_progress", "html_url": "https://job", "steps": [
        {"name": "Set up job", "status": "completed", "conclusion": "success"},
        {"name": "Run actions/checkout@v7", "status": "completed", "conclusion": "success"},
        {"name": "Run actions/setup-node@v7", "status": "completed", "conclusion": "success"},
        {"name": "Install dependencies", "status": "completed", "conclusion": "success"},
        {"name": "Deploy with Rayfin", "status": "in_progress", "started_at": "2026-10-03T23:03:00Z"},
        {"name": "Post Run actions/checkout@v7", "status": "pending"}
      ]})
    ];
    let mapped = map_run(&run, &jobs);
    assert_eq!(mapped.kind, "preview");
    assert_eq!(mapped.started_at.as_deref(), Some("2026-10-03T23:02:37Z"));
    assert_eq!(mapped.jobs[0].folder, None);
    assert_eq!(mapped.jobs[1].folder.as_deref(), Some("trips"));
    let steps: Vec<&str> = mapped.jobs[1].steps.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(steps, vec!["Install dependencies", "Deploy with Rayfin"]);
    // A failed setup step stays visible, so the checklist never hides why a run failed.
    let failed = map_job(&json!({"name": "Deploy trips", "steps": [
      {"name": "Run actions/checkout@v7", "status": "completed", "conclusion": "failure"},
      {"name": "Install dependencies", "status": "completed", "conclusion": "skipped"}
    ]}))
    .unwrap();
    let steps: Vec<&str> = failed.steps.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(steps, vec!["Run actions/checkout@v7", "Install dependencies"]);
    // Named steps that happen to start with "Run" are the pipeline's own.
    assert!(!is_housekeeping_step("Run the checks"));
    assert!(!is_housekeeping_step("Run npm@latest ci"));
    let manual = Run { event: "workflow_dispatch".into(), ..run.clone() };
    assert_eq!(map_run(&manual, &[json!({"name": "Verify Fabric access", "status": "queued"})]).kind, "verify");
    assert_eq!(map_run(&manual, &[json!({"name": "Deploy trips", "status": "queued"})]).kind, "production");
    assert_eq!(map_run(&manual, &[]).kind, "manual");
  }

  #[test]
  fn base64_matches_rfc_4648_vectors() {
    for (input, expected) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
      assert_eq!(base64(input.as_bytes()), expected);
    }
  }
}
