/**
 * The bundled Fabricator templates must pass the quick checks out of the box:
 * a freshly created project should never open with a High or Medium finding.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import type { AdvisorPackage } from '@shared/ipc'
import { buildQuickContext } from './context'
import { runQuickRules } from './engine'
import { snapshotOf, versionInfo } from './testFixtures'

const TEMPLATES = resolve(__dirname, '../../../../resources/fabricator-templates')
const SKIP = new Set(['node_modules', '.git', 'dist'])
const TEXT = /\.(tsx?|jsx?|mjs|cjs|json|ya?ml|md|css|html)$|(^|\/)\.(env[^/]*|gitignore)$/

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        const rel = relative(root, full).split('\\').join('/')
        if (TEXT.test(rel) && statSync(full).size < 512 * 1024) out[rel] = readFileSync(full, 'utf8')
      }
    }
  }
  walk(root)
  return out
}

/** What a fresh scaffold installs: every declared Rayfin package at its pinned version. */
function installedPackages(files: Record<string, string>): AdvisorPackage[] {
  const pkg = JSON.parse(files['package.json'] ?? '{}')
  const out: AdvisorPackage[] = []
  for (const [deps, dev] of [
    [pkg.dependencies ?? {}, false],
    [pkg.devDependencies ?? {}, true]
  ] as const) {
    for (const [name, range] of Object.entries(deps as Record<string, string>)) {
      if (!name.startsWith('@microsoft/rayfin')) continue
      out.push({ name, declared: range, installed: range.replace(/^[\^~]/, ''), dev })
    }
  }
  return out
}

const templates = readdirSync(TEMPLATES).filter((name) => {
  const dir = join(TEMPLATES, name)
  return statSync(dir).isDirectory() && readdirSync(dir).includes('rayfin')
})

describe('bundled templates', () => {
  it('are discovered', () => {
    expect(templates).toEqual(expect.arrayContaining(['fabricator-universal', 'fabricator-todoapp']))
  })

  for (const name of templates) {
    it(`${name} has no high or medium quick-check findings`, async () => {
      const files = readTree(join(TEMPLATES, name))
      // `rayfin init` installs the Rayfin skill after scaffolding.
      files['.agents/skills/rayfin/SKILL.md'] = '# Rayfin\n'
      const snapshot = snapshotOf(files, { packages: installedPackages(files), isGitRepo: false })
      const ctx = await buildQuickContext(snapshot, versionInfo())
      const { findings, results } = runQuickRules(ctx)
      const serious = findings
        .filter((f) => f.severity === 'high' || f.severity === 'medium')
        .map((f) => `${f.ruleId}: ${f.detail}`)
      expect(serious).toEqual([])
      expect(results.filter((r) => r.status === 'skipped')).toEqual([])
    })
  }
})
