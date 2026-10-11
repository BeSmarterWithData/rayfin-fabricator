# Design model benchmark

Times Design mode's AI **Options** on each candidate Copilot model through the real app, so
the model order in `pickDesignModel` (`src/renderer/src/copilotModels.ts`) comes from
measurements instead of model names. Re-run it when Copilot's model list changes.

Everything here is a maintainer tool. It isn't part of the app or of CI. Each request is a
real Copilot call and counts against your plan.

## What it measures

`bench.mjs` calls `window.api.design.variations` in Fabricator's window, the same path the
card's **Options** button takes after the page collects the element: a transient, tool-less
Copilot session, the brand-aware prompt, the streamed `design:variation` events and the final
parse. For each model it runs three fixtures:

| Fixture | What it is |
| --- | --- |
| `kpi` | A KPI card in a dashboard app themed through semantic tokens (`bg-primary`, `p-500`, `rounded-4xl`) in dark mode |
| `section` | A page section in an app on Tailwind's default palette |
| `chart` | A Graphein bar chart, with a request |

Each run prints the time to all options, the time to the first streamed option, and how well
the options stay on brand: `tokens` counts values that use the app's `var(--…)` tokens, `raw`
counts raw colors, `gradients` counts gradients. A summary of medians per model follows.

## Run it

1. Start an isolated debug instance with a DevTools port, for example with
   [`scripts/docs-screenshots/launch.ps1`](../docs-screenshots/launch.ps1), or run `npm run dev`
   with `FABRICATOR_DEV_DATA_DIR`, `WEBVIEW2_USER_DATA_FOLDER` and
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` set.
2. In that instance, open any project once (**Open folder**), then copy its `id` from
   `studio.json` in the instance's data folder. The model call runs in that project's folder
   but reads nothing from it.
3. Run the benchmark with the candidate models, which are the ids in Copilot's model list:

   ```powershell
   node scripts/design-bench/bench.mjs --project <id> --out bench.json `
     claude-haiku-5.5 gpt-6-luna mai-code-1.1-flash gemini-3.7-flash gemini-3.8-flash claude-haiku-4.5
   ```

Options:

| Option | Default | What it does |
| --- | --- | --- |
| `--port` | `9333` | DevTools port of the instance |
| `--runs` | `2` | Runs per model and fixture |
| `--effort` | `low` | `low` asks models that support it to think briefly, as Design does; `default` leaves the model's own effort |
| `--fixtures` | all | Comma-separated subset, such as `kpi,chart` |
| `--image` | none | A PNG of the element to attach to every run, like Design does for models that read images |
| `--out` | none | Write every run, including the options themselves, to a JSON file |

Look at the options too, not only the times: open `--out` and check that the looks are distinct,
use the app's tokens and don't fall back to gradients. Then update `DESIGN_PREFERRED` and its
comment in `copilotModels.ts`, and the expected order in `copilotModels.test.ts`.
