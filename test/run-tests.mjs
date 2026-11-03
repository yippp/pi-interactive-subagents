// Run the package tests with a clean subagent environment.
//
// When the suite runs inside a subagent (for example a Pi-Bolt worker), pi
// exports PI_SUBAGENT_* variables for that child. `index.ts` captures
// PI_SUBAGENT_ALLOWED at module load and filters agent discovery through it, so
// tests that create their own mock agents would be filtered out. Same for
// PI_SUBAGENT_RETRY_MAX, which changes retry defaults under test.
//
// Deleting these variables for the test process gives deterministic results
// without changing production behaviour. An explicit override still works:
// `PI_SUBAGENT_ALLOWED=... node --test test/test.ts`.
import { spawnSync } from "node:child_process";

const files = [
  "test/test.ts",
  "test/join.test.ts",
  "test/pi-bolt.test.ts",
  "test/retry.test.ts",
  "test/system-prompt-mode.test.ts",
  "test/windows-launch.test.ts",
  "test/lifecycle-regressions.test.ts",
  "test/terminal-steer.test.ts",
];

const env = { ...process.env };
for (const key of [
  "PI_SUBAGENT_ALLOWED",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_RETRY_MAX",
]) {
  delete env[key];
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env,
});
process.exit(result.status ?? 1);
