//! Files Fabricator writes into a team workspace repository: the managed
//! deploy workflow, a README, a root `.gitignore`, and the workspace manifest.
//!
//! The workflow signs in to Entra ID through GitHub OIDC (`azure/login` with no
//! subscription), mints a Fabric API token, and hands it to the Rayfin CLI as
//! `RAYFIN_TOKEN` (`rayfin up` only needs the Fabric scope). No secrets are
//! stored in the repository: the variables hold IDs only.

use crate::types::TeamManifest;

use super::MIN_RAYFIN;

/// Bump when [`WORKFLOW`] changes so existing workspaces are offered an update.
pub const TEMPLATE_VERSION: u32 = 3;

const WORKFLOW: &str = r##"# Managed by Fabricator (team workspace template v{{VERSION}}).
# Fabricator replaces this file when its template changes, so edits here may be lost.
#
# Every top-level folder that contains rayfin/rayfin.yml is a Rayfin app.
# - Pull requests deploy a personal preview of the changed apps for their author.
# - Pushes to main deploy the published apps.
# Jobs sign in through GitHub OIDC: pull requests as the preview identity (which
# can only reach the previews workspace), main as the deploy identity.
# No secrets are stored here; the repository variables hold IDs only.
name: Fabricator

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      action:
        description: Deploy apps, or only check that the pipeline can reach Fabric
        type: choice
        options: [deploy, verify]
        default: deploy
      project:
        description: App folder to deploy (leave blank for every app)
        type: string
        required: false
      force:
        description: Allow data-model changes that delete data
        type: boolean
        default: false

permissions:
  contents: read
  id-token: write
  deployments: write

env:
  FABRIC_WORKSPACE_ID: ${{ vars.FABRIC_WORKSPACE_ID }}
  FABRIC_PREVIEW_WORKSPACE_ID: ${{ vars.FABRIC_PREVIEW_WORKSPACE_ID }}

jobs:
  plan:
    name: Plan
    runs-on: ubuntu-latest
    outputs:
      mode: ${{ steps.plan.outputs.mode }}
      projects: ${{ steps.plan.outputs.projects }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: plan
        name: Find the apps to deploy
        shell: bash
        env:
          EVENT: ${{ github.event_name }}
          BEFORE: ${{ github.event.before }}
          PR_BASE: ${{ github.event.pull_request.base.sha }}
          INPUT_ACTION: ${{ inputs.action }}
          INPUT_PROJECT: ${{ inputs.project }}
        run: |
          set -euo pipefail
          all_projects() {
            for dir in */; do
              dir="${dir%/}"
              if [ -f "$dir/rayfin/rayfin.yml" ]; then echo "$dir"; fi
            done
          }
          mode=production
          if [ "$EVENT" = "pull_request" ]; then mode=preview; fi
          if [ "$EVENT" = "workflow_dispatch" ] && [ "${INPUT_ACTION:-deploy}" = "verify" ]; then
            echo "mode=verify" >> "$GITHUB_OUTPUT"
            echo "projects=[]" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if [ "$EVENT" = "workflow_dispatch" ]; then
            if [ -n "${INPUT_PROJECT:-}" ]; then
              if ! [[ "$INPUT_PROJECT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || [[ "$INPUT_PROJECT" == *..* ]]; then
                echo "::error::'$INPUT_PROJECT' isn't an app folder name."
                exit 1
              fi
              list="$INPUT_PROJECT"
            else
              list="$(all_projects)"
            fi
          else
            base="$BEFORE"
            if [ "$EVENT" = "pull_request" ]; then base="$PR_BASE"; fi
            if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
              list="$(all_projects)"
            else
              list="$(git diff --name-only "$base" "$GITHUB_SHA" | grep / | cut -d/ -f1 | sort -u || true)"
            fi
          fi
          projects="[]"
          for project in $list; do
            if [ -f "$project/rayfin/rayfin.yml" ]; then
              projects="$(jq -c --arg p "$project" '. + [$p]' <<< "$projects")"
            fi
          done
          echo "mode=$mode" >> "$GITHUB_OUTPUT"
          echo "projects=$projects" >> "$GITHUB_OUTPUT"
          echo "Mode: $mode. Apps: $projects"

  verify:
    name: Verify Fabric access
    needs: plan
    if: needs.plan.outputs.mode == 'verify'
    runs-on: ubuntu-latest
    steps:
      - name: Sign in as the deploy identity
        uses: azure/login@v3
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          allow-no-subscriptions: true
      - name: Check the published apps' workspace
        shell: bash
        env:
          WORKSPACE: ${{ vars.FABRIC_WORKSPACE_ID }}
        run: |
          set -euo pipefail
          token="$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)"
          echo "::add-mask::$token"
          code="$(curl -sS -o "$RUNNER_TEMP/workspace.json" -w '%{http_code}' -H "Authorization: Bearer $token" "https://api.fabric.microsoft.com/v1/workspaces/$WORKSPACE")"
          if [ "$code" != "200" ]; then
            echo "::error title=Fabric access::Workspace $WORKSPACE returned HTTP $code: $(head -c 400 "$RUNNER_TEMP/workspace.json")"
            exit 1
          fi
          echo "Fabric workspace $WORKSPACE is reachable."
      - name: Sign in as the preview identity
        uses: azure/login@v3
        with:
          client-id: ${{ vars.AZURE_PREVIEW_CLIENT_ID || vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          allow-no-subscriptions: true
      - name: Check the previews workspace
        shell: bash
        env:
          WORKSPACE: ${{ vars.FABRIC_PREVIEW_WORKSPACE_ID }}
        run: |
          set -euo pipefail
          token="$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)"
          echo "::add-mask::$token"
          code="$(curl -sS -o "$RUNNER_TEMP/workspace.json" -w '%{http_code}' -H "Authorization: Bearer $token" "https://api.fabric.microsoft.com/v1/workspaces/$WORKSPACE")"
          if [ "$code" != "200" ]; then
            echo "::error title=Fabric access::Workspace $WORKSPACE returned HTTP $code: $(head -c 400 "$RUNNER_TEMP/workspace.json")"
            exit 1
          fi
          echo "Fabric workspace $WORKSPACE is reachable."

  deploy:
    name: ${{ needs.plan.outputs.mode == 'preview' && 'Preview' || 'Deploy' }} ${{ matrix.project }}
    needs: plan
    if: needs.plan.outputs.mode != 'verify' && needs.plan.outputs.projects != '[]'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        project: ${{ fromJSON(needs.plan.outputs.projects) }}
    concurrency:
      group: fabricator-${{ needs.plan.outputs.mode }}-${{ matrix.project }}-${{ github.event.pull_request.user.login || 'main' }}
      cancel-in-progress: ${{ needs.plan.outputs.mode == 'preview' }}
    env:
      MODE: ${{ needs.plan.outputs.mode }}
      PROJECT: ${{ matrix.project }}
      AUTHOR: ${{ github.event.pull_request.user.login }}
      HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}
      FORCE: ${{ inputs.force }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - id: target
        name: Choose where to deploy
        shell: bash
        run: |
          set -euo pipefail
          item_name() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-60; }
          if [ "$MODE" = "preview" ]; then
            login="$(printf '%s' "$AUTHOR" | tr '[:upper:]' '[:lower:]')"
            {
              echo "workspace=$FABRIC_PREVIEW_WORKSPACE_ID"
              echo "item=$(item_name "$PROJECT-pv-$login")"
              echo "environment=preview/$PROJECT/$login"
              echo "force=--force"
            } >> "$GITHUB_OUTPUT"
          else
            force=""
            if [ "${FORCE:-false}" = "true" ]; then force="--force"; fi
            {
              echo "workspace=$FABRIC_WORKSPACE_ID"
              echo "item=$(item_name "$PROJECT")"
              echo "environment=production/$PROJECT"
              echo "force=$force"
            } >> "$GITHUB_OUTPUT"
          fi
      - name: Install dependencies
        working-directory: ${{ matrix.project }}
        shell: bash
        run: |
          if [ -f package-lock.json ]; then npm ci; else npm install; fi
      - id: rayfin
        name: Check the Rayfin version
        working-directory: ${{ matrix.project }}
        shell: bash
        run: |
          # Deploying by item name needs Rayfin {{MIN_RAYFIN}} or newer.
          help="$(npx --no-install rayfin up --help 2>&1 || true)"
          if ! grep -q -- '--item-name' <<<"$help"; then
            found="$(node -p "require('./node_modules/@microsoft/rayfin-cli/package.json').version" 2>/dev/null || echo none)"
            echo "reason=rayfin-update" >> "$GITHUB_OUTPUT"
            echo "::error title=Rayfin update needed::$PROJECT uses Rayfin CLI $found. Team workspaces need Rayfin {{MIN_RAYFIN}} or newer: open the app in Fabricator, select Rayfin in the status bar and choose Update with Copilot."
            exit 1
          fi
      - name: Sign in to Fabric
        uses: azure/login@v3
        with:
          # Pull requests can only use the preview identity.
          client-id: ${{ needs.plan.outputs.mode == 'preview' && (vars.AZURE_PREVIEW_CLIENT_ID || vars.AZURE_CLIENT_ID) || vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          allow-no-subscriptions: true
      - id: deploy
        name: Deploy with Rayfin
        working-directory: ${{ matrix.project }}
        shell: bash
        env:
          WORKSPACE: ${{ steps.target.outputs.workspace }}
          ITEM: ${{ steps.target.outputs.item }}
          FORCE_FLAG: ${{ steps.target.outputs.force }}
        run: |
          set -uo pipefail
          RAYFIN_TOKEN="$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)"
          echo "::add-mask::$RAYFIN_TOKEN"
          export RAYFIN_TOKEN
          npx rayfin up --workspace-id "$WORKSPACE" --item-name "$ITEM" --yes $FORCE_FLAG 2>&1 | tee "$RUNNER_TEMP/deploy.log"
          code="${PIPESTATUS[0]}"
          if [ "$code" != "0" ]; then
            # The Rayfin CLI refuses data-model or storage changes that delete data.
            if grep -qiE 'use --force to apply (destructive|storage) changes' "$RUNNER_TEMP/deploy.log"; then
              echo "reason=data-loss" >> "$GITHUB_OUTPUT"
              echo "::error title=Deploy stopped::This change would delete data in the published app. Publish it again from Fabricator and confirm to allow it."
            fi
            exit "$code"
          fi
          npx rayfin up status --json > "$RUNNER_TEMP/status.json" 2>/dev/null || true
          if [ -f rayfin/.deployments.json ]; then cp rayfin/.deployments.json "$RUNNER_TEMP/deployments.json"; fi
          # The app's public settings (also built into its web page), so Fabricator
          # can run a local preview against this deployment.
          if [ -f rayfin/.env ]; then grep -E '^RAYFIN_PUBLIC_[A-Z0-9_]+=' rayfin/.env > "$RUNNER_TEMP/public.env" || true; fi
      - name: Record the deployment
        # Not for runs a newer push cancelled: the newer run records instead.
        if: ${{ !cancelled() && steps.target.outputs.environment != '' }}
        uses: actions/github-script@v9
        env:
          ENVIRONMENT: ${{ steps.target.outputs.environment }}
          OUTCOME: ${{ steps.deploy.outcome }}
          REASON: ${{ steps.deploy.outputs.reason || steps.rayfin.outputs.reason }}
        with:
          script: |
            const fs = require('fs')
            const path = require('path')
            const read = (name) => {
              try { return fs.readFileSync(path.join(process.env.RUNNER_TEMP, name), 'utf8') } catch { return '' }
            }
            let entry = {}
            try {
              const registry = JSON.parse(read('deployments.json'))
              const all = registry.deployments || {}
              entry = all[registry.active] || Object.values(all)[0] || {}
            } catch {}
            let status = {}
            for (const line of read('status.json').split('\n').reverse()) {
              try {
                const parsed = JSON.parse(line)
                if (parsed && typeof parsed === 'object') { status = parsed.deployment || {}; break }
              } catch {}
            }
            const scraped = (read('deploy.log').match(/(?:Hosting URL|Static app):\s*(\S+)/i) || [])[1]
            const publicEnv = {}
            for (const line of read('public.env').split('\n')) {
              const m = line.trim().match(/^(RAYFIN_PUBLIC_[A-Z0-9_]+)=(.*)$/)
              if (m && m[1] !== 'RAYFIN_PUBLIC_FRONTEND_PORT') publicEnv[m[1]] = m[2]
            }
            const payload = {
              project: process.env.PROJECT,
              mode: process.env.MODE,
              headSha: process.env.HEAD_SHA,
              itemId: entry.fabricItemId || status.fabricItemId || null,
              workspaceId: entry.fabricWorkspaceId || status.fabricWorkspaceId || null,
              apiUrl: entry.fabricApiUrl || status.rayfinApiUrl || null,
              hostingUrl: entry.hostingUrl || status.hostingUrl || scraped || null,
              portalUrl: entry.fabricDeepLink || status.fabricPortalUrl || null,
              publicEnv: Object.keys(publicEnv).length ? publicEnv : null,
              reason: process.env.REASON || null
            }
            const ok = process.env.OUTCOME === 'success'
            const { owner, repo } = context.repo
            const deployment = await github.rest.repos.createDeployment({
              owner,
              repo,
              ref: process.env.HEAD_SHA,
              environment: process.env.ENVIRONMENT,
              auto_merge: false,
              required_contexts: [],
              transient_environment: process.env.MODE === 'preview',
              production_environment: process.env.MODE !== 'preview',
              description: `Fabricator ${process.env.MODE} of ${process.env.PROJECT}`,
              payload
            })
            await github.rest.repos.createDeploymentStatus({
              owner,
              repo,
              deployment_id: deployment.data.id,
              state: ok ? 'success' : 'failure',
              environment_url: ok && payload.hostingUrl ? payload.hostingUrl : undefined,
              log_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
              description: ok ? 'deployed' : (payload.reason || 'failed'),
              auto_inactive: true
            })
"##;

const README: &str = r##"# {{NAME}}

This repository is a **Fabricator team workspace**. Each top-level folder is a Rayfin app.

- Open it in Fabricator (Settings → Experiments → Team workspaces) to build the apps with your team.
- Fabricator works on a branch for you, opens a pull request, and publishes by merging it.
- The `Fabricator` workflow deploys a personal preview for each pull request and the published app for `main`.
  It signs in to Microsoft Fabric as the workspace's service principal through GitHub OIDC; no secrets are stored.

Each folder's name is also its app's name in Fabric, so don't rename the folders.
"##;

const GITIGNORE: &str = "node_modules/\n.DS_Store\n";

/// The managed deploy workflow.
pub fn workflow() -> String {
  WORKFLOW
    .replace("{{VERSION}}", &TEMPLATE_VERSION.to_string())
    .replace("{{MIN_RAYFIN}}", MIN_RAYFIN)
}

pub fn readme(name: &str) -> String {
  let title: String = name.chars().filter(|c| *c != '\n' && *c != '\r').collect();
  README.replace("{{NAME}}", title.trim())
}

pub fn gitignore() -> &'static str {
  GITIGNORE
}

/// Pretty JSON for `fabricator.workspace.json`.
pub fn manifest_json(manifest: &TeamManifest) -> String {
  let mut text = serde_json::to_string_pretty(manifest).unwrap_or_else(|_| "{}".into());
  text.push('\n');
  text
}

/// Parse `fabricator.workspace.json`.
pub fn parse_manifest(text: &str) -> Option<TeamManifest> {
  serde_json::from_str(text).ok()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::services::team::naming;
  use crate::types::{TeamDeployIdentity, TeamFabricTargets, TeamFabricWorkspace, TeamSettings};

  fn yaml() -> serde_yaml::Value {
    serde_yaml::from_str(&workflow()).expect("workflow is valid YAML")
  }

  #[test]
  fn workflow_is_valid_yaml_with_the_expected_jobs_and_triggers() {
    let doc = yaml();
    let jobs = doc["jobs"].as_mapping().unwrap();
    for job in ["plan", "verify", "deploy"] {
      assert!(jobs.contains_key(job), "missing job {job}");
    }
    // YAML 1.2 (serde_yaml) reads `on` as a string; YAML 1.1 parsers read it as true.
    let on = doc
      .as_mapping()
      .unwrap()
      .iter()
      .find(|(k, _)| k.as_str() == Some("on") || k.as_bool() == Some(true))
      .map(|(_, v)| v)
      .expect("triggers");
    assert!(on.get("pull_request").is_some());
    assert!(on.get("workflow_dispatch").is_some());
    assert_eq!(doc["permissions"]["id-token"].as_str(), Some("write"));
    assert_eq!(doc["permissions"]["deployments"].as_str(), Some("write"));
    assert!(workflow().starts_with(&format!("# Managed by Fabricator (team workspace template v{TEMPLATE_VERSION})")));
  }

  #[test]
  fn workflow_never_references_secrets_and_uses_oidc() {
    let text = workflow();
    assert!(!text.contains("secrets."));
    assert!(text.contains("azure/login@v3"));
    assert!(text.contains("allow-no-subscriptions: true"));
    assert!(text.contains("RAYFIN_TOKEN"));
    assert!(text.contains("--item-name \"$ITEM\" --yes $FORCE_FLAG"));
  }

  #[test]
  fn pull_requests_deploy_with_the_preview_identity() {
    let text = workflow();
    assert!(text.contains(
      "client-id: ${{ needs.plan.outputs.mode == 'preview' && (vars.AZURE_PREVIEW_CLIENT_ID || vars.AZURE_CLIENT_ID) || vars.AZURE_CLIENT_ID }}"
    ));
    // Verification checks each identity against its own workspace.
    let doc = yaml();
    let steps = doc["jobs"]["verify"]["steps"].as_sequence().unwrap();
    let logins: Vec<&str> = steps
      .iter()
      .filter(|s| s["uses"].as_str() == Some("azure/login@v3"))
      .map(|s| s["with"]["client-id"].as_str().unwrap())
      .collect();
    assert_eq!(
      logins,
      vec!["${{ vars.AZURE_CLIENT_ID }}", "${{ vars.AZURE_PREVIEW_CLIENT_ID || vars.AZURE_CLIENT_ID }}"]
    );
  }

  #[test]
  fn workflow_names_match_the_app() {
    let text = workflow();
    // The same sanitizer as naming::item_name, and the same environments.
    assert!(text.contains("sed 's/[^a-z0-9-]/-/g' | cut -c1-60"));
    assert!(text.contains("item_name \"$PROJECT-pv-$login\""));
    assert!(text.contains("environment=preview/$PROJECT/$login"));
    assert!(text.contains("environment=production/$PROJECT"));
    assert_eq!(naming::preview_environment("app", "amy"), "preview/app/amy");
    assert_eq!(naming::preview_item("app", "Amy"), "app-pv-amy");
  }

  #[test]
  fn production_deploys_need_explicit_force_and_previews_always_force() {
    let text = workflow();
    assert!(text.contains("echo \"force=--force\""));
    assert!(text.contains("if [ \"${FORCE:-false}\" = \"true\" ]; then force=\"--force\"; fi"));
  }

  #[test]
  fn data_loss_is_recorded_only_for_the_clis_refusal() {
    let text = workflow();
    assert!(text.contains("grep -qiE 'use --force to apply (destructive|storage) changes' \"$RUNNER_TEMP/deploy.log\""));
    assert!(text.contains("echo \"reason=data-loss\" >> \"$GITHUB_OUTPUT\""));
  }

  #[test]
  fn deployments_record_only_the_apps_public_settings() {
    let text = workflow();
    assert!(text.contains("grep -E '^RAYFIN_PUBLIC_[A-Z0-9_]+=' rayfin/.env > \"$RUNNER_TEMP/public.env\""));
    assert!(text.contains("m[1] !== 'RAYFIN_PUBLIC_FRONTEND_PORT'"));
    assert!(text.contains("publicEnv: Object.keys(publicEnv).length ? publicEnv : null"));
  }

  #[test]
  fn an_outdated_rayfin_cli_stops_before_signing_in_and_is_recorded() {
    let text = workflow();
    assert!(!text.contains("{{MIN_RAYFIN}}"));
    assert!(text.contains(&format!("need Rayfin {MIN_RAYFIN} or newer")));
    let doc = yaml();
    let steps = doc["jobs"]["deploy"]["steps"].as_sequence().unwrap();
    let position = |name: &str| steps.iter().position(|s| s["name"].as_str() == Some(name)).unwrap();
    assert!(position("Install dependencies") < position("Check the Rayfin version"));
    assert!(position("Check the Rayfin version") < position("Sign in to Fabric"));
    let check = &steps[position("Check the Rayfin version")];
    assert_eq!(check["id"].as_str(), Some("rayfin"));
    // Only the project's own CLI counts: never download a package named `rayfin`.
    assert!(check["run"].as_str().unwrap().contains("npx --no-install rayfin up --help"));
    let record = &steps[position("Record the deployment")];
    assert_eq!(
      record["env"]["REASON"].as_str(),
      Some("${{ steps.deploy.outputs.reason || steps.rayfin.outputs.reason }}")
    );
  }

  #[test]
  fn cancelled_runs_dont_record_deployments_or_restart_on_ready() {
    let doc = yaml();
    let steps = doc["jobs"]["deploy"]["steps"].as_sequence().unwrap();
    let record = steps.iter().find(|s| s["name"].as_str() == Some("Record the deployment")).unwrap();
    assert_eq!(record["if"].as_str(), Some("${{ !cancelled() && steps.target.outputs.environment != '' }}"));
    // Marking a draft ready mustn't start a second preview run that cancels the first.
    let on = doc
      .as_mapping()
      .unwrap()
      .iter()
      .find(|(k, _)| k.as_str() == Some("on"))
      .map(|(_, v)| v)
      .unwrap();
    let types: Vec<&str> = on["pull_request"]["types"].as_sequence().unwrap().iter().filter_map(|t| t.as_str()).collect();
    assert_eq!(types, vec!["opened", "synchronize", "reopened"]);
  }

  #[test]
  fn manifest_round_trips() {
    let manifest = TeamManifest {
      schema: 1,
      name: "Acme".into(),
      tenant_id: "t".into(),
      deploy_identity: TeamDeployIdentity { client_id: "c".into(), display_name: "d".into() },
      preview_identity: TeamDeployIdentity { client_id: "pc".into(), display_name: "pd".into() },
      fabric: TeamFabricTargets {
        production: TeamFabricWorkspace { id: "p".into(), name: "Acme".into() },
        previews: TeamFabricWorkspace { id: "v".into(), name: "Acme previews".into() },
      },
      settings: TeamSettings { require_review: true },
      template_version: TEMPLATE_VERSION,
    };
    let text = manifest_json(&manifest);
    assert!(text.contains("\"requireReview\": true"));
    assert_eq!(parse_manifest(&text), Some(manifest));
    assert_eq!(parse_manifest("{}").unwrap().schema, 1);
  }

  #[test]
  fn readme_uses_the_workspace_name() {
    assert!(readme("Acme\nOps").starts_with("# AcmeOps\n"));
  }
}
