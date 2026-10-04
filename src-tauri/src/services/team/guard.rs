//! Chat guardrails for team projects. The team pipeline owns deploys and
//! Fabricator owns branches, pushes and merges, so the agent may not run those
//! commands itself. Everything else is approved, as for any other project.

use std::sync::Arc;

use async_trait::async_trait;
use github_copilot_sdk::handler::{PermissionHandler, PermissionResult};
use github_copilot_sdk::{PermissionRequestData, RequestId, SessionId};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

/// Deploy and sign-in commands of the Rayfin CLI.
static RAYFIN_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)\brayfin(?:\.cmd)?\s+(up|login|logout)\b(\s+(status|list)\b)?").unwrap());

/// Git subcommands that move branches, rewrite history or talk to the remote,
/// after any global options (`-C dir`, `-c key=value`, `--no-pager`, …).
static GIT_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(
    r"(?i)\bgit(?:\.exe)?(?:\s+-[cC]\s+\S+|\s+--?[a-z][\w-]*(?:=\S+)?)*\s+(push|pull|fetch|merge|rebase|checkout|switch|worktree|sparse-checkout|remote|cherry-pick|reset\s+--hard)\b",
  )
  .unwrap()
});

/// The GitHub CLI (it could merge, push or change the repository).
static GH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(?:^|[\s;&|(])gh(?:\.exe)?\s+[a-z]").unwrap());

/// Why a shell command is off-limits in a team project, if it is.
pub fn blocked_reason(command: &str) -> Option<&'static str> {
  if let Some(caps) = RAYFIN_RE.captures(command) {
    let read_only = caps.get(1).is_some_and(|m| m.as_str().eq_ignore_ascii_case("up")) && caps.get(3).is_some();
    if !read_only {
      return Some("the team pipeline deploys this app");
    }
  }
  if GIT_RE.is_match(command) {
    return Some("Fabricator manages this project's branch and publishing");
  }
  if GH_RE.is_match(command) {
    return Some("Fabricator manages this project's GitHub repository");
  }
  None
}

/// The permission request body (nested under `permissionRequest` by current
/// runtimes, flat in older ones).
fn request_body(data: &PermissionRequestData) -> &Value {
  data.extra.get("permissionRequest").filter(|v| v.is_object()).unwrap_or(&data.extra)
}

/// Approves everything except blocked shell commands, which fail on their own
/// without ending the turn.
pub struct TeamChatPolicy;

#[async_trait]
impl PermissionHandler for TeamChatPolicy {
  async fn handle(&self, _: SessionId, _: RequestId, data: PermissionRequestData) -> PermissionResult {
    let body = request_body(&data);
    if body.get("kind").and_then(Value::as_str) == Some("shell") {
      let command = body.get("fullCommandText").and_then(Value::as_str).unwrap_or_default();
      if let Some(reason) = blocked_reason(command) {
        log::info!("Team project: declined a shell command because {reason}");
        // `reject` would end the whole turn; this fails only the one call.
        return PermissionResult::user_not_available();
      }
    }
    PermissionResult::approve_once()
  }
}

/// The permission policy for a project's chat session: `None` (approve
/// everything) unless the project lives in a team workspace.
pub fn chat_policy(project_id: &str) -> Option<Arc<dyn PermissionHandler>> {
  if super::is_team_project_id(project_id) {
    Some(Arc::new(TeamChatPolicy))
  } else {
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn deploy_and_sign_in_commands_are_blocked() {
    for cmd in ["npx rayfin up", "npx rayfin up --yes", "rayfin.cmd up -y --force", "npm exec rayfin login", "npx rayfin logout"] {
      assert!(blocked_reason(cmd).is_some(), "{cmd}");
    }
    for cmd in ["npx rayfin up status --json", "npx rayfin up list", "npx rayfin connector invoke x", "npm run preview"] {
      assert!(blocked_reason(cmd).is_none(), "{cmd}");
    }
  }

  #[test]
  fn branch_and_remote_git_commands_are_blocked() {
    for cmd in [
      "git push",
      "git -C app push origin HEAD",
      "git --no-pager merge origin/main",
      "git checkout main",
      "git switch -c x",
      "git reset --hard HEAD~1",
      "git pull --rebase",
      "cd app && git rebase main",
    ] {
      assert!(blocked_reason(cmd).is_some(), "{cmd}");
    }
    for cmd in ["git status", "git diff --stat", "git log -5", "git restore src/App.tsx", "git add -A", "git commit -m x"] {
      assert!(blocked_reason(cmd).is_none(), "{cmd}");
    }
  }

  #[test]
  fn the_github_cli_is_blocked_but_lookalikes_are_not() {
    assert!(blocked_reason("gh pr merge 3 --squash").is_some());
    assert!(blocked_reason("echo hi && gh api repos/o/r").is_some());
    assert!(blocked_reason("npm i ghost").is_none());
    assert!(blocked_reason("node high.js").is_none());
  }
}
