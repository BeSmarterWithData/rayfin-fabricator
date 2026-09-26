//! The shared Advisor rule catalog (`src/shared/advisor/rules.json`), compiled
//! into the backend so the deep-review prompt and tool validation always match
//! the rules the renderer displays.

use once_cell::sync::Lazy;
use serde::Deserialize;

const RULES_JSON: &str = include_str!("../../../../src/shared/advisor/rules.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
  pub catalog_version: String,
  pub rayfin_baseline: String,
  pub categories: Vec<CategoryDef>,
  pub rules: Vec<RuleDef>,
}

#[derive(Deserialize)]
pub struct CategoryDef {
  pub id: String,
  pub title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDef {
  pub id: String,
  pub category: String,
  pub engine: String,
  pub severity: String,
  #[serde(default)]
  pub applies_when: Vec<String>,
  pub title: String,
  pub summary: String,
  pub why: String,
  pub fix: String,
  #[serde(default)]
  pub check: Option<String>,
  pub docs: Vec<DocLink>,
}

#[derive(Deserialize)]
pub struct DocLink {
  pub title: String,
  pub url: String,
}

pub static CATALOG: Lazy<Catalog> =
  Lazy::new(|| serde_json::from_str(RULES_JSON).expect("src/shared/advisor/rules.json must be valid"));

pub fn rule(id: &str) -> Option<&'static RuleDef> {
  CATALOG.rules.iter().find(|r| r.id == id)
}

pub fn category_title(id: &str) -> &'static str {
  CATALOG.categories.iter().find(|c| c.id == id).map(|c| c.title.as_str()).unwrap_or("Other")
}

impl RuleDef {
  pub fn is_ai(&self) -> bool {
    self.engine == "ai"
  }

  /// A rule applies when it has no conditions or any of them holds.
  pub fn applies(&self, conditions: &[String]) -> bool {
    self.applies_when.is_empty() || self.applies_when.iter().any(|c| conditions.iter().any(|h| h == c))
  }
}

/// The deep-review rules that apply to a project with these conditions, in
/// catalog (category) order.
pub fn ai_rules_for(conditions: &[String]) -> Vec<&'static RuleDef> {
  CATALOG.rules.iter().filter(|r| r.is_ai() && r.applies(conditions)).collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashSet;

  #[test]
  fn catalog_parses_with_unique_well_formed_rules() {
    let cat = &*CATALOG;
    assert!(!cat.catalog_version.is_empty());
    assert!(!cat.rayfin_baseline.is_empty());
    let categories: HashSet<&str> = cat.categories.iter().map(|c| c.id.as_str()).collect();
    let mut ids = HashSet::new();
    for r in &cat.rules {
      assert!(ids.insert(r.id.as_str()), "duplicate rule id {}", r.id);
      assert!(categories.contains(r.category.as_str()), "{} has unknown category", r.id);
      assert!(r.id.starts_with(&format!("{}/", r.category)), "{} should be prefixed by its category", r.id);
      assert!(matches!(r.engine.as_str(), "quick" | "ai"), "{} has unknown engine", r.id);
      assert!(matches!(r.severity.as_str(), "high" | "medium" | "low" | "note"), "{} has unknown severity", r.id);
      assert!(!r.title.is_empty() && !r.summary.is_empty() && !r.why.is_empty() && !r.fix.is_empty());
      assert!(!r.docs.is_empty(), "{} needs a doc link", r.id);
      assert_eq!(r.is_ai(), r.check.as_deref().is_some_and(|c| !c.trim().is_empty()), "{}: only ai rules carry check text", r.id);
    }
  }

  #[test]
  fn ai_rules_are_filtered_by_conditions() {
    let none = ai_rules_for(&[]);
    assert!(none.iter().all(|r| r.applies_when.is_empty()));
    assert!(none.iter().any(|r| r.id == "platform/latest-guidance"));
    let data = ai_rules_for(&["data".to_string()]);
    assert!(data.iter().any(|r| r.id == "queries/unpaginated-list"));
    assert!(!none.iter().any(|r| r.id == "queries/unpaginated-list"));
    assert!(data.len() > none.len());
  }
}
