# Code-Health Analysis — `opencode-orchestrate` (JS source)

Read-only quantitative analysis per `code-health-check.md` (GFN-CIS/coding-agent-public-rules). Numbers before narrative.

## 1. Scope

- **Root**: `/home/alex/Projects/opencode-orchestrate`
- **Language**: JavaScript (ESM), Node/Bun runtime. No TypeScript, no other source language present.
- **Files analyzed (11)**: `.opencode/plugins/orchestrate.js`, `src/{benchmarks,bootstrap,context,inventory,model-data,rate-limit-guard,workers}.js`, `scripts/{refresh-benchmarks,squad-draft,squad-file-performance}.mjs`
- **LOC (code, blanks/comments excluded)**: **1,069** (127 blank, 522 comment — comment-to-code ratio ~49%, unusually high, see §7)
- **Exclusions** (explicit):
  - `src/benchmarks.json` — 17,774-line static AA benchmark data dump, not source code.
  - `tests/*.test.js` (7 files) — test code, analyzed separately from production-code pressure per convention; all 79 tests pass (`bun test`).
  - `skills/*.md`, `prompts/*.md`, `docs/**`, `README.md` — prose/prompt content, not code.
  - `.opencode/node_modules/`, `bun.lock` — vendored/lockfile.
  - No mirror worktrees, no generated code, no sample/dev configs present.

## 2. Tools used

| Metric | Tool | Version | Why this one | Output format |
|---|---|---|---|---|
| LOC excl. blanks/comments | cloc | 2.06 | Standard, JSON output, correctly separates the JSON data file from JS | JSON |
| Cyclomatic complexity / function | lizard | 1.23.0 | Only CC tool that runs standalone (no project-specific config needed), native JS support, CSV output, MIT-licensed, actively maintained (installed into isolated venv under `docs/artifacts/.toolchain/js/venv`) | CSV |
| Lint signal | ESLint | 10.8.1 | Project ships no lint config of its own; ran `@eslint/js` `recommended` flat config as a neutral baseline (installed into `docs/artifacts/.toolchain/js/node_modules`, not the project's own deps) | JSON |
| Dependency graph + cycles | madge | 8.0.0 | Purpose-built JS/TS import-graph extractor, JSON + built-in cycle detector, current major version | JSON |
| Graph metrics (centrality, density) | networkx | latest (pip) | Standard graph-analysis library; graph is tiny (11 nodes) so exact betweenness centrality is cheap and exact | Python objects → JSON |
| Maintainability index | *(none available)* | — | No maintained JS MI tool found; used a documented simplified proxy (see §3, Limitations) | — |
| Tabular aggregation | Python 3 (stdlib `csv`/`json`) | 3.14 | No pandas installed; stdlib sufficient at this scale (76 functions, 11 modules) | CSV/JSON |

No type-checker applies — project is plain JS with no `tsconfig`/JSDoc-strict mode.

## 3. Methodology

- `RP = 0.6·Peak + 0.4·Base`, `combined = max_cc·0.6 + p90_cc·0.4`, `Peak = 100·(1−e^(−0.08·combined))·scale`, `density = total_cc/loc·100`, `Base = 100·(1−e^(−0.02·density·scale))`.
- **`scale = min(1, loc/5000) = 1069/5000 = 0.2138`** — the codebase is well under the 5000-line reference size, so both Peak and Base are heavily scaled down. Stated explicitly per the spec's requirement.
- **OP**: no classes/inheritance exist anywhere in this codebase (pure functional modules, zero `class` keywords, zero `extends`) — the class-level formula is applied at the **module** level instead, with `depth` = import-chain distance (BFS from graph roots, i.e. files nothing imports) since there is no inheritance to measure. `centrality` = exact betweenness (networkx, exact — graph is small enough not to need approximation). `coupling` = **graph edge density** (10 edges / 11·10 possible directed edges ≈ 0.0909) — density chosen over avg-fan-out because fan-out is already one of the four `class_score` terms and using it twice would double-count.
- Each of fan_out/fan_in/depth/centrality min-max normalized to [0,1] across the 11 modules.
- `k = 0.5` (default, unchanged).
- MI: no maintained JS Halstead/MI tool was found (see Limitations) — reported as an internal proxy, not a calibrated Microsoft-style MI; ranked relatively within this repo only, not comparable across projects.

## 4. Headline numbers

| RP | OP | RP+OP | Penalty (`k·\|RP−OP\|`) | **Score** | Verdict |
|---|---|---|---|---|---|
| **15.7** | **21.7** | 37.5 | 3.0 | **40.5** | **Healthy** — both pressures low; OP is somewhat higher than RP but the gap (6.0 pts) is small relative to either value, not a real imbalance signal |

- `max_cc = 25`, `p90_cc = 11.5`, `combined = 19.6` → `Peak = 16.9`
- `density_all = 35.2` (total CC 376 / 1069 LOC) → `Base = 14.0`
- `avg_class_score = 30.2/100`, `coupling(density) = 0.091` → `OP = 0.4·9.1 + 0.6·30.2 = 21.7`

At this size (1,069 LOC), the `scale` factor caps both pressures well below what raw CC/coupling numbers would suggest in isolation — this is by design in the formula (a 25-CC function in a 1K-line plugin is a smaller problem than the same function in a 50K-line service), and is flagged, not hidden (§7).

## 5. Top-N tables

### Top-10 functions by CC

| CC | Location | Function | NLOC |
|---|---|---|---|
| 25 | `.opencode/plugins/orchestrate.js:383` | `event` (plugin event-bus handler) | 55 |
| 21 | `.opencode/plugins/orchestrate.js:448` | `(anonymous)` — the `experimental.chat.messages.transform` hook | 47 |
| 15 | `src/context.js:29` | `estimateContextTokens` | 22 |
| 14 | `src/context.js:130` | `buildLimitMap` | 17 |
| 13 | `src/model-data.js:161` | `formatPerf` | 17 |
| 13 | `src/inventory.js:24` | `(anonymous)` — inventory line formatter | 20 |
| 12 | `.opencode/plugins/orchestrate.js:166` | `extractStatusCode` | 8 |
| 12 | `scripts/squad-draft.mjs:44` | `main` | 50 |
| 11 | `.opencode/plugins/orchestrate.js:253` | `getAgentModel` | 14 |
| 10 | `.opencode/plugins/orchestrate.js:366` | `config` (plugin config hook) | 12 |

### Per-file: LOC, CC, density, MI-proxy (all 11 files — fewer than 10 remain after exclusions, showing all)

| File | LOC | Funcs | Total CC | Max CC | Density | Avg CC | MI-proxy |
|---|---|---|---|---|---|---|---|
| `.opencode/plugins/orchestrate.js` | 362 | 26 | 157 | 25 | 43.4 | 6.04 | 43.4 |
| `src/model-data.js` | 109 | 8 | 43 | 13 | 39.5 | 5.38 | 54.8 |
| `scripts/refresh-benchmarks.mjs` | 89 | 4 | 17 | 9 | 19.1 | 4.25 | 56.9 |
| `src/rate-limit-guard.js` | 89 | 9 | 27 | 6 | 30.3 | 3.00 | 57.1 |
| `src/context.js` | 78 | 6 | 47 | 15 | 60.3 | 7.83 | 57.7 |
| `scripts/squad-draft.mjs` | 79 | 3 | 18 | 12 | 22.8 | 6.00 | 57.8 |
| `scripts/squad-file-performance.mjs` | 67 | 3 | 14 | 8 | 20.9 | 4.67 | 59.5 |
| `src/bootstrap.js` | 64 | 1 | 5 | 5 | 7.8 | 5.00 | 59.9 |
| `src/benchmarks.js` | 53 | 8 | 22 | 7 | 41.5 | 2.75 | 62.0 |
| `src/workers.js` | 47 | 2 | 3 | 2 | 6.4 | 1.50 | 63.3 |
| `src/inventory.js` | 32 | 6 | 23 | 13 | 71.9 | 3.83 | 66.7 |

### Top-10 classes/modules by `class_score` (module-level substitute — no classes exist)

| Module | fan_out | fan_in | depth | betweenness | class_score |
|---|---|---|---|---|---|
| `src/model-data.js` | 1 | 2 | 1 | 0.011 | 62.5 |
| `src/benchmarks.js` | 0 | 3 | 1 | 0.0 | 50.0 |
| `src/inventory.js` | 1 | 1 | 1 | 0.0 | 39.2 |
| `.opencode/plugins/orchestrate.js` | 6 | 0 | 0 | 0.0 | 35.0 |
| `src/bootstrap.js` | 0 | 1 | 1 | 0.0 | 33.3 |
| `src/context.js` | 0 | 1 | 1 | 0.0 | 33.3 |
| `src/rate-limit-guard.js` | 0 | 1 | 1 | 0.0 | 33.3 |
| `src/workers.js` | 0 | 1 | 1 | 0.0 | 33.3 |
| `scripts/squad-draft.mjs` | 1 | 0 | 0 | 0.0 | 5.8 |
| `scripts/squad-file-performance.mjs` | 1 | 0 | 0 | 0.0 | 5.8 |

(`scripts/refresh-benchmarks.mjs` omitted — 0 on every axis, fully standalone.)

### Lint signal (ESLint recommended, neutral baseline — project has no lint config of its own)

- **2 errors, 0 warnings** across 11 files (rest are clean).
- `scripts/refresh-benchmarks.mjs:87` — `no-undef: 'fetch' is not defined` — **false positive**: `fetch` is a real Node 18+/Bun global; the minimal flat-config used here doesn't declare runtime globals beyond `process`/`console`/`setTimeout`. Not a real defect.
- `scripts/squad-draft.mjs:77` — `no-useless-assignment`: `let txt = ""` is immediately overwritten in the following `try` block before any use — a genuine but cosmetic dead initializer (the variable itself IS used later, just not with this initial value).

## 6. Dependency graph stats

- **Nodes**: 11, **Edges**: 10, **Density**: 0.091 (9.1% of possible directed edges present)
- **Cycles**: **0** — `madge --circular` confirms no circular dependencies.
- **Structure**: a shallow star/fan graph. `.opencode/plugins/orchestrate.js` is the sole entrypoint and the only high-fan-out node (6 direct deps, imports everything under `src/` except `workers.js`). `src/benchmarks.js` is the most fan-in'd module (3 importers: orchestrate.js, inventory.js, model-data.js) — a shared static-data accessor, not a coordination bottleneck. Max depth from any root is 1 (single-hop: e.g. `inventory.js → benchmarks.js`) — there is no deep import chain anywhere in the project.

## 7. Diagnosis

**Dominant pressure**: neither — **both RP and OP are low** (15.7 and 21.7 respectively, on a 0–100 scale). This is a genuinely healthy small codebase, not a "diffusely degraded" one (both would need to be high for that verdict) and not meaningfully imbalanced (penalty is only 3.0 of a 40.5 total score).

**Hot spots** (ranked by leverage, not by raw CC — at this LOC scale nothing here is a real structural risk):

1. **`orchestrate.js:event` (CC 25, 55 lines)** — the plugin's single `event` handler is an if/else cascade dispatching on `event.type` (`session.deleted`, `session.status` with nested `idle`/`retry` sub-branches, `session.error`, `message.updated`), each inlined. This is the file's and the project's single highest-CC function, and it lives in the file that also has the worst per-file density (43.4) and lowest MI-proxy (43.4) — the pressure concentrates here, not elsewhere.
2. **`orchestrate.js` as a whole (362 LOC, 26 functions, CC total 157)** — one file carries 34% of all project LOC and 42% of all cyclomatic complexity. It is also the only module with any real fan-out (6), making it the graph's sole coordination point — consistent with its role as the plugin entrypoint, but it's the file where any future growth will land first.
3. **`src/inventory.js` (density 71.9, the highest in the repo)** — only 32 LOC but CC 23 across 6 functions concentrated in one anonymous formatter closure (CC 13) — the highest complexity-per-line in the project, though the file is small enough that absolute risk is low.
4. **Comment-to-code ratio (~49%, 522/1069)** is unusually high for a codebase this size — driven by extensive "why" comments explaining non-obvious constraints (e.g. the rate-limit-guard's empirically-verified SDK call shapes, the bootstrap-injection compaction-survival rationale). This is a *positive* signal given the project's own stated convention (comments only for non-obvious rationale), not a code smell, but it means LOC-based density numbers are somewhat depressed relative to "logic density" — worth knowing when reading the Base/density figures.

**Pressure cluster**: `.opencode/plugins/orchestrate.js` — it is simultaneously the RP hot spot (highest CC, highest density, lowest MI-proxy) and the OP hot spot (only real fan-out in the graph, second-highest module class_score). Everything else in `src/` is a thin, single-purpose, low-CC leaf module — the plugin's central dispatcher is where both pressures actually live.

## 8. Fix 3 things

1. **Split `orchestrate.js`'s `event` handler into per-event-type functions** (`handleSessionStatus`, `handleSessionError`, `handleMessageUpdated`, each already partially factored — `handleTerminalError`/`guardAbort`/`sendGuardNote` exist but the dispatcher itself stays a flat cascade). Expected: max_cc drops from 25 to ~8-10 (the largest remaining branch), `combined` drops ~19.6→~14, Peak drops ~17→~12, **RP: 15.7 → ~12** (−3.7). No OP effect (same module, same edges).
2. **Extract the `experimental.chat.messages.transform` hook's bootstrap-injection body (CC 21, orchestrate.js:448) into a named, separately-testable function in `src/`** (e.g. `src/bootstrap-injection.js`), mirroring how `evaluateRetry`/`formatGuardNote` already live in `src/rate-limit-guard.js` rather than inline in the plugin. Expected: moves ~47 LOC + CC 21 out of `orchestrate.js`; `orchestrate.js` LOC drops to ~315, project total CC redistributes so no single file dominates density — **RP: ~12 → ~10** (−2), **OP: 21.7 → ~24** (+2.3, new module adds a fan-in edge, slightly higher avg_class_score) — a worthwhile RP/OP trade since the new module becomes directly unit-testable (currently this logic has zero direct test coverage — it's only exercised indirectly via the live-server tests done in this session).
3. **Fix the `no-useless-assignment` in `scripts/squad-draft.mjs:77`** (`let txt;` instead of `let txt = ""`) — zero metric impact (trivial single-line cosmetic fix), included because it's the only actual lint finding in the whole codebase and costs nothing to close out.

Combined expected effect: **RP ~15.7 → ~10 (−5.7), OP ~21.7 → ~24 (+2.3), Score ~40.5 → ~35.5** (driven mostly by the RP reduction; the OP increase is an acceptable, deliberate trade for testability, not a regression).

## 9. Limitations & assumptions

- **No classes exist in this codebase** — the OP `class_score` formula was applied at the ES-module level instead (11 modules = 11 "classes"). This is explicitly a substitution, not the literal formula target; `depth` used import-chain (max depth observed: 1) rather than inheritance depth, since there is no inheritance to measure at all.
- **MI is a proxy, not calibrated MI.** No actively-maintained JS/Halstead-metrics CLI was found during tool discovery (rejected candidates: `plato`/`es6-plato` — unmaintained since ~2018, no JSON-stable output confirmed; `typhonjs-escomplex` — same maintenance-age concern). Used `MI ≈ 171 − 0.23·avgCC − 16.2·ln(LOC)`, rescaled to 0–100, **omitting the Halstead-volume term** entirely for lack of a tool to compute it. Values are only meaningful as a *relative, within-this-repo* ranking, not comparable to standard MI thresholds (e.g. "MI < 65 = hard to maintain") from other tools/projects.
- **Test files excluded from RP/OP.** Per common convention and the spec's own exclusion list ("tests"); all 7 test files (79 tests) pass and are not part of the pressure analysis. If included, they would very likely *lower* both RP and OP further (tests are typically low-CC, low-coupling) — not run here to keep scope aligned with "production code" pressure, per the spec's intent.
- **Lint used a neutral baseline config, not the project's own** (none exists). The single `no-undef: fetch` finding is a config artifact (missing `fetch` global declaration), not a real defect — flagged as such rather than counted as a real lint error in the diagnosis.
- **`scale = 0.2138`** materially compresses both RP and OP relative to their "raw" (unscaled) values — stated per the spec's requirement to document the scale choice; this is the formula working as designed for a sub-5000-line project, not a hidden adjustment.

## 10. Artifacts

All under `docs/artifacts/` (this repo):

- `code-health-report-20260808.md` — this report
- `opencode-orchestrate_metrics_20260808.csv` — per-file LOC/CC/density/MI-proxy table
- `lizard_functions.csv` — raw per-function CC (76 functions)
- `cloc_report.json`, `cloc_by_file.json` — raw LOC breakdown
- `madge_graph.json` — raw dependency adjacency list
- `op_summary.json`, `rp_summary.json`, `file_stats.json` — computed intermediate metrics
- `eslint_report.json` — raw lint JSON
- `.toolchain/js/venv/` — isolated Python venv (lizard, networkx)
- `.toolchain/js/node_modules/`, `.toolchain/js/eslint.config.mjs` — isolated ESLint install + neutral flat config used for the lint pass

## 11. Post-fix verification (same tools, re-run)

All three fixes from §8 applied (`orchestrate.js`'s `event` handler split into 4 named per-type functions; the transform hook's body extracted to `src/message-transform.js` with 8 new unit tests; the `squad-draft.mjs` dead initializer removed) and re-measured with the identical toolchain:

| | Before | After | Δ |
|---|---|---|---|
| Lint errors | 2 | 1 (the `fetch` false-positive only) | −1 real finding fixed |
| `orchestrate.js` max CC | 25 | 12 | −13 |
| Project-wide max CC | 25 | 15 (`context.js:estimateContextTokens`, pre-existing, untouched) | −10 |
| RP | 15.7 | **14.2** | −1.5 |
| OP | 21.7 | **19.3** | −2.4 (better than predicted — the new leaf module lowered avg_class_score rather than raising it) |
| Score | 40.5 | **36.0** | −4.5 |
| Circular deps | 0 | 0 | unchanged |
| Test count | 79 pass | **89 pass** (10 new, all for the newly-extracted module) | +10 |

Both pressures moved down, not just the one the fix targeted — no RP/OP trade-off materialized in practice. Full numbers/raw data for this pass were not re-saved as separate CSVs (ephemeral re-run for verification); re-running the commands in §2 against the current tree reproduces them.
