/**
 * Masks credential-looking values in evidence excerpts so the Advisor never
 * displays a secret in full (mirrors `mask_secrets` in the Rust backend).
 */

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g

const SECRET_TOKENS =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AccountKey=[A-Za-z0-9+/=]{20,})/g

const SECRET_ASSIGNMENT =
  /((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|token|connection[_-]?string|conn[_-]?str)["']?\s*[:=]\s*["'`]?)([^"'`\s;,]{6,})/gi

export function maskValue(value: string): string {
  return `${value.slice(0, 4)}••••••`
}

export function maskSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, '-----BEGIN PRIVATE KEY----- •••••• (masked)')
    .replace(SECRET_TOKENS, (m) => maskValue(m))
    .replace(SECRET_ASSIGNMENT, (whole, prefix: string, value: string) =>
      value.startsWith('${') || value.startsWith('process.env') || value.startsWith('import.meta')
        ? whole
        : `${prefix}${maskValue(value)}`
    )
}

/** Mask everything after `=` on env-file lines (values are never shown). */
export function maskEnvValues(text: string): string {
  return text.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.+)$/gm, (_m, key: string, value: string) =>
    value.trim() ? `${key}${maskValue(value.trim().replace(/^['"]/, ''))}` : `${key}${value}`
  )
}
