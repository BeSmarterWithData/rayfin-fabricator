/**
 * The read model the quick-check rules run against, built once per run from an
 * `advisor.collect` snapshot plus the project's Rayfin version report.
 */
import { parse as parseYaml } from 'yaml'
import type {
  AdvisorCondition,
  AdvisorPackage,
  AdvisorProjectFile,
  AdvisorProjectSnapshot,
  RayfinVersionInfo
} from '@shared/ipc'
import { parseDataModel, type DataModel } from '../model/parseSchema'
import { sourceFile, type SourceFile } from './source'

const CODE_FILE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i
const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)__tests__\/|(^|\/)tests?\/)/i

type Obj = Record<string, unknown>

export interface PackageJsonInfo {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  scripts: Record<string, string>
}

export interface QuickContext {
  snapshot: AdvisorProjectSnapshot
  /** A collected text file, comment-masked, by project-relative path. */
  file(path: string): SourceFile | undefined
  /** Collected text files whose path matches. */
  sources(match: (path: string) => boolean): SourceFile[]
  /** Runtime frontend code under `src/` (tests excluded). */
  frontend: SourceFile[]
  /** Listing metadata for any project file (collected or not). */
  fileInfo(path: string): AdvisorProjectFile | undefined
  exists(path: string): boolean
  /** Parsed `rayfin/rayfin.yml`, or null when missing or unreadable. */
  yml: { path: string; text: string; data: Obj } | null
  /** `services.<name>` from rayfin.yml, when it's an object. */
  service(name: string): Obj | undefined
  /** True when `services.<name>.enabled` is exactly `true`. */
  enabled(name: string): boolean
  packageJson: PackageJsonInfo | null
  /** Every dependency declared in package.json (prod and dev). */
  hasDependency(name: string): boolean
  model: DataModel
  conditions: Set<AdvisorCondition>
  versions: RayfinVersionInfo | null
  packages: AdvisorPackage[]
}

function asObj(value: unknown): Obj | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined
}

function asStringMap(value: unknown): Record<string, string> {
  const obj = asObj(value)
  if (!obj) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v
  return out
}

export function isRuntimeFrontendFile(path: string): boolean {
  return path.startsWith('src/') && CODE_FILE.test(path) && !TEST_FILE.test(path.slice(4))
}

export async function buildQuickContext(
  snapshot: AdvisorProjectSnapshot,
  versions: RayfinVersionInfo | null
): Promise<QuickContext> {
  const cache = new Map<string, SourceFile>()
  const file = (path: string): SourceFile | undefined => {
    const hit = cache.get(path)
    if (hit) return hit
    const text = snapshot.contents[path]
    if (text === undefined) return undefined
    const src = sourceFile(path, text)
    cache.set(path, src)
    return src
  }
  const sources = (match: (path: string) => boolean): SourceFile[] =>
    Object.keys(snapshot.contents)
      .filter(match)
      .sort()
      .map((p) => file(p) as SourceFile)
  const listing = new Map(snapshot.files.map((f) => [f.path, f]))

  let yml: QuickContext['yml'] = null
  for (const path of ['rayfin/rayfin.yml', 'rayfin/rayfin.yaml']) {
    const text = snapshot.contents[path]
    if (text === undefined) continue
    try {
      const data = asObj(parseYaml(text)) ?? {}
      yml = { path, text, data }
    } catch {
      yml = { path, text, data: {} }
    }
    break
  }
  const services = asObj(yml?.data.services) ?? {}
  const service = (name: string): Obj | undefined => asObj(services[name])
  const enabled = (name: string): boolean => service(name)?.enabled === true

  let packageJson: PackageJsonInfo | null = null
  const rawPackage = snapshot.contents['package.json']
  if (rawPackage !== undefined) {
    try {
      const pkg = asObj(JSON.parse(rawPackage)) ?? {}
      packageJson = {
        dependencies: asStringMap(pkg.dependencies),
        devDependencies: asStringMap(pkg.devDependencies),
        scripts: asStringMap(pkg.scripts)
      }
    } catch {
      packageJson = null
    }
  }
  const hasDependency = (name: string): boolean =>
    Boolean(packageJson && (name in packageJson.dependencies || name in packageJson.devDependencies))

  const model = await parseDataModel(async (path) => snapshot.contents[path] ?? null)

  const rayfinPaths = Object.keys(snapshot.contents).filter((p) => p.startsWith('rayfin/'))
  const anyFileUnder = (prefix: string): boolean =>
    snapshot.files.some((f) => f.path.startsWith(prefix))
  const connectorsBlock = yml?.data.connectors
  const hasConnectorEntries = Array.isArray(connectorsBlock)
    ? connectorsBlock.length > 0
    : Boolean(asObj(connectorsBlock) && Object.keys(asObj(connectorsBlock)!).length > 0)
  const conditions = new Set<AdvisorCondition>()
  if (enabled('data') || model.entities.length > 0) conditions.add('data')
  if (enabled('auth')) conditions.add('auth')
  if (asObj(service('auth')?.fabric)?.enabled === true || hasDependency('@microsoft/rayfin-auth-provider-fabric')) {
    conditions.add('fabricSso')
  }
  if (
    enabled('storage') ||
    rayfinPaths.some((p) => /@blob\s*\(/.test(snapshot.contents[p] ?? ''))
  ) {
    conditions.add('storage')
  }
  if (enabled('functions') || anyFileUnder('rayfin/functions/')) conditions.add('functions')
  if (
    enabled('connectors') ||
    hasConnectorEntries ||
    anyFileUnder('rayfin/connectors/') ||
    snapshot.packages.some((p) => /^@microsoft\/rayfin-connector/.test(p.name) && p.declared)
  ) {
    conditions.add('connectors')
  }
  if (enabled('staticHosting')) conditions.add('hosting')

  return {
    snapshot,
    file,
    sources,
    frontend: sources(isRuntimeFrontendFile),
    fileInfo: (path) => listing.get(path),
    exists: (path) => listing.has(path) || snapshot.contents[path] !== undefined,
    yml,
    service,
    enabled,
    packageJson,
    hasDependency,
    model,
    conditions,
    versions,
    packages: snapshot.packages
  }
}
