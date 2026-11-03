/**
 * Path handling shared by the subagent launcher.
 *
 * Every path that reaches the disk — child cwd, project settings, agent dir,
 * session group, launch `cd` — goes through these helpers first, so pi's own
 * normalization rules apply consistently. On Windows a Git Bash, MSYS, Cygwin,
 * or WSL path (`/g/repo`, `/mnt/c/repo`, `/cygdrive/g/repo`) is converted to
 * the native `G:\repo` form; otherwise a raw `/c/.../repo` would be joined into
 * `C:\c\...\repo` and point at the wrong directory.
 *
 * This module imports only Node built-ins, so `index.ts` and its siblings can
 * depend on it without a cycle.
 */
import { posix, resolve, win32 } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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

/**
 * Copy of pi's normalizePath(): MSYS/Cygwin/WSL drive conversion, `~` expansion,
 * and `file://` URL decoding.
 */
export function normalizePiPath(
  input: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  let normalized = input;
  if (platform === "win32") normalized = normalizeWindowsShellPath(normalized, platform);
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (platform === "win32" && normalized.startsWith("~\\"))) {
    return pathApi.join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** pi's resolvePath(): normalize, then resolve against `baseDir` when relative. */
export function resolvePiPath(
  input: string,
  baseDir: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = normalizePiPath(input, platform, home);
  const normalizedBaseDir = normalizePiPath(baseDir, platform, home);
  return pathApi.isAbsolute(normalized)
    ? pathApi.resolve(normalized)
    : pathApi.resolve(normalizedBaseDir, normalized);
}

/** Real path when it exists, otherwise the resolved absolute path. */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Default session directory for a cwd, mirroring pi's getDefaultSessionDirPath:
 * resolvePath() first (native, absolute, no trailing separator / `.` / `..`),
 * then the Windows drive-colon encoding (`G:\repo` -> `--G--repo--`).
 *
 * Pure: callers choose whether to create the directory, so an explicit
 * `--session-dir` never gets polluted with an unused default directory.
 */
export function defaultSessionDirPath(
  cwd: string,
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const resolvedCwd = resolvePiPath(cwd, process.cwd(), platform);
  const resolvedAgentDir = resolvePiPath(agentDir, process.cwd(), platform);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return pathApi.join(resolvedAgentDir, "sessions", safePath);
}

/** Compare two paths as pi would: normalize, resolve, then realpath. */
export function samePath(a: string, b: string): boolean {
  // Normalize shell-style drive paths first, so a parent in `G:\repo` and a
  // child cwd `/g/repo` are recognized as the same directory.
  const left = canonicalizePath(resolvePiPath(a));
  const right = canonicalizePath(resolvePiPath(b));
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
export function resolveChildSessionDir(opts: {
  parentSessionDir: string;
  parentCwd: string;
  childCwd: string;
  agentDir: string;
  usesDefaultSessionDir: boolean;
}): string {
  const parentBase = resolvePiPath(opts.parentCwd);
  const parentDir = resolvePiPath(opts.parentSessionDir, parentBase);
  if (!opts.usesDefaultSessionDir) return parentDir;
  if (samePath(opts.parentCwd, opts.childCwd)) return parentDir;
  return defaultSessionDirPath(opts.childCwd, opts.agentDir);
}
