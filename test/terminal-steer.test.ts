import { test } from "node:test";
import assert from "node:assert/strict";
import { probePanePiProcess, HerdrApiError, __probeTest__ } from "../pi-extension/subagents/herdr.ts";
const session = "C:/test dir/session.jsonl";
const pi = { pid: 20, name: "pi-bolt.exe", cmdline: 'pi-bolt.exe --session "C:\\test dir\\session.jsonl" task' };
const deps = (rows = [pi]) => ({
  paneProcessInfo: () => ({ roots: [10], foreground: [{ pid: 10, name: "bash.exe" }] }),
  descendants: () => rows,
  processes: () => rows,
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
    processes: () => [],
  };
  assert.equal(probePanePiProcess("w1:p2", { sessionFile: session }, "win32", staleShell).ok, true);
});

test("finds the child by the pid it recorded, even without a usable pane tree", () => {
  const recorded = process.pid;
  const result = probePanePiProcess(
    "w1:p2",
    { sessionFile: session, pid: recorded },
    "win32",
    {
      paneProcessInfo: () => ({ roots: [10], foreground: [] }),
      descendants: () => [],
      processes: () => [{
        pid: recorded,
        name: "pi-bolt.exe",
        cmdline: `pi-bolt.exe --session "C:/test dir/session.jsonl"`,
      }],
    },
  );
  assert.equal(result.ok, true);
});

test("a recorded pid from another session or a dead process is refused", () => {
  const base = {
    paneProcessInfo: () => ({ roots: [10], foreground: [] }),
    descendants: () => [],
  };
  const otherSession = probePanePiProcess("w1:p2", { sessionFile: session, pid: 20 }, "win32", {
    ...base,
    processes: () => [{ pid: 20, name: "pi-bolt.exe", cmdline: "pi-bolt.exe --session C:/other.jsonl" }],
  });
  assert.equal(otherSession.ok, false);
  if (!otherSession.ok) assert.equal(otherSession.reason, "session_mismatch");

  const dead = probePanePiProcess("w1:p2", { sessionFile: session, pid: 20 }, "win32", {
    ...base,
    processes: () => [],
  });
  assert.equal(dead.ok, false);
  if (!dead.ok) assert.equal(dead.reason, "pane_gone");
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
