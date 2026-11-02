/**
 * Shell helpers shared by the Herdr TUI and Herdr desktop backends.
 *
 * Kept in its own module so herdr-desktop.ts can resolve the same Bash as
 * herdr.ts without importing herdr.ts (which already imports the desktop
 * backend).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const resolvedBash = new Map<NodeJS.Platform, string>();

/**
 * Resolve the Bash that runs launch scripts, mirroring Pi's own resolution:
 * `shellPath` from settings.json, then Git Bash, then PATH.
 *
 * On Windows a bare `bash` usually resolves to the WSL launcher in
 * `%SystemRoot%\System32`, which re-parses its command line and strips the
 * backslashes out of a Windows script path, so Git Bash has to win. Callers
 * that spawn a terminal outside the pane's shell (`hc run`) need an absolute
 * path: herdr-core resolves a bare command against the registry PATH, which
 * may not contain Git's `bin` directory at all.
 */
export function resolveBash(platform: NodeJS.Platform = process.platform): string {
  const cached = resolvedBash.get(platform);
  if (cached) return cached;

  const value = resolveBashFor(
    platform,
    process.env,
    existsSync,
    readShellPathSetting(process.env),
  );
  resolvedBash.set(platform, value);
  return value;
}

/**
 * Pure resolver, used by tests. Only absolute candidates are considered on
 * Windows; a bare `bash` from PATH may be the WSL stub.
 */
export function resolveBashFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  configuredShellPath = "",
): string {
  if (platform !== "win32") return "bash";

  const configured = env.PI_SHELL_PATH?.trim() || configuredShellPath.trim();
  // Build Windows paths regardless of the host running the test/simulation.
  const winJoin = (...parts: string[]) => parts.join("\\");
  const candidates = [
    configured,
    winJoin(env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    winJoin(
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Git",
      "bin",
      "bash.exe",
    ),
    "C:\\msys64\\usr\\bin\\bash.exe",
  ].filter((candidate): candidate is string => !!candidate?.trim());

  return candidates.find((candidate) => exists(candidate)) ?? "bash";
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
