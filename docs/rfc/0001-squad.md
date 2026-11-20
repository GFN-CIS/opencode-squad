# RFC 0001: opencode-squad

Status: draft for review. Target behaviour of the plugin as a whole; integration tests verify it at the plugin boundary.

## 1. Terms

| Term | Meaning |
| --- | --- |
| lead | The host's `build` agent with the plugin's bootstrap; call sign sarge. |
| grunt | Squad executor agent for one model: edits files, runs commands. |
| drill | Squad reviewer agent for one model: read-only. |
| squad agent | A grunt or drill the plugin registers from the roster. |
| roster | The squad definition stored in `squad.json`: one map per role, keyed by model id. |
| squad id | `<role>-<provider>-<model>`: role, then the model id lower-cased with every run of characters outside `a-z0-9` replaced by `-`. |
| user agent | Any agent the host loaded from the user's files or config, including one at a squad id. |
| legacy file | An agent file an earlier version of the plugin generated in the global agent dir. |
| role rules | The permission rules that define a role, applied after the user's global rules. |
| revision | Content hash of `squad.json` as returned by `squad_dump`. |
| bootstrap | The block the plugin appends to the lead's system prompt: role, lead model, squad inventory. |
| owner rule | A routing rule the user wrote in `model_data.json`, per provider or per model. |
| guard note | A message the plugin sends to the lead's session about a subagent it stopped or found stuck. |
| quota note | A message the plugin sends to the lead's session about a provider's used rate-limit window. |

## 2. Problems

- An expensive primary model does routine work itself: reads, edits, log digging. The cost and its context grow with work a cheaper model could do.
- Work handed to a cheaper model comes back unchecked; a confident wrong change reaches the user.
- The host dispatches subagents by agent id, not by model, so choosing a model needs one agent per model and role.
- The host retries a rate-limited call for as long as the provider asks, days included; a subagent in that state blocks the lead indefinitely.
- An empty subagent result carries no reason; the lead invents one (a provider refusal) and acts on it.
- Per-turn text in the prompt invalidates the prompt cache for the whole conversation; measured cost was about a third of the spend over two weeks.
- Earlier versions kept the squad as agent files; the host reaches one file under several ids, and writes, prunes and migrations damaged other agents.

## 3. Goals, non-goals, accepted scope creep

| ID | Goal |
| --- | --- |
| GOAL-1 | Routine work leaves the primary model: the lead delegates to per-model subagents the user chose. |
| GOAL-2 | Every change a grunt produces can be reviewed by a read-only reviewer that cannot alter what it reviews. |
| GOAL-3 | The lead routes on current facts: models, context windows, billing, owner rules, benchmarks, quota, session cache state, result failure causes. |
| GOAL-4 | A subagent stuck on a provider limit or silent does not block the lead. |
| GOAL-5 | The roster is edited without silent loss: no change is lost to a concurrent edit, nothing is deleted without intent. |
| GOAL-6 | The plugin keeps the prompt cache valid across turns. |
| GOAL-7 | Installing the plugin changes nothing the user configured and does not slow or break the host. |
| GOAL-8 | A release is gated on the full test suite and maps one version to one source revision. |

| ID | Non-goal |
| --- | --- |
| OOS-1 | Deterministic behaviour of the lead model: its verdicts, model choice, iteration count. These are prompt protocol, outside integration tests. |
| OOS-2 | Rate-limit handling of top-level (human) sessions. |
| OOS-3 | OpenCode 1. |
| OOS-4 | Per-project squads; the roster is global. |
| OOS-5 | Choosing the compaction model; the host's settings decide. |
| OOS-6 | A bundled fallback grunt or drill. |
| OOS-7 | Per-agent permissions, temperature, sampling or provider options in the roster. |
| OOS-8 | A command-line editor for the roster. |

| ID | Accepted scope creep |
| --- | --- |
| ASC-1 | One-time import of a squad that earlier versions kept as legacy files. |
| ASC-2 | A manual script that measures provider cache TTLs from local session history. |

## 4. Target state

### Constraints

| ID | Constraint | Source |
| --- | --- | --- |
| CON-001 | Host: OpenCode 2.x; integration tests run against a pinned release, currently 2.1.3 (agreed). | OOS-3 |
| CON-002 | The lead is the host's `build` agent (agreed). | GOAL-1 |
| CON-003 | Roster file: `squad.json` in the OpenCode config dir, `$XDG_CONFIG_HOME/opencode/` or `~/.config/opencode/` (agreed). | OOS-4 |
| CON-004 | Owner notes: `model_data.json`, global in the config dir, or per project in `.opencode/` (agreed). | GOAL-3 |
| CON-005 | Delegation protocol: at most 3 grunt/drill rounds per change, then the lead returns to the user (agreed). | GOAL-2 |
| CON-006 | Guard defaults by which FR-034 to FR-036 are met: single announced wait 3600 s, cumulative retry wait 3600 s, silence 600 s, status codes 429 and 403, message patterns `rate.?limit`, `usage.?limit`, `quota`, `blocked by a gateway or proxy`; all overridable in plugin options (agreed). | GOAL-4 |
| CON-007 | Quota bands by which FR-039 is met: 60 %, 80 %, 95 % of the binding window; inside the top band a repeat after a further 2 percentage points (agreed). | GOAL-3 |
| CON-008 | Metrics sources: SuperIndex and llmbenchmark.ai; data refreshed when older than 48 h, checked every 4 h, each source under an 8 s timeout (agreed). | GOAL-3 |
| CON-009 | Cache TTL used when neither the user, a published value nor a measurement gives one: 300 s (agreed). | GOAL-3 |
| CON-010 | `squad_metrics` with `full: true` accepts at most 6 models (agreed). | GOAL-3 |
| CON-011 | A roster lock older than 30 s is reported with its holder (agreed). | GOAL-5 |

### Functional requirements

Squad registration and roles:

| ID | Requirement | Source |
| --- | --- | --- |
| FR-001 | **THE** plugin **SHALL** register, for every roster entry not marked `disable`, one hidden agent at its squad id with the role's bundled prompt and the entry's model, variant, steps and notes. | GOAL-1 |
| FR-002 | **THE** plugin **SHALL** register no squad agent the roster does not list. | OOS-6 |
| FR-003 | **WHERE** the agent is a drill, **THE** host **SHALL** offer it only local read and search tools, skills, web fetch and search, and allowlisted read-only `git`, `gh` and `glab` commands with text filters, and **SHALL** reject edits, MCP tools, Code Mode, output redirection and any other command, whatever the user's global rules. | GOAL-2 |
| FR-004 | **WHERE** the agent is a grunt, **THE** host **SHALL** allow it edits and shell commands and deny it launching subagents, whatever the user's global rules. | GOAL-1 |
| FR-005 | **WHEN** a session is started directly for a squad agent, **THE** first request **SHALL** already carry only the tools its role allows. | GOAL-2 |
| FR-006 | **IF** a request selects a squad agent before the plugin has built it, **THEN THE** request **SHALL** fail as an unknown agent. | GOAL-2 |
| FR-007 | **WHEN** the host re-applies its configuration so that role rules no longer come last, **THE** plugin **SHALL** restore their order before the next request of that agent and **SHALL** remove from that request every tool the role denies. | GOAL-2 |
| FR-008 | **THE** system prompt of each squad agent request **SHALL** carry the role prompt bundled with the running plugin, without a re-registration. | GOAL-1 |
| FR-009 | **THE** plugin **SHALL** register the skills `squad-draft`, `squad-delegate`, `squad-stall` and `squad-redteam`. | GOAL-1 |

User agents and legacy files:

| ID | Requirement | Source |
| --- | --- | --- |
| FR-010 | **WHERE** a user agent holds a squad id, **THE** plugin **SHALL** leave its effective definition equal to what the host builds without the plugin, and **SHALL NOT** register that squad entry. | GOAL-7 |
| FR-011 | **THE** plugin **SHALL** leave every agent other than squad agents and matching legacy agents as the host built it, whatever its id. | GOAL-7 |
| FR-012 | **WHERE** a legacy file is present, **THE** plugin **SHALL** treat its id as the squad's only when the agent the host loaded there equals, field for field, what that file alone yields; otherwise the id belongs to a user agent. | ASC-1 |
| FR-013 | **WHERE** a matching legacy agent's model is no longer in the roster, **THE** plugin **SHALL** hide it so it cannot be dispatched. | ASC-1 |
| FR-014 | **WHEN** the plugin starts with no `squad.json` and legacy files are present, **THE** plugin **SHALL** import them into `squad.json` once and leave the files in place. | ASC-1 |
| FR-015 | **IF** a legacy file cannot be read, or two entries map to one squad id, **THEN THE** import **SHALL** write nothing and `squad_dump` **SHALL** name the cause. | ASC-1 |

Roster:

| ID | Requirement | Source |
| --- | --- | --- |
| FR-016 | **THE** `squad_dump` tool **SHALL** return the roster, its revision, the variants the host accepts per model, and every problem: an invalid `squad.json` or `model_data.json`, user agents at squad ids, colliding entries, leftover legacy files. | GOAL-5 |
| FR-017 | **IF** `squad_patch` receives a revision other than the current one, **THEN** it **SHALL** write nothing and say the roster changed. | GOAL-5 |
| FR-018 | **IF** a patch removes an agent and `allow_remove` is not set, **THEN** it **SHALL** write nothing and name each removal. | GOAL-5 |
| FR-019 | **IF** a patch carries a variant the host does not accept, a `description`, two model ids with one squad id, a roster wrapped in an extra key, a `directory` argument, or an entry whose squad id a user agent holds, **THEN** it **SHALL** write nothing and name the cause. | GOAL-5 |
| FR-020 | **IF** `squad_patch` or `squad_compact` is called by a grunt or a drill, **THEN** it **SHALL** refuse. | GOAL-5 |
| FR-021 | **WHEN** a patch is written, **THE** next dispatch in the same process **SHALL** use the new roster without a restart. | GOAL-5 |
| FR-022 | **WHEN** another process has changed the content of `squad.json`, **THE** plugin **SHALL** apply the change on its next request, whatever the file's size and timestamps. | GOAL-5 |
| FR-023 | **IF** `squad.json` exists but does not parse or validate, **THEN THE** plugin **SHALL** leave it unchanged, register nothing new from it, and refuse every patch. | GOAL-5 |
| FR-024 | **WHILE** another process holds the roster lock, **THE** `squad_patch` tool **SHALL** write nothing and leave the lock in place, and name its holder per CON-011. | GOAL-5 |
| FR-025 | **THE** plugin **SHALL** replace `squad.json` and `model_data.json` atomically, write through a symlink to its target, keep the file's permission bits, and refuse a dangling symlink. | GOAL-7 |

Owner notes and descriptions:

| ID | Requirement | Source |
| --- | --- | --- |
| FR-026 | **THE** description of a squad agent **SHALL** consist of its role, the owner rules that apply to its model, and its provider's billing, and **SHALL** contain no benchmark, price or rank. | GOAL-3 |
| FR-027 | **IF** `model_data.json` cannot be read, **THEN THE** plugin **SHALL** keep the owner rules it last read, or else state in each squad agent's description that the owner rules are unknown, and **SHALL NOT** write the file. | GOAL-3 |
| FR-028 | **WHEN** the plugin starts, **THE** global `model_data.json` **SHALL** gain an empty entry for each new squad model, lose the entries of models no longer in the squad, keep every hand-written field, and be written only if its content changed; a project's file **SHALL NOT** be written. | GOAL-7 |

Lead bootstrap:

| ID | Requirement | Source |
| --- | --- | --- |
| FR-029 | **WHERE** the request is the lead's, **THE** plugin **SHALL** append exactly one bootstrap to the system prompt, naming the lead's model and listing each squad agent with its description, model and context window. | GOAL-1 |
| FR-030 | **THE** bootstrap **SHALL** stay byte-identical between requests while the squad and the lead's model are unchanged, and **SHALL** contain no clock, context size, benchmark or price. | GOAL-6 |
| FR-031 | **THE** plugin **SHALL NOT** modify any message of any session. | GOAL-6 |
| FR-032 | **WHERE** the request is not the lead's, **THE** plugin **SHALL** add no bootstrap. | GOAL-6 |
| FR-033 | **WHERE** the squad is empty, **THE** bootstrap **SHALL** tell the lead to send the user to `squad-draft`. | OOS-6 |

Rate-limit guard and quota:

| ID | Requirement | Source |
| --- | --- | --- |
| FR-034 | **WHEN** a subagent's retry crosses a guard threshold (CON-006), **THE** plugin **SHALL** veto the retry and send exactly one guard note to the parent session, with the reset time when the provider gave one. | GOAL-4 |
| FR-035 | **IF** a subagent execution fails with an error the guard patterns match, **THEN THE** plugin **SHALL** send exactly one guard note to the parent session. | GOAL-4 |
| FR-036 | **WHILE** a subagent execution, including one resumed by session id, shows no activity for longer than the silence threshold, **THE** plugin **SHALL** interrupt it and send exactly one guard note saying whether the interrupt stopped it, found it idle, or is unconfirmed. | GOAL-4 |
| FR-037 | **THE** guard note **SHALL** warn that the subagent may already have changed files or run commands. | GOAL-4 |
| FR-038 | **WHERE** a session has no parent, **THE** guard **SHALL NOT** act. | OOS-2 |
| FR-039 | **WHEN** a subagent's response headers show its binding quota window entering a higher band (CON-007), or the provider switching to rejected, **THE** plugin **SHALL** send one quota note to the parent session; otherwise it **SHALL** send none. | GOAL-3 |

Session tools and metrics:

| ID | Requirement | Source |
| --- | --- | --- |
| FR-040 | **THE** `squad_metrics` tool **SHALL** return one line per requested model with the squad roles it serves, its context window, its billing, its owner rules and the benchmark data the sources hold for it; a figure it cannot attribute to that exact model **SHALL** read as unknown, not as another model's. | GOAL-3 |
| FR-041 | **IF** a metrics source fails, times out, or returns an empty or shrunken body, **THEN THE** plugin **SHALL** keep that source's previous data with its age. | GOAL-3 |
| FR-042 | **THE** `squad_session` tool **SHALL** report, for each session id given, whether its prompt cache is warm or cold with the seconds left or elapsed, where the TTL came from (configured, published, measured or assumed), its context size and whether it is still running; without ids, the current time and the caller's own context size. | GOAL-3 |
| FR-043 | **IF** a session's last result is empty or cut at the output cap, **THEN THE** `squad_session` report **SHALL** state the cause from the session's numbers and, for a cut, that it is not a provider refusal. | GOAL-3 |
| FR-044 | **WHEN** `squad_compact` is called with a subagent session id, **THE** plugin **SHALL** compact that session with the host's compaction settings and report its size before and after. | GOAL-6 |

Release:

| ID | Requirement | Source |
| --- | --- | --- |
| FR-045 | **WHEN** master carries a package version that is not yet both a GitHub release and an npm version, **THE** release workflow **SHALL** publish it only after unit tests, lint, unused-code check, type check and integration tests pass on the revision being released. | GOAL-8 |
| FR-046 | **IF** a release run resumes a version whose tag exists, **THEN** it **SHALL** release the tagged revision, not the current master. | GOAL-8 |

### Non-functional requirements

| ID | Requirement | Source |
| --- | --- | --- |
| NFR-001 | **THE** plugin's setup **SHALL** complete without network access or reads of the roster, owner notes or metrics; these happen in hooks and tools. | GOAL-7 |
| NFR-002 | **WHILE** the network is unavailable, **THE** plugin **SHALL** register the squad, inject the bootstrap and serve every tool; only metrics figures go missing. | GOAL-7 |
| NFR-003 | **THE** test suites **SHALL NOT** read or write the user's real OpenCode config or data dirs. | GOAL-7 |

### Contracts

`squad.json`:

```json
{ "version": 1,
  "grunts": { "<provider>/<model>": { "variant": "high", "steps": 25, "notes": "…", "disable": false } },
  "drills": { "<provider>/<model>": {} } }
```

An entry's presence makes the agent; `{}` means role defaults. Keys are kept sorted.

`squad_patch` input: `{ grunts, drills, revision, allow_remove? }`. `revision` is the first 16 hex characters of the SHA-256 of the `squad.json` bytes, or `none` when the file is absent.

`model_data.json`:

```json
{ "providers": { "<provider>": "<plan> | api" | { "plan": "<plan> | api", "info": "<owner rule>" } },
  "models": { "<provider>/<model>": { "info": "<owner rule>", "billing": "<plan> | api", "cache_ttl_seconds": 300 } } }
```

Drill verdict, returned as strict JSON with no surrounding prose:

```json
{ "verdict": "PASS | FAIL",
  "checks": [{ "check": "", "met": true, "how": "read | fetched | ran", "where": "", "evidence": "" }],
  "unverified": [{ "check": "", "kind": "needs_execution | blocked", "why": "" }],
  "skills": { "loaded": [], "considered_not_loaded": [{ "id": "", "why": "" }] },
  "issues": [{ "severity": "high | med | low", "description": "" }],
  "suggested_fixes": [],
  "blocking": true }
```

Plugin options: `{ "rate_limit_guard": { enabled, retry_on_errors, retryable_error_patterns, max_wait_seconds, max_cumulative_seconds, max_silence_seconds } }`, defaults per CON-006.

### Assumptions and accepted risks

| ID | Assumption / accepted risk | Source |
| --- | --- | --- |
| ASM-001 | The lead model follows the bootstrap and `squad-delegate`: a SELF or DELEGATE verdict first, grunt then drill for changes, confirmation before high-risk writes, return to the user after CON-005. | OOS-1 |
| ASM-002 | The host runs agent transforms in registration order, a plugin's setup-time transform before its own config plugin, and evaluates permission rules last match wins; verified on the CON-001 release. | GOAL-2 |
| ASM-003 | Anthropic sends its unified rate-limit headers on every successful response; the ChatGPT (Codex) path sends none on the CON-001 release, so it gets no quota note. | GOAL-3 |
| ASM-004 | Accepted risk: a roster lock left by a crashed process blocks patches until the user deletes it; the refusal names the file. | GOAL-5 |
| ASM-005 | Accepted risk: a user agent identical in every field to a legacy file is indistinguishable from it and is treated as the squad's. | ASC-1 |
| ASM-006 | Accepted risk: while the plugin re-registers its late transform, a request for a squad agent fails as unknown. | GOAL-2 |
| ASM-007 | Accepted risk: another process sees a roster change on its next request, not at once. | GOAL-5 |

## 5. Found defects

| ID | Defect |
| --- | --- |
| DEF-001 | Unit assertions on prompt and skill prose break on harmless edits and miss the behaviour they claim to protect (GitHub #76). |
| DEF-002 | No integration test on the real host covers FR-003's rejection of edits, MCP tools and output redirection, FR-007, FR-014, FR-015, FR-017, FR-018, FR-020, FR-023, FR-024, FR-028, FR-030 to FR-035, FR-039 to FR-041, FR-043 or FR-044; unit tests cover most of them. |

## 6. Open questions

| ID | Question | Blocks | Owner |
| --- | --- | --- | --- |
| OQ-001 | Is ASM-001 verified at all, for example by evaluations against real models, or does it stay an assumption? | whether OOS-1 stays a non-goal | maintainer |
| OQ-002 | Should `squad_metrics` say that quota is unknown for a provider that sends no quota headers? | FR-039 and FR-040 wording | maintainer |
