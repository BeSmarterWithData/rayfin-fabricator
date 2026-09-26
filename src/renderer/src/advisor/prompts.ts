/**
 * Prompts that hand Advisor findings to the Build chat for Copilot to fix.
 */
import type { AdvisorFinding } from '@shared/ipc'
import { categoryById, ruleById, severityLabel, severityRank } from '@shared/advisor/catalog'
import { langFromPath } from '../syntax'

const GUIDANCE =
  'Before changing Rayfin APIs, confirm them in the version-matched docs — ' +
  '`.agents/skills/rayfin/SKILL.md` and `node_modules/@microsoft/rayfin-guide/assets/docs/` — ' +
  'or the linked rayfin.ai pages, and only use documented APIs. Keep the app building and follow ' +
  'Rayfin conventions. Do not run `rayfin up` or deploy — Fabricator redeploys automatically.'

function location(f: AdvisorFinding): string | undefined {
  if (!f.file) return undefined
  const main = f.line ? `${f.file}:${f.line}` : f.file
  const others = (f.locations ?? []).map((l) => (l.line ? `${l.file}:${l.line}` : l.file))
  return others.length ? `${main} (also ${others.join(', ')})` : main
}

function docsOf(f: AdvisorFinding): string[] {
  const urls = (ruleById(f.ruleId)?.docs ?? []).map((d) => d.url)
  if (f.docsUrl) urls.unshift(f.docsUrl)
  return [...new Set(urls)]
}

function describe(f: AdvisorFinding): string[] {
  const rule = ruleById(f.ruleId)
  const category = categoryById(f.category)?.title ?? f.category
  const lines = [
    `Issue: ${f.title}${rule ? ` [${rule.id}]` : ''}`,
    `Severity: ${severityLabel(f.severity)} · Category: ${category}`
  ]
  const where = location(f)
  if (where) lines.push(`Location: ${where}`)
  lines.push(`Problem: ${f.detail}`)
  if (rule) lines.push(`Why it matters: ${rule.why}`)
  lines.push(`Suggested fix: ${f.recommendation}`)
  if (f.excerpt) {
    const lang = f.file ? (langFromPath(f.file) ?? '') : ''
    lines.push(`Code${f.excerptStart ? ` (from line ${f.excerptStart})` : ''}:`, '```' + lang, f.excerpt, '```')
  }
  return lines
}

/** A chat hand-off for one or more findings, most severe first. */
export function fixPrompt(findings: AdvisorFinding[]): { display: string; prompt: string } {
  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  if (sorted.length === 1) {
    const f = sorted[0]
    const docs = docsOf(f)
    const prompt = [
      'The Advisor flagged an issue in this app. Please fix it.',
      '',
      ...describe(f),
      ...(docs.length ? ['', `Rayfin guidance: ${docs.join(' · ')}`] : []),
      '',
      GUIDANCE
    ].join('\n')
    return { display: `Fix: ${f.title}`, prompt }
  }
  const blocks = sorted.map((f, i) =>
    describe(f)
      .map((line, j) => (j === 0 ? `${i + 1}. ${line}` : `   ${line}`))
      .join('\n')
  )
  const docs = [...new Set(sorted.flatMap(docsOf))]
  const prompt = [
    `The Advisor found ${sorted.length} issues in this app. Please fix all of them, most severe first.`,
    '',
    blocks.join('\n\n'),
    ...(docs.length ? ['', `Rayfin guidance: ${docs.join(' · ')}`] : []),
    '',
    GUIDANCE
  ].join('\n')
  return { display: `Fix ${sorted.length} Advisor issues`, prompt }
}

/** Version findings go through the dedicated Rayfin upgrade hand-off instead. */
export function isVersionFinding(f: AdvisorFinding): boolean {
  return f.ruleId === 'platform/cli-outdated' || f.ruleId === 'platform/sdk-outdated'
}
