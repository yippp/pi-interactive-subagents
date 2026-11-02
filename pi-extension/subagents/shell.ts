/**
 * Shell helpers shared by the Herdr TUI and Herdr desktop backends.
 *
 * Kept in its own module so herdr-desktop.ts can resolve the same Bash as
 * herdr.ts without importing herdr.ts (which already imports the desktop
 * backend).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const resolvedBash = new Map<NodeJS.Platform, string>();

/**
 * Resolve the Bash used by the TUI launch path. Falls back to bare `bash` when
 * no absolute Windows candidate exists; that fallback keeps the historical TUI
 * behaviour. The desktop backend must use `resolveBashStrict` instead.
 */
export function resolveBash(platform: NodeJS.Platform = process.platform): string {
  const cached = resolvedBash.get(platform);
  if (cached) return cached;

  const value =
    resolveBashFor(platform, process.env, existsSync, readShellPathSetting(process.env)) ??
    "bash";
  resolvedBash.set(platform, value);
  return value;
}

/**
 * Resolve an absolute Bash for a terminal started by herdr-core (`hc run`).
 * A bare `bash` is not acceptable there: herdr-core resolves it against the
 * registry PATH, which may not contain Git's `bin` directory at all, and the
 * WSL stub in System32 mangles Windows script paths. Throws with a
 * `PI_SHELL_PATH` hint when no absolute candidate exists.
 */
export function resolveBashStrict(platform: NodeJS.Platform = process.platform): string {
  return requireBash(platform, process.env, existsSync, readShellPathSetting(process.env));
}

/**
 * Pure resolver, used by tests. On Windows, returns the first existing
 * absolute candidate (configured shellPath, Program Files Git, msys64), or
 * null. Non-Windows keeps `bash` because the launch path runs a login shell.
 */
export function resolveBashFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  configuredShellPath = "",
): string | null {
  if (platform !== "win32") return "bash";

  const configured = env.PI_SHELL_PATH?.trim() || configuredShellPath.trim();
  // Build Windows paths regardless of the host running the test/simulation.
  const winJoin = (...parts: string[]) => parts.join("\\");
  const candidates = [
    // A relative or bare configured value cannot be used by herdr-core and
    // may be the WSL stub; ignore it instead of silently accepting it.
    win32.isAbsolute(configured) ? configured : "",
    winJoin(env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    winJoin(
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Git",
      "bin",
      "bash.exe",
    ),
    "C:\\msys64\\usr\\bin\\bash.exe",
  ].filter((candidate): candidate is string => !!candidate?.trim());

  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** Throw the user-facing error for a Windows host with no absolute Bash. */
export function requireBash(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  configuredShellPath = "",
): string {
  const bash = resolveBashFor(platform, env, exists, configuredShellPath);
  if (bash) return bash;
  const configured = env.PI_SHELL_PATH?.trim() || configuredShellPath.trim();
  throw new Error(
    "Cannot start the Herdr desktop terminal: no absolute bash.exe was found. " +
      "Set PI_SHELL_PATH (or shellPath in settings.json) to an absolute Git Bash path, " +
      "for example C:\\Program Files\\Git\\bin\\bash.exe. " +
      (configured && !win32.isAbsolute(configured)
        ? `The configured path "${configured}" is not absolute. `
        : "") +
      "A bare `bash` from PATH is not used because it may be the WSL stub and " +
      "herdr-core resolves it against the registry PATH.",
  );
}

/** `shellPath` from the global settings, the same knob that configures Pi's own shell. */
function readShellPathSetting(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return typeof settings?.shellPath === "string" ? settings.shellPath : "";
  } catch {
    return "";
  }
}
