// Times Design mode's AI Options on each candidate model through the real app,
// to choose the order in `pickDesignModel` (src/renderer/src/copilotModels.ts).
// Drives `window.api.design.variations` in an isolated debug instance over the
// DevTools protocol; see README.md. Node 22+ (global fetch and WebSocket).
//
//   node scripts/design-bench/bench.mjs --project <id> [--port 9333] [--runs 2]
//     [--effort low|default] [--fixtures kpi,section,chart] [--image card.png]
//     [--out results.json] <model> [<model>...]
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = { port: 9333, runs: 2, effort: 'low', fixtures: null, image: null, out: null, project: null }
const models = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--port') opt.port = Number(args[++i])
  else if (a === '--runs') opt.runs = Number(args[++i])
  else if (a === '--effort') opt.effort = args[++i]
  else if (a === '--fixtures') opt.fixtures = args[++i].split(',')
  else if (a === '--image') opt.image = args[++i]
  else if (a === '--out') opt.out = args[++i]
  else if (a === '--project') opt.project = args[++i]
  else models.push(a)
}
if (!opt.project || !models.length) {
  console.error('usage: node bench.mjs --project <id> [options] <model> [<model>...]')
  process.exit(2)
}

// A dashboard app themed through semantic tokens and its own scales (dark mode),
// like the Rayfin templates.
const TOKENS = {
  colors: [['primary', '#60a5fa'], ['primary-foreground', '#0b1220'], ['card', 'rgba(15, 23, 42, 0.9)'], ['muted-foreground', '#bfdbfe'],
    ['foreground', '#ecf5ff'], ['background', '#0b1220'], ['muted', '#1f2a3d'], ['border', '#2b3d5c'], ['accent', '#21314b'],
    ['secondary', '#172033'], ['destructive', '#c50f1f'], ['brand', '#60a5fa']],
  text: [['100', '10px'], ['200', '12px'], ['300', '14px'], ['400', '16px'], ['500', '20px'], ['600', '24px'], ['hero-700', '28px'], ['hero-800', '32px']],
  spacing: [['100', '4px'], ['200', '8px'], ['300', '12px'], ['400', '16px'], ['500', '20px'], ['600', '24px'], ['700', '28px'], ['800', '32px']],
  radius: [['sm', '2px'], ['md', '4px'], ['lg', '6px'], ['xl', '8px'], ['2xl', '12px'], ['3xl', '16px'], ['4xl', '24px']],
  fonts: [['base', "'Manrope', 'Segoe UI', sans-serif"]],
  dark: true
}

const FIXTURES = {
  // A KPI card in the token-themed app.
  kpi: {
    tag: 'div', text: 'Total population 7.45B Across all countries in the model', component: 'KpiCard',
    classes: 'rounded-4xl border border-primary bg-primary p-500 text-primary-foreground shadow-sm',
    styles: { 'background-color': 'rgb(96, 165, 250)', 'border-radius': '24px', color: 'rgb(11, 18, 32)', display: 'block', 'font-size': '16px',
      padding: '20px', width: '302px', height: '150px' },
    isChart: false,
    children: [{ tag: 'p', classes: 'text-300 font-medium', text: 'Total population' }, { tag: 'span', classes: 'opacity-80' },
      { tag: 'p', classes: 'mt-400 text-hero-800 font-semibold', text: '7.45B' }, { tag: 'p', classes: 'mt-300 text-200 opacity-80', text: 'Across all countries in the model' }],
    system: TOKENS
  },
  // A page section in an app on Tailwind's default palette.
  section: {
    tag: 'main', classes: 'mx-auto max-w-4xl px-4 py-8', text: '0 Trips 0 Destinations 0 km Distance Log a new trip',
    styles: { color: 'oklch(0.21 0.034 264.665)', display: 'block', 'font-size': '16px', padding: '32px 16px', width: '896px' },
    isChart: false,
    children: [{ tag: 'section', classes: 'mb-8 grid grid-cols-3 gap-4' }, { tag: 'div', classes: 'rounded-2xl bg-white p-4 shadow-sm' },
      { tag: 'p', classes: 'text-2xl font-bold text-gray-900', text: '0' }, { tag: 'h2', classes: 'mb-4 text-lg font-semibold', text: 'Log a new trip' },
      { tag: 'button', classes: 'rounded-xl bg-indigo-600 px-4 py-2 text-white', text: 'Add trip' }],
    system: { palettes: ['indigo', 'gray'], spacingBase: '0.25rem', radius: [['xl', '12px'], ['2xl', '16px']] }
  },
  // A Graphein bar chart, with a request.
  chart: {
    tag: 'div', isChart: true, chartType: 'bar', styles: {}, system: TOKENS, hint: 'make it easier to compare regions',
    spec: { type: 'bar', title: 'Population by region', theme: 'dark',
      encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'population', type: 'quantitative', aggregate: 'sum' } } }
  }
}

// Fabricator's own window (not the preview of an app it's showing).
const targets = await (await fetch(`http://127.0.0.1:${opt.port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && /^(http:\/\/localhost:1420|http:\/\/tauri\.localhost|tauri:)/.test(t.url))
if (!page) throw new Error('No Fabricator window on the DevTools port: ' + targets.map((t) => t.url).join(', '))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let nextId = 0
const waiting = new Map()
ws.onmessage = (m) => { const msg = JSON.parse(m.data); waiting.get(msg.id)?.(msg); waiting.delete(msg.id) }
async function evaluate(expression) {
  const id = ++nextId
  const msg = await new Promise((resolve) => {
    waiting.set(id, resolve)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 300))
  return msg.result?.result?.value
}
const image = opt.image ? 'data:image/png;base64,' + readFileSync(opt.image).toString('base64') : null

/** On brand: values through the app's var(--…) tokens, not raw colors, gradients or glows. */
function score(options) {
  const values = []
  for (const o of options) {
    values.push(...Object.values(o.styles ?? {}).map(String))
    for (const r of o.rules ?? []) values.push(...Object.values(r.styles ?? {}).map(String))
  }
  return {
    tokens: values.filter((v) => /var\(--/.test(v)).length,
    raw: values.filter((v) => /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|hsla?\(/i.test(v) && !/var\(--/.test(v)).length,
    gradients: values.filter((v) => /gradient\(/i.test(v)).length + options.filter((o) => /bg-(gradient|linear)-to/.test(o.classes ?? '')).length
  }
}

const rows = []
for (const model of models) {
  for (const [fixture, fx] of Object.entries(FIXTURES)) {
    if (opt.fixtures && !opt.fixtures.includes(fixture)) continue
    const { hint, ...ctx } = fx
    for (let run = 0; run < opt.runs; run++) {
      // Each Options request deletes its capture, so save a fresh one per run.
      const shot = image ? await evaluate(`window.api.screenshot.save(${JSON.stringify(image)})`) : null
      const r = await evaluate(`(async () => {
        const info = (await window.api.chat.listModels()).find((m) => m.id === ${JSON.stringify(model)})
        const want = ${JSON.stringify(opt.effort === 'default' ? null : opt.effort)}
        const effort = want && info && info.supportedReasoningEfforts.includes(want) ? want : undefined
        const requestId = 'bench-' + Math.random().toString(36).slice(2)
        const t0 = performance.now()
        let first = null
        const stop = window.api.design.onVariation((e) => { if (e.requestId === requestId && first === null) first = performance.now() - t0 })
        try {
          const options = await window.api.design.variations(${JSON.stringify(opt.project)}, ${JSON.stringify(ctx)}, ${JSON.stringify(hint ?? null)} ?? undefined, 3,
            ${JSON.stringify(model)}, { effort, requestId, screenshotPath: ${JSON.stringify(shot)} ?? undefined })
          return { ms: performance.now() - t0, first, options, effort: effort ?? 'none' }
        } catch (e) {
          return { ms: performance.now() - t0, first, error: String(e), effort: effort ?? 'none' }
        } finally { stop() }
      })()`)
      const row = {
        model, effort: r.effort, fixture, run, image: Boolean(shot), ms: Math.round(r.ms), first: r.first == null ? null : Math.round(r.first), error: r.error,
        ...(r.options ? { n: r.options.length, ...score(r.options), names: r.options.map((o) => o.name) } : {}), options: r.options
      }
      rows.push(row)
      console.log(`${model.padEnd(22)} ${row.effort.padEnd(5)} ${fixture.padEnd(8)} #${run} ${String(row.ms).padStart(6)} ms  first ${String(row.first ?? '-').padStart(6)}  ` +
        (row.error ? `ERROR ${row.error.slice(0, 80)}` : `n=${row.n} tokens=${row.tokens} raw=${row.raw} gradients=${row.gradients}  ${row.names.join(' | ')}`))
      if (opt.out) writeFileSync(opt.out, JSON.stringify(rows, null, 2))
    }
  }
}
ws.close()

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
console.log('\nmodel                  median ms  median first  failures')
for (const model of models) {
  const ok = rows.filter((r) => r.model === model && !r.error)
  const firsts = ok.map((r) => r.first).filter((f) => f != null)
  console.log(`${model.padEnd(22)} ${String(median(ok.map((r) => r.ms)) ?? '-').padStart(9)}  ${String(median(firsts) ?? '-').padStart(12)}  ${rows.filter((r) => r.model === model && r.error).length}`)
}
