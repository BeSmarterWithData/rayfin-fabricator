//! The diagnosis session's tools. `fabricator_team_check` runs more read-only
//! checks from the catalog (limited to this context's targets, and to a budget),
//! and `fabricator_team_conclude` records Copilot's structured conclusion.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::Deserialize;
use serde_json::json;

use super::checks::{self, Args, Check, Emit, Runner};
use crate::types::{TeamDiagnosisConclusion, TeamDiagnosisEvent};

pub const CHECK_TOOL: &str = "fabricator_team_check";
pub const CONCLUDE_TOOL: &str = "fabricator_team_conclude";

/// Where the fix belongs (the renderer shows these).
const AREAS: &[&str] = &["github", "entra", "fabric", "pipeline", "app", "local", "unknown"];
const MAX_SUMMARY: usize = 200;

/// The conclusion, once Copilot reports it.
pub type SharedConclusion = Arc<Mutex<Option<TeamDiagnosisConclusion>>>;

fn ok(text: impl Into<String>) -> ToolResult {
  ToolResult::Expanded(ToolResultExpanded::new(text.into(), "success"))
}

fn fail(text: impl Into<String>) -> ToolResult {
  let text = text.into();
  ToolResult::Expanded(ToolResultExpanded::new(text.clone(), "failure").with_error(text))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckParams {
  check: String,
  #[serde(default)]
  client_id: Option<String>,
  #[serde(default)]
  workspace_id: Option<String>,
  #[serde(default)]
  run_id: Option<u64>,
}

struct CheckTool(Arc<Runner>);

#[async_trait]
impl ToolHandler for CheckTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<CheckParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid check request: {e}"))),
    };
    let Some(check) = Check::parse(&params.check) else {
      return Ok(fail(format!("Unknown check `{}`. Use one of: {}.", params.check, Check::names().join(", "))));
    };
    let args = Args { client_id: params.client_id, workspace_id: params.workspace_id, run_id: params.run_id };
    let requests = match checks::requests_for(&self.0.ctx, check, &args) {
      Ok(requests) => requests,
      Err(why) => return Ok(fail(why)),
    };
    if !self.0.take_request() {
      return Ok(fail("That's the most checks one diagnosis can run. Write your answer with the evidence you have."));
    }
    let outcomes = self.0.run_all(requests).await;
    Ok(ok(checks::render(&outcomes)))
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConcludeParams {
  #[serde(default)]
  summary: String,
  #[serde(default)]
  area: Option<String>,
  #[serde(default)]
  fix_in_chat: Option<bool>,
}

/// A conclusion the renderer can trust: a short summary, a known area, and a
/// chat hand-off only when there's an open app to hand it to.
fn normalize(params: ConcludeParams, can_fix_in_chat: bool) -> TeamDiagnosisConclusion {
  let summary = params.summary.split_whitespace().collect::<Vec<_>>().join(" ");
  let summary = if summary.chars().count() > MAX_SUMMARY {
    format!("{}…", summary.chars().take(MAX_SUMMARY - 1).collect::<String>().trim_end())
  } else {
    summary
  };
  let area = params
    .area
    .map(|a| a.trim().to_ascii_lowercase())
    .filter(|a| AREAS.contains(&a.as_str()))
    .unwrap_or_else(|| "unknown".into());
  let fix_in_chat = can_fix_in_chat && area == "app" && params.fix_in_chat.unwrap_or(false);
  TeamDiagnosisConclusion { summary, area, fix_in_chat }
}

struct ConcludeTool {
  conclusion: SharedConclusion,
  emit: Emit,
  can_fix_in_chat: bool,
}

#[async_trait]
impl ToolHandler for ConcludeTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<ConcludeParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid conclusion: {e}"))),
    };
    let conclusion = normalize(params, self.can_fix_in_chat);
    *self.conclusion.lock().unwrap() = Some(conclusion.clone());
    (self.emit)(TeamDiagnosisEvent::Conclusion { conclusion });
    Ok(ok("Recorded. Now write your answer for the user in the required format, with no more tool calls."))
  }
}

/// The two tools for one diagnosis.
pub fn diagnosis_tools(runner: Arc<Runner>, conclusion: SharedConclusion, emit: Emit) -> Vec<Tool> {
  let can_fix_in_chat = runner.ctx.project_id.is_some();
  let check = Tool::new(CHECK_TOOL)
    .with_description(
      "Run one more read-only check on GitHub, Microsoft Entra ID, Fabric or this computer, using the user's own \
       sign-ins. It can only look at this workspace's repository, identities, Fabric workspaces and runs. Use it \
       when the evidence you have doesn't settle the cause; don't repeat checks you already have.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "check": { "type": "string", "enum": Check::names() },
        "clientId": { "type": "string", "description": "For entra_app or entra_federated_credentials: one of this workspace's identity client IDs. Default: all of them." },
        "workspaceId": { "type": "string", "description": "For fabric_workspace: one of this workspace's Fabric workspace IDs. Default: all of them." },
        "runId": { "type": "integer", "minimum": 1, "description": "For github_run or github_run_log: a run of this repository's Fabricator workflow. Default: the run being diagnosed, or the latest failed one." }
      },
      "required": ["check"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(CheckTool(runner)));
  let conclude = Tool::new(CONCLUDE_TOOL)
    .with_description(
      "Record your conclusion once, right before you write the answer: the most likely cause in one plain \
       sentence, and where the fix belongs.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "summary": { "type": "string", "description": "The most likely cause in one plain sentence, under 25 words." },
        "area": {
          "type": "string",
          "enum": AREAS,
          "description": "Where the fix belongs: github (GitHub account, organization or repository settings), entra (Microsoft Entra ID), fabric (Fabric tenant settings, capacity or workspace), pipeline (the workflow or its runners), app (the app's own code or data model), local (this computer), unknown."
        },
        "fixInChat": { "type": "boolean", "description": "True only when area is app and Copilot can fix it by changing the app's code in its Build chat." }
      },
      "required": ["summary", "area"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(ConcludeTool { conclusion, emit, can_fix_in_chat }));
  vec![check, conclude]
}

#[cfg(test)]
mod tests {
  use super::*;

  fn params(summary: &str, area: Option<&str>, fix: Option<bool>) -> ConcludeParams {
    ConcludeParams { summary: summary.into(), area: area.map(String::from), fix_in_chat: fix }
  }

  #[test]
  fn conclusions_are_normalized() {
    let c = normalize(params("  The   deploy identity\nisn't trusted. ", Some(" Entra "), Some(true)), true);
    assert_eq!(c.summary, "The deploy identity isn't trusted.");
    assert_eq!(c.area, "entra");
    assert!(!c.fix_in_chat, "only app-code problems go to the chat");
    assert_eq!(normalize(params("x", Some("somewhere"), None), true).area, "unknown");
    assert!(normalize(params("x", Some("app"), Some(true)), true).fix_in_chat);
    assert!(!normalize(params("x", Some("app"), Some(true)), false).fix_in_chat, "no open app to hand it to");
    let long = normalize(params(&"word ".repeat(80), Some("app"), None), true);
    assert!(long.summary.ends_with('…') && long.summary.chars().count() <= MAX_SUMMARY);
  }
}
