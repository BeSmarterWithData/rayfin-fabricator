//! Client-defined tools the Help assistant reports through.
//!
//! The assistant can't change anything, so its tools don't *do* work — they
//! turn parts of an answer into UI the user can act on. An offered action
//! becomes a button in the transcript; a citation becomes a docs link.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::Deserialize;
use serde_json::json;

use crate::types::{HelpAction, HelpCitation, HelpEvent, HelpIssueDraft};

pub const ACTION_TOOL: &str = "help_offer_action";
pub const CITE_TOOL: &str = "help_cite";
pub const ISSUE_TOOL: &str = "help_draft_issue";

/// True for the assistant's own reporting tools, which are hidden from the
/// activity feed (the user sees their result as a button or a link instead).
pub fn is_reporting_tool(name: &str) -> bool {
  name == ACTION_TOOL || name == CITE_TOOL || name == ISSUE_TOOL
}

/// The safe app operations the assistant may offer. Each maps to something the
/// user could already do themselves from the UI; the button is a shortcut,
/// never a new capability, and none of them change the user's app.
pub const ACTIONS: &[(&str, &str)] = &[
  ("open-docs", "Open a documentation page in the browser. Needs `url`."),
  (
    "open-project",
    "Open one of the user's projects. Needs `target`, the project's id from the list above.",
  ),
  ("open-home", "Show the list of all their projects, so they can pick one."),
  ("share-app", "Open the dialog for sharing the open project's deployed app with someone. Personal projects only."),
  (
    "open-team-access",
    "Open the team workspace overview, where an owner grants access to the team's apps. Use this \
instead of `share-app` for a team app.",
  ),
  ("open-advisor", "Open the Advisor, which reviews the open project for problems."),
  ("open-code", "Show the open project's files."),
  ("run-doctor", "Re-check that the required tools are installed."),
  ("refresh-fabric-auth", "Refresh the Microsoft Fabric sign-in."),
  ("sign-in-copilot", "Sign in to GitHub Copilot again."),
  ("export-diagnostics", "Write a diagnostics file and reveal it in the file manager."),
  ("open-logs", "Open the logs folder."),
  ("report-issue", "Open a prefilled GitHub bug report."),
  ("open-settings", "Open Settings."),
  ("open-accounts", "Open the Accounts dialog."),
];

/// Actions that only make sense with a project open.
const NEEDS_PROJECT: &[&str] = &["share-app", "open-advisor", "open-code", "open-team-access"];

/// Actions that only apply to a personal project. A team app is published by
/// the team's pipeline and its access is granted workspace-wide by an owner, so
/// it has no Share control at all — offering one would be a dead button.
const PERSONAL_ONLY: &[&str] = &["share-app"];

/// Actions that only apply to a team app.
const TEAM_ONLY: &[&str] = &["open-team-access"];

fn action_ids() -> Vec<&'static str> {
  ACTIONS.iter().map(|(id, _)| *id).collect()
}

/// The catalogue, rendered for the prompt so the model knows what it can offer.
pub fn action_catalogue() -> String {
  ACTIONS.iter().map(|(id, what)| format!("- `{id}` — {what}")).collect::<Vec<_>>().join("\n")
}

pub type Emit = Arc<dyn Fn(HelpEvent) + Send + Sync>;

/// Collects what one turn produced, so the command can persist it with the
/// finished message.
#[derive(Default)]
pub struct TurnArtifacts {
  pub actions: Vec<HelpAction>,
  pub citations: Vec<HelpCitation>,
  pub issue: Option<HelpIssueDraft>,
}

pub type SharedArtifacts = Arc<Mutex<TurnArtifacts>>;

pub struct ToolContext {
  pub emit: Emit,
  pub artifacts: SharedArtifacts,
  /// Ids of the user's projects, so `open-project` can't be offered for one
  /// that doesn't exist.
  pub project_ids: Vec<String>,
  /// Whether a project is currently open, which gates the project-scoped actions.
  pub has_project: bool,
  /// Whether the open project is a team app, which has a different set of
  /// controls from a personal one.
  pub team_project: bool,
}

fn ok(text: impl Into<String>) -> ToolResult {
  ToolResult::Expanded(ToolResultExpanded::new(text.into(), "success"))
}

fn fail(text: impl Into<String>) -> ToolResult {
  let text = text.into();
  ToolResult::Expanded(ToolResultExpanded::new(text.clone(), "failure").with_error(text))
}

fn clip(text: &str, max: usize) -> String {
  let t = text.trim();
  if t.chars().count() <= max {
    return t.to_string();
  }
  let mut s: String = t.chars().take(max.saturating_sub(1)).collect();
  s.push('…');
  s
}

/* ----------------------------- offer an action ----------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionParams {
  id: String,
  label: String,
  #[serde(default)]
  url: Option<String>,
  #[serde(default)]
  target: Option<String>,
}

struct ActionTool(Arc<ToolContext>);

#[async_trait]
impl ToolHandler for ActionTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<ActionParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid action: {e}"))),
    };
    let id = params.id.trim().to_ascii_lowercase();
    if !action_ids().contains(&id.as_str()) {
      return Ok(fail(format!(
        "`{id}` is not an action this app can perform. Choose one of: {}.",
        action_ids().join(", ")
      )));
    }

    let ctx = &self.0;
    if NEEDS_PROJECT.contains(&id.as_str()) && !ctx.has_project {
      return Ok(fail(format!(
        "`{id}` needs a project to be open, and none is. Offer `open-project` or `open-home` first."
      )));
    }
    // A dead button is worse than no button: these controls genuinely don't
    // exist for the other kind of project.
    if ctx.team_project && PERSONAL_ONLY.contains(&id.as_str()) {
      return Ok(fail(format!(
        "`{id}` doesn't exist for a team app. Team apps are published by the team's pipeline, and \
an owner grants access under App access in the workspace overview — offer `open-team-access` and \
explain that only a workspace owner can grant it."
      )));
    }
    if !ctx.team_project && TEAM_ONLY.contains(&id.as_str()) {
      return Ok(fail(format!("`{id}` only applies to a team app, and this is a personal project.")));
    }

    // `open-docs` carries a URL, and only to Fabricator's own docs. The URL is
    // model-authored and ends up in the user's browser, so the host is parsed
    // rather than prefix-matched.
    let url = params.url.as_deref().map(str::trim).filter(|u| !u.is_empty());
    if id == "open-docs" {
      match url {
        Some(u) if super::fabricator_docs_url(u) => {}
        Some(_) => {
          return Ok(fail(
            "open-docs only opens pages on https://spatney.github.io/rayfin-fabricator.".to_string(),
          ))
        }
        None => return Ok(fail("open-docs needs the full https URL of the page.".to_string())),
      }
    }

    // `open-project` carries a project id, which must be one that exists.
    let target = params.target.as_deref().map(str::trim).filter(|t| !t.is_empty());
    if id == "open-project" {
      match target {
        Some(t) if ctx.project_ids.iter().any(|known| known == t) => {}
        Some(t) => {
          return Ok(fail(format!(
            "There is no project with id `{t}`. Use an id from the list you were given, or offer \
`open-home` instead."
          )))
        }
        None => {
          return Ok(fail(
            "open-project needs `target`, the id of the project to open.".to_string(),
          ))
        }
      }
    }

    let action = HelpAction {
      id: id.clone(),
      label: clip(&params.label, 60),
      url: if id == "open-docs" { url.map(str::to_string) } else { None },
      target: if id == "open-project" { target.map(str::to_string) } else { None },
    };
    {
      let mut held = ctx.artifacts.lock().unwrap();
      if held.actions.iter().any(|a| a.id == action.id && a.url == action.url && a.target == action.target) {
        return Ok(ok("Already offered."));
      }
      held.actions.push(action.clone());
    }
    (ctx.emit)(HelpEvent::Action { action });
    Ok(ok(format!("Offered \"{id}\" to the user as a button. Don't repeat the instruction in prose.")))
  }
}

/* ----------------------------- cite a page ----------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CiteParams {
  title: String,
  url: String,
}

struct CiteTool(Arc<ToolContext>);

#[async_trait]
impl ToolHandler for CiteTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<CiteParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid citation: {e}"))),
    };
    let url = params.url.trim();
    if !super::docs_url_allowed(url) {
      return Ok(fail(
        "Cite only the Fabricator documentation (https://spatney.github.io/rayfin-fabricator) or \
https://rayfin.ai."
          .to_string(),
      ));
    }
    let citation = HelpCitation { title: clip(&params.title, 80), url: url.to_string() };
    {
      let mut held = self.0.artifacts.lock().unwrap();
      if held.citations.iter().any(|c| c.url == citation.url) {
        return Ok(ok("Already cited."));
      }
      held.citations.push(citation.clone());
    }
    (self.0.emit)(HelpEvent::Citation { citation });
    Ok(ok("Citation shown under your answer."))
  }
}

/* ----------------------------- draft an issue ----------------------------- */

const MAX_ISSUE_TITLE: usize = 120;
const MAX_ISSUE_BODY: usize = 6000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueParams {
  title: String,
  body: String,
}

struct IssueTool(Arc<ToolContext>);

#[async_trait]
impl ToolHandler for IssueTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<IssueParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid issue draft: {e}"))),
    };
    let title = clip(&params.title, MAX_ISSUE_TITLE);
    let body = clip(&params.body, MAX_ISSUE_BODY);
    if title.is_empty() || body.is_empty() {
      return Ok(fail("An issue draft needs both a title and a body.".to_string()));
    }

    // The draft quotes the user's own logs, so mask anything secret-looking
    // before it can reach a public issue.
    let issue = HelpIssueDraft {
      title: crate::commands::advisor::mask_secrets(&title),
      body: crate::commands::advisor::mask_secrets(&body),
    };
    {
      let mut held = self.0.artifacts.lock().unwrap();
      if held.issue.is_some() {
        return Ok(ok("An issue is already drafted for this answer."));
      }
      held.issue = Some(issue.clone());
    }
    (self.0.emit)(HelpEvent::Issue { issue });
    Ok(ok(
      "Drafted the bug report. The user sees it with a button to review and submit it, so don't \
repeat the text in your answer — just say it's ready.",
    ))
  }
}

/// The assistant's reporting tools.
pub fn help_tools(ctx: Arc<ToolContext>) -> Vec<Tool> {
  let action = Tool::new(ACTION_TOOL)
    .with_description(
      "Offer the user a button that performs an action the app can do for them. Call this instead \
of telling them to go and click something, whenever the action is in the list. Call it once per \
action, after you have explained why it helps. Offer at most three per answer, most useful first.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "enum": action_ids(), "description": "Which action to offer." },
        "label": { "type": "string", "description": "Button text, imperative and under 6 words, e.g. \"Refresh Fabric sign-in\" or \"Open Contoso Expenses\"." },
        "url": { "type": "string", "description": "Required for open-docs: the full https URL of the documentation page." },
        "target": { "type": "string", "description": "Required for open-project: the id of the project to open." }
      },
      "required": ["id", "label"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(ActionTool(ctx.clone())));

  let cite = Tool::new(CITE_TOOL)
    .with_description(
      "Cite the documentation page your answer is based on, so the user can read more. Call it \
once per page, at most three times per answer.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "title": { "type": "string", "description": "The page's title." },
        "url": { "type": "string", "description": "The page's full https URL." }
      },
      "required": ["title", "url"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(CiteTool(ctx.clone())));

  let issue = Tool::new(ISSUE_TOOL)
    .with_description(
      "Write up the user's problem as a bug report they can submit. Call this when the problem \
looks like a fault in Fabricator rather than something they can fix, or when they ask you to \
report it. Fill in everything you learned from the logs so they don't have to remember it. The \
app adds the version and system details, so don't include those. Call it at most once per answer.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "title": {
          "type": "string",
          "description": "One line naming the symptom, e.g. \"Deploy fails with 'Tenant not authorized for cluster'\"."
        },
        "body": {
          "type": "string",
          "description":
            "Markdown with these sections: '### What happened' quoting the exact error and when it \
started; '### Steps to reproduce' as a numbered list; '### What I expected'; and '### What I've \
already tried' if anything was. Write it in the user's voice, as 'I'. Quote real values from the \
logs, but never include secrets or tokens."
        }
      },
      "required": ["title", "body"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(IssueTool(ctx)));

  vec![action, cite, issue]
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reporting_tools_are_recognised() {
    assert!(is_reporting_tool(ACTION_TOOL));
    assert!(is_reporting_tool(CITE_TOOL));
    assert!(!is_reporting_tool("read"));
  }

  #[test]
  fn the_catalogue_lists_every_action() {
    let text = action_catalogue();
    for (id, _) in ACTIONS {
      assert!(text.contains(id), "{id} is missing from the catalogue");
    }
  }

  #[test]
  fn action_ids_are_unique() {
    let mut ids = action_ids();
    let before = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), before);
  }

  #[test]
  fn every_project_scoped_action_exists() {
    for id in NEEDS_PROJECT {
      assert!(action_ids().contains(id), "{id} is gated but not offered");
    }
  }

  #[test]
  fn navigation_actions_are_offered() {
    // The two the user asked for by name: "find me app X" and "share my app".
    assert!(action_ids().contains(&"open-project"));
    assert!(action_ids().contains(&"share-app"));
  }

  #[test]
  fn the_two_project_kinds_do_not_share_their_controls() {
    // Share exists only for a personal project; a team app's access is granted
    // workspace-wide from the overview. Offering either to the wrong kind would
    // be a button that does nothing.
    for id in PERSONAL_ONLY {
      assert!(action_ids().contains(id), "{id} is gated but not offered");
      assert!(!TEAM_ONLY.contains(id), "{id} cannot be both");
    }
    for id in TEAM_ONLY {
      assert!(action_ids().contains(id), "{id} is gated but not offered");
      assert!(NEEDS_PROJECT.contains(id), "{id} needs a project to act on");
    }
  }

  #[test]
  fn clip_shortens_long_labels() {
    assert_eq!(clip("  Refresh  ", 60), "Refresh");
    assert!(clip(&"x".repeat(100), 10).ends_with('…'));
  }
}
