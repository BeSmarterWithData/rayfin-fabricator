//! Model-backed and source-aware helpers for Design mode ("visual chat").
//!
//! * [`design_variations`] asks a fast model for a few named alternative looks
//!   for one element — whitelisted inline-CSS patches (or Graphein spec patches
//!   for charts) that the in-page controller previews live.
//! * [`design_polish`] reviews a compact outline of the page (plus a screenshot)
//!   and proposes a handful of concrete, previewable improvements.
//! * [`design_locate`] finds the likely source lines behind picked elements.
//!
//! The model calls run on **transient, read-only** Copilot sessions: they never
//! land in the project's chat history, can't write files or run commands, and
//! must answer with JSON only. Nothing here edits the project — Copilot applies
//! the chosen changes later, in one ordinary chat turn.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::{Attachment, MessageOptions};
use serde_json::Value;
use tauri::State;

use crate::commands::screenshot;
use crate::services::design_locate::{self, LocateResult, LocateTarget};
use crate::services::store;
use crate::state::AppState;

/// Ceiling for a single model run (the UI shows a busy state and recovers on
/// timeout).
const RUN_TIMEOUT_MS: u64 = 60_000;
/// Variations offered per request (and the most a caller may ask for).
const DEFAULT_VARIATIONS: usize = 3;
const MAX_VARIATIONS: usize = 4;
/// Polish suggestions returned at most.
const MAX_SUGGESTIONS: usize = 6;
/// Outline elements and findings a Polish prompt includes at most.
const MAX_OUTLINE_ELEMENTS: usize = 80;
const MAX_FINDINGS: usize = 24;

/// CSS properties a model-proposed preview may set on a live element.
/// Deliberately a safe, layout/typography/appearance-only subset — anything else
/// is dropped, and the in-page controller re-checks the same list.
const ALLOWED_RESTYLE_PROPS: &[&str] = &[
    "color",
    "background",
    "background-color",
    "background-image",
    "border",
    "border-color",
    "border-width",
    "border-style",
    "border-radius",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-transform",
    "text-decoration",
    "opacity",
    "box-shadow",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "display",
    "gap",
    "align-items",
    "justify-content",
    "flex-direction",
];

/// Compact element context the renderer sends with a variations request:
/// enough for the model to make a good local proposal without the whole DOM.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestyleContext {
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub classes: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
    /// Current (relevant) computed styles, keyed by CSS property.
    #[serde(default)]
    pub styles: HashMap<String, String>,
    #[serde(default)]
    pub is_chart: bool,
    #[serde(default)]
    pub chart_type: Option<String>,
    /// Current Graphein spec (data omitted by the renderer) for charts.
    #[serde(default)]
    pub spec: Option<Value>,
    /// Compact summary of notable descendants ({tag, classes, text}) so the model
    /// can target children via `rules`.
    #[serde(default)]
    pub children: Option<Value>,
}

/// Whitelisted CSS for the element, descendant rules, and an optional Graphein
/// spec patch (charts).
#[derive(Default, PartialEq, Debug)]
struct RestylePatch {
    styles: HashMap<String, String>,
    graphein: Option<Value>,
    rules: Vec<RestyleRule>,
}

impl RestylePatch {
    fn is_empty(&self) -> bool {
        self.styles.is_empty() && self.graphein.is_none() && self.rules.is_empty()
    }
}

/// A restyle rule targeting descendants of the element.
#[derive(serde::Serialize, Default, PartialEq, Debug, Clone)]
pub struct RestyleRule {
    pub selector: String,
    pub styles: HashMap<String, String>,
}

/// One proposed alternative look (see `DesignVariation` in `src/shared/design.ts`).
#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Variation {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub styles: HashMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RestyleRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graphein: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classes: Option<String>,
}

/// One proposed page improvement (see `DesignSuggestion` in `src/shared/design.ts`).
#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: String,
    pub why: String,
    pub instruction: String,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub styles: HashMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RestyleRule>,
}

/// The page outline the renderer collects for a Polish pass.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageOutline {
    pub route: String,
    pub title: String,
    pub viewport: Value,
    pub elements: Vec<OutlineElement>,
    pub findings: Vec<Finding>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OutlineElement {
    #[serde(rename = "ref")]
    pub reference: String,
    pub label: String,
    pub role: String,
    pub tag: String,
    pub text: Option<String>,
    pub classes: Option<String>,
    pub styles: HashMap<String, String>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Finding {
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub kind: String,
    pub message: String,
}

/* ----------------------------- model plumbing ----------------------------- */

/// Streaming accumulator for one transient run.
#[derive(Default)]
struct GenState {
    assistant: String,
    streamed: HashMap<String, usize>,
}

/// Feed one Copilot server event in. Returns `true` at a terminal state.
fn map_event(event_type: &str, data: &Value, st: &mut GenState) -> bool {
    match event_type {
        "assistant.message_delta" => {
            let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let text = data.get("deltaContent").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return false;
            }
            st.assistant.push_str(text);
            *st.streamed.entry(id).or_insert(0) += text.chars().count();
        }
        "assistant.message" => {
            let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let total = content.chars().count();
            let have = *st.streamed.get(&id).unwrap_or(&0);
            if total > have {
                let rest: String = content.chars().skip(have).collect();
                st.assistant.push_str(&rest);
                st.streamed.insert(id, total);
            }
        }
        "session.error" | "session.idle" => return true,
        _ => {}
    }
    false
}

/// Run `prompt` once on a transient, read-only session rooted at `cwd` and
/// return the assistant's full reply. Never touches the project's chat.
async fn run_transient(
    state: &AppState,
    cwd: &str,
    model: Option<String>,
    prompt: String,
    attachments: &[PathBuf],
) -> Result<String, String> {
    let session = state
        .copilot
        .transient_session_with(cwd, model, None, crate::commands::advisor::read_only_options(cwd))
        .await
        .map_err(|_| "Couldn't reach the model.".to_string())?;

    let mut st = GenState::default();
    let mut sub = session.subscribe();
    let mut opts = MessageOptions::new(prompt);
    if !attachments.is_empty() {
        opts = opts.with_attachments(
            attachments
                .iter()
                .map(|p| Attachment::File { path: p.clone(), display_name: None, line_range: None })
                .collect(),
        );
    }
    let sent = session.send(opts).await.is_ok();
    if sent {
        let drain = async {
            loop {
                match sub.recv().await {
                    Ok(ev) => {
                        if map_event(&ev.event_type, &ev.data, &mut st) {
                            break;
                        }
                    }
                    Err(err) => match err.kind() {
                        RecvErrorKind::Lagged(_) => {}
                        _ => break,
                    },
                }
            }
        };
        if tokio::time::timeout(Duration::from_millis(RUN_TIMEOUT_MS), drain).await.is_err() {
            let _ = session.abort().await;
        }
    }
    let _ = session.disconnect().await;
    if !sent {
        return Err("Couldn't send the request to the model.".into());
    }
    Ok(st.assistant)
}

/* ----------------------------- JSON extraction ----------------------------- */

/// Parse the model's JSON answer: the last fenced block that parses, else the
/// widest `[…]` or `{…}` span.
fn extract_json(text: &str) -> Option<Value> {
    let parts: Vec<&str> = text.split("```").collect();
    let mut blocks: Vec<String> = Vec::new();
    let mut i = 1;
    while i < parts.len() {
        let mut block = parts[i];
        if let Some(nl) = block.find('\n') {
            let first = block[..nl].trim();
            if !first.contains(['{', '[']) && first.len() <= 12 {
                block = &block[nl + 1..];
            }
        }
        blocks.push(block.trim().to_string());
        i += 2;
    }
    for block in blocks.into_iter().rev() {
        if block.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&block) {
            return Some(v);
        }
    }
    for (open, close) in [('[', ']'), ('{', '}')] {
        if let (Some(start), Some(end)) = (text.find(open), text.rfind(close)) {
            if end > start {
                if let Ok(v) = serde_json::from_str::<Value>(&text[start..=end]) {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// The list of entries in a model answer: a bare array, or the first array
/// under one of `keys` in an object.
fn entries(val: Value, keys: &[&str]) -> Vec<Value> {
    match val {
        Value::Array(items) => items,
        Value::Object(mut map) => keys
            .iter()
            .find_map(|k| match map.remove(*k) {
                Some(Value::Array(items)) => Some(items),
                _ => None,
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// Collect whitelisted CSS property→value pairs from a JSON object, dropping any
/// property not in [`ALLOWED_RESTYLE_PROPS`] and any value carrying an external
/// resource / script vector (defense-in-depth; the controller also sanitizes).
fn collect_styles(map: &serde_json::Map<String, Value>, out: &mut HashMap<String, String>) {
    for (k, v) in map {
        let key = k.trim().to_lowercase();
        if !ALLOWED_RESTYLE_PROPS.contains(&key.as_str()) {
            continue;
        }
        let val = match v {
            Value::String(s) => s.trim().to_string(),
            Value::Number(n) => n.to_string(),
            _ => continue,
        };
        if val.is_empty() || val.len() > 200 {
            continue;
        }
        let low = val.to_lowercase();
        if low.contains("url(")
            || low.contains("expression(")
            || low.contains("javascript:")
            || low.contains("@import")
            || low.contains(['<', '>', '{', '}', ';'])
        {
            continue;
        }
        out.insert(key, val);
    }
}

/// Descendant rules (`[{ selector, styles }]`) with plain, element-relative
/// selectors only.
fn collect_rules(map: &serde_json::Map<String, Value>) -> Vec<RestyleRule> {
    let Some(Value::Array(arr)) = map.get("rules") else {
        return vec![];
    };
    arr.iter()
        .filter_map(|r| {
            let Value::Object(ro) = r else { return None };
            let sel = ro.get("selector").and_then(|v| v.as_str()).unwrap_or("").trim();
            if sel.is_empty() || sel.len() > 100 || sel.contains(['{', '}', '<', '@', '"', ';']) {
                return None;
            }
            let mut styles = HashMap::new();
            if let Some(Value::Object(s)) = ro.get("styles") {
                collect_styles(s, &mut styles);
            }
            (!styles.is_empty()).then(|| RestyleRule { selector: sel.to_string(), styles })
        })
        .take(12)
        .collect()
}

/// Keys of a variation/suggestion entry that describe it rather than style it.
const META_KEYS: &[&str] = &["name", "description", "classes", "title", "why", "instruction", "ref", "id"];

/// Turn one model entry into a patch. Accepts `{ "styles": {…}, "rules": […] }`,
/// a flat object of CSS props, and — for charts — a `graphein`/`spec` object or
/// the bare object itself (minus descriptive keys and any `data`).
fn to_patch(val: &Value, allow_chart: bool) -> RestylePatch {
    let mut patch = RestylePatch::default();
    let Value::Object(map) = val else {
        return patch;
    };
    if let Some(Value::Object(styles)) = map.get("styles") {
        collect_styles(styles, &mut patch.styles);
    }
    if allow_chart {
        let g = map.get("graphein").or_else(|| map.get("spec")).cloned().unwrap_or_else(|| {
            let mut m = map.clone();
            for k in META_KEYS.iter().chain(["styles", "rules"].iter()) {
                m.remove(*k);
            }
            Value::Object(m)
        });
        if let Value::Object(mut obj) = g {
            obj.remove("data");
            if !obj.is_empty() {
                patch.graphein = Some(Value::Object(obj));
            }
        }
    } else {
        if patch.styles.is_empty() && !map.contains_key("styles") {
            collect_styles(map, &mut patch.styles);
        }
        patch.rules = collect_rules(map);
    }
    patch
}

fn clipped(val: Option<&Value>, max: usize) -> Option<String> {
    let s = val?.as_str()?.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        return None;
    }
    Some(if s.chars().count() > max { format!("{}…", s.chars().take(max).collect::<String>()) } else { s })
}

/// Tailwind utilities are plain tokens: keep only those, capped.
fn class_hint(val: Option<&Value>) -> Option<String> {
    let s = val?.as_str()?;
    let tokens: Vec<&str> = s
        .split_whitespace()
        .filter(|t| {
            t.len() <= 60
                && t.chars().all(|c| c.is_ascii_alphanumeric() || "-_:/[]().%#!".contains(c))
        })
        .take(24)
        .collect();
    (!tokens.is_empty()).then(|| tokens.join(" "))
}

/// Parse up to `count` distinct, non-empty variations from a model answer.
fn parse_variations(text: &str, is_chart: bool, count: usize) -> Vec<Variation> {
    let Some(val) = extract_json(text) else { return vec![] };
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (i, entry) in entries(val, &["variations", "options"]).iter().enumerate() {
        let patch = to_patch(entry, is_chart);
        if patch.is_empty() {
            continue;
        }
        let name = clipped(entry.get("name"), 32).unwrap_or_else(|| format!("Option {}", i + 1));
        if !seen.insert(name.to_lowercase()) {
            continue;
        }
        out.push(Variation {
            name,
            description: clipped(entry.get("description"), 140),
            styles: patch.styles,
            rules: patch.rules,
            graphein: patch.graphein,
            classes: if is_chart { None } else { class_hint(entry.get("classes")) },
        });
        if out.len() >= count {
            break;
        }
    }
    out
}

/// Parse up to [`MAX_SUGGESTIONS`] suggestions that target known outline refs.
fn parse_suggestions(text: &str, refs: &HashSet<String>) -> Vec<Suggestion> {
    let Some(val) = extract_json(text) else { return vec![] };
    let mut out: Vec<Suggestion> = Vec::new();
    for entry in entries(val, &["suggestions", "improvements"]) {
        let Some(reference) = entry.get("ref").and_then(|v| v.as_str()).map(str::trim) else { continue };
        if !refs.contains(reference) {
            continue;
        }
        let (Some(title), Some(instruction)) = (clipped(entry.get("title"), 80), clipped(entry.get("instruction"), 400))
        else {
            continue;
        };
        let patch = to_patch(&entry, false);
        out.push(Suggestion {
            id: format!("s{}", out.len() + 1),
            reference: reference.to_string(),
            title,
            why: clipped(entry.get("why"), 220).unwrap_or_default(),
            instruction,
            styles: patch.styles,
            rules: patch.rules,
        });
        if out.len() >= MAX_SUGGESTIONS {
            break;
        }
    }
    out
}

/* ----------------------------- prompts ----------------------------- */

/// Chart-type-specific display fields the model may set, appended to the shared
/// capability menu. Empty for types whose editable surface is fully covered by
/// the shared (BaseSpec) fields.
fn chart_type_hint(chart_type: Option<&str>) -> &'static str {
    match chart_type.unwrap_or("").trim() {
        "line" => "This line chart also supports: `curve` (\"linear\"|\"monotone\"|\"step\"|\"stepBefore\"|\"stepAfter\"|\"catmullRom\"), `points` (bool — show markers), `area` (bool — fill under the line).",
        "area" => "This area chart also supports: `curve` (\"linear\"|\"monotone\"|\"step\"|\"stepBefore\"|\"stepAfter\"|\"catmullRom\"), `stack` (bool).",
        "bar" => "This bar chart also supports: `orientation` (\"vertical\"|\"horizontal\"), `stack` (bool), `group` (bool — side-by-side series), `cornerRadius` (px).",
        "scatter" => "This scatter chart also supports: `trendline` (see below).",
        "histogram" => "This histogram also supports: `bin` ({ \"maxbins\": N } or { \"step\": N }), `density` (bool), `color` (bar color), `cornerRadius` (px).",
        "pie" => "This pie/donut chart also supports: `donut` (true, or a 0..1 inner-radius ratio), `labels` (true|false, or { \"placement\": \"inside\"|\"outside\"|\"auto\" }).",
        "combo" => "This combo (dual-axis) chart is composed of `layers`: [{ \"mark\": \"line\"|\"bar\"|\"area\"|\"scatter\", \"encoding\": { \"y\": … }, \"axis\": \"left\"|\"right\", \"curve\", \"points\", \"color\", \"name\" }].",
        _ => "",
    }
}

const CHART_MENU: &str = r##"Each option changes the chart through a PARTIAL Graphein spec patch (only the keys it changes), deep-merged over the current spec. Use these EXACT field names:
- TITLE: `title` — a string, or { "text": "…", "subtitle": "…", "align": "left"|"center"|"right" }.
- THEME: `theme` — "light" or "dark".
- COLORS: `palette` — "graphein"|"colorblind"|"bright"|"muted", OR an array of hex colors (one per series). `background` — the plot background color.
- AXES: `axes` = { "x": {…}, "y": {…} }. Each axis takes `show` (bool), `title` (string), `grid` (bool), `ticks` (approx count), `labels` (bool), `labelAngle` (x only: 0|45|90), and `format`.
    `format` is a number-format string: [$][,][.precision][type] — f=fixed, %=percent, s=SI, d=integer. Examples: "$,.0f"→$1,234 · ".1%"→12.3% · ".2s"→3.4M.
- LEGEND: `legend` — { "show": true, "position": "top"|"right"|"bottom"|"left" }, or a boolean.
- TOOLTIP: `tooltip` — { "show": true }, or a boolean.
- ANNOTATIONS: `annotations` — reference overlays: { "type": "line"|"band"|"point", "axis": "x"|"y", "value": …, "from"/"to": …, "label": "…", "color": "#hex" }.
- INSIGHTS: `insights` — true (mark max + min), or { "max": true, "min": true, "outliers": true }.
- SKETCH: `sketch` — true for a hand-drawn look.
Nested OBJECTS are deep-merged; ARRAYS are REPLACED (to add an annotation, include the existing ones). NEVER include a `data` key."##;

fn component_note(ctx: &RestyleContext) -> String {
    ctx.component
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!(" (React component <{s}>)"))
        .unwrap_or_default()
}

/// Describe the element (tag, classes, text, computed styles, notable children).
fn element_brief(ctx: &RestyleContext) -> String {
    let mut el = format!("<{}", if ctx.tag.is_empty() { "div" } else { ctx.tag.as_str() });
    if let Some(c) = ctx.classes.as_deref().filter(|s| !s.trim().is_empty()) {
        el.push_str(&format!(" class=\"{}\"", c.trim()));
    }
    el.push('>');
    let mut out = format!("Element: {el}");
    if let Some(t) = ctx.text.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("\nIts visible text: \"{}\".", t.trim()));
    }
    let mut keys: Vec<&String> = ctx.styles.keys().collect();
    keys.sort();
    if !keys.is_empty() {
        out.push_str("\nCurrent computed styles:");
        for k in keys {
            out.push_str(&format!("\n  {}: {};", k, ctx.styles[k]));
        }
    }
    if let Some(Value::Array(arr)) = &ctx.children {
        let mut kids = String::new();
        for c in arr.iter().take(40) {
            let Value::Object(o) = c else { continue };
            let tag = o.get("tag").and_then(|v| v.as_str()).unwrap_or("");
            if tag.is_empty() {
                continue;
            }
            let cls = o
                .get("classes")
                .and_then(|v| v.as_str())
                .and_then(|s| s.split_whitespace().next())
                .map(|s| format!(".{s}"))
                .unwrap_or_default();
            let txt = o
                .get("text")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| format!(" \"{s}\""))
                .unwrap_or_default();
            kids.push_str(&format!("\n  <{tag}{cls}>{txt}"));
        }
        if !kids.is_empty() {
            out.push_str("\nElements inside it (targetable via `rules`):");
            out.push_str(&kids);
        }
    }
    out
}

/// Ask for `count` distinct, named alternatives for one element.
fn build_variations_prompt(hint: Option<&str>, ctx: &RestyleContext, count: usize) -> String {
    let hint = hint.map(str::trim).filter(|h| !h.is_empty());
    let goal = match hint {
        Some(h) => format!("The user wants: \"{h}\". Propose {count} DISTINCT ways to do that."),
        None => format!("Propose {count} DISTINCT, tasteful alternative looks that would improve it."),
    };
    let comp = component_note(ctx);
    if ctx.is_chart {
        let spec = ctx.spec.as_ref().and_then(|s| serde_json::to_string_pretty(s).ok()).unwrap_or_else(|| "{}".into());
        let kind = ctx.chart_type.as_deref().filter(|s| !s.is_empty()).map(|s| format!("{s} ")).unwrap_or_default();
        let mut p = format!(
            "You are a data-visualization designer improving a Graphein {kind}chart{comp} in a live app. Current spec (data omitted):\n```json\n{spec}\n```\n\n{goal}\n\n{CHART_MENU}"
        );
        let type_hint = chart_type_hint(ctx.chart_type.as_deref());
        if !type_hint.is_empty() {
            p.push('\n');
            p.push_str(type_hint);
        }
        p.push_str(&format!(
            "\n\nReturn ONLY a single fenced ```json block holding an array of {count} objects: \
[{{ \"name\": \"2-3 word label\", \"description\": \"one short sentence\", \"graphein\": {{ /* partial spec patch */ }} }}]. Return nothing else."
        ));
        return p;
    }
    let allowed = ALLOWED_RESTYLE_PROPS.join(", ");
    format!(
        "You are a senior product designer restyling one element{comp} in a live web app.\n{brief}\n\n{goal} \
Keep each option coherent with a modern, accessible UI (readable contrast, consistent radii and spacing).\n\n\
Return ONLY a single fenced ```json block holding an array of {count} objects with this exact shape:\n\
[{{ \"name\": \"2-3 word label\", \"description\": \"one short sentence\", \"styles\": {{ /* CSS for THIS element */ }}, \
\"rules\": [ {{ \"selector\": \"h2\", \"styles\": {{ }} }} ], \"classes\": \"the Tailwind utilities that would produce this look\" }}]\n\
- `styles` restyle the element itself; `rules` restyle its DESCENDANTS (simple selectors relative to the element, \
e.g. \"h2\", \".badge\", \"p span\"). Inner elements with their own colors need `rules`.\n\
- Allowed properties ONLY: {allowed}.\n\
- Concrete CSS values only. NO url(), external resources, @import, or JavaScript.\n\
Return nothing else.",
        brief = element_brief(ctx)
    )
}

/// Ask for concrete, high-impact improvements to the page in the outline.
fn build_polish_prompt(page: &PageOutline) -> String {
    let mut outline = String::new();
    for el in page.elements.iter().take(MAX_OUTLINE_ELEMENTS) {
        let mut line = format!("- [{}] {} <{}>", el.reference, el.label, el.tag);
        if let Some(t) = el.text.as_deref().filter(|t| !t.is_empty()) {
            line.push_str(&format!(" \"{t}\""));
        }
        if let Some(c) = el.classes.as_deref().filter(|c| !c.is_empty()) {
            line.push_str(&format!(" class=\"{}\"", c.chars().take(160).collect::<String>()));
        }
        let mut keys: Vec<&String> = el.styles.keys().collect();
        keys.sort();
        let styles: Vec<String> = keys.iter().map(|k| format!("{k}: {}", el.styles[*k])).collect();
        if !styles.is_empty() {
            line.push_str(&format!(" {{{}}}", styles.join("; ")));
        }
        outline.push_str(&line);
        outline.push('\n');
    }
    let mut findings = String::new();
    for f in page.findings.iter().take(MAX_FINDINGS) {
        let at = f.reference.as_deref().map(|r| format!(" [{r}]")).unwrap_or_default();
        findings.push_str(&format!("- {}{at}: {}\n", f.kind, f.message));
    }
    if findings.is_empty() {
        findings.push_str("- none\n");
    }
    let title = if page.title.trim().is_empty() { "(untitled)" } else { page.title.trim() };
    let allowed = ALLOWED_RESTYLE_PROPS.join(", ");
    format!(
        "You are a senior product designer doing a quick polish review of one page of a live web app \
(title \"{title}\", route {route}, viewport {viewport}). The attached screenshot (when present) shows it as rendered.\n\n\
Notable elements, each with a ref in brackets:\n{outline}\n\
Automated checks found:\n{findings}\n\
Suggest up to {MAX_SUGGESTIONS} concrete, high-impact visual improvements — hierarchy, spacing rhythm, alignment, contrast, \
consistency, emphasis of the primary action. Prefer fixing the automated findings. Each suggestion targets ONE element by its ref, \
and includes a small CSS preview of the change for that element (and optional descendant `rules`).\n\n\
Return ONLY a single fenced ```json block holding an array:\n\
[{{ \"ref\": \"r3\", \"title\": \"short imperative title\", \"why\": \"one sentence on the benefit\", \
\"instruction\": \"what to change in the source, specifically\", \"styles\": {{ }}, \"rules\": [ {{ \"selector\": \"h2\", \"styles\": {{ }} }} ] }}]\n\
- Allowed CSS properties ONLY: {allowed}. Concrete values; NO url(), @import, or JavaScript.\n\
- Only refs from the list above. Skip anything you can't preview with CSS unless the instruction is still clearly valuable.\n\
Return nothing else.",
        route = if page.route.is_empty() { "/" } else { page.route.as_str() },
        viewport = page.viewport,
    )
}

/* ----------------------------- commands ----------------------------- */

fn project_path(project_id: &str) -> Result<String, String> {
    store::find_project(project_id).map(|p| p.path).ok_or_else(|| "Project not found.".to_string())
}

/// Propose `count` (default 3) named alternative looks for one element, as
/// previewable patches. Runs on a transient, read-only session (defaulting to a
/// fast `model`). Returns a soft error string the UI shows in place.
#[tauri::command]
pub async fn design_variations(
    state: State<'_, AppState>,
    project_id: String,
    context: RestyleContext,
    hint: Option<String>,
    count: Option<usize>,
    model: Option<String>,
) -> Result<Vec<Variation>, String> {
    let cwd = project_path(&project_id)?;
    let count = count.unwrap_or(DEFAULT_VARIATIONS).clamp(1, MAX_VARIATIONS);
    let prompt = build_variations_prompt(hint.as_deref(), &context, count);
    let reply = run_transient(&state, &cwd, model, prompt, &[]).await?;
    let options = parse_variations(&reply, context.is_chart, count);
    if options.is_empty() {
        return Err("Couldn't come up with options — try describing what you want.".into());
    }
    Ok(options)
}

/// Review a page outline (and an optional screenshot, one of Fabricator's own
/// temp captures) and suggest up to six previewable improvements. Retries
/// without the screenshot when the model can't use it. The capture is deleted
/// afterwards.
#[tauri::command]
pub async fn design_polish(
    state: State<'_, AppState>,
    project_id: String,
    page: PageOutline,
    screenshot_path: Option<String>,
    model: Option<String>,
) -> Result<Vec<Suggestion>, String> {
    let shot = screenshot_path.as_deref().and_then(screenshot::owned_capture_path);
    let result: Result<Vec<Suggestion>, String> = async {
        let cwd = project_path(&project_id)?;
        if page.elements.is_empty() {
            return Err("There's nothing on this page to review yet.".to_string());
        }
        let refs: HashSet<String> = page.elements.iter().map(|e| e.reference.clone()).collect();
        let prompt = build_polish_prompt(&page);
        let attachments: Vec<PathBuf> = shot.iter().cloned().collect();
        let first = run_transient(&state, &cwd, model.clone(), prompt.clone(), &attachments).await;
        let mut suggestions = first.as_deref().map(|reply| parse_suggestions(reply, &refs)).unwrap_or_default();
        if suggestions.is_empty() && !attachments.is_empty() {
            let reply = run_transient(&state, &cwd, model, prompt, &[]).await?;
            suggestions = parse_suggestions(&reply, &refs);
        } else if let Err(error) = first {
            return Err(error);
        }
        if suggestions.is_empty() {
            return Err("No clear improvements found for this page.".to_string());
        }
        Ok(suggestions)
    }
    .await;
    if let Some(path) = screenshot_path {
        screenshot::cleanup(&[path]);
    }
    result
}

/// Find the likely source lines behind picked elements (heuristic hints) and the
/// project's Tailwind entry stylesheet.
#[tauri::command]
pub async fn design_locate(project_id: String, targets: Vec<LocateTarget>) -> Result<LocateResult, String> {
    let root = PathBuf::from(project_path(&project_id)?);
    let targets: Vec<LocateTarget> = targets.into_iter().take(40).collect();
    tokio::task::spawn_blocking(move || design_locate::locate(&root, &targets))
        .await
        .map_err(|e| format!("Source lookup failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_prefers_last_fenced_block() {
        let text = "first:\n```json\n{\"color\":\"red\"}\n```\nbut actually:\n```json\n{\"color\":\"blue\"}\n```";
        let v = extract_json(text).expect("json");
        assert_eq!(v["color"], "blue");
    }

    #[test]
    fn extract_json_falls_back_to_array_then_brace_span() {
        let arr = extract_json("here: [{\"name\":\"A\"}] done").expect("array");
        assert!(arr.is_array());
        let obj = extract_json("no fences but {\"border-radius\":\"8px\"} here").expect("object");
        assert_eq!(obj["border-radius"], "8px");
        assert!(extract_json("just prose, no json").is_none());
    }

    #[test]
    fn collect_styles_keeps_only_whitelisted_safe_values() {
        let map = serde_json::json!({
            "color": "#fff",
            "background-color": "#0f766e",
            "position": "absolute",
            "onclick": "evil()",
            "background-image": "url(https://evil.example/x.png)",
            "background": "expression(alert(1))",
            "border": "1px solid red; position: fixed",
            "border-radius": "9999px"
        });
        let mut out = HashMap::new();
        collect_styles(map.as_object().unwrap(), &mut out);
        assert_eq!(out.get("color").map(String::as_str), Some("#fff"));
        assert_eq!(out.get("background-color").map(String::as_str), Some("#0f766e"));
        assert_eq!(out.get("border-radius").map(String::as_str), Some("9999px"));
        for dropped in ["position", "onclick", "background-image", "background", "border"] {
            assert!(!out.contains_key(dropped), "{dropped}");
        }
    }

    #[test]
    fn in_page_controller_rechecks_the_same_property_list() {
        let js = include_str!("../services/design_agent.js");
        let start = js.find("var SAFE_PROPS = [").expect("SAFE_PROPS in design_agent.js");
        let list = &js[start..start + js[start..].find("];").expect("end of SAFE_PROPS")];
        for prop in ALLOWED_RESTYLE_PROPS {
            assert!(list.contains(&format!("'{prop}'")), "design_agent.js SAFE_PROPS is missing {prop}");
        }
        assert_eq!(list.matches('\'').count() / 2, ALLOWED_RESTYLE_PROPS.len(), "SAFE_PROPS has extra properties");
    }

    #[test]
    fn to_patch_reads_styles_rules_and_flat_objects() {
        let v = serde_json::json!({
            "name": "Pill",
            "styles": { "border-radius": "16px" },
            "rules": [
                { "selector": "h1", "styles": { "font-size": "32px", "position": "absolute" } },
                { "selector": "h1 { } body", "styles": { "color": "#fff" } },
                { "selector": "p", "styles": {} }
            ]
        });
        let patch = to_patch(&v, false);
        assert_eq!(patch.styles.get("border-radius").map(String::as_str), Some("16px"));
        assert_eq!(patch.rules.len(), 1);
        assert!(!patch.rules[0].styles.contains_key("position"));
        let flat = to_patch(&serde_json::json!({ "name": "x", "color": "#111" }), false);
        assert_eq!(flat.styles.get("color").map(String::as_str), Some("#111"));
    }

    #[test]
    fn chart_patches_drop_data_and_descriptive_keys() {
        let bare = to_patch(&serde_json::json!({ "name": "Bars", "description": "x", "type": "bar", "data": [1] }), true);
        let g = bare.graphein.expect("graphein");
        assert_eq!(g["type"], "bar");
        assert!(g.get("data").is_none() && g.get("name").is_none() && g.get("description").is_none());
        let wrapped = to_patch(&serde_json::json!({ "graphein": { "palette": "bright", "data": [1] } }), true);
        assert_eq!(wrapped.graphein.expect("graphein"), serde_json::json!({ "palette": "bright" }));
    }

    #[test]
    fn parse_variations_names_dedupes_and_caps() {
        let reply = r##"```json
[
  { "name": "Pill", "description": "Fully rounded", "styles": { "border-radius": "9999px" }, "classes": "rounded-full px-5 <script>" },
  { "name": "pill", "styles": { "border-radius": "20px" } },
  { "name": "Nothing", "styles": { "position": "fixed" } },
  { "styles": { "box-shadow": "0 8px 24px rgba(0,0,0,.2)" } },
  { "name": "Outline", "styles": { "background-color": "transparent", "border": "1px solid #4f46e5" } }
]
```"##;
        let got = parse_variations(reply, false, 2);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "Pill");
        assert_eq!(got[0].classes.as_deref(), Some("rounded-full px-5"));
        assert_eq!(got[1].name, "Option 4"); // unnamed entry gets a positional name
        let wrapped = parse_variations(r##"{"variations":[{"name":"A","styles":{"color":"#222"}}]}"##, false, 3);
        assert_eq!(wrapped.len(), 1);
    }

    #[test]
    fn parse_suggestions_requires_known_refs_and_instructions() {
        let refs: HashSet<String> = ["r1".to_string(), "r2".to_string()].into_iter().collect();
        let reply = r##"[
          { "ref": "r1", "title": "Raise the primary action", "why": "It's easy to miss.", "instruction": "Make the Add deal button a filled indigo button.", "styles": { "background-color": "#4f46e5" } },
          { "ref": "r9", "title": "Unknown", "instruction": "x" },
          { "ref": "r2", "title": "No instruction" },
          { "ref": "r2", "title": "Tighten spacing", "instruction": "Reduce the card padding to p-4." }
        ]"##;
        let got = parse_suggestions(reply, &refs);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].id.as_str(), got[0].reference.as_str()), ("s1", "r1"));
        assert_eq!(got[0].styles.get("background-color").map(String::as_str), Some("#4f46e5"));
        assert_eq!(got[1].id, "s2");
        assert!(got[1].styles.is_empty());
        let json = serde_json::to_value(&got[0]).unwrap();
        assert_eq!(json["ref"], "r1");
    }

    #[test]
    fn variations_prompt_covers_elements_and_charts() {
        let el = RestyleContext { tag: "button".into(), classes: Some("rounded-lg bg-indigo-600".into()), ..Default::default() };
        let p = build_variations_prompt(Some("make it feel more premium"), &el, 3);
        assert!(p.contains("make it feel more premium"));
        assert!(p.contains("Allowed properties ONLY"));
        assert!(p.contains("\"classes\""));
        assert!(p.contains("array of 3 objects"));
        let chart = RestyleContext {
            is_chart: true,
            chart_type: Some("bar".into()),
            spec: Some(serde_json::json!({ "type": "bar", "title": "Revenue" })),
            ..Default::default()
        };
        let c = build_variations_prompt(None, &chart, 2);
        assert!(c.contains("\"title\": \"Revenue\""));
        assert!(c.contains("orientation")); // bar-specific hint
        assert!(c.contains("NEVER include a `data` key"));
        assert!(c.contains("\"graphein\""));
    }

    #[test]
    fn polish_prompt_lists_refs_and_findings() {
        let page = PageOutline {
            route: "/deals".into(),
            title: "Deals".into(),
            viewport: serde_json::json!({ "w": 1280, "h": 800 }),
            elements: vec![OutlineElement {
                reference: "r1".into(),
                label: "Button · Add deal".into(),
                tag: "button".into(),
                text: Some("Add deal".into()),
                styles: HashMap::from([("color".into(), "rgb(255, 255, 255)".into())]),
                ..Default::default()
            }],
            findings: vec![Finding { reference: Some("r1".into()), kind: "contrast".into(), message: "2.1:1 text contrast".into() }],
        };
        let p = build_polish_prompt(&page);
        assert!(p.contains("[r1] Button · Add deal <button> \"Add deal\""));
        assert!(p.contains("contrast [r1]: 2.1:1 text contrast"));
        assert!(p.contains("route /deals"));
    }

    #[test]
    fn chart_type_hint_covers_common_types() {
        assert!(chart_type_hint(Some("bar")).contains("orientation"));
        assert!(chart_type_hint(Some("pie")).contains("donut"));
        assert!(chart_type_hint(Some("line")).contains("curve"));
        assert!(chart_type_hint(Some("combo")).contains("layers"));
        assert_eq!(chart_type_hint(Some("gauge")), "");
        assert_eq!(chart_type_hint(None), "");
    }
}
