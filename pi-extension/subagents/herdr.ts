/**
 * Herdr surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the herdr calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by Herdr pane ids (e.g. `w1:p12`). A subagent spawned
 * by the main session gets its own tab; a subagent spawned by another
 * subagent splits its parent's pane, so one tab holds one lineage. Splits
 * always target the parent pi's pane (`$HERDR_PANE_ID`) so they follow the
 * agent rather than the user's focus. All calls go through the `herdr` CLI,
 * which inherits the session and socket from the pane environment.
 *
 * Launching uses the raw pane surface on purpose: the child runs inside a
 * shell wrapper that exports env, cds, and echoes an exit sentinel, none of
 * which `herdr agent start` can do. Steering a running child goes through
 * the agent surface (`herdr agent prompt`) so Herdr honours bracketed paste
 * and refuses to type over an approval or question dialog.
 *
 * Inside the Herdr desktop app the same primitives go through herdr-core's
 * `hc` CLI instead; see herdr-desktop.ts.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, basename, dirname, join } from "node:path";
import {
  SurfaceGoneError,
  closeDesktopSurface,
  createDesktopSurface,
  desktopExitState,
  hcBin,
  isHerdrDesktopEnv,
  isPendingDesktopSurface,
  launchDesktopSurface,
  readDesktopScreen,
  readDesktopScreenAsync,
  sendDesktopCommand,
  sendDesktopMessage,
} from "./herdr-desktop.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    // An explicit binary path is not a PATH lookup. PI_SUBAGENT_HC_BIN may
    // point at an absolute executable outside PATH.
    if (isAbsolute(command) || /[\\/]/.test(command)) {
      available = existsSync(command);
    } else if (process.platform === "win32") {
      // Windows has no `sh` for a native process; `where` answers the same question.
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } else {
      execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
      available = true;
    }
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * Path to the herdr binary. Herdr exports `HERDR_BIN_PATH` into every pane
 * it manages; fall back to PATH lookup otherwise.
 */
function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/**
 * True when running inside a Herdr-managed pane with the herdr binary
 * reachable. Herdr sets `HERDR_ENV=1` in every process it spawns.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && (!!process.env.HERDR_BIN_PATH || hasCommand("herdr"));
}

/**
 * True when running in a terminal of the Herdr desktop app with `hc`
 * reachable, and not inside a Herdr TUI pane (which wins when both apply).
 */
export function isHerdrDesktopAvailable(): boolean {
  return !isHerdrAvailable() && isHerdrDesktopEnv() && hasCommand(hcBin());
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable() || isHerdrDesktopAvailable();
}

export function muxSetupHint(): string {
  return "Start pi in a terminal of the Herdr desktop app, or inside a Herdr pane (run `herdr`, then `pi`).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

/**
 * Whether a freshly created surface needs a pause for its shell to start
 * before the launch command is typed. Desktop surfaces run the launch script
 * directly, so there is nothing to wait for.
 */
export function needsShellReadyDelay(): boolean {
  return !isHerdrDesktopAvailable();
}

function requireMux(): void {
  if (!isMuxAvailable()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── CLI helpers ──

/**
 * Run a herdr CLI command and parse its JSON stdout. Server errors arrive as
 * JSON on stderr with exit status 1; surface their message.
 */
function herdrJson(args: string[]): any {
  let stdout: string;
  try {
    stdout = execFileSync(herdrBin(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error: any) {
    throw new Error(`herdr ${args[0]} ${args[1] ?? ""} failed: ${herdrErrorMessage(error)}`);
  }
  return parseHerdrResponse(stdout);
}

async function herdrJsonAsync(args: string[]): Promise<any> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin(), args, { encoding: "utf8" }));
  } catch (error: any) {
    throw new Error(`herdr ${args[0]} ${args[1] ?? ""} failed: ${herdrErrorMessage(error)}`);
  }
  return parseHerdrResponse(stdout);
}

function parseHerdrResponse(stdout: string): any {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed);
  if (parsed?.error) {
    throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
  }
  return parsed?.result ?? parsed;
}

function herdrErrorMessage(error: any): string {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    try {
      const parsed = JSON.parse(stderr);
      if (parsed?.error?.message) {
        return `${parsed.error.code}: ${parsed.error.message}`;
      }
    } catch {}
    return stderr;
  }
  return error?.message ?? String(error);
}

// ── Shell helpers ──
// Shared with herdr-desktop.ts, which must not import this module (cycle).
export { resolveBash, shellEscape } from "./shell.ts";
export { SurfaceGoneError } from "./herdr-desktop.ts";
import { resolveBash, shellEscape } from "./shell.ts";

/**
 * The POSIX form of `dir` as seen by the resolved Bash (`/c/...` for Git Bash,
 * `/mnt/c/...` for WSL). Letting Bash print its own cwd avoids hardcoding mounts.
 */
function bashPosixDir(dir: string): string | null {
  if (process.platform !== "win32") return dir;
  try {
    return execFileSync(resolveBash(), ["-c", "pwd"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ── Pane layout ──

/**
 * Where a new subagent pane goes, relative to the parent pi pane.
 * "right" and "down" always split that way. "auto" follows the Herdr
 * guidance: split a wide pane to the right and a narrow or tall pane down.
 * Override with PI_SUBAGENT_SPLIT_DIRECTION.
 */
const SUBAGENT_SPLIT_DIRECTION: "right" | "down" | "auto" = "auto";

function splitDirectionSetting(): "right" | "down" | "auto" {
  const raw = process.env.PI_SUBAGENT_SPLIT_DIRECTION?.trim();
  return raw === "right" || raw === "down" || raw === "auto" ? raw : SUBAGENT_SPLIT_DIRECTION;
}

/**
 * Which surface a top-level subagent gets. "tab" gives every subagent of the
 * main session its own tab, so the tab bar reads as a list of running
 * subagents and each lineage keeps its own pane layout. "pane" keeps the old
 * behaviour of splitting the main session's pane.
 * Override with PI_SUBAGENT_TOP_LEVEL_SURFACE.
 */
const SUBAGENT_TOP_LEVEL_SURFACE: "tab" | "pane" = "tab";

function topLevelSurfaceSetting(): "tab" | "pane" {
  const raw = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE?.trim();
  return raw === "tab" || raw === "pane" ? raw : SUBAGENT_TOP_LEVEL_SURFACE;
}

/**
 * True when this pi is itself a subagent, i.e. it was launched by another pi
 * with PI_SUBAGENT_NAME exported into its pane. Its children split its pane
 * instead of opening a tab.
 */
export function isNestedSpawner(): boolean {
  return !!process.env.PI_SUBAGENT_NAME?.trim();
}

/**
 * Decide where a new subagent surface goes: a tab for the main session, a
 * split for a subagent spawning its own children.
 */
export function chooseSurfaceKind(
  nested: boolean = isNestedSpawner(),
  setting: "tab" | "pane" = topLevelSurfaceSetting(),
): "tab" | "pane" {
  return !nested && setting === "tab" ? "tab" : "pane";
}

/**
 * Pick the split direction for a new pane off `pane`. Terminal cells are
 * roughly twice as tall as wide, so a pane is "wide" when it has more than
 * two columns per row. Falls back to "right" when the layout can't be read.
 */
export function chooseSplitDirection(
  layout: LayoutSnapshot | undefined,
  pane: string,
  setting: "right" | "down" | "auto" = splitDirectionSetting(),
): "right" | "down" {
  if (setting !== "auto") return setting;
  const rect = layout?.panes.find((p) => p.pane_id === pane)?.rect;
  if (!rect || rect.height === 0) return "right";
  return rect.width / rect.height >= 2 ? "right" : "down";
}

interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutSnapshot {
  zoomed: boolean;
  area: LayoutRect;
  focused_pane_id: string;
  panes: Array<{ pane_id: string; focused: boolean; rect: LayoutRect }>;
  splits: Array<{ id: string; direction: "right" | "down"; ratio: number; rect: LayoutRect }>;
}

function readLayout(pane: string): LayoutSnapshot | undefined {
  try {
    return herdrJson(["pane", "layout", "--pane", pane])?.layout as LayoutSnapshot | undefined;
  } catch {
    return undefined;
  }
}

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * Herdr halves the target pane on every split and hands freed space to the
 * sibling on close, so without this panes drift to wildly uneven sizes.
 *
 * Herdr has no named layouts. Instead this reads the tab layout and, for
 * every split, resizes the pane at the split boundary so each column (or
 * row) gets an equal share (the tmux "even-horizontal" look). Debounced so
 * a burst of parallel spawns or staggered exits collapses into a single
 * pass, and non-fatal: a cosmetic resize must never break spawning or
 * watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.HERDR_PANE_ID ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    void evenSplits(target).catch(() => {
      // Pane/tab may be gone; balancing is best-effort.
    });
  }, 120);
}

async function evenSplits(pane: string): Promise<void> {
  const layout = (await herdrJsonAsync(["pane", "layout", "--pane", pane]))?.layout as
    | LayoutSnapshot
    | undefined;
  if (!layout || layout.zoomed) return;

  for (const step of planEvenSplits(layout)) {
    await herdrJsonAsync([
      "pane",
      "resize",
      "--pane",
      step.pane,
      "--direction",
      step.direction,
      "--amount",
      step.amount.toFixed(4),
    ]);
  }
}

interface ResizeStep {
  pane: string;
  direction: "left" | "right" | "up" | "down";
  amount: number;
}

/**
 * Compute the `pane resize` calls that give every column (for right splits)
 * or row (for down splits) an equal share. For each split the wanted ratio
 * is (columns before the boundary) / (columns in the split). `pane resize`
 * moves the split at the target pane's trailing edge by a ratio delta, so
 * the target is the pane whose trailing edge sits on the boundary.
 * `right`/`down` grow the first side; `left`/`up` shrink it.
 */
export function planEvenSplits(layout: LayoutSnapshot): ResizeStep[] {
  const steps: ResizeStep[] = [];
  const contains = (outer: LayoutRect, inner: LayoutRect) =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;

  for (const split of layout.splits) {
    const horizontal = split.direction === "right";
    const start = (r: LayoutRect) => (horizontal ? r.x : r.y);
    const end = (r: LayoutRect) => (horizontal ? r.x + r.width : r.y + r.height);
    const size = (r: LayoutRect) => (horizontal ? r.width : r.height);

    const inside = layout.panes.filter((p) => contains(split.rect, p.rect));
    if (inside.length < 2) continue;

    const boundary = start(split.rect) + Math.round(size(split.rect) * split.ratio);
    const first = inside.filter((p) => end(p.rect) <= boundary + 1);
    if (first.length === 0 || first.length === inside.length) continue;

    const lanes = (panes: typeof inside) => new Set(panes.map((p) => start(p.rect))).size;
    const wanted = lanes(first) / lanes(inside);
    const delta = wanted - split.ratio;
    if (Math.abs(delta) < 0.01) continue;

    // The pane whose trailing edge lands on the boundary owns this split.
    const target = first.reduce((best, p) => (end(p.rect) > end(best.rect) ? p : best));
    steps.push({
      pane: target.pane_id,
      direction: delta > 0 ? (horizontal ? "right" : "down") : horizontal ? "left" : "up",
      amount: Math.abs(delta),
    });
  }
  return steps;
}

// ── Surface primitives ──

/**
 * Create the surface a subagent runs in.
 *
 * The main session opens a new tab per subagent, so each one is easy to find
 * by name in the tab bar. A subagent spawning its own children splits its
 * pane instead, which keeps a whole lineage inside one tab. Splits go off the
 * parent pi's pane, so new panes follow the agent rather than the user's
 * focus, with the direction taken from the parent pane's geometry (see
 * SUBAGENT_SPLIT_DIRECTION).
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `w1:p12`).
 */
export function createSurface(name: string): string {
  requireMux();
  if (isHerdrDesktopAvailable()) return createDesktopSurface(name, chooseSurfaceKind());

  if (chooseSurfaceKind() === "tab") {
    const pane = createSurfaceTab(name);
    if (pane) return pane;
    // Tab creation failed (old server, no workspace) — fall back to a split.
  }

  const parent = process.env.HERDR_PANE_ID;
  const direction = chooseSplitDirection(parent ? readLayout(parent) : undefined, parent ?? "");
  return createSurfaceSplit(name, direction, parent);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Herdr only splits right or down; "left"/"up" map to the same axis.
 * The new pane starts in the caller's cwd and does not take focus unless
 * `options.focus` is set. The pane is labelled with `name` so the Herdr
 * sidebar shows which subagent lives there.
 * Returns the new pane id (e.g. `w1:p12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  options?: { focus?: boolean; cwd?: string },
): string {
  requireHerdr();

  const args = ["pane", "split"];
  if (fromSurface) {
    args.push(fromSurface);
  } else {
    args.push("--current");
  }
  args.push("--direction", direction === "left" || direction === "right" ? "right" : "down");
  args.push("--cwd", options?.cwd ?? process.cwd());
  args.push(options?.focus ? "--focus" : "--no-focus");

  const result = herdrJson(args);
  const pane = result?.pane?.pane_id;
  // Pane ids are opaque handles (`w1:p12`, `w1:pA`); only trust the JSON shape.
  if (typeof pane !== "string" || pane.trim() === "") {
    throw new Error(`Unexpected herdr pane split output: ${JSON.stringify(result)}`);
  }

  labelSurface(pane, name);
  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Create a new tab holding a single pane for a subagent. The tab carries
 * `name` as its label so the tab bar names the subagent, and the root pane
 * gets the same label for the sidebar. Does not take focus unless
 * `options.focus` is set.
 *
 * Returns the root pane id, or null when Herdr could not create the tab —
 * callers fall back to splitting a pane.
 */
export function createSurfaceTab(
  name: string,
  options?: { focus?: boolean; cwd?: string },
): string | null {
  requireHerdr();

  const args = ["tab", "create"];
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (workspace) args.push("--workspace", workspace);
  args.push("--cwd", options?.cwd ?? process.cwd());
  const label = name.trim();
  if (label) args.push("--label", label);
  args.push(options?.focus ? "--focus" : "--no-focus");

  let result: any;
  try {
    result = herdrJson(args);
  } catch {
    return null;
  }

  const pane = result?.root_pane?.pane_id;
  if (typeof pane !== "string" || pane.trim() === "") return null;

  labelSurface(pane, name);
  return pane;
}

/**
 * Label a pane in the Herdr sidebar. Cosmetic and best-effort.
 */
export function labelSurface(surface: string, label: string): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  try {
    herdrJson(["pane", "rename", surface, trimmed]);
  } catch {
    // A missing label must never break spawning.
  }
}

/**
 * The tab a pane lives in (e.g. `w1:t2`), or null when it can't be read.
 */
export function getSurfaceTab(surface: string): string | null {
  try {
    const tab = herdrJson(["pane", "get", surface])?.pane?.tab_id;
    return typeof tab === "string" && tab.trim() !== "" ? tab : null;
  } catch {
    return null;
  }
}

/**
 * Get the pane that currently has UI focus in the caller's tab.
 * Returns null when the layout can't be read.
 */
export function getFocusedSurface(fromSurface?: string): string | null {
  const pane = fromSurface ?? process.env.HERDR_PANE_ID;
  if (!pane) return null;
  return readLayout(pane)?.focused_pane_id ?? null;
}

/**
 * Send a command string to a pane and execute it.
 * `pane run` writes the text literally and submits it with Enter as one
 * ordered write, so special characters are never interpreted as keys.
 */
export function sendCommand(surface: string, command: string): void {
  requireMux();
  if (isHerdrDesktopAvailable()) return sendDesktopCommand(surface, command);
  herdrJson(["pane", "run", surface, command]);
}

/**
 * Deliver a message to the agent running in a pane. Goes through the agent
 * surface so Herdr honours bracketed paste and rejects an agent parked at an
 * approval or question dialog (`agent_blocked`) instead of typing over it.
 * If Herdr cannot find an agent, fail rather than type the message into a
 * shell that may interpret it as a command.
 */
export function sendMessage(surface: string, message: string): void {
  requireMux();
  if (isHerdrDesktopAvailable()) return sendDesktopMessage(surface, message);
  herdrJson(["agent", "prompt", surface, message]);
}

/** Build a launch command for the shell actually running in a Windows pane. */
export function windowsPaneLaunchCommand(shellName: string, scriptPath: string, posixScriptPath: string): string {
  const name = shellName.toLowerCase().replace(/\.exe$/, "");
  if (["bash", "sh", "zsh"].includes(name)) return `bash ${shellEscape(posixScriptPath)}`;
  const shim = scriptPath.replace(/\.sh$/i, ".cmd");
  if (["pwsh", "powershell"].includes(name)) return `& '${shim.replace(/'/g, "''")}'`;
  if (name === "cmd") return `"${shim.replace(/"/g, '""')}"`;
  throw new Error(`Cannot launch subagent: unsupported Herdr pane shell "${shellName || "unknown"}".`);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });

  if (isHerdrDesktopAvailable() && isPendingDesktopSurface(surface)) {
    launchDesktopSurface(surface, scriptPath);
    return scriptPath;
  }

  if (process.platform === "win32") {
    const posixDir = bashPosixDir(dirname(scriptPath));
    if (!posixDir) throw new Error("Cannot resolve the subagent script path in Git Bash.");
    const info = herdrJson(["pane", "process-info", "--pane", surface])?.process_info;
    const shell = info?.foreground_processes?.find((p: any) => p.pid === info.shell_pid)
      ?? info?.foreground_processes?.[0];
    const shellName = typeof shell?.name === "string" ? shell.name : "";
    const launch = windowsPaneLaunchCommand(shellName, scriptPath, `${posixDir}/${basename(scriptPath)}`);
    if (/^(?:pwsh|powershell|cmd)(?:\.exe)?$/i.test(shellName)) {
      const shimPath = scriptPath.replace(/\.sh$/i, ".cmd");
      writeFileSync(
        shimPath,
        `@echo off\r\n"${resolveBash()}" "${posixDir}/${basename(scriptPath)}"\r\n`,
      );
    }
    sendCommand(surface, launch);
    return scriptPath;
  }

  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

function readArgs(surface: string, lines: number): string[] {
  return [
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--format",
    "text",
    "--lines",
    String(Math.max(1, lines)),
  ];
}

/**
 * Read the screen contents of a pane (sync). `pane read` prints plain text.
 */
export function readScreen(surface: string, lines = 50): string {
  requireMux();
  if (isHerdrDesktopAvailable()) return readDesktopScreen(surface, lines);
  try {
    return execFileSync(herdrBin(), readArgs(surface, lines), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: any) {
    throw surfaceError("herdr pane read failed", error);
  }
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireMux();
  if (isHerdrDesktopAvailable()) return readDesktopScreenAsync(surface, lines);
  try {
    const { stdout } = await execFileAsync(herdrBin(), readArgs(surface, lines), {
      encoding: "utf8",
    });
    return stdout;
  } catch (error: any) {
    throw surfaceError("herdr pane read failed", error);
  }
}

/**
 * True when herdr reported the pane itself is gone (`pane_not_found`) rather
 * than failing to reach the server.
 */
export function isHerdrSurfaceGone(error: any): boolean {
  for (const text of [error?.stderr, error?.stdout]) {
    if (typeof text !== "string" || !text.trim()) continue;
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed?.error?.code === "pane_not_found") return true;
    } catch {}
  }
  return false;
}

/**
 * True when a mux error message means the target pane/terminal does not exist.
 * Used to make closing an already-gone pane a no-op (idempotent cleanup)
 * without swallowing unrelated mux failures.
 */
export function isSurfaceGoneMessage(message: string): boolean {
  return /pane_not_found|terminal_not_found|tab_not_found|workspace_not_found|\bnot_found\b/i.test(
    message,
  );
}

/**
 * Classify a mux failure: a closed pane/terminal becomes SurfaceGoneError so
 * callers can stop waiting for a surface that no longer exists, while every
 * other failure (socket, CLI crash, timeout) stays a plain Error and is
 * retried by the caller.
 */
function surfaceError(prefix: string, error: any): Error {
  const message = `${prefix}: ${herdrErrorMessage(error)}`;
  return isHerdrSurfaceGone(error) ? new SurfaceGoneError(message) : new Error(message);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireMux();
  if (isHerdrDesktopAvailable()) return closeDesktopSurface(surface);
  try {
    herdrJson(["pane", "close", surface]);
  } catch (error: any) {
    // Closing a pane that already disappeared is a no-op, not a failure: the
    // user may have closed it after the child finished. Any other error still
    // propagates so a broken mux is not silently ignored.
    if (isSurfaceGoneMessage(error?.message ?? String(error))) return;
    throw error;
  }
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "surface_lost";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
  /**
   * Why the pane/terminal was lost, when reason is "surface_lost". This is a
   * local/terminal condition (the user closed the pane, or the mux stopped
   * answering), never a provider failure, so it must not drive a provider retry.
   */
  surfaceLostReason?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = {
  interpretExitSidecar,
  parseSentinelExitCode,
  isSurfaceGoneError,
};
export const __layoutTest__ = { planEvenSplits, chooseSplitDirection, chooseSurfaceKind };

/** Exit code from the terminal sentinel a launch script echoes, or null. */
export function parseSentinelExitCode(screen: string): number | null {
  const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : null;
}

/** The shell suffix every launch script appends with its exit code. */
export const EXIT_SENTINEL_ECHO = "echo '__SUBAGENT_DONE_'$?'__'";

/** Append the exit-code sentinel echo to a command (shell semantics unchanged). */
export function withExitSentinel(command: string): string {
  return `${command}; ${EXIT_SENTINEL_ECHO}`;
}

/** Remove the sentinel from screen text so it does not leak into summaries. */
export function stripExitSentinel(text: string): string {
  return text.replace(/__SUBAGENT_DONE_\d+__/, "");
}

/** True when a read failed because the pane/terminal no longer exists. */
export function isSurfaceGoneError(error: unknown): boolean {
  return error instanceof SurfaceGoneError || (error as any)?.name === "SurfaceGoneError";
}

/** Read and consume the `.exit` sidecar, if one appeared. */
function takeExitSidecar(sessionFile: string | undefined): PollResult | null {
  if (!sessionFile) return null;
  const exitFile = `${sessionFile}.exit`;
  try {
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf-8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return null;
  }
}

/**
 * Consecutive reads that must report "pane/terminal not found" before the
 * surface counts as gone. One flaky CLI call must not end a live run.
 */
const DEFAULT_GONE_CONFIRMATIONS = 3;

/**
 * How long reads may keep failing for another reason (mux socket down, CLI
 * crash) before the wait gives up. Transport trouble is retried, not treated as
 * a closed pane, but it cannot hang the watcher forever either.
 */
const DEFAULT_TRANSPORT_FAILURE_LIMIT_MS = 30_000;

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    /** Reads that must confirm "pane/terminal not found" before the surface is gone. */
    goneConfirmations?: number;
    /** Transport failures tolerated before the wait gives up (never a closed pane). */
    transportFailureLimitMs?: number;
    /** Injection seam for tests: defaults probe the real multiplexer. */
    deps?: Partial<PollDeps>;
  },
): Promise<PollResult> {
  const start = Date.now();
  const deps: PollDeps = { ...defaultPollDeps(), ...options.deps };
  const goneConfirmations = options.goneConfirmations ?? DEFAULT_GONE_CONFIRMATIONS;
  const transportFailureLimitMs =
    options.transportFailureLimitMs ?? DEFAULT_TRANSPORT_FAILURE_LIMIT_MS;

  // Consecutive "not found" reads, and when the current streak of other read
  // failures began. A closed pane is confirmed before the wait ends; plain
  // transport trouble is retried but bounded so a dead mux cannot hang the wait.
  let goneReads = 0;
  let transportFailureSince: number | null = null;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: a finished child may have written its result sidecar.
    const sidecar = takeExitSidecar(options.sessionFile);
    if (sidecar) return sidecar;

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection).
    // Desktop terminals end with their launch script, so herdr-core's record
    // says when; the screen only supplies pi's exit code.
    try {
      if (deps.isDesktop()) {
        const state = await deps.desktopExit(surface);
        if (state.finished) {
          const screen = await deps.readScreen(surface, 5).catch(() => "");
          return {
            reason: "sentinel",
            exitCode: parseSentinelExitCode(screen) ?? state.exitCode,
          };
        }
      } else {
        const exitCode = parseSentinelExitCode(await deps.readScreen(surface, 5));
        if (exitCode != null) return { reason: "sentinel", exitCode };
      }
      goneReads = 0;
      transportFailureSince = null;
    } catch (error) {
      // A finished child may have written the .exit sidecar in the same tick.
      const lateSidecar = takeExitSidecar(options.sessionFile);
      if (lateSidecar) return lateSidecar;

      const now = Date.now();
      if (isSurfaceGoneError(error)) {
        // `pane_not_found`/`not_found` is a definitive answer: the pane or
        // terminal ceased to exist (the user closed it, or the app removed
        // it). Confirm over a few reads so one flaky CLI call cannot end a
        // live run, then return without an errorMessage so the provider-retry
        // path does not reopen a pane the user just closed.
        goneReads += 1;
        if (goneReads >= goneConfirmations) {
          return {
            reason: "surface_lost",
            exitCode: 1,
            surfaceLostReason: describeSurfaceLoss(error),
          };
        }
      } else {
        goneReads = 0;
        transportFailureSince ??= now;
        if (now - transportFailureSince >= transportFailureLimitMs) {
          return {
            reason: "surface_lost",
            exitCode: 1,
            surfaceLostReason: `could not read the subagent pane for ${Math.round(
              (now - transportFailureSince) / 1000,
            )}s (${error instanceof Error ? error.message : String(error)})`,
          };
        }
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

interface PollDeps {
  readScreen(surface: string, lines: number): Promise<string>;
  desktopExit(
    surface: string,
  ): Promise<{ finished: false } | { finished: true; exitCode: number }>;
  isDesktop(): boolean;
}

function defaultPollDeps(): PollDeps {
  return {
    readScreen: readScreenAsync,
    desktopExit: desktopExitState,
    isDesktop: isHerdrDesktopAvailable,
  };
}

/** Human-readable cause for a lost surface, without leaking provider wording. */
function describeSurfaceLoss(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const hint = /no terminal|not_found/i.test(detail)
    ? "its terminal was closed or removed"
    : "its pane no longer exists";
  return `subagent ${hint}; no exit status was reported (${detail})`;
}
