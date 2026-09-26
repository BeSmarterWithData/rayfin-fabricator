import type { QuickHit, QuickRuleImpl } from '../quick'
import { lineOf, matchAll, methodCalls, statementAround, stringLiterals } from '../source'
import { code, regexHits } from './util'

const DOT_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/

export const queryRules: QuickRuleImpl[] = [
  {
    id: 'queries/count-method',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const m of matchAll(/\.count\s*\(/, src.masked)) {
          if (!/\.data\.[A-Za-z_$][\w$]*/.test(statementAround(src.masked, m.index))) continue
          const line = lineOf(src, m.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            message: `${code(src.path)} calls ${code('.count()')} on a Rayfin query, which has no such method.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'queries/find-by-pk',
    run: (ctx) =>
      regexHits(
        ctx.frontend,
        /\.findByPk\s*\(/,
        (src) => `${code(src.path)} calls ${code('findByPk')}, which doesn't exist in Rayfin.`
      )
  },
  {
    id: 'queries/total-count',
    run: (ctx) =>
      regexHits(
        ctx.frontend.filter((src) => /\.data\.|executePaginated/.test(src.masked)),
        /\.totalCount\b/,
        (src) => `${code(src.path)} reads ${code('totalCount')}, which Rayfin never populates.`
      )
  },
  {
    id: 'queries/where-dot-path',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const call of methodCalls(src.masked, 'where')) {
          for (const lit of stringLiterals(call.args)) {
            if (!DOT_PATH.test(lit.value)) continue
            const after = call.args.slice(lit.index + lit.value.length + 2)
            if (!/^\s*:/.test(after)) continue
            const line = lineOf(src, call.argsStart + lit.index)
            hits.push({
              file: src.path,
              line,
              label: `${src.path}:${line}`,
              message: `${code(src.path)} filters on ${code(`'${lit.value}'`)}; dot-paths only work in ${code('.select()')}.`
            })
          }
        }
      }
      return hits
    }
  },
  {
    id: 'queries/select-nested-path',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const call of methodCalls(src.masked, 'select')) {
          for (const lit of stringLiterals(call.args)) {
            if (!DOT_PATH.test(lit.value) || lit.value.split('.').length < 3) continue
            const line = lineOf(src, call.argsStart + lit.index)
            hits.push({
              file: src.path,
              line,
              label: `${src.path}:${line}`,
              message: `${code(src.path)} selects ${code(`'${lit.value}'`)}, which is more than one relationship level deep.`
            })
          }
        }
      }
      return hits
    }
  },
  {
    id: 'queries/aggregate-with-row-methods',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        const seen = new Set<number>()
        for (const m of matchAll(/\.(aggregate|groupBy)\s*\(/, src.masked)) {
          const stmt = statementAround(src.masked, m.index)
          const row = /\.(select|orderBy|first|after)\s*\(/.exec(stmt)
          if (!row) continue
          const line = lineOf(src, m.index)
          if (seen.has(line)) continue
          seen.add(line)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            message: `${code(src.path)} combines ${code(`.${m[1]}()`)} with ${code(`.${row[1]}()`)} in one query.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'queries/sort-direction-case',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const call of methodCalls(src.masked, 'orderBy')) {
          const bad = /(['"`])(ASC|DESC|Asc|Desc)\1/.exec(call.args)
          if (!bad) continue
          const line = lineOf(src, call.argsStart + bad.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            message: `${code(src.path)} sorts with ${code(`'${bad[2]}'`)} instead of ${code(`'${bad[2].toLowerCase()}'`)}.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'queries/raw-data-fetch',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        if (!/rayfin/i.test(src.masked)) continue
        for (const call of matchAll(/\bfetch\s*\(/, src.masked)) {
          const args = src.masked.slice(call.index, call.index + 400)
          if (!/graphql/i.test(args)) continue
          const line = lineOf(src, call.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            message: `${code(src.path)} sends a hand-built GraphQL request with ${code('fetch()')}.`
          })
        }
        for (const tag of matchAll(/\bgql\s*`/, src.masked)) {
          const line = lineOf(src, tag.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            message: `${code(src.path)} builds a raw GraphQL document with ${code('gql')}.`
          })
        }
      }
      return hits
    }
  }
]
