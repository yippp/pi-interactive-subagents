import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsPaneLaunchCommand } from "../pi-extension/subagents/herdr.ts";
import { childHerdrStatusExtension } from "../pi-extension/subagents/index.ts";
import { resolveBashStrict } from "../pi-extension/subagents/shell.ts";

test("only Pi-Bolt children inside Herdr TUI load the status reporter", () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
  assert.equal(childHerdrStatusExtension("C:/bin/pi-bolt.exe", env), "builtin:herdr");
  assert.equal(childHerdrStatusExtension("C:/bin/node.exe", env), undefined);
  assert.equal(childHerdrStatusExtension("C:/bin/pi-bolt.exe", {}), undefined);
  assert.equal(childHerdrStatusExtension("C:/bin/pi-bolt.exe", { ...env, PI_SUBAGENT_PI_BIN: "pi" }), undefined);
});

test("Windows pane launch uses the actual shell and quotes paths", () => {
  const native = "C:\\a dir\\agent's task.sh";
  const posix = "/c/a dir/agent's task.sh";
  assert.equal(windowsPaneLaunchCommand("bash.exe", native, posix), "bash '/c/a dir/agent'\\''s task.sh'");
  assert.equal(windowsPaneLaunchCommand("pwsh.exe", native, posix), "& 'C:\\a dir\\agent''s task.cmd'");
  assert.equal(windowsPaneLaunchCommand("cmd.exe", native, posix), '"C:\\a dir\\agent\'s task.cmd"');
  assert.throws(() => windowsPaneLaunchCommand("unknown", native, posix), /unsupported Herdr pane shell/);
});

test("Git Bash executes the selected launch command from a path with spaces", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi launch space "));
  try {
    const file = join(dir, "agent's task.sh");
    writeFileSync(file, "#!/bin/bash\nprintf '%s' BASH_LAUNCH_OK\n");
    const bash = resolveBashStrict();
    const posixDir = execFileSync(bash, ["-c", "pwd"], { cwd: dir, encoding: "utf8" }).trim();
    const command = windowsPaneLaunchCommand("bash.exe", file, `${posixDir}/agent's task.sh`);
    assert.equal(execFileSync(bash, ["-c", command], { encoding: "utf8" }), "BASH_LAUNCH_OK");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
