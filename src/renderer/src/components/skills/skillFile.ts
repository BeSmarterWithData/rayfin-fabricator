import { parse as parseYaml } from 'yaml'

/** What a SKILL.md tells the reader beyond its card. */
export interface SkillFile {
  /** When the agent uses the skill: the frontmatter description without its trigger list. */
  when: string
  /** Phrases from the description's "Triggers:" list. */
  triggers: string[]
  /** The guidance itself: the markdown body without its leading title. */
  body: string
}

const FRONTMATTER = /^\uFEFF?---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/

/** Split a SKILL.md into its "when" text, trigger phrases and markdown body. */
export function parseSkillFile(raw: string): SkillFile {
  const text = raw.replace(/\r\n?/g, '\n')
  const match = FRONTMATTER.exec(text)
  let description = ''
  if (match) {
    try {
      const meta: unknown = parseYaml(match[1])
      const value = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).description : null
      if (typeof value === 'string') description = value
    } catch {
      // Unreadable frontmatter: the body still shows.
    }
  }
  const rest = match ? text.slice(match[0].length) : text
  const body = rest.replace(/^\s*# [^\n]*\n*/, '').trim()
  return { ...splitTriggers(description), body }
}

/** "Use when … Triggers: a, b, c" → the text before the list, and the list. */
export function splitTriggers(description: string): { when: string; triggers: string[] } {
  const flat = description.replace(/\s+/g, ' ').trim()
  const found = /\bTriggers?:\s*/i.exec(flat)
  if (!found) return { when: flat, triggers: [] }
  const triggers = flat
    .slice(found.index + found[0].length)
    .split(/,\s*/)
    .map((t) => t.trim().replace(/[.;]+$/, ''))
    .filter((t) => t.length > 0 && t.length <= 48)
  return { when: flat.slice(0, found.index).trim(), triggers: [...new Set(triggers)] }
}
