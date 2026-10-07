//! What the Help assistant can see for one conversation.
//!
//! A Copilot session is scoped to a single working directory, but the assistant
//! needs to read from several unrelated places: the logs, Fabricator's source,
//! the mirrored docs, the user's project, and anything the user attaches. The
//! session therefore runs rooted at the assistant's own cache directory, and
//! every readable location is declared here so the permission policy can allow
//! exactly those roots and nothing else.

use std::path::PathBuf;

use crate::services::{grounding, journal, paths, store};

/// How many journal records to put in front of the model each turn.
///
/// Successes are in here too, so the window has to be wide enough that a
/// failure and the success that resolved it both fit — otherwise the fix falls
/// off the end and the problem looks live again.
const RECENT_ACTIVITY: usize = 60;

/// The user's active project, when the Help overlay was opened with one.
#[derive(Clone, Debug)]
pub struct ProjectContext {
  pub name: String,
  pub path: String,
  /// Set when the project belongs to a team workspace. Team apps work
  /// differently enough (publishing, and who may grant access) that the
  /// assistant must not offer the personal-project controls for them.
  pub team: Option<String>,
}

/// One of the user's projects, so the assistant can answer "open my expenses
/// app" by offering a button rather than describing where to click.
#[derive(Clone, Debug)]
pub struct ProjectSummary {
  pub id: String,
  pub name: String,
  /// Whether the project has ever been deployed, which decides whether sharing
  /// it is possible yet.
  pub deployed: bool,
}

/// Everything one Help conversation is allowed to read, plus the facts worth
/// telling the model up front.
#[derive(Clone, Debug)]
pub struct HelpContext {
  pub app_version: String,
  pub os: String,
  /// Fabricator's own source checkout, when the grounding cache is populated.
  pub source_dir: Option<String>,
  /// The git ref that checkout came from.
  pub source_ref: Option<String>,
  /// The mirrored documentation.
  pub docs_dir: Option<String>,
  /// The app's logs directory, which holds the activity journal.
  pub logs_dir: String,
  pub project: Option<ProjectContext>,
  /// Every project the user has, so the assistant can offer to open one by name.
  pub projects: Vec<ProjectSummary>,
  /// Recent activity-journal lines — successes and failures both — inlined into
  /// the turn so the model never has to go looking for the obvious.
  pub recent_activity: String,
  /// What is true right now, from the screen that opened Help.
  pub facts: Vec<String>,
  /// Extra files and folders the user attached.
  pub extra_roots: Vec<String>,
}

impl HelpContext {
  /// Assemble the context for a conversation.
  pub fn build(
    app_version: &str,
    project_id: Option<&str>,
    attachments: &[String],
    facts: &[String],
  ) -> Self {
    let status = grounding::status(app_version);
    let project = project_id.and_then(project_context);

    Self {
      app_version: app_version.to_string(),
      os: std::env::consts::OS.to_string(),
      source_dir: status.source_ready.then(|| grounding::source_dir().to_string_lossy().into_owned()),
      source_ref: status.reference,
      docs_dir: status.docs_ready.then(|| grounding::docs_dir().to_string_lossy().into_owned()),
      logs_dir: paths::logs_dir().to_string_lossy().into_owned(),
      project,
      projects: all_projects(),
      recent_activity: journal::recent(RECENT_ACTIVITY),
      facts: facts.to_vec(),
      extra_roots: attachments.to_vec(),
    }
  }

  /// Every directory or file the session may read. The permission policy allows
  /// reads under these and denies everything else.
  pub fn roots(&self) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from(&self.logs_dir)];
    if let Some(d) = &self.source_dir {
      roots.push(PathBuf::from(d));
    }
    if let Some(d) = &self.docs_dir {
      roots.push(PathBuf::from(d));
    }
    if let Some(p) = &self.project {
      roots.push(PathBuf::from(&p.path));
    }
    roots.extend(self.extra_roots.iter().map(PathBuf::from));
    roots
  }

  /// The working directory the session runs in. The grounding cache is a
  /// neutral root that always exists and contains nothing the user owns.
  pub fn cwd(&self) -> PathBuf {
    grounding::root()
  }

  /// The orientation paragraph appended to the system frame: where things are,
  /// and what state the app is in.
  pub fn describe(&self) -> String {
    let mut s = String::new();
    s.push_str(&format!("- Fabricator version: {}\n", self.app_version));
    s.push_str(&format!("- Operating system: {}\n", self.os));

    match &self.project {
      Some(p) => {
        s.push_str(&format!("- The user's open project: \"{}\" at `{}`\n", p.name, p.path));
        if p.team.is_some() {
          s.push_str(
            "  It is a **team app**, which works differently from a personal one. It is published \
by the team's pipeline, not deployed from this computer, and access to it is granted to the whole \
team workspace rather than per app. So there is no **Share** control for it: an owner grants \
access under **App access** in the workspace overview. Offer `open-team-access` instead of \
`share-app`, and say that only a workspace owner can grant it.\n",
          );
        }
      }
      None => s.push_str("- The user has no project open right now.\n"),
    }

    if self.projects.is_empty() {
      s.push_str("- The user has no projects yet.\n");
    } else {
      s.push_str(
        "- Their projects, with the id to pass as `target` when you offer `open-project`:\n",
      );
      for p in &self.projects {
        let deployed = if p.deployed { "deployed" } else { "never deployed" };
        s.push_str(&format!("  - \"{}\" — id `{}` ({deployed})\n", p.name, p.id));
      }
      s.push_str(
        "  Match the user's wording loosely against these names. If exactly one is a plausible \
match, offer `open-project` for it. If several could match, offer `open-home` and name the \
candidates. Never invent an id.\n",
      );
    }

    s.push_str(&format!(
      "- Logs and the error journal: `{}` (files named `errors-*.jsonl`, `diagnostics-*.jsonl`, `main-*.log`)\n",
      self.logs_dir
    ));

    match &self.docs_dir {
      Some(d) => s.push_str(&format!(
        "- The published documentation, mirrored for offline reading: `{d}`. `llms-full.txt` is \
every page in one file; `llms.txt` is the index with each page's URL. Search these before \
answering a \"how do I\" question.\n"
      )),
      None => s.push_str(
        "- The documentation is not cached on this machine. Answer from the logs and the source, \
and point the user at https://spatney.github.io/rayfin-fabricator/docs.\n",
      ),
    }

    match (&self.source_dir, &self.source_ref) {
      (Some(d), Some(r)) => s.push_str(&format!(
        "- Fabricator's own source code: `{d}` (checked out at `{r}`, matching the running build). \
Use it only to trace a symptom to its cause, and never show it to the user.\n"
      )),
      (Some(d), None) => s.push_str(&format!("- Fabricator's own source code: `{d}`.\n")),
      _ => s.push_str(
        "- Fabricator's source is not cached on this machine, so you can't look up internal \
causes. Work from the logs and the documentation.\n",
      ),
    }

    if !self.extra_roots.is_empty() {
      s.push_str("- The user attached:\n");
      for root in &self.extra_roots {
        s.push_str(&format!("  - `{root}`\n"));
      }
    }

    s
  }
}

/// Look up a project's name and folder from the app's store.
fn project_context(project_id: &str) -> Option<ProjectContext> {
  store::find_project(project_id).map(|p| ProjectContext {
    name: p.name,
    path: p.path,
    team: p.team.map(|t| t.workspace_id),
  })
}

/// Every project the user has, newest-used first as the store holds them.
fn all_projects() -> Vec<ProjectSummary> {
  store::get_state()
    .projects
    .into_iter()
    .map(|p| ProjectSummary { id: p.id, name: p.name, deployed: p.last_deploy.is_some() })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ctx() -> HelpContext {
    HelpContext {
      app_version: "1.10.0".into(),
      os: "windows".into(),
      source_dir: Some("C:\\cache\\source".into()),
      source_ref: Some("v1.10.0".into()),
      docs_dir: Some("C:\\cache\\docs".into()),
      logs_dir: "C:\\data\\logs".into(),
      project: Some(ProjectContext {
        name: "Contoso Expenses".into(),
        path: "C:\\projects\\contoso".into(),
        team: None,
      }),
      projects: Vec::new(),
      recent_activity: String::new(),
      facts: Vec::new(),
      extra_roots: vec!["C:\\Users\\me\\Desktop\\shot.png".into()],
    }
  }

  #[test]
  fn a_team_app_is_called_out_with_how_its_access_works() {
    let mut c = ctx();
    c.project = Some(ProjectContext {
      name: "Contoso Expenses".into(),
      path: "C:\\projects\\contoso".into(),
      team: Some("ws-1".into()),
    });
    let text = c.describe();
    assert!(text.contains("team app"));
    assert!(text.contains("no **Share** control"), "the missing control is explained, not ignored");
    assert!(text.contains("open-team-access"));
  }

  #[test]
  fn a_personal_project_says_nothing_about_team_access() {
    assert!(!ctx().describe().contains("team app"));
  }

  #[test]
  fn roots_cover_every_readable_location() {
    let roots = ctx().roots();
    let shown: Vec<String> = roots.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    assert!(shown.contains(&"C:\\data\\logs".to_string()));
    assert!(shown.contains(&"C:\\cache\\source".to_string()));
    assert!(shown.contains(&"C:\\cache\\docs".to_string()));
    assert!(shown.contains(&"C:\\projects\\contoso".to_string()));
    assert!(shown.contains(&"C:\\Users\\me\\Desktop\\shot.png".to_string()));
  }

  #[test]
  fn the_description_names_the_project_and_the_pinned_source() {
    let text = ctx().describe();
    assert!(text.contains("Contoso Expenses"));
    assert!(text.contains("v1.10.0"));
    assert!(text.contains("never show it to the user"));
  }

  #[test]
  fn a_missing_grounding_is_called_out() {
    let mut c = ctx();
    c.source_dir = None;
    c.source_ref = None;
    c.docs_dir = None;
    c.project = None;
    let text = c.describe();
    assert!(text.contains("no project open"));
    assert!(text.contains("documentation is not cached"));
    assert!(text.contains("source is not cached"));
  }

  #[test]
  fn roots_shrink_when_grounding_is_missing() {
    let mut c = ctx();
    c.source_dir = None;
    c.docs_dir = None;
    c.extra_roots.clear();
    let roots = c.roots();
    assert_eq!(roots.len(), 2, "only the logs and the project remain");
  }
}
