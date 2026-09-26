//! Evidence handling for deep-review findings: resolve the reported file inside
//! the project, locate the excerpt the model quoted, rebuild the excerpt from
//! the real file lines (plus a little context), mask secret-looking values, and
//! derive a stable finding id.

use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;
use sha2::{Digest, Sha256};

use crate::commands::util::safe_resolve;

/// Largest file the evidence check reads.
pub const MAX_EVIDENCE_FILE_BYTES: u64 = 1024 * 1024;
/// Lines of context kept around the flagged lines.
const CONTEXT_LINES: u32 = 2;
/// Longest excerpt shown for one finding.
const MAX_EXCERPT_LINES: u32 = 18;

/// Turn a model-reported path into a project-relative POSIX path that exists
/// inside `root`. Accepts `./x`, backslashes, and absolute paths under the root.
pub fn normalize_rel(path: &str, root: &Path) -> Option<String> {
  let trimmed = path.trim().trim_matches('`').trim();
  if trimmed.is_empty() {
    return None;
  }
  let slashed = trimmed.replace('\\', "/");
  let candidate = Path::new(&slashed);
  let rel = if candidate.is_absolute() {
    let root_norm = crate::commands::util::normalize(root);
    let abs = crate::commands::util::normalize(candidate);
    abs.strip_prefix(&root_norm).ok()?.to_string_lossy().replace('\\', "/")
  } else {
    slashed.trim_start_matches("./").to_string()
  };
  let resolved = safe_resolve(&root.to_string_lossy(), &rel)?;
  resolved.is_file().then(|| rel.trim_start_matches('/').to_string())
}

/// Read a project file for evidence checks (text only, size-capped).
pub fn read_text(root: &Path, rel: &str) -> Option<String> {
  let path = safe_resolve(&root.to_string_lossy(), rel)?;
  let meta = std::fs::metadata(&path).ok()?;
  if !meta.is_file() || meta.len() > MAX_EVIDENCE_FILE_BYTES {
    return None;
  }
  let buf = std::fs::read(path).ok()?;
  if crate::commands::util::looks_binary(&buf) {
    return None;
  }
  Some(String::from_utf8_lossy(&buf).into_owned())
}

static NUMBERED_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*\d+\s*[.:|]\s?").unwrap());

/// The meaningful lines of a quoted excerpt: code fences dropped, the view
/// tool's `N. ` numbering stripped when every line carries it, and each line
/// trimmed (models often re-indent).
fn excerpt_lines(excerpt: &str) -> Vec<String> {
  let lines: Vec<&str> = excerpt
    .lines()
    .filter(|l| !l.trim_start().starts_with("```"))
    .collect();
  let numbered = !lines.is_empty() && lines.iter().filter(|l| !l.trim().is_empty()).all(|l| NUMBERED_LINE.is_match(l));
  lines
    .into_iter()
    .map(|l| if numbered { NUMBERED_LINE.replace(l, "").into_owned() } else { l.to_string() })
    .map(|l| l.trim().to_string())
    .filter(|l| !l.is_empty())
    .collect()
}

fn collapse(s: &str) -> String {
  s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Find where `excerpt` occurs in `content`, returning 1-based (start, end)
/// lines. Matching ignores indentation and blank lines; a single quoted line may
/// be a fragment of a longer line. When several places match, the one closest
/// to `hint` wins.
pub fn locate(content: &str, excerpt: &str, hint: Option<u32>) -> Option<(u32, u32)> {
  let needle = excerpt_lines(excerpt);
  if needle.is_empty() {
    return None;
  }
  // Non-blank content lines with their 1-based numbers.
  let hay: Vec<(u32, String)> = content
    .lines()
    .enumerate()
    .filter_map(|(i, l)| {
      let t = l.trim();
      (!t.is_empty()).then(|| (i as u32 + 1, collapse(t)))
    })
    .collect();
  let needle: Vec<String> = needle.iter().map(|l| collapse(l)).collect();
  let mut hits: Vec<(u32, u32)> = Vec::new();
  if needle.len() == 1 {
    let n = &needle[0];
    if n.len() < 4 {
      return None;
    }
    for (line, text) in &hay {
      if text.contains(n.as_str()) {
        hits.push((*line, *line));
      }
    }
  } else if hay.len() >= needle.len() {
    for start in 0..=(hay.len() - needle.len()) {
      let ok = needle.iter().enumerate().all(|(k, n)| {
        let h = &hay[start + k].1;
        // The first and last quoted lines may be partial.
        if k == 0 {
          h.ends_with(n.as_str()) || h == n
        } else if k == needle.len() - 1 {
          h.starts_with(n.as_str()) || h == n
        } else {
          h == n
        }
      });
      if ok {
        hits.push((hay[start].0, hay[start + needle.len() - 1].0));
      }
    }
  }
  let target = hint.unwrap_or(0);
  hits.into_iter().min_by_key(|(s, _)| (*s as i64 - target as i64).abs())
}

/// The file lines around `start..=end` (1-based) with a little context, capped.
/// Returns the excerpt text and the line number of its first line.
pub fn window(content: &str, start: u32, end: u32) -> (String, u32) {
  let lines: Vec<&str> = content.lines().collect();
  if lines.is_empty() {
    return (String::new(), 1);
  }
  let last = lines.len() as u32;
  let start = start.clamp(1, last);
  let end = end.clamp(start, last);
  let from = start.saturating_sub(CONTEXT_LINES).max(1);
  let mut to = (end + CONTEXT_LINES).min(last);
  if to - from + 1 > MAX_EXCERPT_LINES {
    to = from + MAX_EXCERPT_LINES - 1;
  }
  let text = lines[(from - 1) as usize..to as usize].join("\n");
  (text, from)
}

static SECRET_ASSIGNMENT: Lazy<Regex> = Lazy::new(|| {
  Regex::new(
    r#"(?i)((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|token|connection[_-]?string|conn[_-]?str)["']?\s*[:=]\s*["'`]?)([^"'`\s;,]{6,})"#,
  )
  .unwrap()
});

static SECRET_TOKENS: Lazy<Regex> = Lazy::new(|| {
  Regex::new(
    r"(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AccountKey=[A-Za-z0-9+/=]{20,})",
  )
  .unwrap()
});

static PRIVATE_KEY_BLOCK: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(-----END [A-Z ]*PRIVATE KEY-----|$)").unwrap()
});

fn mask_value(value: &str) -> String {
  let keep: String = value.chars().take(4).collect();
  format!("{keep}••••••")
}

/// Mask values that look like credentials so evidence never shows them in full.
pub fn mask_secrets(text: &str) -> String {
  let text = PRIVATE_KEY_BLOCK.replace_all(text, "-----BEGIN PRIVATE KEY----- •••••• (masked)");
  let text = SECRET_TOKENS.replace_all(&text, |c: &regex::Captures| mask_value(&c[1]));
  SECRET_ASSIGNMENT
    .replace_all(&text, |c: &regex::Captures| {
      let value = &c[2];
      // Leave references (env lookups, template placeholders) readable.
      if value.starts_with("${") || value.starts_with("process.env") || value.starts_with("import.meta") {
        c[0].to_string()
      } else {
        format!("{}{}", &c[1], mask_value(value))
      }
    })
    .into_owned()
}

/// Id for a deep-review finding: one grouped finding per rule (like the quick
/// checks' `quick:<rule>`), so a re-review that picks a different primary
/// place for the same issue keeps its id — and its dismissal, hand-off, and
/// New/Resolved history.
pub fn rule_finding_id(rule_id: &str) -> String {
  format!("ai:{rule_id}")
}

/// Id for a fallback finding with no catalog rule: the same file and content
/// (not line number) keep the same id across runs.
pub fn finding_id(rule_id: &str, file: Option<&str>, anchor: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(rule_id.as_bytes());
  hasher.update(b"\0");
  hasher.update(file.unwrap_or("").as_bytes());
  hasher.update(b"\0");
  hasher.update(collapse(anchor).as_bytes());
  let digest = hex::encode(hasher.finalize());
  format!("ai:{rule_id}:{}", &digest[..12])
}

#[cfg(test)]
mod tests {
  use super::*;

  const SRC: &str = "import { entity } from '@microsoft/rayfin-core';\n\n@entity()\nexport class Todo {\n  @uuid() id!: string;\n  @text() title!: string;\n  @text() user_id!: string;\n}\n";

  #[test]
  fn locate_matches_multiline_excerpts_ignoring_indentation_and_blank_lines() {
    assert_eq!(locate(SRC, "@text() title!: string;\n@text() user_id!: string;", None), Some((6, 7)));
    assert_eq!(locate(SRC, "    @entity()\n\n    export class Todo {", None), Some((3, 4)));
  }

  #[test]
  fn locate_accepts_numbered_view_output_and_fences() {
    let quoted = "```ts\n6.   @text() title!: string;\n7.   @text() user_id!: string;\n```";
    assert_eq!(locate(SRC, quoted, None), Some((6, 7)));
  }

  #[test]
  fn locate_prefers_the_match_nearest_the_hint() {
    let src = "a();\nfoo.execute();\nb();\nfoo.execute();\n";
    assert_eq!(locate(src, "foo.execute();", Some(4)), Some((4, 4)));
    assert_eq!(locate(src, "foo.execute();", Some(1)), Some((2, 2)));
  }

  #[test]
  fn locate_rejects_text_that_is_not_in_the_file() {
    assert_eq!(locate(SRC, "@text({ max: 200 }) title!: string;", None), None);
    assert_eq!(locate(SRC, "", None), None);
    assert_eq!(locate(SRC, "ab", None), None);
  }

  #[test]
  fn window_adds_context_and_caps_length() {
    let (text, first) = window(SRC, 6, 6);
    assert_eq!(first, 4);
    assert_eq!(text.lines().count(), 5);
    let long: String = (1..=100).map(|i| format!("line {i}\n")).collect();
    let (text, first) = window(&long, 10, 60);
    assert_eq!(first, 8);
    assert_eq!(text.lines().count(), MAX_EXCERPT_LINES as usize);
  }

  #[test]
  fn mask_secrets_hides_values_but_keeps_references() {
    let masked = mask_secrets("const apiKey = 'abcd1234efgh5678';\nconst token = process.env.TOKEN;\nOPENAI=sk-proj-abcdefghijklmnopqrstu");
    assert!(masked.contains("abcd••••••"));
    assert!(!masked.contains("abcd1234efgh5678"));
    assert!(masked.contains("process.env.TOKEN"));
    assert!(!masked.contains("sk-proj-abcdefghijklmnopqrstu"));
    let key = mask_secrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----");
    assert!(!key.contains("MIIE"));
  }

  #[test]
  fn finding_ids_are_stable_and_content_based() {
    let a = finding_id("queries/unpaginated-list", Some("src/a.ts"), "const  rows = await q.execute()");
    let b = finding_id("queries/unpaginated-list", Some("src/a.ts"), "const rows = await q.execute()");
    let c = finding_id("queries/unpaginated-list", Some("src/b.ts"), "const rows = await q.execute()");
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert!(a.starts_with("ai:queries/unpaginated-list:"));
  }

  #[test]
  fn normalize_rel_keeps_paths_inside_the_project() {
    let dir = std::env::temp_dir().join(format!("advisor-evidence-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src").join("App.tsx"), "x").unwrap();
    assert_eq!(normalize_rel("./src/App.tsx", &dir).as_deref(), Some("src/App.tsx"));
    assert_eq!(normalize_rel("src\\App.tsx", &dir).as_deref(), Some("src/App.tsx"));
    let abs = dir.join("src").join("App.tsx");
    assert_eq!(normalize_rel(&abs.to_string_lossy(), &dir).as_deref(), Some("src/App.tsx"));
    assert_eq!(normalize_rel("../outside.txt", &dir), None);
    assert_eq!(normalize_rel("src/Missing.tsx", &dir), None);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
