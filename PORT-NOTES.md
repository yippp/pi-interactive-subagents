# Pi-Bolt compatibility port

Status: local working tree only. No remote fork, no push, and the user's
settings, installed packages, and Herdr configuration were not touched.

Base: upstream `c41d6fc` (`@jordyvanvorselen/pi-interactive-subagents` 1.2.0).
The port keeps the Herdr TUI (`herdr.ts`) and Herdr desktop / herdr-core
(`herdr-desktop.ts`) backends and the existing agent frontmatter schema. It does
not reintroduce the tmux/WezTerm mux layer from the local package.

## Ported from the local package

- `pi-extension/subagents/join.ts` (new) — event-driven join state keyed by
  name. `subagent_wait` supports `all`/`any`, timeout, abort, early release on
  any child question, and never cancels or closes children. Results still
  arrive through the normal steer channel; the wait returns compact statuses.
- `subagent_wait` tool registration plus a `before_agent_start` note. The tool
  is also part of `SPAWNING_TOOLS`, so nested workers receive it.
- `childPiBin()` — a Pi-Bolt host spawns `process.execPath` so children run the
  same ahead-of-time build; npm/git Pi hosts keep `pi` from PATH.
  `PI_SUBAGENT_PI_BIN` overrides the binary. Used by spawn, resume, and retry.
- `buildResumeCommand()` — one resume/retry command builder (session, sandbox,
  model, env, cwd), used by `subagent_message` resume and provider-error retry.
- Provider-error retry — `watchSubagentWithRetry`, `retrySubagentRun`,
  `retryNudge`, `SUBAGENT_RETRY_MAX` (default 3 extra attempts,
  `PI_SUBAGENT_RETRY_MAX=0` disables). Only `result.errorMessage` triggers a
  retry; claude children keep their previous behavior. A retry resumes the same
  session in a fresh surface under the **same run id**, so an in-flight
  `subagent_wait` keeps waiting instead of returning `runtime_changed`.
  Summaries use only entries written after the attempt started, so a retry
  that produces no new assistant output cannot report the previous answer.
  The failed run keeps its `runningSubagents` identity until the retry reaches a
  terminal state; `subagent_message` on a retrying run returns a clear error
  instead of racing a second process onto the same session file. All watcher
  failures (retry, summary, delivery) are caught, finish the join, remove the
  run, and report once. Missing or corrupt session transcripts are reported in
  the result rather than thrown.
- Provider/auth snapshot — when a profile omits `model:`, the effective child
  model is resolved **before** any surface opens: a fork uses the parent
  session's last `model_change`; otherwise the child's global/project settings
  must provide `defaultProvider` + `defaultModel` and must not set
  `enabledModels`. The resolved model is pinned in the loadout, then
  `providerExtensions` and `providerAuthExtension` are snapshotted from it.
  The parent's current `ctx.model` is not used, because the child resolves its
  own settings. An unresolvable case is refused instead of snapshotting the
  wrong provider.
- Tool source mapping — `getToolExtensionPath` now resolves `sourceInfo.path`
  from `getAllTools()` for npm/git/local extensions instead of guessing
  `<agent dir>/extensions/<name>/index.ts`. This is what makes
  `fetch_content`, `get_search_content`, and `source_check` from pi-web-access
  resolvable. `ask_question` maps to `subagent-done.ts`; `powershell` is a
  built-in. Unresolvable tools throw before a surface is created.
- Pinned extension paths — `SubagentLoadout.toolExtensions` snapshots the
  resolved tool → extension map, so resume/retry replays the same files even if
  the parent later loads a different set.
- Read-only default — a profile that omits `tools:` gets
  `read,grep,find,ls,ask_question` instead of the full toolset and every global
  extension. A snapshot with `toolAllowlist: null` is refused rather than
  replayed unrestricted.
- Provider extensions — `providerExtensionPath()` loads a model-provider
  extension for a restricted child when the model prefix matches
  (`antigravity-acp` is mapped). The upstream Anthropic OAuth transport
  extension (`getProviderAuthExtensionPath`) is preserved and still added for
  `anthropic/` OAuth models. `registerProviderExtension(prefix, path)` covers
  other providers.
- Windows cwd — `resolveSubagentPaths` uses `isAbsolute()` instead of
  `startsWith("/")`, so a `G:\repo` cwd is not joined onto the parent cwd.
- Windows hc (Core) launch — `herdr-desktop.ts` used a bare `bash`, which
  herdr-core resolves against the Windows registry PATH (often without Git's
  bin directory), so `hc run` failed with `cannot start bash: not found on
  PATH`. The launch argv now uses the shared `resolveBash()` (extracted to
  `shell.ts` to avoid a herdr/herdr-desktop cycle): `PI_SHELL_PATH` / settings
  `shellPath`, Program Files Git, Program Files (x86) Git, then msys64. Only
  absolute candidates are used, never the WSL stub from PATH. The bash, script,
  and cwd are passed as separate argv/`--cwd` values, so spaces are preserved
  without shell quoting. Desktop availability now checks `hcBin()`, so
  `PI_SUBAGENT_HC_BIN` is respected.
- CRLF agent files — `parseAgentDefinition` normalizes CRLF before parsing.
  Git checkouts on Windows (`core.autocrlf=true`) previously produced zero
  discoverable agents and silently empty agent defaults.
- `/subagent-doctor` — prints each agent's allowlist, resolved extension paths,
  provider-extension status, and Herdr availability without a model call.

## Behavior changes to review

- Profiles without `tools:` are read-only. All bundled agents declare tools;
  a local agent that relies on implicit full access must add `tools:`.
- Profiles without `model:` are accepted only when the child's effective model
  can be resolved reliably (fork: a recorded model_change; otherwise child
  settings with `defaultProvider`/`defaultModel` and no `enabledModels`). The
  resolved model is pinned for the run. Otherwise spawn is refused with an
  explicit error; set `model:` in the profile. The parent's `ctx.model` is
  deliberately ignored.
- Pre-port loadout snapshots without a tool list cannot be resumed. Spawn a
  fresh named agent instead.
- `subagent_wait` state is in memory. After `/reload` or restart, resume the
  finished agent by name or spawn fresh before waiting.
- A tool that cannot be resolved is a hard spawn error. A new agent profile
  using an extension-provided tool needs that extension loaded in the parent
  (or `registerToolExtension`), otherwise spawn fails loudly. Local profiles
  that still request `web_fetch` must switch to pi-web-access's
  `fetch_content`; the bundled agents and README were updated.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 216 tests, 216 pass. `test/run-tests.mjs` clears inherited
  `PI_SUBAGENT_*` variables so the suite is deterministic when run inside a
  subagent; direct `node --test test/test.ts` inside a restricted child also
  works if `PI_SUBAGENT_ALLOWED` is unset.
- Added tests: `test/join.test.ts` (all/any, timeout, abort, question, blocked,
  stale generation, reset), `test/pi-bolt.test.ts` (read-only default,
  legacy snapshot refusal, provenance for pi-web-access tool names, bundled
  agent tool resolution, pinned paths, provider and Anthropic extensions,
  Windows cwd, Pi-Bolt binary resolution, shared resume command, wait tool
  statuses and question release), and `test/retry.test.ts` (retry success with
  the same run id, exhaustion, retry-start failure, retry/summary/delivery
  exceptions, missing and corrupt transcripts, seeded-session summary
  baseline, parallel retries, MCP refusal, pinned provider/auth failure,
  omitted-model resolution from child settings and forks, refusal on
  enabledModels/missing defaults, and refusal of null-model snapshots).
- Windows hc launch tests cover an absolute Git Bash plus a script and cwd
  containing spaces, `resolveBashFor` precedence (configured shell, Program
  Files Git, msys64, never a bare PATH bash), and `isHerdrDesktopAvailable()`
  honouring an existing/missing `PI_SUBAGENT_HC_BIN` path.
- Bundled `researcher` and `worker` now request `fetch_content` instead of the
  removed `web_fetch`; with the new hard failure, `web_fetch` made both agents
  impossible to spawn on a clean install. The README agent table was corrected
  to the actual models and tools.
- Resume validates the loadout and builds the command before creating a
  surface, and closes the surface if the launch write fails.
- Updated upstream tests for the intentional behavior changes and for Windows
  path separators.

## MCP tools are deliberately unsupported in restricted subagents

`builtin:mcp` is a gateway, not a per-tool extension. Passing `-e builtin:mcp`
connects every enabled MCP server and may expose their names and capabilities
to the child. Fine-grained per-tool or per-server isolation has not been
verified, so the conservative choice is to refuse it: the sandbox never emits a
`builtin:` path, and an `mcp__*` / `mcp_*` tool in a profile fails with an
explicit error instead of silently disappearing. Parent MCP use is unaffected.
To grant one MCP tool to a child, wrap it in a dedicated extension that
registers only that tool and call `registerToolExtension(name, path)`; there is
no per-server isolation for MCP.

## Switch blockers (unverified, do not replace the active package until checked)

1. No live Herdr TUI or Herdr desktop spawn/resume was run in this task. The
   workspace already had a running Herdr session and a real model call was out
   of scope. Unit tests cover the command builders, not surface creation.
2. The Windows hc/Core fix is covered by unit tests only here. The real
   herdr-core launch (`hc run` with the absolute Git Bash, a script path with
   spaces, and a cwd with spaces) must be retested by `core-test-plan` before
   this branch replaces the active package.
3. No live Pi-Bolt child was launched in a pane. `resolveChildPiBin` is tested
   as a pure function; `pi-bolt.exe --session ...` in a Herdr surface remains
   unconfirmed.
4. `getAllTools().sourceInfo` was exercised through a mocked extension API.
   The installed pi-web-access package does register `fetch_content`,
   `get_search_content`, and `source_check`, but a live parent was not queried.
   Run `/subagent-doctor` in the target session to confirm the real paths.
5. The provider extension path was tested with a temporary fixture matching the
   real npm layout, not with a live `antigravity-acp/*` model call.
6. The retry loop is covered with injected dependencies, not a real provider
   failure. `retryNudge`, `buildResumeCommand`, defaults, summary baselines,
   retry/summary/delivery exceptions, and the same-id join behavior are tested,
   but no child was actually resumed after an upstream error.
7. A native blocked-UI signal is not wired into joins. The join class supports
   `blocked`, but this upstream has no poll event for Herdr `agent_blocked`
   (it only surfaces as a steer error). `ask_question` early return is wired
   through the `.ask` file and is tested. Any child question releases a wait,
   including one for unrelated names, by design: a queued steer cannot be
   answered while a tool call is blocked.
8. `npm run test:integration` was not run: it starts live pi sessions and model
   requests in Herdr surfaces.
9. The Windows cwd fix is covered by a unit test on win32, not by a live spawn
   with a drive-letter cwd.
10. Only `antigravity-acp` and the upstream Anthropic auth extension have
    provider mappings. Other extension-provided providers need an entry or
    `registerProviderExtension`.
11. The fork/lineage summary baseline is tested at the `summarizeAttempt`
    level, not by spawning a real seeded fork session. Verify with a live fork
    run before relying on the last-message summary.
12. Omitted-model resolution reads the child's global/project settings and a
    fork's recorded `model_change`. It refuses when `enabledModels` scopes the
    session or defaults are absent. A trust difference between parent and
    child project settings could still change the effective model; set
    `model:` explicitly when that matters.
