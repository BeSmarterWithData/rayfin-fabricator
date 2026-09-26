//! Client-defined tools the deep review and Verify sessions report through.
//! Findings stream to the renderer the moment the model reports them, each one
//! validated first: the rule must be one the prompt listed, the file must exist
//! in the project, and the quoted excerpt must actually be in that file (one
//! retry is requested before an unmatched excerpt is accepted as unverified).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::Deserialize;
use serde_json::json;

use super::evidence;
use crate::types::{AdvisorEvent, AdvisorFinding, AdvisorLocation, AdvisorRuleResult, AdvisorVerdict};

pub const FINDING_TOOL: &str = "fabricator_advisor_finding";
pub const PROGRESS_TOOL: &str = "fabricator_advisor_progress";
pub const COMPLETE_TOOL: &str = "fabricator_advisor_complete";
pub const VERDICT_TOOL: &str = "fabricator_advisor_verdict";

const MAX_TITLE: usize = 160;
const MAX_TEXT: usize = 1500;
const MAX_SUMMARY: usize = 800;
const MAX_LOCATIONS: usize = 10;

/// True for the Advisor's own reporting tools (hidden from the activity feed).
pub fn is_reporting_tool(name: &str) -> bool {
  name.starts_with("fabricator_advisor_")
}

fn clip(text: &str, max: usize) -> String {
  let t = text.trim();
  if t.chars().count() <= max {
    t.to_string()
  } else {
    let mut s: String = t.chars().take(max.saturating_sub(1)).collect();
    s.push('…');
    s
  }
}

/// Shorten a summary to `max` characters, ending on a full sentence when one
/// fits in the second half, otherwise on a word boundary with `…`.
fn clip_summary(text: &str, max: usize) -> String {
  let t = text.trim();
  if t.chars().count() <= max {
    return t.to_string();
  }
  let mut sentence_end = None;
  let mut chars = t.char_indices().enumerate().peekable();
  while let Some((n, (i, c))) = chars.next() {
    if n >= max {
      break;
    }
    let then_space = chars.peek().map_or(true, |(_, (_, next))| next.is_whitespace());
    if matches!(c, '.' | '!' | '?') && then_space && n + 1 >= max / 2 {
      sentence_end = Some(i + c.len_utf8());
    }
  }
  if let Some(end) = sentence_end {
    return t[..end].to_string();
  }
  let cut: String = t.chars().take(max.saturating_sub(1)).collect();
  let words = cut.rfind(char::is_whitespace).map_or(cut.as_str(), |i| cut[..i].trim_end());
  format!("{words}…")
}

fn normalize_severity(value: Option<&str>, default: &str) -> String {
  match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
    Some("high") | Some("critical") => "high".into(),
    Some("medium") | Some("med") => "medium".into(),
    Some("low") => "low".into(),
    Some("note") | Some("info") => "note".into(),
    _ => default.to_string(),
  }
}

fn ok(text: impl Into<String>) -> ToolResult {
  ToolResult::Expanded(ToolResultExpanded::new(text.into(), "success"))
}

fn fail(text: impl Into<String>) -> ToolResult {
  let text = text.into();
  ToolResult::Expanded(ToolResultExpanded::new(text.clone(), "failure").with_error(text))
}

/// A deep-review rule the prompt listed: its category and default severity.
#[derive(Clone)]
pub struct RuleMeta {
  pub category: String,
  pub severity: String,
}

/// Everything the deep review reported so far.
#[derive(Default)]
pub struct ReviewLog {
  pub findings: Vec<AdvisorFinding>,
  pub rules: BTreeMap<String, AdvisorRuleResult>,
  pub summary: Option<String>,
  pub completed: bool,
  /// Unmatched excerpt attempts per (rule, file, title).
  excerpt_misses: HashMap<String, u32>,
}

impl ReviewLog {
  /// True once the model reported anything at all through the tools.
  pub fn has_reports(&self) -> bool {
    !self.findings.is_empty() || !self.rules.is_empty() || self.summary.is_some()
  }
}

pub type SharedLog = Arc<Mutex<ReviewLog>>;

/// The validation state behind the reporting tools (no app handle, so it can
/// be unit-tested).
pub struct ReviewCore {
  pub root: PathBuf,
  pub log: SharedLog,
  pub rules: HashMap<String, RuleMeta>,
}

/// Delivers an event to the renderer (a closure, so the tools don't need a Tauri handle).
pub type Emit = Arc<dyn Fn(AdvisorEvent) + Send + Sync>;

pub struct ReviewContext {
  pub emit: Emit,
  pub core: ReviewCore,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocationParam {
  file: String,
  #[serde(default)]
  line: Option<u32>,
  #[serde(default)]
  label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FindingParams {
  rule_id: String,
  #[serde(default)]
  severity: Option<String>,
  title: String,
  detail: String,
  recommendation: String,
  #[serde(default)]
  file: Option<String>,
  #[serde(default)]
  start_line: Option<u32>,
  #[serde(default)]
  end_line: Option<u32>,
  #[serde(default)]
  excerpt: Option<String>,
  #[serde(default)]
  confidence: Option<String>,
  #[serde(default)]
  docs_url: Option<String>,
  #[serde(default)]
  other_locations: Vec<LocationParam>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleResultParam {
  rule_id: String,
  status: String,
  #[serde(default)]
  note: Option<String>,
}

#[derive(Deserialize)]
struct ProgressParams {
  #[serde(default)]
  results: Vec<RuleResultParam>,
}

#[derive(Deserialize)]
struct CompleteParams {
  #[serde(default)]
  summary: String,
  #[serde(default)]
  results: Vec<RuleResultParam>,
}

/// Validate one reported finding and record it. `Err` carries the message sent
/// back to the model so it can correct the report.
pub(crate) fn record_finding(ctx: &ReviewCore, p: FindingParams) -> Result<(AdvisorFinding, Recorded), String> {
  let rule_id = p.rule_id.trim().to_string();
  let Some(meta) = ctx.rules.get(&rule_id) else {
    return Err(format!("Unknown ruleId `{rule_id}`. Use one of the rule ids listed in your instructions."));
  };
  let title = clip(&p.title, MAX_TITLE);
  let detail = clip(&p.detail, MAX_TEXT);
  let recommendation = clip(&p.recommendation, MAX_TEXT);
  if title.is_empty() || detail.is_empty() || recommendation.is_empty() {
    return Err("title, detail and recommendation are all required.".into());
  }
  let severity = normalize_severity(p.severity.as_deref(), &meta.severity);

  let mut file = None;
  let mut line = None;
  let mut end_line = None;
  let mut excerpt = None;
  let mut excerpt_start = None;
  let mut verified = false;

  if let Some(raw) = p.file.as_deref().filter(|f| !f.trim().is_empty()) {
    let Some(rel) = evidence::normalize_rel(raw, &ctx.root) else {
      return Err(format!(
        "`{raw}` isn't a file in this project. Report a project-relative path to an existing file, such as src/App.tsx."
      ));
    };
    if let Some(content) = evidence::read_text(&ctx.root, &rel) {
      let quoted = p.excerpt.as_deref().map(str::trim).filter(|e| !e.is_empty());
      let located = quoted.and_then(|q| evidence::locate(&content, q, p.start_line));
      let range = if let Some((s, e)) = located {
        verified = true;
        Some((s, e))
      } else if quoted.is_some() {
        let key = format!("{rule_id}\u{0}{rel}\u{0}{title}");
        let misses = {
          let mut log = ctx.log.lock().unwrap();
          let n = log.excerpt_misses.entry(key).or_insert(0);
          *n += 1;
          *n
        };
        if misses == 1 {
          return Err(format!(
            "That excerpt wasn't found in {rel}. Re-read the file and copy the exact lines (without line numbers), then report the finding again."
          ));
        }
        p.start_line.map(|s| (s, p.end_line.unwrap_or(s).max(s)))
      } else {
        p.start_line.map(|s| (s, p.end_line.unwrap_or(s).max(s)))
      };
      if let Some((s, e)) = range {
        let total = content.lines().count().max(1) as u32;
        let s = s.clamp(1, total);
        let e = e.clamp(s, total);
        let (text, first) = evidence::window(&content, s, e);
        line = Some(s);
        end_line = (e != s).then_some(e);
        excerpt = Some(evidence::mask_secrets(&text));
        excerpt_start = Some(first);
      }
    }
    file = Some(rel);
  }

  let docs_url = p
    .docs_url
    .map(|u| u.trim().to_string())
    .filter(|u| u.starts_with("https://") && !u.contains(char::is_whitespace));
  let locations: Vec<AdvisorLocation> = p
    .other_locations
    .into_iter()
    .filter_map(|l| {
      let rel = evidence::normalize_rel(&l.file, &ctx.root)?;
      Some(AdvisorLocation {
        file: rel,
        line: l.line,
        end_line: None,
        label: l.label.map(|s| clip(&s, 80)).filter(|s| !s.is_empty()),
      })
    })
    .take(MAX_LOCATIONS)
    .collect();
  let confidence = p
    .confidence
    .map(|c| c.trim().to_ascii_lowercase())
    .filter(|c| matches!(c.as_str(), "high" | "medium" | "low"));

  let id = evidence::rule_finding_id(&rule_id);
  let finding = AdvisorFinding {
    id: id.clone(),
    rule_id: rule_id.clone(),
    category: meta.category.clone(),
    severity,
    source: "ai".into(),
    title,
    detail,
    recommendation,
    file,
    line,
    end_line,
    excerpt,
    excerpt_start,
    verified: Some(verified),
    confidence,
    docs_url,
    locations,
  };

  let mut log = ctx.log.lock().unwrap();
  if let Some(existing) = log.findings.iter_mut().find(|f| f.id == id) {
    let changed = merge_finding(existing, finding);
    let current = existing.clone();
    return Ok((current, if changed { Recorded::Merged } else { Recorded::Duplicate }));
  }
  log.findings.push(finding.clone());
  log.rules.insert(rule_id.clone(), AdvisorRuleResult { rule_id, status: "fail".into(), note: None });
  Ok((finding, Recorded::New))
}

/// What happened to a reported finding.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Recorded {
  /// The first report for its rule.
  New,
  /// Another report for a rule that already has a finding; its places were
  /// added to that finding.
  Merged,
  /// Nothing new.
  Duplicate,
}

fn severity_rank(severity: &str) -> u8 {
  match severity {
    "high" => 0,
    "medium" => 1,
    "low" => 2,
    _ => 3,
  }
}

/// Fold another finding for the same rule into `existing`: its places become
/// extra locations and the higher severity wins. Returns whether it changed.
pub(crate) fn merge_finding(existing: &mut AdvisorFinding, other: AdvisorFinding) -> bool {
  let mut changed = false;
  if severity_rank(&other.severity) < severity_rank(&existing.severity) {
    existing.severity = other.severity;
    changed = true;
  }
  let primary = other.file.map(|file| AdvisorLocation { file, line: other.line, end_line: other.end_line, label: None });
  for loc in primary.into_iter().chain(other.locations) {
    let is_primary = existing.file.as_deref() == Some(loc.file.as_str()) && (loc.line.is_none() || loc.line == existing.line);
    let known = existing.locations.iter().any(|l| l.file == loc.file && l.line == loc.line);
    if is_primary || known || existing.locations.len() >= MAX_LOCATIONS {
      continue;
    }
    existing.locations.push(loc);
    changed = true;
  }
  changed
}

/// Record rule outcomes; a rule that already has a finding stays `fail`.
fn record_results(ctx: &ReviewCore, results: Vec<RuleResultParam>) -> (Vec<AdvisorRuleResult>, Vec<String>) {
  let mut accepted = Vec::new();
  let mut rejected = Vec::new();
  let mut log = ctx.log.lock().unwrap();
  for r in results {
    let rule_id = r.rule_id.trim().to_string();
    let status = r.status.trim().to_ascii_lowercase();
    if !ctx.rules.contains_key(&rule_id) || !matches!(status.as_str(), "pass" | "fail" | "na" | "skipped") {
      rejected.push(rule_id);
      continue;
    }
    let has_finding = log.findings.iter().any(|f| f.rule_id == rule_id);
    let status = if has_finding { "fail".to_string() } else { status };
    let result = AdvisorRuleResult {
      rule_id: rule_id.clone(),
      status,
      note: r.note.map(|n| clip(&n, 240)).filter(|n| !n.is_empty()),
    };
    log.rules.insert(rule_id, result.clone());
    accepted.push(result);
  }
  (accepted, rejected)
}

struct FindingTool(Arc<ReviewContext>);
struct ProgressTool(Arc<ReviewContext>);
struct CompleteTool(Arc<ReviewContext>);

#[async_trait]
impl ToolHandler for FindingTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<FindingParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid finding: {e}"))),
    };
    let ctx = self.0.clone();
    match record_finding(&ctx.core, params) {
      Ok((finding, Recorded::New)) => {
        let where_ = match (&finding.file, finding.line) {
          (Some(f), Some(l)) => format!(" at {f}:{l}"),
          (Some(f), None) => format!(" in {f}"),
          _ => String::new(),
        };
        let reply = format!("Recorded {} ({}){where_}. Continue the review.", finding.id, finding.rule_id);
        (ctx.emit)(AdvisorEvent::Finding { finding });
        Ok(ok(reply))
      }
      Ok((finding, Recorded::Merged)) => {
        let reply = format!(
          "Added these places to the existing {} finding ({}). Report each rule once, with every place in otherLocations. Continue the review.",
          finding.rule_id, finding.id
        );
        (ctx.emit)(AdvisorEvent::Finding { finding });
        Ok(ok(reply))
      }
      Ok((finding, Recorded::Duplicate)) => {
        Ok(ok(format!("Already recorded as {}; no need to report it again.", finding.id)))
      }
      Err(message) => Ok(fail(message)),
    }
  }
}

#[async_trait]
impl ToolHandler for ProgressTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<ProgressParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid progress report: {e}"))),
    };
    let (accepted, rejected) = record_results(&self.0.core, params.results);
    let count = accepted.len();
    if !accepted.is_empty() {
      (self.0.emit)(AdvisorEvent::RuleStatus { results: accepted });
    }
    if rejected.is_empty() {
      Ok(ok(format!("Recorded {count} rule results.")))
    } else {
      Ok(ok(format!(
        "Recorded {count} rule results. Ignored unknown rule ids or statuses: {}.",
        rejected.join(", ")
      )))
    }
  }
}

#[async_trait]
impl ToolHandler for CompleteTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<CompleteParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid completion report: {e}"))),
    };
    let (accepted, _) = record_results(&self.0.core, params.results);
    if !accepted.is_empty() {
      (self.0.emit)(AdvisorEvent::RuleStatus { results: accepted });
    }
    let summary = clip_summary(&params.summary, MAX_SUMMARY);
    {
      let mut log = self.0.core.log.lock().unwrap();
      log.completed = true;
      if !summary.is_empty() {
        log.summary = Some(summary.clone());
      }
    }
    if !summary.is_empty() {
      (self.0.emit)(AdvisorEvent::Summary { text: summary });
    }
    Ok(ok("Review recorded. Reply with one short sentence and stop."))
  }
}

fn result_items(rule_ids: &[String]) -> serde_json::Value {
  json!({
    "type": "array",
    "items": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ruleId": { "type": "string", "enum": rule_ids },
        "status": { "type": "string", "enum": ["pass", "fail", "na", "skipped"] },
        "note": { "type": "string", "description": "Short reason, required for na and skipped." }
      },
      "required": ["ruleId", "status"]
    }
  })
}

/// The three reporting tools for one deep-review run.
pub fn review_tools(ctx: Arc<ReviewContext>) -> Vec<Tool> {
  let mut rule_ids: Vec<String> = ctx.core.rules.keys().cloned().collect();
  rule_ids.sort();
  let finding = Tool::new(FINDING_TOOL)
    .with_description(
      "Report ONE verified Advisor finding as soon as you have confirmed it. The host checks the \
       excerpt against the file, so copy the exact lines. Group repeated instances of the same rule \
       into one finding and list the extra places in otherLocations.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ruleId": { "type": "string", "enum": rule_ids },
        "severity": { "type": "string", "enum": ["high", "medium", "low", "note"] },
        "title": { "type": "string", "description": "Short headline (at most 12 words)." },
        "detail": { "type": "string", "description": "What is wrong in THIS app and why it matters, 1-3 sentences." },
        "recommendation": { "type": "string", "description": "A concrete fix using documented Rayfin APIs." },
        "file": { "type": "string", "description": "Project-relative path of the evidence, e.g. rayfin/data/Todo.ts." },
        "startLine": { "type": "integer", "minimum": 1 },
        "endLine": { "type": "integer", "minimum": 1 },
        "excerpt": { "type": "string", "description": "1-12 lines copied exactly from the file (no line numbers). Mask secret values." },
        "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
        "docsUrl": { "type": "string", "description": "Optional https URL of the documentation page this finding relies on." },
        "otherLocations": {
          "type": "array",
          "maxItems": MAX_LOCATIONS,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "file": { "type": "string" },
              "line": { "type": "integer", "minimum": 1 },
              "label": { "type": "string" }
            },
            "required": ["file"]
          }
        }
      },
      "required": ["ruleId", "title", "detail", "recommendation"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(FindingTool(ctx.clone())));
  let progress = Tool::new(PROGRESS_TOOL)
    .with_description(
      "After finishing a category, report the outcome of EVERY rule in it: fail (you reported a \
       finding), pass (the app follows the rule), na (the rule doesn't apply), or skipped (you \
       couldn't check it).",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": { "results": result_items(&rule_ids) },
      "required": ["results"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(ProgressTool(ctx.clone())));
  let complete = Tool::new(COMPLETE_TOOL)
    .with_description(
      "Finish the review: a plain-language summary of the app's overall state in one or two short sentences \
       (under 50 words), plus the outcome of any rules you haven't reported yet.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "summary": { "type": "string" },
        "results": result_items(&rule_ids)
      },
      "required": ["summary"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(CompleteTool(ctx)));
  vec![finding, progress, complete]
}

/* ----------------------------- verify ----------------------------- */

pub type SharedVerdicts = Arc<Mutex<Vec<AdvisorVerdict>>>;

pub struct VerifyContext {
  pub emit: Emit,
  pub verify_id: String,
  pub finding_ids: HashSet<String>,
  pub verdicts: SharedVerdicts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerdictParams {
  finding_id: String,
  status: String,
  #[serde(default)]
  note: Option<String>,
}

struct VerdictTool(Arc<VerifyContext>);

#[async_trait]
impl ToolHandler for VerdictTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let p = match invocation.params::<VerdictParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid verdict: {e}"))),
    };
    let ctx = &self.0;
    let finding_id = p.finding_id.trim().to_string();
    let status = p.status.trim().to_ascii_lowercase();
    if !ctx.finding_ids.contains(&finding_id) {
      return Ok(fail(format!("Unknown findingId `{finding_id}`. Use one of the ids listed in your instructions.")));
    }
    if !matches!(status.as_str(), "fixed" | "present" | "unclear") {
      return Ok(fail("status must be fixed, present, or unclear."));
    }
    let verdict = AdvisorVerdict {
      finding_id: finding_id.clone(),
      status,
      note: p.note.map(|n| clip(&n, 400)).filter(|n| !n.is_empty()),
    };
    {
      let mut all = ctx.verdicts.lock().unwrap();
      all.retain(|v| v.finding_id != finding_id);
      all.push(verdict.clone());
    }
    (ctx.emit)(AdvisorEvent::Verdict { verify_id: ctx.verify_id.clone(), verdict });
    Ok(ok("Recorded."))
  }
}

pub fn verify_tools(ctx: Arc<VerifyContext>) -> Vec<Tool> {
  let mut ids: Vec<String> = ctx.finding_ids.iter().cloned().collect();
  ids.sort();
  vec![Tool::new(VERDICT_TOOL)
    .with_description("Report whether ONE previously reported finding is fixed, still present, or unclear.")
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "findingId": { "type": "string", "enum": ids },
        "status": { "type": "string", "enum": ["fixed", "present", "unclear"] },
        "note": { "type": "string", "description": "One sentence explaining the verdict." }
      },
      "required": ["findingId", "status", "note"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(VerdictTool(ctx)))]
}

#[cfg(test)]
mod tests {
  use super::*;

  fn core(dir: &std::path::Path) -> ReviewCore {
    let mut rules = HashMap::new();
    rules.insert(
      "queries/unpaginated-list".to_string(),
      RuleMeta { category: "queries".into(), severity: "high".into() },
    );
    rules.insert(
      "policy/overbroad-grant".to_string(),
      RuleMeta { category: "policy".into(), severity: "medium".into() },
    );
    ReviewCore { root: dir.to_path_buf(), log: SharedLog::default(), rules }
  }

  fn project() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("advisor-tools-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("src/services")).unwrap();
    std::fs::write(
      dir.join("src/services/todos.ts"),
      "import { client } from './rayfinClient';\n\nexport async function listTodos() {\n  return client.data.Todo.select(['id', 'title']).execute();\n}\n",
    )
    .unwrap();
    dir
  }

  fn params(json: serde_json::Value) -> FindingParams {
    serde_json::from_value(json).unwrap()
  }

  #[test]
  fn verified_findings_get_real_lines_and_a_per_rule_id() {
    let dir = project();
    let ctx = core(&dir);
    let (finding, recorded) = record_finding(
      &ctx,
      params(json!({
        "ruleId": "queries/unpaginated-list",
        "title": "Todo list stops at 100 rows",
        "detail": "listTodos uses execute().",
        "recommendation": "Paginate with executePaginated().",
        "file": "./src/services/todos.ts",
        "excerpt": "return client.data.Todo.select(['id', 'title']).execute();"
      })),
    )
    .unwrap();
    assert_eq!(recorded, Recorded::New);
    assert_eq!(finding.id, "ai:queries/unpaginated-list");
    assert_eq!(finding.file.as_deref(), Some("src/services/todos.ts"));
    assert_eq!(finding.line, Some(4));
    assert_eq!(finding.verified, Some(true));
    assert_eq!(finding.severity, "high");
    assert_eq!(finding.category, "queries");
    assert_eq!(finding.excerpt_start, Some(2));
    assert!(finding.excerpt.as_deref().unwrap().contains(".execute()"));

    // Re-reporting the same issue is deduplicated.
    let (again, recorded) = record_finding(
      &ctx,
      params(json!({
        "ruleId": "queries/unpaginated-list",
        "title": "Different wording",
        "detail": "d",
        "recommendation": "r",
        "file": "src/services/todos.ts",
        "excerpt": "return client.data.Todo.select(['id', 'title']).execute();"
      })),
    )
    .unwrap();
    assert_eq!(recorded, Recorded::Duplicate);
    assert_eq!(again.id, finding.id);
    let log = ctx.log.lock().unwrap();
    assert_eq!(log.findings.len(), 1);
    assert_eq!(log.rules["queries/unpaginated-list"].status, "fail");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_second_report_for_a_rule_adds_its_places_to_the_first() {
    let dir = project();
    std::fs::write(dir.join("src/services/notes.ts"), "export const list = () => client.data.Note.execute();\n").unwrap();
    let ctx = core(&dir);
    let report = |file: &str, excerpt: &str, severity: &str| {
      params(json!({
        "ruleId": "queries/unpaginated-list",
        "severity": severity,
        "title": "List stops at 100 rows",
        "detail": "d",
        "recommendation": "r",
        "file": file,
        "excerpt": excerpt,
        "otherLocations": [{ "file": "src/services/todos.ts", "line": 4 }]
      }))
    };
    let (first, _) = record_finding(&ctx, report("src/services/notes.ts", "client.data.Note.execute()", "medium")).unwrap();
    let (merged, recorded) =
      record_finding(&ctx, report("src/services/todos.ts", "client.data.Todo.select(['id', 'title']).execute();", "high"))
        .unwrap();
    assert_eq!(recorded, Recorded::Merged);
    assert_eq!(merged.id, first.id);
    assert_eq!(merged.file.as_deref(), Some("src/services/notes.ts"));
    assert_eq!(merged.severity, "high");
    assert_eq!(merged.locations.len(), 1, "the todos.ts place is listed once");
    assert_eq!(merged.locations[0].file, "src/services/todos.ts");
    assert_eq!(ctx.log.lock().unwrap().findings.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn bad_reports_are_rejected_with_actionable_messages() {
    let dir = project();
    let ctx = core(&dir);
    let unknown = record_finding(
      &ctx,
      params(json!({ "ruleId": "made/up", "title": "t", "detail": "d", "recommendation": "r" })),
    );
    assert!(unknown.unwrap_err().contains("Unknown ruleId"));
    let missing = record_finding(
      &ctx,
      params(json!({ "ruleId": "policy/overbroad-grant", "title": "t", "detail": "d", "recommendation": "r", "file": "src/nope.ts" })),
    );
    assert!(missing.unwrap_err().contains("isn't a file"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn an_unmatched_excerpt_gets_one_retry_then_is_accepted_unverified() {
    let dir = project();
    let ctx = core(&dir);
    let report = || {
      params(json!({
        "ruleId": "queries/unpaginated-list",
        "title": "List stops at 100 rows",
        "detail": "d",
        "recommendation": "r",
        "file": "src/services/todos.ts",
        "startLine": 4,
        "excerpt": "client.data.Todo.findMany()"
      }))
    };
    assert!(record_finding(&ctx, report()).unwrap_err().contains("wasn't found"));
    let (finding, recorded) = record_finding(&ctx, report()).unwrap();
    assert_eq!(recorded, Recorded::New);
    assert_eq!(finding.verified, Some(false));
    assert_eq!(finding.line, Some(4));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn rule_results_are_validated_and_findings_keep_rules_failing() {
    let dir = project();
    let ctx = core(&dir);
    record_finding(
      &ctx,
      params(json!({
        "ruleId": "queries/unpaginated-list",
        "title": "t",
        "detail": "d",
        "recommendation": "r"
      })),
    )
    .unwrap();
    let (accepted, rejected) = record_results(
      &ctx,
      vec![
        RuleResultParam { rule_id: "queries/unpaginated-list".into(), status: "pass".into(), note: None },
        RuleResultParam { rule_id: "policy/overbroad-grant".into(), status: "NA".into(), note: Some("No entities".into()) },
        RuleResultParam { rule_id: "made/up".into(), status: "pass".into(), note: None },
        RuleResultParam { rule_id: "policy/overbroad-grant".into(), status: "maybe".into(), note: None },
      ],
    );
    assert_eq!(rejected, vec!["made/up".to_string(), "policy/overbroad-grant".to_string()]);
    assert_eq!(accepted.len(), 2);
    assert_eq!(accepted[0].status, "fail");
    assert_eq!(accepted[1].status, "na");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn summaries_end_on_a_sentence_or_a_word() {
    assert_eq!(clip_summary("  Looks good.  ", 800), "Looks good.");
    let first = format!("{}.", "a".repeat(40));
    let long = format!("{first} Then a second sentence that runs well past the limit.");
    assert_eq!(clip_summary(&long, 60), first);
    assert_eq!(clip_summary("Tiny. Then one very long second sentence without an end", 40), "Tiny. Then one very long second…");
    assert_eq!(clip_summary("one two three four five six", 12), "one two…");
    assert_eq!(clip_summary("v1.35.1 is installed and it is the latest release", 30), "v1.35.1 is installed and it…");
  }
}
