# Pi-Bolt compatibility port

This branch is published in a fork for review. Installing it alongside the
existing extension, or replacing the user's package, requires separate validation.

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
  model is resolved **before** any surface opens. A fork uses the parent
  session's last `model_change`; otherwise the child's project settings are
  considered only when trust resolves true (explicit decision, or
  `defaultProjectTrust` `always`; `ask`/extensions/unreadable store fail
  closed). If there is no project settings file, no trust gate is applied and
  global settings are used. An untrusted project file is not read. Settings
  must provide `defaultProvider` + `defaultModel`, and `enabledModels` (if
  present) must include the default; a stored `defaultModel` that already starts
  with the provider is not double-prefixed. The resolved model is pinned in the
  loadout, then `providerExtensions` and `providerAuthExtension` are snapshotted
  from it. The parent's current `ctx.model` is not used. Missing defaults,
  out-of-scope defaults, invalid patterns, and unresolved trust are refused
  instead of snapshotting the wrong provider.
- Child session placement — child session files are created in the parent's
  actual session directory (`ctx.sessionManager.getSessionDir()`), not a
  re-derived default. An explicit `--session-dir` / settings `sessionDir` is
  authoritative for every child, including a cross-project `cwd`, so lab runs
  do not leak into `~/.pi/agent/sessions`. A relative session dir is resolved
  against the parent cwd before the path is passed to the child and stored in
  the name registry, because the child changes to its own cwd. Artifact and
  activity paths are resolved the same way. With default
  session dirs, a child in the parent's cwd uses the parent's dir, while an
  explicit cross-project cwd uses that project's default grouping after the
  cwd is resolved and normalized. The path encoding mirrors pi
  (`--G--repo--`), including its `normalizeWindowsShellPath` step: a Git Bash,
  MSYS, Cygwin, or WSL cwd (`/g/repo`, `/mnt/c/repo`, `/cygdrive/g/repo`) is
  converted to the native `G:\repo` form before resolving, so it lands in the
  same session group as the native path. UNC (`//server/share`) is left alone.
  Resume and fork follow the stored file path.
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
- Path helpers — pi's path normalization (`normalizeWindowsShellPath`,
  `normalizePiPath`, `resolvePiPath`), the child session-directory choice
  (`defaultSessionDirPath`, `samePath`, `resolveChildSessionDir`), and
  `canonicalizePath` live in `paths.ts`. `index.ts` imports them and re-exports
  the three public normalizers, so existing importers keep working; the
  `__test__` surface is unchanged. `paths.ts` imports only Node built-ins, so it
  cannot form a cycle with `index.ts`, `herdr.ts`, or `session.ts`. Behaviour is
  unchanged — the move only removed the duplicated bodies from the 3.7k-line
  `index.ts`.
- Windows hc (Core) launch — `herdr-desktop.ts` used a bare `bash`, which
  herdr-core resolves against the Windows registry PATH (often without Git's
  bin directory), so `hc run` failed with `cannot start bash: not found on
  PATH`. The launch argv now uses strict resolution in `shell.ts` (extracted to
  avoid a herdr/herdr-desktop cycle): `PI_SHELL_PATH` / settings `shellPath`
  (only when absolute), Program Files Git, Program Files (x86) Git, then
  msys64. A relative/bare configured path is ignored. If no absolute candidate
  exists, the desktop launch **refuses** with a `PI_SHELL_PATH` hint; it never
  falls back to a bare `bash` or the WSL stub. The TUI path keeps its
  historical bare-`bash` fallback via `resolveBash()`. The bash, script, and
  cwd are passed as separate argv/`--cwd` values, so spaces are preserved
  without shell quoting. Desktop availability now checks `hcBin()`, so
  `PI_SUBAGENT_HC_BIN` is respected.
- Windows TUI launch — query the new pane's foreground shell before typing
  the launch command. Git Bash receives a quoted POSIX script path;
  PowerShell and cmd receive a quoted `.cmd` wrapper in their own syntax.
  An unknown shell is a launch error. Messages require a detected Herdr agent;
  they are never sent as shell commands when agent detection fails.
- Pi-Bolt Herdr status — restricted Pi-Bolt children in Herdr TUI explicitly
  load `builtin:herdr` after `--no-extensions`. This reporter registers no
  tools; the tool allowlist and provider restrictions remain in force.
- CRLF agent files — `parseAgentDefinition` normalizes CRLF before parsing.
  Git checkouts on Windows (`core.autocrlf=true`) previously produced zero
  discoverable agents and silently empty agent defaults.
- `/subagent-doctor` — prints each agent's allowlist, resolved extension paths,
  provider-extension status, and Herdr availability without a model call.
- The sub-agent tools widget lists `getActiveTools()`, not `getAllTools()`. The
  former is the set declared to the model after `--tools` filtering; the latter
  also contains registered-but-inactive tools, so the widget used to advertise
  tools the child could not call. A host without `getActiveTools` falls back to
  `getAllTools`. `test/test.ts` covers both branches, the collapsed and
  expanded renderings, and fails if the active list is ignored.

## Behavior changes to review

- Profiles without `tools:` are read-only. All bundled agents declare tools;
  a local agent that relies on implicit full access must add `tools:`.
- Profiles without `model:` are accepted only when the child's effective model
  can be resolved reliably. A fork uses its recorded `model_change`. Otherwise:
  - No project `.pi/settings.json` means no trust gate (matching pi's
    `hasTrustRequiringProjectResources` shortcut); global settings apply.
  - If project settings exist, an explicit trust-store decision wins; with no
    decision, `defaultProjectTrust` `always` trusts and `never` denies. An
    unresolved `ask`, an unreadable trust store, or a project `.pi/extensions`
    directory (whose `project_trust` handlers cannot be replicated) fails
    closed.
  - An untrusted project file is **never read**; global defaults apply.
  - Settings must provide `defaultProvider` + `defaultModel`; `enabledModels`
    (if present) must include that default. A stored `defaultModel` that
    already begins with the provider is not double-prefixed.

  The resolved model is pinned for the run. Otherwise spawn is refused with an
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
- `npm test` — 252 tests, 252 pass. `test/run-tests.mjs` clears inherited
  `PI_SUBAGENT_*` variables so the suite is deterministic when run inside a
  subagent; direct `node --test test/test.ts` inside a restricted child also
  works if `PI_SUBAGENT_ALLOWED` is unset. `test/system-prompt-mode.test.ts`
  is part of the suite: it now loads agents through `loadAgentDefaults` and
  builds CLI flags through `applySandboxToParts`, so the frontmatter field and
  its two delivery flags are covered by shipped code instead of a local copy
  of the logic.
- Added tests: `test/join.test.ts` (all/any, timeout, abort, question, blocked,
  stale generation, reset), `test/pi-bolt.test.ts` (read-only default,
  legacy snapshot refusal, provenance for pi-web-access tool names, bundled
  agent tool resolution, pinned paths, provider and Anthropic extensions,
  Windows cwd, Pi-Bolt binary resolution, shared resume command, wait tool
  statuses and question release), and `test/retry.test.ts` (retry success with
  the same run id, exhaustion, retry-start failure, retry/summary/delivery
  exceptions, missing and corrupt transcripts, seeded-session summary
  baseline, parallel retries, MCP refusal, pinned provider/auth failure,
  omitted-model resolution from trusted child settings and forks, the
  home-directory setup (defaultProjectTrust always, no project settings),
  explicit deny/never global fallback, project extensions and unreadable trust
  store fail-closed, out-of-scope enabledModels/missing defaults, provider
  prefix handling, and refusal of null-model snapshots).
- Child session placement tests cover an explicit lab `--session-dir`
  (including a cross-project cwd and no default-dir pollution), a relative
  session dir resolved against the parent cwd, canonical cwd normalization
  (trailing separator, `.`, `..`), Git Bash/MSYS/Cygwin/WSL cwd normalization
  (`/g`, `/mnt/c`, `/cygdrive/g`) against the native encoding with UNC
  preserved, the parent's actual dir for the same cwd,
  the child cwd's default grouping for cross-project cwd, Windows drive-colon
  encoding, seeding a fork in the lab directory with the child cwd in its
  header, and resolving a relative artifact dir against the parent cwd.
- Windows Git Bash TUI regression probe — a real Pi-Bolt parent and child
  completed a model task in an isolated Herdr 0.9.5 server configured with
  Git Bash as its default shell. The server identified the running child as
  `pi-bolt`; completion delivery and an in-flight wait passed. The probe had
  22 passing assertions and left the user's server and sessions unchanged.
- Windows hc launch tests cover an absolute Git Bash plus a script and cwd
  containing spaces, `resolveBashFor` precedence (configured shell, Program
  Files Git, msys64, never a bare PATH bash), rejection of a non-absolute
  `shellPath`, the explicit `PI_SHELL_PATH` refusal when no candidate exists,
  and `isHerdrDesktopAvailable()` honouring an existing/missing
  `PI_SUBAGENT_HC_BIN` path.
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

1. Windows herdr-core 0.1.17 was tested headlessly with the desktop backend:
   a 65-check probe covered child launch, message delivery, exit status,
   cleanup, and `pi-bolt.exe --version`. Two subsequent real Pi-Bolt/model
   tasks on commit `c691bcb` tested result delivery and `subagent_wait` while
   the child was running, including same-cwd and cross-cwd cases. A custom
   absolute session directory kept both child sessions outside the default
   session tree. A further real Pi-Bolt/model task on commit `08e0f24`
   verified a relative session directory and a cross-project `/c/...` cwd,
   result delivery, and an in-flight wait. GUI layout remains unverified.
2. Herdr TUI spawn is verified, TUI resume is not. A real Pi-Bolt parent and
   child ran in an isolated Herdr 0.9.5 server (named session, lab XDG dirs)
   with the default shell set to Git Bash: the fork created the surface, the
   child completed a model call, the completion steer arrived, and an in-flight
   `subagent_wait` blocked ~40 s before returning `completed`. The server also
   reported the child pane's agent as `pi-bolt`, and the child session stayed
   in the parent's `--session-dir`. The user's live server, socket, and layout
   were unchanged. Herdr TUI resume and desktop resume remain unverified, as
   does the TUI client's own rendering and focus behaviour.
3. `/subagent-doctor` was run in a live Pi-Bolt session and printed real
   extension paths resolved through `getAllTools().sourceInfo`: pi-web-access
   (`web_search`, `fetch_content`, `get_search_content`, `source_check` →
   `…/pi-web-access/dist/index.js`), this package's spawning tools and
   `subagent-done.ts`, and `antigravity-acp` →
   `…/pi-antigravity-acp-provider/extensions/index.ts`. The earlier
   `getAllTools` mock coverage is superseded by this live run.
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
9. Native Windows cwd, a Git Bash `/c/...` cwd, and both absolute and relative
   custom session-directory placement were exercised in headless Core; live
   resume/fork across cwd remains unverified.
10. Only `antigravity-acp` and the upstream Anthropic auth extension have
    provider mappings. Other extension-provided providers need an entry or
    `registerProviderExtension`.
11. The fork/lineage summary baseline is tested at the `summarizeAttempt`
    level, not by spawning a real seeded fork session. Verify with a live fork
    run before relying on the last-message summary.
12. Omitted-model resolution follows pi's trust order but cannot run project
    extension `project_trust` handlers: a project `.pi/extensions` directory
    fails closed. With no project settings file no trust gate is applied. When
    one exists, explicit trust-store decisions win; `always`/`never` are
    honoured; unresolved `ask` and unreadable stores are refused. An untrusted
    project file is never read; global defaults apply. `enabledModels` matching
    uses conservative globs, so a fuzzy pattern that cannot be proven to include
    the default is refused even though pi might resolve it. Set `model:`
    explicitly where that matters.
