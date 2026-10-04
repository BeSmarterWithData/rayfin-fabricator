//! Microsoft Entra ID access for team workspaces through the Azure CLI the user
//! signed in with during setup: the workspace's app registration, its service
//! principal and federated credentials, user lookups, and access tokens.
//!
//! JSON parameters go through `@file` because `az` is a batch script on
//! Windows, and `cmd.exe` mangles quotes and braces in arguments.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

use crate::services::exec::{self, RunOptions, RunResult};

/// OIDC issuer for GitHub Actions on github.com.
pub const GITHUB_ISSUER: &str = "https://token.actions.githubusercontent.com";
/// Audience `azure/login` requests by default.
pub const TOKEN_EXCHANGE_AUDIENCE: &str = "api://AzureADTokenExchange";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AzErrorKind {
  Missing,
  NeedsLogin,
  /// The directory doesn't let this user do it (needs an admin or a role).
  Blocked,
  NotFound,
  Other,
}

#[derive(Debug, Clone)]
pub struct AzError {
  pub kind: AzErrorKind,
  pub message: String,
}

static LOGIN_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)az login|interaction_required|refresh token has expired|AADSTS(50076|50078|50079|50173|70043|700082)|no subscription found.*login|token.*expired")
    .unwrap()
});
static BLOCKED_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)insufficient privileges|Authorization_RequestDenied|does not have authorization|forbidden|not allowed to create|policy")
    .unwrap()
});
static NOT_FOUND_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)does not exist|not found|Request_ResourceNotFound|ResourceNotFound").unwrap());

fn classify(res: &RunResult) -> AzError {
  if res.not_found {
    return AzError { kind: AzErrorKind::Missing, message: "The Azure CLI (az) isn't installed.".into() };
  }
  let text = res.stderr.trim();
  let message = text
    .lines()
    .map(|l| l.trim().trim_start_matches("ERROR:").trim())
    .find(|l| !l.is_empty() && !l.starts_with("WARNING"))
    .unwrap_or("The Azure CLI command failed.")
    .to_string();
  let kind = if LOGIN_RE.is_match(text) {
    AzErrorKind::NeedsLogin
  } else if BLOCKED_RE.is_match(text) {
    AzErrorKind::Blocked
  } else if NOT_FOUND_RE.is_match(text) {
    AzErrorKind::NotFound
  } else {
    AzErrorKind::Other
  };
  AzError { kind, message }
}

impl AzError {
  pub fn describe(&self, action: &str) -> String {
    match self.kind {
      AzErrorKind::Missing => format!("{action}: the Azure CLI isn't installed."),
      AzErrorKind::NeedsLogin => format!("{action}: your Azure sign-in has expired. Sign in to Azure again from setup."),
      _ => format!("{action}: {}", self.message),
    }
  }
}

async fn az(args: &[&str], timeout_ms: u64) -> Result<String, AzError> {
  let res = exec::run(
    "az",
    args,
    RunOptions {
      env: vec![("AZURE_CORE_ONLY_SHOW_ERRORS".into(), "true".into())],
      timeout_ms: Some(timeout_ms),
      ..Default::default()
    },
  )
  .await;
  if res.ok {
    Ok(res.stdout)
  } else {
    Err(classify(&res))
  }
}

async fn az_json(args: &[&str]) -> Result<Value, AzError> {
  let out = az(args, 90_000).await?;
  if out.trim().is_empty() {
    return Ok(Value::Null);
  }
  serde_json::from_str(out.trim())
    .map_err(|e| AzError { kind: AzErrorKind::Other, message: format!("Unexpected Azure CLI output: {e}") })
}

/// Write a JSON parameter file for `az … --parameters @file`.
fn param_file(value: &Value) -> Result<std::path::PathBuf, AzError> {
  let file = std::env::temp_dir().join(format!("fabricator-az-{}.json", uuid::Uuid::new_v4()));
  std::fs::write(&file, serde_json::to_vec(value).unwrap_or_default())
    .map_err(|e| AzError { kind: AzErrorKind::Other, message: format!("Could not prepare the Azure request: {e}") })?;
  Ok(file)
}

fn str_of(v: &Value, key: &str) -> Option<String> {
  v.get(key).and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty())
}

/// The signed-in account: (tenant id, user name).
pub async fn account() -> Result<(String, String), AzError> {
  let v = az_json(&["account", "show", "--output", "json"]).await?;
  let tenant = str_of(&v, "tenantId").ok_or(AzError { kind: AzErrorKind::NeedsLogin, message: "Not signed in.".into() })?;
  let user = v.get("user").and_then(|u| str_of(u, "name")).unwrap_or_default();
  Ok((tenant, user))
}

/// An access token for `resource` as the signed-in user.
pub async fn token(resource: &str) -> Result<String, AzError> {
  let out = az(
    &["account", "get-access-token", "--resource", resource, "--query", "accessToken", "--output", "tsv"],
    60_000,
  )
  .await?;
  let token = out.trim().to_string();
  if token.is_empty() {
    return Err(AzError { kind: AzErrorKind::NeedsLogin, message: "The Azure CLI returned no token.".into() });
  }
  Ok(token)
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppRegistration {
  /// Application (client) ID.
  pub app_id: String,
  /// Directory object ID of the application.
  pub object_id: String,
  pub display_name: String,
}

fn app_of(v: &Value) -> Option<AppRegistration> {
  Some(AppRegistration {
    app_id: str_of(v, "appId")?,
    object_id: str_of(v, "id")?,
    display_name: str_of(v, "displayName").unwrap_or_default(),
  })
}

/// Register a single-tenant application (the creator becomes its owner).
pub async fn create_app(display_name: &str) -> Result<AppRegistration, AzError> {
  let v = az_json(&[
    "ad",
    "app",
    "create",
    "--display-name",
    display_name,
    "--sign-in-audience",
    "AzureADMyOrg",
    "--output",
    "json",
  ])
  .await?;
  app_of(&v).ok_or(AzError { kind: AzErrorKind::Other, message: "Azure returned no application.".into() })
}

/// The application with this client ID, or `None` when it doesn't exist.
pub async fn app(app_id: &str) -> Result<Option<AppRegistration>, AzError> {
  match az_json(&["ad", "app", "show", "--id", app_id, "--output", "json"]).await {
    Ok(v) => Ok(app_of(&v)),
    Err(e) if e.kind == AzErrorKind::NotFound => Ok(None),
    Err(e) => Err(e),
  }
}

/// The object ID of the service principal for `app_id`, if it exists.
pub async fn service_principal(app_id: &str) -> Result<Option<String>, AzError> {
  match az_json(&["ad", "sp", "show", "--id", app_id, "--output", "json"]).await {
    Ok(v) => Ok(str_of(&v, "id")),
    Err(e) if e.kind == AzErrorKind::NotFound => Ok(None),
    Err(e) => Err(e),
  }
}

/// The service principal for `app_id`, created when missing. Returns its object ID.
pub async fn ensure_service_principal(app_id: &str) -> Result<String, AzError> {
  if let Some(id) = service_principal(app_id).await? {
    return Ok(id);
  }
  let v = az_json(&["ad", "sp", "create", "--id", app_id, "--output", "json"]).await?;
  str_of(&v, "id").ok_or(AzError { kind: AzErrorKind::Other, message: "Azure returned no service principal.".into() })
}

/// The application's federated credentials as (name, subject).
pub async fn federated_credentials(app_object_id: &str) -> Result<Vec<(String, String)>, AzError> {
  let v = az_json(&["ad", "app", "federated-credential", "list", "--id", app_object_id, "--output", "json"]).await?;
  Ok(
    v.as_array()
      .map(|items| {
        items
          .iter()
          .filter_map(|c| Some((str_of(c, "name")?, str_of(c, "subject").unwrap_or_default())))
          .collect()
      })
      .unwrap_or_default(),
  )
}

/// JSON body for a GitHub Actions federated credential.
pub fn federated_credential_body(name: &str, subject: &str) -> Value {
  json!({
    "name": name,
    "issuer": GITHUB_ISSUER,
    "subject": subject,
    "description": "GitHub Actions deploys for a Fabricator team workspace",
    "audiences": [TOKEN_EXCHANGE_AUDIENCE]
  })
}

/// Make sure the application trusts each (name, subject), adding or fixing them.
pub async fn ensure_federated_credentials(app_object_id: &str, wanted: &[(String, String)]) -> Result<(), AzError> {
  let existing = federated_credentials(app_object_id).await?;
  for (name, subject) in wanted {
    let current = existing.iter().find(|(n, _)| n == name);
    if current.is_some_and(|(_, s)| s == subject) {
      continue;
    }
    let file = param_file(&federated_credential_body(name, subject))?;
    let param = format!("@{}", file.to_string_lossy());
    let result = if current.is_some() {
      az(
        &[
          "ad",
          "app",
          "federated-credential",
          "update",
          "--id",
          app_object_id,
          "--federated-credential-id",
          name,
          "--parameters",
          &param,
        ],
        90_000,
      )
      .await
    } else {
      az(&["ad", "app", "federated-credential", "create", "--id", app_object_id, "--parameters", &param], 90_000)
        .await
    };
    let _ = std::fs::remove_file(&file);
    result?;
  }
  Ok(())
}

pub async fn delete_app(app_id: &str) -> Result<(), AzError> {
  match az(&["ad", "app", "delete", "--id", app_id], 90_000).await {
    Ok(_) => Ok(()),
    Err(e) if e.kind == AzErrorKind::NotFound => Ok(()),
    Err(e) => Err(e),
  }
}

/// Look up a person by sign-in name or email: (object id, display name).
pub async fn find_user(email: &str) -> Result<Option<(String, String)>, AzError> {
  match az_json(&["ad", "user", "show", "--id", email, "--output", "json"]).await {
    Ok(v) => return Ok(str_of(&v, "id").map(|id| (id, str_of(&v, "displayName").unwrap_or_default()))),
    Err(e) if e.kind == AzErrorKind::NotFound => {}
    Err(e) => return Err(e),
  }
  // Guests and aliases: match the mail attribute instead of the sign-in name.
  let safe = email.replace('\'', "''");
  let v = az_json(&["ad", "user", "list", "--filter", &format!("mail eq '{safe}'"), "--output", "json"]).await?;
  Ok(
    v.as_array()
      .and_then(|a| a.first())
      .and_then(|u| Some((str_of(u, "id")?, str_of(u, "displayName").unwrap_or_default()))),
  )
}

/// Instructions an administrator can follow when the user can't create the
/// deploy identity themselves.
pub fn admin_note(display_name: &str, repo: &str, subjects: &[(String, String)]) -> String {
  let mut note = format!(
    "Please create a deploy identity for the Fabricator team workspace \"{repo}\":\n\n\
     az ad app create --display-name \"{display_name}\" --sign-in-audience AzureADMyOrg\n\
     az ad sp create --id <appId>\n"
  );
  for (name, subject) in subjects {
    note.push_str(&format!(
      "az ad app federated-credential create --id <appObjectId> --parameters '{{\"name\":\"{name}\",\"issuer\":\"{GITHUB_ISSUER}\",\"subject\":\"{subject}\",\"audiences\":[\"{TOKEN_EXCHANGE_AUDIENCE}\"]}}'\n"
    ));
  }
  note.push_str("\nThen send me the application (client) ID so I can finish setup in Fabricator.");
  note
}

#[cfg(test)]
mod tests {
  use super::*;

  fn failed(stderr: &str) -> RunResult {
    RunResult { ok: false, exit_code: Some(1), stdout: String::new(), stderr: stderr.into(), not_found: false }
  }

  #[test]
  fn errors_are_classified_for_guidance() {
    let blocked = classify(&failed("ERROR: Insufficient privileges to complete the operation."));
    assert_eq!(blocked.kind, AzErrorKind::Blocked);
    assert_eq!(blocked.message, "Insufficient privileges to complete the operation.");
    assert_eq!(classify(&failed("ERROR: Please run 'az login' to setup account.")).kind, AzErrorKind::NeedsLogin);
    assert_eq!(
      classify(&failed("ERROR: Resource 'abc' does not exist or one of its queried reference-property objects are not present.")).kind,
      AzErrorKind::NotFound
    );
    assert_eq!(classify(&failed("ERROR: something else")).kind, AzErrorKind::Other);
    let missing = classify(&RunResult { ok: false, exit_code: None, stdout: String::new(), stderr: String::new(), not_found: true });
    assert_eq!(missing.kind, AzErrorKind::Missing);
  }

  #[test]
  fn federated_credential_body_targets_github_actions() {
    let body = federated_credential_body("fabricator-main", "repo:o/r:ref:refs/heads/main");
    assert_eq!(body["issuer"], GITHUB_ISSUER);
    assert_eq!(body["audiences"][0], TOKEN_EXCHANGE_AUDIENCE);
    assert_eq!(body["subject"], "repo:o/r:ref:refs/heads/main");
  }

  #[test]
  fn admin_note_lists_every_subject() {
    let subjects = vec![("a".to_string(), "repo:o/r:pull_request".to_string())];
    let note = admin_note("Fabricator deploy - Team", "o/r", &subjects);
    assert!(note.contains("az ad app create --display-name \"Fabricator deploy - Team\""));
    assert!(note.contains("repo:o/r:pull_request"));
  }
}
