import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SubagentJoin } from "./join.ts";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  needsShellReadyDelay,
  createSurface,
  sendMessage,
  sendLongCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  readScreen,
} from "./herdr.ts";

import {
  countSessionEntryLines,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  summarizeSessionStats,
  writeSubagentLoadout,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the CLI binary used for child subagent processes.
 *
 * A Pi-Bolt host must spawn Pi-Bolt itself (`process.execPath`), not the npm
 * `pi` found on PATH, so children run the same ahead-of-time build and see the
 * same provider/runtime behaviour. npm/git Pi hosts keep the upstream `pi`.
 * `PI_SUBAGENT_PI_BIN` overrides the result for testing or pinning.
 */
export function resolveChildPiBin(execPath: string, override?: string): string {
  if (override) return shellEscape(override);
  const execName = basename(execPath).toLowerCase();
  if (/^pi-bolt(-[a-z0-9]+)*(?:\.exe)?$/.test(execName)) {
    return shellEscape(execPath);
  }
  return "pi";
}

let cachedChildPiBin: string | undefined;

/** Cached child CLI invocation (shell-escaped when it is an absolute path). */
function childPiBin(): string {
  return (cachedChildPiBin ??= resolveChildPiBin(
    process.execPath,
    process.env.PI_SUBAGENT_PI_BIN,
  ));
}

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Short descriptive label for the subagent's tab/pane and widget row. ALWAYS set it. " +
        "Name the task, not the agent type: 2-4 words, lowercase, kebab-case, under 24 characters " +
        "(e.g. 'auth-token-refactor', 'map-payment-flow', 'research-oauth-pkce'). " +
        "It must be unique within this session. Has no effect on which agent runs — use `agent` for that.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * An agent is granted these (and this extension is loaded into its child
 * process) only when its frontmatter declares a non-empty `subagent_agents`.
 */
const SPAWNING_TOOLS = [
  "subagent",
  "subagent_message",
  "subagents_list",
  "subagent_wait",
] as const;

/** Built-in tools pi provides natively — no extension needs to be loaded. */
const BUILTIN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
]);

// A profile that omits `tools:` gets a read-only fallback instead of every
// extension and shell access. Write/bash privileges must be explicit.
const READ_ONLY_FALLBACK_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ── Runtime tool-extension registration ─────────────────────────────────────
// `getToolExtensionPath` otherwise only knows a closed set of tool names. Other
// pi extensions that bundle a tool for subagents (e.g. a project-local
// extension exposing a bespoke tool) register its name → extension-file path
// here at load/session_start time so a child process can be launched with
// `--no-extensions` + an explicit `-e <path>` for it. Mirrors the legacy
// `subagents` extension's `registerToolExtension` hook.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/**
 * Provider-providing extensions, keyed by the provider prefix used in
 * `--model <provider>/<id>`. These register models, not tools, so the
 * tool → extension map cannot cover them. A restricted child runs with
 * `--no-extensions`; without the provider extension it fails to resolve the
 * model at all (`No models match pattern ...`) before doing any work.
 *
 * The map holds package-relative paths under `<agent dir>/npm/node_modules`.
 * Add an entry per provider extension; callers can also register one at runtime.
 */
const PROVIDER_EXTENSION_PACKAGES: Record<string, string[]> = {
  "antigravity-acp": ["pi-antigravity-acp-provider", "extensions", "index.ts"],
};
const EXTRA_PROVIDER_EXTENSIONS = new Map<string, string>();

/** Resolve the installed entry file for a model provider implemented by an extension. */
function providerExtensionPath(providerPrefix: string): string | undefined {
  const registered = EXTRA_PROVIDER_EXTENSIONS.get(providerPrefix);
  if (registered) return registered;
  const segments = PROVIDER_EXTENSION_PACKAGES[providerPrefix];
  if (!segments) return undefined;
  return join(getAgentConfigDir(), "npm", "node_modules", ...segments);
}

/** Resolve installed provider extensions for a model id or provider prefix. */
function providerExtensionsForModel(model: string | null | undefined): string[] {
  if (!model) return [];
  const prefix = model.split("/")[0];
  const path = prefix ? providerExtensionPath(prefix) : undefined;
  return path && existsSync(path) ? [path] : [];
}

/** Registered provider extension paths, for diagnostics and tests. */
function providerExtensionMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const prefix of Object.keys(PROVIDER_EXTENSION_PACKAGES)) {
    const path = providerExtensionPath(prefix);
    if (path) map[prefix] = path;
  }
  for (const [prefix, path] of EXTRA_PROVIDER_EXTENSIONS) map[prefix] = path;
  return map;
}

/**
 * Register a provider extension for restricted children. Use this when a model
 * provider is implemented by an extension installed outside the default npm
 * package directory.
 */
export function registerProviderExtension(providerPrefix: string, extensionPath: string): void {
  const existing = EXTRA_PROVIDER_EXTENSIONS.get(providerPrefix);
  if (existing === extensionPath) return;
  if (existing !== undefined) {
    throw new Error(
      `Provider extension already registered for "${providerPrefix}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_PROVIDER_EXTENSIONS.set(providerPrefix, extensionPath);
}

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
  registerProviderExtension,
};

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Used to build the child's `--extension` whitelist after
 * `--no-extensions` disables global discovery. Returns undefined for built-in
 * tools and for unknown names (which simply won't be granted).
 */
function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  // ask_question is registered by subagent-done.ts, which is always loaded
  // into a subagent process (the spawning tools are registered by this file).
  if (tool === "ask_question") return join(SUBAGENTS_DIR, "subagent-done.ts");
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(import.meta.url);
  }
  // Resolve the actual loaded extension (npm package, git package, local file)
  // through pi's canonical provenance instead of guessing install paths. This
  // is what makes npm-provided tools such as pi-web-access work in a child.
  const source = latestPi?.getAllTools?.().find((item) => item.name === tool)?.sourceInfo;
  if (
    source &&
    source.source !== "builtin" &&
    source.source !== "sdk" &&
    isAbsolute(source.path) &&
    existsSync(source.path)
  ) {
    return source.path;
  }
  // Legacy install-path fallback for hosts that did not expose provenance
  // (for example a tool registered after startup). Prefer the loaded path above.
  const extBase = join(getAgentConfigDir(), "extensions");
  const map: Record<string, string> = {
    web_search: join(extBase, "web-search", "index.ts"),
    web_fetch: join(extBase, "web-fetch", "index.ts"),
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts"),
  };
  // Prefer the built-in path, but fall back to a runtime-registered extension
  // when that path no longer exists on disk (e.g. a built-in tool extension
  // was disabled/removed but a project-local extension re-registered it).
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  return EXTRA_TOOL_EXTENSIONS.get(tool);
}

/**
 * Extensions that must be re-enabled in a child even though they back no tool.
 *
 * `--no-extensions` + one `-e` per tool-backing extension leaves out anything
 * that only wraps the provider transport. `@gotgenes/pi-anthropic-auth` is
 * exactly that: it shapes Anthropic OAuth requests so a Claude Pro/Max
 * subscription token is billed against the plan instead of extra usage. Without
 * it a child on an `anthropic/` model dies on its first provider request with
 * `400 You're out of extra usage`.
 *
 * Fork children are a separate `pi` process, so the extension's own
 * docs/architecture.md rates them covered "for that process's own modelRuntime
 * traffic" — the only requirement is that the process load the extension.
 * Returns undefined when the package is absent or the child is not on an
 * Anthropic OAuth model, so nothing changes for API-key or other providers.
 */
function getProviderAuthExtensionPath(model: string | null | undefined): string | undefined {
  if (!model?.startsWith("anthropic/")) return undefined;

  let credentials: string;
  try {
    credentials = readFileSync(join(getAgentConfigDir(), "auth.json"), "utf8");
  } catch {
    return undefined; // no stored credentials: API key or env-var auth
  }
  const access = JSON.parse(credentials)?.anthropic?.access;
  if (typeof access !== "string" || !access.startsWith("sk-ant-oat")) return undefined;

  const path = join(
    getAgentConfigDir(),
    "npm",
    "node_modules",
    "@gotgenes",
    "pi-anthropic-auth",
    "src",
    "index.ts",
  );
  return existsSync(path) ? path : undefined;
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session, or an unrestricted child).
 */
const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
})();

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  // Git checkouts on Windows (core.autocrlf=true) hand us CRLF agent files.
  // Normalize first: the frontmatter regexes and value parsing below assume LF.
  const normalized = content.replace(/\r\n?/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = normalized.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  // When this process is itself a restricted subagent, only expose the agents
  // it is permitted to spawn (PI_SUBAGENT_ALLOWED). Top-level sessions see all.
  const all = [...agents.values()];
  return SUBAGENT_ALLOWLIST ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name)) : all;
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? isAbsolute(rawCwd)
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

/**
 * Copy of pi's normalizeWindowsShellPath: convert a Git Bash / MSYS / Cygwin /
 * WSL drive path (`/g/repo`, `/mnt/c/repo`, `/cygdrive/g/repo`) into the native
 * `G:\repo` form. Only applies on Windows, and leaves UNC paths (`//server/...`)
 * and paths that already contain a backslash alone.
 */
export function normalizeWindowsShellPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return filePath;
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/** Resolve a cwd the way pi does before encoding a session directory. */
function resolvedCwdForEncoding(cwd: string): string {
  // pi's resolvePath() calls normalizePath() first, so a shell-style drive path
  // becomes a native Windows path before it is resolved and encoded. Without
  // this, `/g/repo` and `G:\repo` would produce different session groups and
  // the session would not be discoverable.
  return resolve(normalizeWindowsShellPath(cwd));
}

function defaultSessionDirPath(cwd: string, agentDir: string): string {
  // Mirrors pi's getDefaultSessionDirPath: resolvePath() first (native path,
  // absolute, normalized, no trailing separator / `.` / `..`), then the Windows
  // drive-colon encoding (`G:\repo` -> `--G--repo--`). Pure: callers choose
  // whether to create the directory, so an explicit --session-dir is never
  // polluted with an unused default directory.
  const resolvedCwd = resolvedCwdForEncoding(cwd);
  const resolvedAgentDir = resolve(normalizeWindowsShellPath(agentDir));
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvedAgentDir, "sessions", safePath);
}

function samePath(a: string, b: string): boolean {
  // Normalize shell-style drive paths first, so a parent in `G:\repo` and a
  // child cwd `/g/repo` are recognized as the same directory.
  const left = canonicalizePath(resolve(normalizeWindowsShellPath(a)));
  const right = canonicalizePath(resolve(normalizeWindowsShellPath(b)));
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Choose where a child session file lives.
 *
 * - An explicit session dir (`--session-dir`, settings `sessionDir`, or a
 *   session file opened from a custom directory) is authoritative: children go
 *   beside the parent, even when the child runs in another project. This keeps
 *   lab runs out of the user's default `~/.pi/agent/sessions` tree. A relative
 *   explicit dir is resolved against the parent cwd so the child process (which
 *   changes cwd) and the parent's registry/watch paths agree.
 * - With default session dirs and the same cwd, use the parent's actual dir.
 * - With default session dirs and an explicit cross-project cwd, use that
 *   project's default grouping so resume-by-cwd still works.
 */
function resolveChildSessionDir(opts: {
  parentSessionDir: string;
  parentCwd: string;
  childCwd: string;
  agentDir: string;
  usesDefaultSessionDir: boolean;
}): string {
  const parentBase = resolve(opts.parentCwd);
  const parentDir = resolve(parentBase, opts.parentSessionDir);
  if (!opts.usesDefaultSessionDir) return parentDir;
  if (samePath(opts.parentCwd, opts.childCwd)) return parentDir;
  return defaultSessionDirPath(opts.childCwd, opts.agentDir);
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

function readJsonSettings(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

type SettingsFileLoad =
  | { kind: "ok"; value: Record<string, any> }
  | { kind: "missing" }
  | { kind: "invalid"; error: string };

function loadSettingsFile(file: string): SettingsFileLoad {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { kind: "missing" };
    return { kind: "invalid", error: error?.message ?? String(error) };
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid", error: "expected a JSON object" };
    }
    return { kind: "ok", value: parsed as Record<string, any> };
  } catch (error: any) {
    return { kind: "invalid", error: error?.message ?? String(error) };
  }
}

type TrustStoreLoad =
  | { kind: "missing" }
  | { kind: "ok"; store: Record<string, unknown> }
  | { kind: "invalid"; error: string };

function loadTrustStore(agentDir: string): TrustStoreLoad {
  const file = join(agentDir, "trust.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { kind: "missing" };
    return { kind: "invalid", error: error?.message ?? String(error) };
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid", error: "expected a JSON object" };
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== true && value !== false && value !== null) {
        return {
          kind: "invalid",
          error: `value for ${JSON.stringify(key)} must be true, false, or null`,
        };
      }
    }
    return { kind: "ok", store: parsed as Record<string, unknown> };
  } catch (error: any) {
    return { kind: "invalid", error: error?.message ?? String(error) };
  }
}

/** Nearest ancestor trust decision, mirroring pi's trust store lookup. */
function nearestTrustDecision(
  store: Record<string, unknown>,
  cwd: string,
): boolean | null {
  let current = canonicalizePath(cwd);
  for (;;) {
    const value = store[current];
    if (value === true || value === false) return value;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Decide whether the child would load project settings, following pi's
 * `resolveProjectTrusted` order: an explicit trust-store decision first,
 * then `defaultProjectTrust` (`always` / `never` / `ask`). `ask` cannot be
 * resolved without the child's UI, so it fails closed.
 *
 * Project extensions can answer the `project_trust` event before the store;
 * their decision cannot be replicated here, so a project `.pi/extensions`
 * directory also fails closed.
 */
function resolveProjectSettingsTrust(opts: {
  agentDir: string;
  childCwd: string;
  globalSettings: Record<string, any>;
}): { trusted: boolean } | { error: string } {
  if (existsSync(join(opts.childCwd, ".pi", "extensions"))) {
    return {
      error:
        `project extensions in ${join(opts.childCwd, ".pi", "extensions")} can decide project trust ` +
        `at runtime, so the effective trust cannot be verified here; set model: explicitly.`,
    };
  }

  const store = loadTrustStore(opts.agentDir);
  if (store.kind === "invalid") {
    return {
      error:
        `cannot read trust store ${join(opts.agentDir, "trust.json")}: ${store.error}; ` +
        `set model: explicitly.`,
    };
  }
  const explicit = store.kind === "ok" ? nearestTrustDecision(store.store, opts.childCwd) : null;
  if (explicit === false) return { trusted: false };
  if (explicit === true) return { trusted: true };

  const fallback = opts.globalSettings.defaultProjectTrust;
  if (fallback === "always") return { trusted: true };
  if (fallback === "never") return { trusted: false };
  return {
    error:
      `project trust for ${opts.childCwd} is unresolved ` +
      `(no trust decision and defaultProjectTrust is ${typeof fallback === "string" ? `"${fallback}"` : "unset (ask)"}); ` +
      `set model: explicitly.`,
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** True when the concrete model matches any enabledModels pattern. */
function modelMatchesScope(model: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(model));
}

function configuredProviders(agentDir: string): Set<string> {
  const models = readJsonSettings(join(agentDir, "models.json"));
  const providers = models?.providers;
  return new Set(
    providers && typeof providers === "object" && !Array.isArray(providers)
      ? Object.keys(providers)
      : [],
  );
}

/**
 * Build `provider/modelId` without prefixing twice when settings already store
 * `provider/modelId`. A model id may itself contain a slash (`group/master`),
 * so only treat the first segment as a provider when it is the default
 * provider or a provider declared in models.json.
 */
function withProviderPrefix(provider: string, modelId: string, agentDir: string): string {
  if (modelId.startsWith(`${provider}/`)) return modelId;
  if (modelId.includes("/")) {
    const first = modelId.split("/")[0];
    if (configuredProviders(agentDir).has(first)) return modelId;
  }
  return `${provider}/${modelId}`;
}

/** The last model_change in a pi session file, or null. */
function lastModelInSession(file: string): string | null {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (
          entry?.type === "model_change" &&
          typeof entry.provider === "string" &&
          entry.provider.trim() &&
          typeof entry.modelId === "string" &&
          entry.modelId.trim()
        ) {
          return `${entry.provider.trim()}/${entry.modelId.trim()}`;
        }
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Resolve the model the child actually starts with when the profile omits
 * `model:`.
 *
 * The parent's current model is not authoritative: a child resolves its own
 * settings, project trust controls whether project settings apply, and a fork
 * inherits the parent session's last model_change. Snapshotting the wrong
 * provider would load the wrong provider/auth extension, so refuse when the
 * effective model cannot be determined reliably.
 */
function resolveChildInitialModel(opts: {
  explicitModel: string | null;
  sessionMode: SubagentSessionMode;
  parentSessionFile: string;
  agentDir: string;
  childCwd: string;
}): { model: string } | { error: string } {
  if (opts.explicitModel) return { model: opts.explicitModel };

  if (opts.sessionMode === "fork") {
    const inherited = lastModelInSession(opts.parentSessionFile);
    if (inherited) return { model: inherited };
    return {
      error: `the forked session has no recorded model; set model: explicitly.`,
    };
  }

  // A project settings file matters only when it exists. With no such file
  // there is nothing to gate: the child uses global settings, matching pi's
  // `hasTrustRequiringProjectResources` shortcut. When the file exists, follow
  // pi's order: explicit trust-store decision, then defaultProjectTrust; an
  // unresolved `ask`, an unreadable store, or project extensions fail closed.
  // An untrusted project file is never read.
  const globalFile = join(opts.agentDir, "settings.json");
  const globalLoad = loadSettingsFile(globalFile);
  if (globalLoad.kind === "invalid") {
    return {
      error: `cannot read ${globalFile}: ${globalLoad.error}; set model: explicitly.`,
    };
  }
  const globalSettings = globalLoad.kind === "ok" ? globalLoad.value : {};

  const projectFile = join(opts.childCwd, ".pi", "settings.json");
  let projectSettings: Record<string, any> = {};
  if (existsSync(projectFile)) {
    const trust = resolveProjectSettingsTrust({
      agentDir: opts.agentDir,
      childCwd: opts.childCwd,
      globalSettings,
    });
    if ("error" in trust) return trust;
    if (trust.trusted) {
      const projectLoad = loadSettingsFile(projectFile);
      if (projectLoad.kind !== "ok") {
        return {
          error:
            `cannot read trusted project settings ${projectFile}: ` +
            `${projectLoad.kind === "invalid" ? projectLoad.error : "file disappeared"}; ` +
            `set model: explicitly.`,
        };
      }
      projectSettings = projectLoad.value;
    }
  }
  const settings = { ...globalSettings, ...projectSettings };

  const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
  const modelId = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : "";
  if (!provider || !modelId) {
    return {
      error:
        `the effective child settings have no defaultProvider/defaultModel; ` +
        `set model: explicitly.`,
    };
  }
  if (/[*?]/.test(provider) || /[*?]/.test(modelId)) {
    return {
      error: `defaultProvider/defaultModel must be a concrete model, not a pattern; set model: explicitly.`,
    };
  }

  const model = withProviderPrefix(provider, modelId, opts.agentDir);

  const scoped = settings.enabledModels;
  if (scoped !== undefined) {
    if (
      !Array.isArray(scoped) ||
      !scoped.every((pattern) => typeof pattern === "string" && pattern.trim())
    ) {
      return { error: `enabledModels is not a valid string list; set model: explicitly.` };
    }
    if (scoped.length > 0 && !modelMatchesScope(model, scoped)) {
      return {
        error:
          `the default model ${model} is not in enabledModels scope (${scoped.join(", ")}); ` +
          `the child would start from another scoped model, so set model: explicitly.`,
      };
    }
  }

  return { model };
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
function resolveEffectiveInteractive(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Known context-window sizes by model id substring, used for the context-usage
 * gauge. Unknown models fall back to a window-less "Nk ctx" label.
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  if (!needsShellReadyDelay()) return 0;
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require Herdr. ${muxSetupHint()}`,
      },
    ],
    details: { error: "herdr not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  // Resolve against the parent cwd: a relative --session-dir must not produce
  // artifact/activity paths that the child (which changes cwd) interprets
  // differently from the parent and the name registry.
  return resolve(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  >,
  name: string,
): string {
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it.
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  /** Session lines that predate this run; only newer output is summarized. */
  entryCountBefore?: number;
  /** True while the run is being resumed after a provider/agent error. */
  retrying?: boolean;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

/**
 * Event-driven join state for `subagent_wait`, keyed by name. Results still
 * arrive through the normal steer messages; the join only reports status.
 */
const joins = new SubagentJoin();

/** Extra resume attempts after a run fails with a provider/agent error. */
const SUBAGENT_RETRY_MAX = (() => {
  const raw = Number.parseInt(process.env.PI_SUBAGENT_RETRY_MAX ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
})();

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag} `;
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call ask_question.
 */
function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean },
): string {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;

  // A profile that omits `tools:` must not inherit every extension and shell
  // access. Read-only is the safe default; write/bash require an explicit list.
  const allow = new Set<string>(
    requested.length > 0 ? requested : READ_ONLY_FALLBACK_TOOLS,
  );
  if (
    !grantSpawning &&
    requested.some((tool) => (SPAWNING_TOOLS as readonly string[]).includes(tool))
  ) {
    throw new Error(
      "Spawning tools require a non-empty subagent_agents profile field.",
    );
  }
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Resolve every non-built-in tool to the extension file that registers it, and
 * fail loudly when one cannot be found. `pinned` replays the paths saved in a
 * loadout snapshot so resume/retry do not depend on what the parent currently
 * loads. A null allowlist is a legacy unrestricted snapshot and is refused:
 * replaying it would relaunch with all global extensions and the full toolset.
 */
function resolveToolExtensions(
  allowlist: string | null,
  pinned?: Record<string, string>,
): Record<string, string> {
  if (!allowlist) {
    throw new Error(
      "Legacy unrestricted subagent loadout refused. Spawn a fresh named agent with an explicit tools list.",
    );
  }
  const paths: Record<string, string> = {};
  for (const tool of allowlist.split(",")) {
    if (BUILTIN_TOOLS.has(tool)) continue;
    const path = pinned?.[tool] ?? getToolExtensionPath(tool);
    if (!path || !isAbsolute(path) || !existsSync(path)) {
      // `builtin:mcp` is a gateway, not a per-tool extension. Loading it with
      // -e connects every enabled MCP server and may expose their names and
      // capabilities to the child; fine-grained per-tool isolation is not
      // verified. Keep refusing it.
      if (tool.startsWith("mcp__") || tool.startsWith("mcp_")) {
        throw new Error(
          `MCP tool "${tool}" cannot be granted to a restricted subagent: loading builtin:mcp connects every enabled MCP server and may expose their names/capabilities, and per-tool isolation is not verified. Remove MCP tools from the profile's tools list, or expose this tool through a dedicated extension and registerToolExtension(name, path).`,
        );
      }
      throw new Error(
        `Cannot load subagent tool "${tool}". Load its backing extension in the parent or registerToolExtension(name, path). Check tool names: fetch_content, not web_fetch.`,
      );
    }
    paths[tool] = path;
  }
  return paths;
}

/**
 * Apply a loadout snapshot's sandbox to a pi command's `parts` array: model,
 * identity (system prompt), and the default-deny tool/extension restriction
 * (`--no-extensions` + `--tools` + one `-e` per tool-backing extension).
 *
 * This is the single source of truth for reconstructing a subagent's sandbox,
 * used both by the initial `launchSubagent` and by the `subagent_message`
 * resume path so the two can never drift. Env vars (PI_SUBAGENT_AGENT /
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR) and cwd are the caller's
 * responsibility since they differ slightly between launch and resume.
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  // Validate before the pane opens: a missing extension must never turn into a
  // silently missing tool. Legacy unrestricted snapshots are refused here.
  const resolvedExtensions = resolveToolExtensions(
    loadout.toolAllowlist,
    loadout.toolExtensions,
  );

  // A null model means the child would resolve its own default, which cannot be
  // recovered from the snapshot. Refuse instead of replaying the wrong provider.
  if (
    !loadout.model &&
    loadout.providerExtensions === undefined &&
    loadout.providerAuthExtension === undefined
  ) {
    throw new Error(
      "Cannot safely replay a subagent without a recorded model or provider snapshot. Spawn a fresh subagent with an explicit model.",
    );
  }

  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
  }

  // Default-deny: disable global extension discovery and re-enable only the
  // extensions backing the whitelisted tools.
  if (loadout.toolAllowlist) {
    parts.push("--no-extensions");
    parts.push("--tools", shellEscape(loadout.toolAllowlist));

    const extPaths = new Set<string>();
    for (const tool of loadout.toolAllowlist.split(",")) {
      if (BUILTIN_TOOLS.has(tool)) continue;
      const extPath = resolvedExtensions[tool];
      if (!extPath || !existsSync(extPath)) {
        throw new Error(
          `Cannot load subagent tool "${tool}". Load its backing extension in the parent, or registerToolExtension(name, path). Check the tool name (fetch_content, not web_fetch).`,
        );
      }
      extPaths.add(extPath);
    }
    // Anthropic OAuth subscription auth is a transport extension, not a tool.
    // Prefer the spawn-time snapshot: a profile may omit `model:` and use the
    // host's default Anthropic OAuth model, which cannot be re-derived here.
    const authExtPath =
      loadout.providerAuthExtension === undefined
        ? getProviderAuthExtensionPath(loadout.model)
        : loadout.providerAuthExtension;
    if (authExtPath) {
      if (!existsSync(authExtPath)) {
        throw new Error(
          `Cannot load pinned Anthropic auth extension "${authExtPath}". Reinstall the package, or spawn a fresh subagent so the path is re-resolved.`,
        );
      }
      extPaths.add(authExtPath);
    }
    // Restricted children run with --no-extensions, so a model provider
    // implemented by an extension must be re-enabled explicitly. Prefer the
    // spawn-time snapshot for the same null-model reason as above.
    const providerExts =
      loadout.providerExtensions ?? providerExtensionsForModel(loadout.model);
    for (const providerExt of providerExts) {
      if (!existsSync(providerExt)) {
        throw new Error(
          `Cannot load pinned provider extension "${providerExt}". Reinstall it, or spawn a fresh subagent so the path is re-resolved.`,
        );
      }
      extPaths.add(providerExt);
    }
    for (const extPath of extPaths) {
      parts.push("-e", shellEscape(extPath));
    }
  }
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 */
const reservedNames = new Set<string>();

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function resolveRunningByName(name: string):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = Array.from(runningSubagents.values()).map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/**
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendMessage,
): { ok: true } | { error: string } {
  if (running.retrying) {
    return {
      error:
        `Subagent "${running.name}" is restarting after a provider error. ` +
        `Wait for the retry result before sending another message.`,
    };
  }
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
  try {
    send(running.surface, flattened);
    // A reply answers a pending ask_question: release a join that stopped on it.
    joins.answer(running.name);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via Herdr: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendMessage,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();
  observeRunningSubagent(running, now);

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`,
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  resolveToolExtensions,
  joins,
  deliverPendingQuestion,
  applySandboxToParts,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  providerExtensionPath,
  providerExtensionMap,
  resolveRunningByName,
  uniqueRunningName,
  reservedNames,
  steerSubagent,
  handleSubagentSteer,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  runningSubagents,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
  buildResumeCommand,
  retryNudge,
  subagentSlug,
  SUBAGENT_RETRY_MAX,
  resolveSubagentPaths,
  resolveChildPiBin,
  resolveChildInitialModel,
  resolveChildSessionDir,
  defaultSessionDirPath,
  normalizeWindowsShellPath,
  getArtifactDir,
  lastModelInSession,
  watchSubagentWithRetry,
  summarizeAttempt,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: Static<typeof SubagentParams> & { name: string },
  ctx: {
    sessionManager: {
      getSessionFile(): string | null | undefined;
      getSessionId(): string;
      getSessionDir(): string;
      /** Present on pi's SessionManager; used to detect --session-dir. */
      usesDefaultSessionDir?(): boolean;
    };
    cwd: string;
  },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveTools = agentDefs?.tools;
  const grantSpawning = !!agentDefs?.subagentAgents?.length;
  // Every profile resolves to an explicit allowlist (read-only if it omitted
  // `tools:`). Resolve the backing extension files before creating a pane, so a
  // missing tool fails the spawn instead of silently disappearing in the child.
  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, { grantSpawning });
  const toolExtensions =
    agentDefs?.cli === "claude" ? undefined : resolveToolExtensions(toolAllowlist);
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const parentSessionDir = ctx.sessionManager.getSessionDir();
  const usesDefaultSessionDir =
    typeof ctx.sessionManager.usesDefaultSessionDir === "function"
      ? ctx.sessionManager.usesDefaultSessionDir()
      : samePath(parentSessionDir, defaultSessionDirPath(ctx.cwd, effectiveAgentDir));
  const sessionDir = resolveChildSessionDir({
    parentSessionDir,
    parentCwd: ctx.cwd,
    childCwd: targetCwdForSession,
    agentDir: effectiveAgentDir,
    usesDefaultSessionDir,
  });
  mkdirSync(sessionDir, { recursive: true });
  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  // Resolve the real child model before any surface exists. An omitted model
  // means the child reads its own settings, not the parent's current ctx.model.
  let effectiveModel = params.model ?? agentDefs?.model ?? null;
  if (!effectiveModel && agentDefs?.cli !== "claude") {
    const resolved = resolveChildInitialModel({
      explicitModel: null,
      sessionMode: launchBehavior.sessionMode,
      parentSessionFile: sessionFile,
      agentDir: localAgentDir && existsSync(localAgentDir) ? localAgentDir : process.env.PI_CODING_AGENT_DIR ?? getAgentConfigDir(),
      childCwd: targetCwdForSession,
    });
    if ("error" in resolved) {
      throw new Error(`Cannot start subagent "${params.name || params.agent}": ${resolved.error}`);
    }
    effectiveModel = resolved.model;
  }
  const resolvedAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : process.env.PI_CODING_AGENT_DIR ?? null;

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  // An agent with a non-empty subagent_agents list is granted the spawning
  // toolset and may only spawn the listed agents (enforced via PI_SUBAGENT_ALLOWED).
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    const sp = agentDefs.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    cmdParts.push(shellEscape(params.task));

    const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    const launchScriptName = `${(params.name || "subagent")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    joins.start(id, running.name);
    return running;
  }

  // ── Pi CLI path ──

  // Build pi command. Pi-Bolt hosts spawn their own executable; npm/git Pi
  // hosts keep `pi` from PATH.
  const parts: string[] = [childPiBin()];
  parts.push("--session", shellEscape(subagentSessionFile));

  // Resolve the config dir the child sees: a target-local .pi/agent/ wins,
  // else the propagated global dir. Captured once so the launch env and the
  // resume snapshot agree.
  // (resolvedAgentDir was computed before surface creation for model resolution.)

  // Default-deny model: every new profile has an explicit allowlist, including
  // profiles that omit `tools:` (read-only fallback). It never inherits all
  // extensions, and a missing backing extension fails before the pane opens.

  // Snapshot the fully-resolved sandbox beside the session file so a later
  // `subagent_message({ name })` resume can replay the exact same
  // restriction instead of relaunching pi with all global extensions + tools.
  // The model is resolved above and pinned, so the provider/auth snapshot
  // cannot drift when the parent switches models.
  const loadout: SubagentLoadout = {
    agent: params.agent ?? null,
    toolAllowlist,
    toolExtensions,
    providerExtensions:
      agentDefs?.cli === "claude"
        ? undefined
        : providerExtensionsForModel(effectiveModel),
    providerAuthExtension:
      agentDefs?.cli === "claude"
        ? undefined
        : getProviderAuthExtensionPath(effectiveModel),
    model: effectiveModel,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    spawnable: agentDefs?.subagentAgents ?? null,
    autoExit: agentDefs?.autoExit ?? false,
    cwd: effectiveCwd ?? null,
    agentDir: resolvedAgentDir,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Apply model, identity, and the default-deny tool/extension restriction via
  // the shared helper (same code path resume uses — they can't drift).
  applySandboxToParts(parts, loadout, { artifactDir, name: params.name });

  // Build env prefix: subagent identity + config dir propagation + spawn allowlist
  const envParts: string[] = [];

  if (resolvedAgentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resolvedAgentDir)}`);
  }

  if (grantSpawning && agentDefs?.subagentAgents) {
    envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(agentDefs.subagentAgents.join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  // Seeded fork/lineage sessions already contain parent entries. Baseline
  // after seeding so the result summary only covers this child's own output.
  const entryCountBefore = countSessionEntryLines(subagentSessionFile);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    entryCountBefore,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  joins.start(id, running.name);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, and cleans up the surface. The caller
 * (`watchSubagentWithRetry`) owns the running-map entry so an automatic retry
 * can keep the run's identity across attempts.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
function deliverPendingQuestion(running: RunningSubagent): void {
  const askFile = `${running.sessionFile}.ask`;
  let payload: any = null;
  try {
    if (!existsSync(askFile)) return;
    payload = JSON.parse(readFileSync(askFile, "utf-8"));
  } catch {
    // Malformed/partway-written file — drop it and move on.
  }
  try {
    unlinkSync(askFile);
  } catch {}
  if (!payload?.question) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  joins.question(running.id, name, payload.question);
  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      onTick() {
        observeRunningSubagent(running);
        deliverPendingQuestion(running);
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      closeSurface(surface);

      return { name, task, summary, exitCode: result.exitCode, elapsed, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    closeSurface(surface);

    return {
      name,
      task,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    try {
      closeSurface(surface);
    } catch {}

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

// ── Provider-error retry for subagent runs ───────────────────────────────────
// pi retries a failed turn inside the child (`settings.retry.maxRetries`), but
// only while the error text matches its retryable pattern. Once those attempts
// are exhausted the child exits and the run would be reported as failed. Retry
// the run itself instead: resume the same session (context preserved) with a
// nudge message, up to PI_SUBAGENT_RETRY_MAX extra attempts. Only provider/agent
// errors (`result.errorMessage`) are retried; a clean non-zero exit is not.
function subagentSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "resume"
  );
}

function retryNudge(errorMessage: string, attempt: number, maxAttempts: number): string {
  return [
    `Your previous turn ended with a provider/agent error (attempt ${attempt}/${maxAttempts} failed):`,
    "",
    errorMessage,
    "",
    "That is an upstream failure, not a problem with your work or the task.",
    "Continue the task from where you left off: do not repeat completed work, do not restart " +
      "from scratch, and do not report success unless the task is actually done.",
  ].join("\n");
}

/**
 * Build the command that resumes a subagent session, plus the script file the
 * multiplexer needs. Shared by the `subagent_message` resume path and by
 * provider-error retries so sandbox/model/env replay cannot drift.
 */
function buildResumeCommand(params: {
  id: string;
  name: string;
  sessionPath: string;
  message: string | undefined;
  loadout: SubagentLoadout;
  artifactDir: string;
  activityFile: string;
  autoExit: boolean;
  scriptLabel: string;
}): { command: string; launchScriptFile: string; resumeMsgFile?: string } {
  const parts = [childPiBin(), "--session", shellEscape(params.sessionPath)];

  // Replay the model, identity, and default-deny tool/extension sandbox.
  // applySandboxToParts adds subagent-done.ts through ask_question, which is
  // always part of the allowlist.
  applySandboxToParts(parts, params.loadout, {
    artifactDir: params.artifactDir,
    name: params.name,
  });

  let resumeMsgFile: string | undefined;
  if (params.message) {
    const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    resumeMsgFile = join(
      params.artifactDir,
      "subagent-resume",
      `${subagentSlug(params.name)}-${msgTimestamp}.md`,
    );
    mkdirSync(dirname(resumeMsgFile), { recursive: true });
    writeFileSync(resumeMsgFile, params.message, "utf8");
    parts.push(shellEscape(`@${resumeMsgFile}`));
  }

  // Replay the snapshot's config dir + spawn whitelist so the resumed process
  // resolves the same agents/extensions and keeps the same nested-spawn limit.
  const envParts: string[] = [];
  const agentDir = params.loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null;
  if (agentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(agentDir)}`);
  }
  if (params.loadout.spawnable && params.loadout.spawnable.length > 0) {
    envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(params.loadout.spawnable.join(","))}`);
  }
  if (params.loadout.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.loadout.agent)}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(params.id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(params.activityFile)}`);
  if (params.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  const envPrefix = envParts.join(" ") + " ";

  // Resume in the subagent's original cwd so its tools operate where they did.
  const cdPrefix = params.loadout.cwd ? `cd ${shellEscape(params.loadout.cwd)} && ` : "";

  const command = `${cdPrefix}${envPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptFile = join(
    params.artifactDir,
    "subagent-scripts",
    `${subagentSlug(params.name)}-${params.scriptLabel}-${Date.now()}.sh`,
  );

  return { command, launchScriptFile, resumeMsgFile };
}

/**
 * Restart a failed run in a fresh pane by resuming its session with a retry
 * nudge. Registers the run again: join entries are keyed by name, so the new id
 * supersedes the finished attempt and `subagent_wait` keeps waiting.
 */
interface RetryRunOptions {
  id: string;
  name: string;
  task: string;
  agent?: string;
  sessionPath: string;
  loadout: SubagentLoadout;
  artifactDir: string;
  errorMessage: string;
  attempt: number;
  maxAttempts: number;
}

type RetryRunOutcome =
  | { running: RunningSubagent; entryCountBefore: number }
  | { error: string };

async function retrySubagentRun(opts: RetryRunOptions): Promise<RetryRunOutcome> {
  const startTime = Date.now();
  // Reuse the run id. The join is keyed by name, and keeping the same id means
  // an in-flight subagent_wait keeps waiting instead of returning
  // "runtime_changed" while the retried child is still running.
  const id = opts.id;
  const activityFile = getSubagentActivityFile(opts.artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  // Build before creating a surface: a missing pinned extension or identity
  // write failure must not leave an empty pane behind.
  const { command, launchScriptFile } = buildResumeCommand({
    id,
    name: opts.name,
    sessionPath: opts.sessionPath,
    message: retryNudge(opts.errorMessage, opts.attempt, opts.maxAttempts),
    loadout: opts.loadout,
    artifactDir: opts.artifactDir,
    activityFile,
    // A retry must finish on its own; an interactive profile would leave the
    // pane open waiting for a user after the recovered turn.
    autoExit: resolveResumeLaunchBehavior().autoExit,
    scriptLabel: `retry-${opts.attempt}`,
  });

  // Only the new attempt's output belongs in the result summary.
  const entryCountBefore = countSessionEntryLines(opts.sessionPath);

  const surface = createSurface(opts.name);
  await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

  try {
    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Subagent retry script for ${opts.name} (attempt ${opts.attempt + 1}/${opts.maxAttempts})`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${opts.sessionPath}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });
  } catch (error: any) {
    try {
      closeSurface(surface);
    } catch {}
    return { error: error?.message ?? String(error) };
  }

  const running: RunningSubagent = {
    id,
    name: opts.name,
    task: opts.task,
    ...(opts.agent ? { agent: opts.agent } : {}),
    surface,
    startTime,
    sessionFile: opts.sessionPath,
    launchScriptFile,
    activityFile,
    interactive: false,
    statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
  };
  runningSubagents.set(id, running);
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  joins.start(id, running.name);
  startWidgetRefresh();
  if (latestPi) startStatusRefresh(latestPi);
  updateWidget();

  return { running, entryCountBefore };
}

function fallbackExitSummary(result: SubagentResult): string {
  return result.errorMessage
    ? `Subagent error: ${result.errorMessage}`
    : result.exitCode !== 0
      ? `Sub-agent exited with code ${result.exitCode}`
      : "Sub-agent exited without output";
}

/**
 * Injection seam for the retry loop. Production uses the defaults below; tests
 * replace them to exercise retries, unreadable transcripts, and delivery errors
 * without a multiplexer or a model call.
 */
interface WatchDeps {
  watch(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
  retry(options: RetryRunOptions): Promise<RetryRunOutcome>;
  deliver(content: string, details: Record<string, unknown>): void;
  finish(id: string, name: string, failed: boolean): void;
  remove(id: string): void;
  summarize(
    running: RunningSubagent,
    entryCountBefore: number,
    result: SubagentResult,
  ): string;
}

/**
 * Extract this attempt's assistant summary. Missing or corrupt transcripts are
 * reported as part of the result instead of throwing inside the watcher.
 */
function summarizeAttempt(
  running: RunningSubagent,
  entryCountBefore: number,
  result: SubagentResult,
): string {
  if (running.cli === "claude") return result.summary || fallbackExitSummary(result);
  try {
    return (
      findLastAssistantMessage(getNewEntries(running.sessionFile, entryCountBefore)) ??
      fallbackExitSummary(result)
    );
  } catch (error: any) {
    return (
      `${fallbackExitSummary(result)}\n\n` +
      `Session transcript could not be read: ${error?.message ?? String(error)}`
    );
  }
}

function defaultWatchDeps(): WatchDeps {
  return {
    watch: watchSubagent,
    retry: retrySubagentRun,
    deliver(content, details) {
      latestPi?.sendMessage(
        {
          customType: "subagent_result",
          content,
          display: true,
          details,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
    finish(id, name, failed) {
      joins.finish(id, name, failed);
    },
    remove(id) {
      runningSubagents.delete(id);
    },
    summarize: summarizeAttempt,
  };
}

/**
 * Watch a run to completion, retrying provider/agent failures by resuming the
 * same session, and deliver exactly one result steer message. The run keeps its
 * `runningSubagents` identity until the final state so a `subagent_message`
 * cannot resume the same session while an automatic retry is pending. The join
 * is finished on every terminal path, and all failures are caught so a
 * fire-and-forget call cannot leave an unhandled rejection or a hanging wait.
 */
async function watchSubagentWithRetry(
  opts: {
    running: RunningSubagent;
    signal: AbortSignal;
    ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } };
    /** Session lines that predate this run; only newer output is summarized. */
    entryCountBefore: number;
  },
  deps: WatchDeps = defaultWatchDeps(),
): Promise<void> {
  const maxAttempts = SUBAGENT_RETRY_MAX + 1;
  let running = opts.running;
  let signal = opts.signal;
  let attempt = 1;
  let entryCountBefore = opts.entryCountBefore;
  let settled = false;

  const finalize = (failed: boolean) => {
    if (settled) return;
    settled = true;
    try {
      deps.finish(running.id, running.name, failed);
    } catch {}
    try {
      deps.remove(running.id);
    } catch {}
  };

  try {
    for (;;) {
      let result: SubagentResult;
      try {
        result = await deps.watch(running, signal);
      } catch (err: any) {
        finalize(true);
        if (signal.aborted || getModuleAbortSignal().aborted) return;
        updateWidget();
        deps.deliver(`Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`, {
          name: running.name,
          task: running.task,
          error: err?.message,
        });
        return;
      }

      updateWidget();
      if (signal.aborted || getModuleAbortSignal().aborted) {
        finalize(true);
        return;
      }

      // Provider/agent error with attempts left: resume the session instead of
      // reporting failure. Claude subagents keep their existing behaviour.
      if (result.errorMessage && attempt < maxAttempts && running.cli !== "claude") {
        const artifactDir = getArtifactDir(
          opts.ctx.sessionManager.getSessionDir(),
          opts.ctx.sessionManager.getSessionId(),
        );
        const loadout = readSubagentLoadout(running.sessionFile);
        if (loadout) {
          // Keep the entry visible as running while the retry starts; steering
          // it now would target the closed surface of the failed attempt.
          running.retrying = true;
          const retry = await deps.retry({
            id: running.id,
            name: running.name,
            task: running.task,
            ...(running.agent ? { agent: running.agent } : {}),
            sessionPath: running.sessionFile,
            loadout,
            artifactDir,
            errorMessage: result.errorMessage,
            attempt,
            maxAttempts,
          });
          if ("running" in retry) {
            running = retry.running;
            signal = running.abortController?.signal ?? new AbortController().signal;
            entryCountBefore = retry.entryCountBefore;
            attempt += 1;
            continue;
          }
          result = {
            ...result,
            errorMessage:
              `${result.errorMessage}\n` +
              `(retry attempt ${attempt + 1} could not start: ${retry.error})`,
          };
        }
      }

      // Compute the summary before finalizing: a summary failure must mark the
      // run failed instead of leaving a completed status on a broken result.
      // Only this attempt's new assistant output belongs in the result. Using
      // the whole session would report the previous turn (or the failed
      // attempt) as the outcome of a retry that produced no new output.
      const summary = deps.summarize(running, entryCountBefore, result);
      const presentation = resolveResultPresentation(
        { ...result, summary, sessionFile: running.sessionFile },
        running.name,
      );

      finalize(result.exitCode !== 0);
      updateWidget();

      deps.deliver(presentation, {
        name: running.name,
        task: running.task,
        agent: running.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: running.sessionFile,
        attempts: attempt,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
        ...(result.stats ? { stats: result.stats } : {}),
      });
      return;
    }
  } catch (error: any) {
    // Retry, summary, or delivery threw. Finish the join and remove the run,
    // then report once through the same steer channel. If delivery itself is
    // what failed, the second attempt is still guarded.
    finalize(true);
    updateWidget();
    if (signal.aborted || getModuleAbortSignal().aborted) return;
    try {
      deps.deliver(`Sub-agent "${running.name}" watcher failed: ${error?.message ?? String(error)}`, {
        name: running.name,
        task: running.task,
        error: error?.message ?? String(error),
      });
    } catch {}
  }
}

/**
 * Start a fire-and-forget watcher with a final rejection guard. The watcher
 * handles its own failures; this catch exists so an unexpected rejection can
 * never leave an unhandled promise or a join entry stuck in `running`.
 */
function startSubagentWatcher(opts: {
  running: RunningSubagent;
  signal: AbortSignal;
  ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } };
  entryCountBefore: number;
}): void {
  void watchSubagentWithRetry(opts).catch((error: any) => {
    try {
      joins.finish(opts.running.id, opts.running.name, true);
    } catch {}
    runningSubagents.delete(opts.running.id);
    if (opts.signal.aborted || getModuleAbortSignal().aborted) return;
    try {
      latestPi?.sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${opts.running.name}" watcher failed: ${error?.message ?? String(error)}`,
          display: true,
          details: {
            name: opts.running.name,
            task: opts.running.task,
            error: error?.message ?? String(error),
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } catch {}
  });
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  // Give the model an explicit join primitive instead of relying on bash sleep.
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\n\nSubagent orchestration: after spawn acknowledgements, use subagent_wait({names:[...],mode:'all'}) " +
      "to join dependencies, or end your turn to receive results automatically. Never sleep or poll " +
      "session files. subagent_wait returns early for child questions; answer them via " +
      "subagent_message before waiting again. Results are steer messages, not the initial acknowledgements.",
  }));
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
    joins.reset();
  });

  // ── subagent_wait tool ──
  // Event-driven join: resolves on lifecycle events, never cancels children.
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for subagents",
    description:
      "Wait for named subagents using lifecycle events, not bash sleep or polling. " +
      "Call AFTER spawn acknowledgements, never in the same tool batch as spawning. " +
      "Results still arrive as steer messages; this returns only completion status (no duplicate summaries). " +
      "Returns early for any child question so you can reply via subagent_message. " +
      "Timeout/cancellation does not cancel children. Names are tracked for the current runtime; " +
      "after restart/reload resume by name first. Status output is bounded to 50 runs.",
    promptSnippet:
      "Join named subagents without shell sleeps; all/any completion, timeout and cancellation supported.",
    parameters: Type.Object({
      names: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
      mode: Type.Optional(Type.String({ enum: ["all", "any"] })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000 })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: `Waiting for: ${params.names.join(", ")}` }],
        details: {},
      });
      const result = await joins.wait(
        params.names,
        params.mode === "any" ? "any" : "all",
        params.timeoutMs ?? 120000,
        AbortSignal.any([getModuleAbortSignal(), ...(signal ? [signal] : [])]),
      );
      const questions = result.questions.slice(0, 50).map(({ name }) => name);
      const statuses = result.runs.map((run) => `${run.name}: ${run.status}`).join("\n");
      const questionNote = questions.length
        ? `Pending questions/blocked UI: ${questions.join(", ")}. Reply to ask_question via subagent_message; native approval dialogs require inspection, not blind approval.`
        : "Read the automatically delivered steer messages for results. Do not invent results or use shell sleeps.";
      return {
        content: [
          {
            type: "text",
            text: `Wait ended: ${result.reason}.\n${statuses}\n${questionNote}`,
          },
        ],
        details: {
          reason: result.reason,
          runs: result.runs.map(({ id, name, status }) => ({ id, name, status })),
          questions,
        },
      };
    },
    renderCall(args, theme) {
      return new Text(
        "◷ " + theme.fg("toolTitle", theme.bold("wait")) + theme.fg("dim", ` — ${args.names.join(", ")}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as any;
      const text =
        details?.reason === "timeout"
          ? theme.fg("warning", "timeout (children still running)")
          : details?.reason === "question"
            ? theme.fg("warning", "child asked a question")
            : theme.fg("success", "joined");
      return new Text("◷ " + text, 0, 0);
    },
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in its own terminal multiplexer surface: a new tab when you are the main session, " +
        "a split pane inside your own tab when you are yourself a subagent. " +
        "ALWAYS pass a short descriptive `name` (2-4 kebab-case words naming the task) — it becomes the tab or pane title the user reads. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in its own terminal multiplexer surface (a new tab from the main session, a split pane from a subagent). " +
        "ALWAYS pass a short descriptive `name` (2-4 kebab-case words naming the task) — it becomes the tab or pane title. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Strict whitelist at every depth. The caller's permitted set is:
        //   • a restricted subagent (PI_SUBAGENT_ALLOWED) → only its pinned agents;
        //   • a top-level session → every discoverable agent, i.e. exactly what
        //     `subagents_list` shows.
        // Every spawn must name an agent in that set. The lone exception is a
        // top-level `fork: true` clone, which has no role and inherits the
        // caller's own already-trusted toolset. Without this guard a missing or
        // unknown `agent` silently launches an unrestricted, full-toolset child.
        const permittedAgents = SUBAGENT_ALLOWLIST
          ? [...SUBAGENT_ALLOWLIST]
          : discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        if (!params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent required" },
          };
        } else if (!permittedSet.has(params.agent)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You may not spawn the "${params.agent}" agent — it is not ` +
                  `${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: {
              error: SUBAGENT_ALLOWLIST ? "agent not in allowlist" : "unknown agent",
            },
          };
        }

        // Validate prerequisites (need mux + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // Default the cosmetic pane label to the agent name when omitted,
        // disambiguating against running subagents, in-flight reservations, and
        // every name already in the registry — so names stay unique across the
        // whole session, running or finished. Reserve the chosen name
        // synchronously (before any await) so parallel spawns don't collide.
        let reservedName: string | null = null;
        if (!params.name?.trim()) {
          const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
          params.name = uniqueRunningName(params.agent, registryNames);
          reservedName = params.name;
          reservedNames.add(reservedName);
        }

        // Launch the subagent (creates pane, sends command). Release the name
        // reservation once it registers in runningSubagents (or launch fails) —
        // from then on uniqueRunningName tracks it via the running map.
        let running;
        try {
          running = await launchSubagent({ ...params, name: params.name }, ctx);
        } finally {
          if (reservedName) reservedNames.delete(reservedName);
        }

        // Persist name → session so subagent_message({ name }) can resume this
        // subagent after it finishes (and after a pi restart). Done at launch,
        // not completion, so the handle exists even if the parent dies mid-run.
        registerName(parentArtifactDir, running.name, {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
        });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background. Provider/agent errors
        // resume the same session before failure is reported.
        startSubagentWatcher({
          running,
          signal: watcherAbort.signal,
          ctx,
          entryCountBefore: running.entryCountBefore ?? 0,
        });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct cosmetic name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Send a message to a subagent by name. Names are unique within your session and persist after a subagent finishes, " +
        "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
        "if it has finished, your message resumes that session and continues it. " +
        "`name` and `message` are both required. " +
        "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
        "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
        "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
        "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
      promptSnippet:
        "Message a subagent by name: steers it if running, resumes it if finished (same name either way). " +
        "`name` and `message` are required. Steering returns immediately; resuming delivers its result later as a steer message. " +
        "Do not poll or fabricate results.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
        }),
        message: Type.String({
          description:
            "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
        }),
      }),

      renderCall(args, theme) {
        const target = args.name ?? "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "steered") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const requestedName = params.name?.trim();
        if (!requestedName) {
          const err = "Provide the subagent's `name` to steer (if running) or resume (if finished).";
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        // ── Steer a running subagent ──
        // A name that matches a currently-running subagent always steers it.
        const runningMatch = Array.from(runningSubagents.values()).find((r) => r.name === requestedName);
        if (runningMatch) {
          return handleSubagentSteer({ name: requestedName, message: params.message });
        }

        // ── Resume a finished session by name ──
        const message = params.message;
        const name = requestedName; // identity preservation: the resumed run reclaims its name
        const { autoExit, interactive } = resolveResumeLaunchBehavior();
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        // Resolve the name to its session file via this session's registry.
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );
        const entry = resolveNameInRegistry(parentArtifactDir, requestedName);
        if (!entry) {
          const known = Object.keys(readNameRegistry(parentArtifactDir));
          const err =
            `No subagent named "${requestedName}" in this session. ` +
            (known.length > 0
              ? `Known subagents: ${known.join(", ")}.`
              : "No subagents have been spawned in this session yet.");
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        const sessionPath = entry.sessionFile;
        if (!sessionPath || !existsSync(sessionPath)) {
          const err =
            `Subagent "${requestedName}" is registered but its session file is gone ` +
            `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        // Guard: never resume a session that is still running — two processes
        // mutating the same .jsonl corrupts it. Steer it by name instead.
        for (const r of runningSubagents.values()) {
          if (resolve(r.sessionFile) === resolve(sessionPath)) {
            const err = `Subagent "${requestedName}" is still running as "${r.name}". Your message will steer it; resending as a steer.`;
            return handleSubagentSteer({ name: r.name, message: params.message });
          }
        }

        // Reconstruct the sandbox from the snapshot written at spawn time.
        // Without it we cannot safely resume: relaunching bare would load every
        // global extension + the full toolset. Refuse rather than escalate.
        const loadout = readSubagentLoadout(sessionPath);
        if (!loadout) {
          const err =
            `Cannot safely resume "${requestedName}": no sandbox snapshot found for this session ` +
            `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
            `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
            `Re-run the task as a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? requestedName;

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        // Validate and build the command before creating a surface, including
        // legacy unrestricted snapshots that have no tool list to replay.
        resolveToolExtensions(loadout.toolAllowlist, loadout.toolExtensions);
        const entryCountBefore = countSessionEntryLines(sessionPath);

        // Command construction is shared with provider-error retries.
        const { command, launchScriptFile, resumeMsgFile } = buildResumeCommand({
          id,
          name,
          sessionPath,
          message,
          loadout,
          artifactDir,
          activityFile,
          autoExit,
          scriptLabel: "resume",
        });

        const surface = createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
        try {
          sendLongCommand(surface, command, {
            scriptPath: launchScriptFile,
            scriptPreamble: [
              `# Subagent resume script for ${name}`,
              `# Generated: ${new Date().toISOString()}`,
              `# Session: ${sessionPath}`,
              `# Surface: ${surface}`,
              ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
            ].join("\n"),
          });
        } catch (error: any) {
          try {
            closeSurface(surface);
          } catch {}
          const err = `Failed to start the resumed session: ${error?.message ?? String(error)}`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: message,
          surface,
          startTime,
          sessionFile: sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        joins.start(id, running.name);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher: provider/agent errors resume this session
        // again (up to PI_SUBAGENT_RETRY_MAX) before failure is reported.
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        startSubagentWatcher({
          running,
          signal: watcherAbort.signal,
          ctx,
          entryCountBefore,
        });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionId: resumedSessionId,
            sessionFile: sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    });

  // /subagent-doctor — verify tool loadouts and the multiplexer without a model call.
  pi.registerCommand("subagent-doctor", {
    description:
      "Check agent tool loadouts, extension paths, provider extensions, and Herdr availability (no model call).",
    handler: async (_args, ctx) => {
      const lines: string[] = [
        isMuxAvailable()
          ? "herdr: detected (server connectivity is checked on launch)"
          : muxSetupHint(),
      ];
      for (const agent of discoverAgentDefinitions()) {
        try {
          const allow = buildSubagentToolAllowlist(agent.tools, {
            grantSpawning: !!agent.subagentAgents?.length,
          });
          const extensions = resolveToolExtensions(allow);
          const extNote = Object.entries(extensions)
            .map(([tool, path]) => `\n    ${tool} -> ${path}`)
            .join("");
          lines.push(
            `${agent.name} [${agent.source}]: ${allow}${agent.tools ? "" : " (read-only default; add tools: explicitly)"}${extNote}`,
          );
        } catch (error: any) {
          lines.push(`${agent.name}: ERROR — ${error.message}`);
        }
      }
      for (const [prefix, path] of Object.entries(providerExtensionMap())) {
        lines.push(
          `provider ${prefix}: ${existsSync(path) ? path : `NOT INSTALLED (${path})`}`,
        );
      }
      ctx.ui.notify(
        lines.join("\n"),
        lines.some((line) => line.includes("ERROR")) ? "warning" : "info",
      );
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = contextWindowFor(stats.model);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
// test
