import { test } from "node:test";
import assert from "node:assert/strict";
import { probePanePiProcess, HerdrApiError, __probeTest__ } from "../pi-extension/subagents/herdr.ts";
const session = "C:/test dir/session.jsonl";
const pi = { pid: 20, name: "pi-bolt.exe", cmdline: 'pi-bolt.exe --session "C:\\test dir\\session.jsonl" task' };
const deps = (rows = [pi]) => ({
  paneProcessInfo: () => ({ roots: [10], foreground: [{ pid: 10, name: "bash.exe" }] }),
  descendants: () => rows,
});

test("Windows fallback requires a Pi child with the exact --session argument", () => {
  assert.equal(probePanePiProcess("w1:p2", { sessionFile: session }, "win32", deps()).ok, true);
  assert.equal(__probeTest__.cmdlineNamesSession('pi-bolt.exe --other "C:/test dir/session.jsonl"', session, "win32"), false);
  assert.equal(__probeTest__.cmdlineNamesSession('pi-bolt.exe --session "C:/test dir/session.jsonl.bak"', session, "win32"), false);
  const wrong = probePanePiProcess("w1:p2", { sessionFile: "C:/another.jsonl" }, "win32", deps());
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "session_mismatch");
});

test("a process started in the pane's foreground job is found even when shell_pid is stale", () => {
  const staleShell = {
    paneProcessInfo: () => ({ roots: [10, 11], foreground: [{ pid: 10, name: "bash.exe" }] }),
    descendants: (root: number) => (root === 10 ? [] : [pi]),
  };
  assert.equal(probePanePiProcess("w1:p2", { sessionFile: session }, "win32", staleShell).ok, true);
});

test("a shell, a vanished pane, or ambiguous child identities refuse input", () => {
  assert.equal(probePanePiProcess("w1:p2", { sessionFile: session }, "win32", deps([])).ok, false);
  assert.equal(probePanePiProcess("w1:p2", { sessionFile: session }, "win32", deps([pi, { ...pi, pid: 21 }])).ok, false);
  const result = probePanePiProcess("w1:p2", { sessionFile: session }, "win32", {
    ...deps(), paneProcessInfo() { throw new HerdrApiError("pane_not_found", "gone"); },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "pane_gone");
});
