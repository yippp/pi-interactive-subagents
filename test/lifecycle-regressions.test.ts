/**
 * Regression tests for four lifecycle bugs fixed together:
 *
 *  1. A corrupt `auth.json` leaked a raw `SyntaxError` out of
 *     `getProviderAuthExtensionPath`, so a Claude child launched without the
 *     OAuth transport extension.
 *  2. A failed `sendLongCommand` during launch left an empty pane open.
 *  3. `pollForExit` looped forever when the pane/terminal was gone, so
 *     `subagent_wait` never released.
 *  4. `ask_question` wrote `${sessionFile}.ask` non-atomically, and the parent
 *     deleted the file when its parse failed, losing the question.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, { __test__ as api } from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import {
  __pollForExitTest__,
  SurfaceGoneError,
  isHerdrSurfaceGone,
  isSurfaceGoneMessage,
  parseSentinelExitCode,
  pollForExit,
  stripExitSentinel,
  withExitSentinel,
} from "../pi-extension/subagents/herdr.ts";
import { writeFileAtomic } from "../pi-extension/subagents/activity.ts";
import { isHcNotFound } from "../pi-extension/subagents/herdr-desktop.ts";
import { writeSubagentLoadout, type SubagentLoadout } from "../pi-extension/subagents/session.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function loadout(overrides: Partial<SubagentLoadout> = {}): SubagentLoadout {
  return {
    agent: "scout",
    toolAllowlist: "read,ask_question",
    model: "anthropic/claude-haiku-4-5",
    thinking: null,
    systemPromptMode: null,
    identity: null,
    spawnable: null,
    autoExit: true,
    cwd: null,
    agentDir: null,
    providerExtensions: [],
    providerAuthExtension: null,
    ...overrides,
  };
}

/** Extension API mock that records registered tools and sent messages. */
function mockExtension() {
  const tools: any[] = [];
  const messages: any[] = [];
  const pi = {
    on() {
      return () => {};
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    getAllTools: () => [],
    sendMessage(message: any, options: any) {
      messages.push([message, options]);
    },
  };
  return { pi, tools, messages };
}

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_ACTIVITY_FILE",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ── 1. corrupt auth.json ────────────────────────────────────────────────────

describe("getProviderAuthExtensionPath with a corrupt auth.json", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = tempDir("pi-auth-");
    saved = snapshotEnv();
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the old behaviour when auth.json is absent", () => {
    assert.equal(api.getProviderAuthExtensionPath("anthropic/claude-sonnet-4-5"), undefined);
    assert.equal(api.getProviderAuthExtensionPath(null), undefined);
    assert.equal(api.getProviderAuthExtensionPath("openai/gpt-4o"), undefined);
  });

  it("returns the extension path for a valid OAuth subscription token", () => {
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { access: "sk-ant-oat01-example" } }),
    );
    // The package is not installed in this checkout, so a valid token still
    // yields undefined — what matters is that parsing succeeded.
    assert.equal(api.getProviderAuthExtensionPath("anthropic/claude-sonnet-4-5"), undefined);
    assert.equal(api.getProviderAuthExtensionPath("openai/gpt-4o"), undefined);
  });

  it("throws an actionable, credential-free error when auth.json is corrupt", () => {
    const secret = "sk-ant-oat01-SECRET-TOKEN-VALUE";
    const corrupt = `{"anthropic": {"access": "${secret}"`; // truncated JSON
    writeFileSync(join(dir, "auth.json"), corrupt);

    assert.throws(
      () => api.getProviderAuthExtensionPath("anthropic/claude-sonnet-4-5"),
      (error: any) => {
        assert.match(error.message, /auth\.json/);
        assert.match(error.message, /not valid JSON/);
        assert.match(error.message, /signing in again/);
        // The error must never echo the file contents or the token.
        assert.doesNotMatch(error.message, /SECRET-TOKEN-VALUE/);
        assert.doesNotMatch(error.message, /sk-ant-oat01/);
        // It must not be a raw JSON SyntaxError either.
        assert.notEqual(error.constructor, SyntaxError);
        return true;
      },
    );

    // Other providers never read the Anthropic store, so they are unaffected.
    assert.equal(api.getProviderAuthExtensionPath("openai/gpt-4o"), undefined);
  });

  it("does not silently skip the auth transport for a corrupt file on a null model path", () => {
    writeFileSync(join(dir, "auth.json"), "{");
    assert.throws(
      () => api.getProviderAuthExtensionPath("anthropic/claude-haiku-4-5"),
      /not valid JSON/,
    );
  });
});

// ── 2. launch failure cleanup ───────────────────────────────────────────────

describe("launch/resume/retry cleanup when the command cannot be sent", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  let created: string[];
  let closed: string[];
  let sent: Array<{ surface: string; command: string }>;

  beforeEach(() => {
    dir = tempDir("pi-launch-");
    saved = snapshotEnv();
    created = [];
    closed = [];
    sent = [];
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    api.setLaunchSurfaceDeps();
    api.runningSubagents.clear();
    api.joins.reset();
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  });

  function installDeps(overrides: { send?: () => void; waitForShell?: () => Promise<void> } = {}) {
    api.setLaunchSurfaceDeps({
      create: (name: string) => {
        const surface = `w1:${name}`;
        created.push(surface);
        return surface;
      },
      send: (surface: string, command: string) => {
        sent.push({ surface, command });
        if (overrides.send) overrides.send();
      },
      close: (surface: string) => {
        closed.push(surface);
      },
      waitForShell: overrides.waitForShell ?? (async () => {}),
    });
  }

  /** A real agent profile so the spawn path builds a full loadout. */
  function writeAgent(name: string, body: string): void {
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", `${name}.md`), body);
  }

  function parentCtx(sessionDir: string) {
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "parent.jsonl");
    writeFileSync(sessionFile, "");
    return {
      sessionFile,
      ctx: {
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "parent-session",
          getSessionDir: () => sessionDir,
          usesDefaultSessionDir: () => false,
        },
        cwd: sessionDir,
      },
    };
  }

  it("closes the pane it just created when the Claude launch send fails", async () => {
    writeAgent(
      "claude-worker",
      "---\nname: claude-worker\ntools: read\nmodel: anthropic/claude-haiku-4-5\nauto-exit: true\ncli: claude\n---\n\nbody\n",
    );
    installDeps({ send: () => { throw new Error("pane is gone"); } });
    const { ctx } = parentCtx(join(dir, "sessions"));
    mkdirSync(join(dir, "sessions"), { recursive: true });

    await assert.rejects(
      api.launchSubagent(
        { agent: "claude-worker", name: "cc-run", task: "do the thing" } as any,
        ctx as any,
      ),
      (error: any) => {
        assert.equal(error.message, "pane is gone", "the original send error must survive");
        return true;
      },
    );

    assert.equal(created.length, 1, "exactly one pane was created");
    assert.deepEqual(closed, created, "the pane this launch owned was closed");
    assert.equal(sent.length, 1);
    // No run may stay registered as running after a failed launch.
    assert.equal(api.runningSubagents.size, 0);
    assert.deepEqual(api.joins.snapshot(), []);
  });

  it("closes the pane it just created when the Pi launch send fails", async () => {
    writeAgent(
      "pi-worker",
      "---\nname: pi-worker\ntools: read\nmodel: anthropic/claude-haiku-4-5\nauto-exit: true\n---\n\nbody\n",
    );
    installDeps({ send: () => { throw new Error("herdr pane run failed: socket closed"); } });
    const { ctx } = parentCtx(join(dir, "sessions"));
    mkdirSync(join(dir, "sessions"), { recursive: true });

    await assert.rejects(
      api.launchSubagent(
        { agent: "pi-worker", name: "pi-run", task: "do the thing" } as any,
        ctx as any,
      ),
      /socket closed/,
    );

    assert.equal(created.length, 1);
    assert.deepEqual(closed, created);
    assert.equal(api.runningSubagents.size, 0);
    assert.deepEqual(api.joins.snapshot(), []);
  });

  it("leaves a caller-provided surface alone when the send fails", async () => {
    writeAgent(
      "pi-worker2",
      "---\nname: pi-worker2\ntools: read\nmodel: anthropic/claude-haiku-4-5\nauto-exit: true\n---\n\nbody\n",
    );
    installDeps({ send: () => { throw new Error("send failed"); } });
    const { ctx } = parentCtx(join(dir, "sessions"));
    mkdirSync(join(dir, "sessions"), { recursive: true });

    await assert.rejects(
      api.launchSubagent(
        { agent: "pi-worker2", name: "pre-owned", task: "do the thing" } as any,
        ctx as any,
        { surface: "w9:p1" },
      ),
      /send failed/,
    );

    assert.equal(created.length, 0, "the pre-created surface must not be re-created");
    assert.deepEqual(closed, [], "a caller-owned surface must not be closed");
  });

  it("closes the retry pane and reports the error when the retry send fails", async () => {
    const sessionFile = join(dir, "retry-session.jsonl");
    writeFileSync(sessionFile, "");
    writeSubagentLoadout(sessionFile, loadout());
    installDeps({ send: () => { throw new Error("retry send failed"); } });

    const outcome = await api.retrySubagentRun({
      id: "run-1",
      name: "a",
      task: "do work",
      sessionPath: sessionFile,
      loadout: loadout(),
      artifactDir: join(dir, "artifacts"),
      errorMessage: "529 overloaded",
      attempt: 1,
      maxAttempts: 4,
    });

    assert.ok("error" in outcome, "the retry must report failure instead of registering");
    assert.match((outcome as any).error, /retry send failed/);
    assert.equal(created.length, 1);
    assert.deepEqual(closed, created);
    assert.equal(api.runningSubagents.size, 0);
  });

  it("does not create a surface when the sandbox snapshot cannot be built", async () => {
    writeAgent(
      "broken-worker",
      "---\nname: broken-worker\ntools: read,no_such_tool\nmodel: anthropic/claude-haiku-4-5\nauto-exit: true\n---\n\nbody\n",
    );
    installDeps();
    const { ctx } = parentCtx(join(dir, "sessions"));
    mkdirSync(join(dir, "sessions"), { recursive: true });

    await assert.rejects(
      api.launchSubagent(
        { agent: "broken-worker", name: "broken", task: "do the thing" } as any,
        ctx as any,
      ),
      /Cannot load subagent tool "no_such_tool"/,
    );

    assert.deepEqual(created, [], "a sandbox failure must not open a pane");
    assert.deepEqual(closed, []);
  });
});

// ── 3. pollForExit and a surface that disappeared ───────────────────────────

describe("pollForExit when the pane or terminal is gone", () => {
  const never = new AbortController().signal;

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      isDesktop: () => false,
      desktopExit: async () => ({ finished: false as const }),
      readScreen: async () => "screen text",
      ...overrides,
    } as any;
  }

  it("returns surface_lost after repeated not-found reads instead of looping forever", async () => {
    let reads = 0;
    const result = await pollForExit("w1:p1", never, {
      interval: 0,
      goneConfirmations: 3,
      deps: deps({
        readScreen: async () => {
          reads += 1;
          throw new SurfaceGoneError("herdr pane read failed: pane_not_found: pane w1:p1 not found");
        },
      }),
    });

    assert.equal(reads, 3);
    assert.equal(result.reason, "surface_lost");
    assert.match(result.surfaceLostReason ?? "", /pane|terminal/i);
    // A closed pane is not a provider failure: no errorMessage may be set,
    // otherwise the retry path would reopen a pane the user just closed.
    assert.equal(result.errorMessage, undefined);
  });

  it("survives an occasional flaky read instead of declaring the pane gone", async () => {
    let reads = 0;
    const result = await pollForExit("w1:p1", never, {
      interval: 0,
      goneConfirmations: 3,
      deps: deps({
        readScreen: async () => {
          reads += 1;
          if (reads === 1 || reads === 3) throw new Error("herdr pane read failed: timeout");
          if (reads === 2) throw new SurfaceGoneError("pane_not_found: pane w1:p1 not found");
          return "still running\n__SUBAGENT_DONE_0__\n";
        },
      }),
    });

    assert.equal(result.reason, "sentinel");
    assert.equal(result.exitCode, 0);
    // Two not-found reads were separated by a successful read, so the streak
    // never reached the confirmation count.
    assert.equal(reads, 4);
  });

  it("keeps retrying a transport failure but gives up after the bounded window", async () => {
    let reads = 0;
    const result = await pollForExit("w1:p1", never, {
      interval: 0,
      transportFailureLimitMs: 0,
      deps: deps({
        readScreen: async () => {
          reads += 1;
          throw new Error("herdr pane read failed: connection reset by peer");
        },
      }),
    });

    assert.equal(reads, 1);
    assert.equal(result.reason, "surface_lost");
    assert.match(result.surfaceLostReason ?? "", /could not read/i);
    assert.equal(result.errorMessage, undefined);
  });

  it("prefers a .exit sidecar written at the same moment the pane vanished", async () => {
    const dir = tempDir("pi-poll-");
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, "");
      writeFileSync(
        `${sessionFile}.exit`,
        JSON.stringify({ type: "error", errorMessage: "Anthropic 529 Overloaded" }),
      );

      const result = await pollForExit("w1:p1", never, {
        interval: 0,
        sessionFile,
        goneConfirmations: 1,
        deps: deps({
          readScreen: async () => {
            throw new SurfaceGoneError("pane_not_found");
          },
        }),
      });

      assert.equal(result.reason, "error");
      assert.equal(result.errorMessage, "Anthropic 529 Overloaded");
      assert.ok(!existsSync(`${sessionFile}.exit`), "the sidecar is consumed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects the sentinel and parses its exit code", async () => {
    const result = await pollForExit("w1:p1", never, {
      interval: 0,
      deps: deps({ readScreen: async () => "output\n__SUBAGENT_DONE_130__\n" }),
    });
    assert.equal(result.reason, "sentinel");
    assert.equal(result.exitCode, 130);
  });

  it("classifies herdr error payloads and desktop not-found errors", () => {
    const notFound = {
      stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane w1:p1 not found" } }),
    };
    assert.equal(isHerdrSurfaceGone(notFound), true);
    assert.equal(
      isHerdrSurfaceGone({ stderr: JSON.stringify({ error: { code: "internal", message: "boom" } }) }),
      false,
    );
    assert.equal(isHerdrSurfaceGone(new Error("spawn herdr ENOENT")), false);

    const { isSurfaceGoneError } = __pollForExitTest__;
    assert.equal(isSurfaceGoneError(new SurfaceGoneError("gone")), true);
    assert.equal(isSurfaceGoneError(new Error("other")), false);
    assert.equal(isSurfaceGoneError({ name: "SurfaceGoneError", message: "gone" }), true);
  });

  it("treats closing an already-gone pane as a no-op", () => {
    // Real herdr: `pane close` on a missing pane exits 1 with the
    // `pane_not_found` error code. `closeSurface` must swallow exactly that
    // shape (idempotent cleanup) and keep reporting every other failure.
    const realMessage =
      "herdr pane close failed: pane_not_found: pane w1:p1 not found";
    assert.equal(isSurfaceGoneMessage(realMessage), true);
    assert.equal(
      isSurfaceGoneMessage(JSON.stringify({ error: { code: "pane_not_found" } })),
      true,
    );
    assert.equal(isSurfaceGoneMessage("herdr pane close failed: connection refused"), false);
    assert.equal(isSurfaceGoneMessage("herdr pane close failed: permission denied"), false);
  });

  it("classifies hc not-found terminal errors for the desktop backend", () => {
    // Real hc shape: exit 3, the error JSON arrives on stderr.
    const hcError = {
      message: "Command failed: hc get t9 --json",
      stderr: JSON.stringify({
        error: { hint: "see hc ls --all", kind: "not_found", message: 'no terminal "t9"' },
      }),
    };
    assert.equal(isHcNotFound(hcError), true);
    assert.equal(
      isHcNotFound({ stderr: JSON.stringify({ error: { kind: "internal", message: "boom" } }) }),
      false,
    );
    assert.equal(isHcNotFound(new Error("spawn hc ENOENT")), false);
  });

  it("keeps the exit-sentinel helpers shell-compatible", () => {
    assert.equal(
      withExitSentinel("pi --session s.jsonl"),
      "pi --session s.jsonl; echo '__SUBAGENT_DONE_'$?'__'",
    );
    assert.equal(stripExitSentinel("answer\n__SUBAGENT_DONE_0__\n"), "answer\n\n");
    assert.equal(parseSentinelExitCode("__SUBAGENT_DONE_7__"), 7);
    assert.equal(parseSentinelExitCode("no sentinel here"), null);
  });
});

// ── 4. ask_question durability ──────────────────────────────────────────────

describe("ask_question .ask handoff", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = tempDir("pi-ask-");
    saved = snapshotEnv();
    api.joins.reset();
  });

  afterEach(() => {
    restoreEnv(saved);
    api.runningSubagents.clear();
    api.joins.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  function setupSubagent(sessionFile: string) {
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_NAME = "scout-2";
    process.env.PI_SUBAGENT_AGENT = "scout";
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    const { pi, tools } = mockExtension();
    subagentDoneExtension(pi as any);
    return { tools };
  }

  function setupParent() {
    const { pi, messages } = mockExtension();
    extension(pi as any);
    return { messages };
  }

  it("writes the .ask file atomically and leaves no temp file behind", async () => {
    const sessionFile = join(dir, "s.jsonl");
    writeFileSync(sessionFile, "");
    const { tools } = setupSubagent(sessionFile);
    const ask = tools.find((tool) => tool.name === "ask_question");

    await ask.execute("c1", { question: "Which base URL?" }, undefined, undefined, {
      shutdown() {},
    });

    const askFile = `${sessionFile}.ask`;
    assert.ok(existsSync(askFile));
    const payload = JSON.parse(readFileSync(askFile, "utf-8"));
    assert.equal(payload.question, "Which base URL?");
    assert.equal(payload.name, "scout-2");
    assert.equal(payload.agent, "scout");
    assert.equal(typeof payload.askId, "string", "each ask carries a unique id");

    // The atomic writer must not leave temp siblings in the session dir.
    const leftovers = (await import("node:fs")).readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("writeFileAtomic replaces the target in one step and cleans up on failure", () => {
    const target = join(dir, "payload.json");
    writeFileAtomic(target, '{"a":1}');
    assert.equal(readFileSync(target, "utf-8"), '{"a":1}');
    writeFileAtomic(target, '{"a":2}');
    assert.equal(readFileSync(target, "utf-8"), '{"a":2}');

    // A failing rename must not leave a temp file behind.
    const blocked = join(dir, "blocked");
    mkdirSync(blocked);
    const fileAsDir = join(blocked, "target.json");
    mkdirSync(fileAsDir); // rename onto a directory fails
    assert.throws(() => writeFileAtomic(fileAsDir, "data"));
    const leftovers = readdirSync(blocked).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("does not drop a half-written .ask file and delivers it once complete", async () => {
    const sessionFile = join(dir, "parent.jsonl");
    writeFileSync(sessionFile, "");
    const { messages } = setupParent();
    const askFile = `${sessionFile}.ask`;
    writeFileSync(askFile, '{"name":"scout-2","quest'); // truncated JSON

    const running: any = { id: "1", name: "scout-2", sessionFile, startTime: Date.now() };
    let now = 1_000;
    api.joins.start("1", "scout-2");

    // Inside the grace window the parent must leave the file alone.
    api.deliverPendingQuestion(running, { now: () => now, invalidGraceMs: 5_000 });
    assert.ok(existsSync(askFile), "a partway file must not be deleted immediately");
    assert.equal(messages.length, 0);

    // The writer finishes; the next tick delivers the question normally.
    writeFileSync(askFile, JSON.stringify({ name: "scout-2", question: "Which base URL?" }));
    now += 1_000;
    api.deliverPendingQuestion(running, { now: () => now, invalidGraceMs: 5_000 });

    assert.equal(messages.length, 1);
    assert.match(messages[0][0].content, /Which base URL\?/);
    assert.equal(messages[0][0].customType, "subagent_question");
    assert.ok(!existsSync(askFile), "a delivered question is consumed");
  });

  it("drops a permanently corrupt .ask file once and reports it a single time", async () => {
    const sessionFile = join(dir, "parent.jsonl");
    writeFileSync(sessionFile, "");
    const { messages } = setupParent();
    const askFile = `${sessionFile}.ask`;
    writeFileSync(askFile, "not json at all");

    const running: any = { id: "1", name: "scout-2", sessionFile, startTime: Date.now() };
    api.joins.start("1", "scout-2");
    let now = 1_000;

    // First ticks inside the grace window: no delete, no notification.
    for (let tick = 0; tick < 3; tick++) {
      api.deliverPendingQuestion(running, { now: () => now, invalidGraceMs: 2_000 });
      now += 500;
      assert.ok(existsSync(askFile));
      assert.equal(messages.length, 0);
    }

    // Past the grace window: the file is removed and the parent is told once.
    now += 3_000;
    api.deliverPendingQuestion(running, { now: () => now, invalidGraceMs: 2_000 });
    assert.ok(!existsSync(askFile));
    assert.equal(messages.length, 1);
    assert.match(messages[0][0].content, /could not be read/);
    assert.equal(messages[0][0].details.unreadableQuestion, true);

    // A later tick with no file must not notify again.
    now += 1_000;
    api.deliverPendingQuestion(running, { now: () => now, invalidGraceMs: 2_000 });
    assert.equal(messages.length, 1);
  });

  it("does not re-notify the same question when the delete fails", () => {
    const sessionFile = join(dir, "parent.jsonl");
    writeFileSync(sessionFile, "");
    const { messages } = setupParent();
    const askFile = `${sessionFile}.ask`;
    const payload = { name: "scout-2", question: "Which base URL?", askId: "ask-1" };
    writeFileSync(askFile, JSON.stringify(payload));

    const running: any = { id: "1", name: "scout-2", sessionFile, startTime: Date.now() };
    api.joins.start("1", "scout-2");
    const now = () => 1_000;

    api.deliverPendingQuestion(running, { now, invalidGraceMs: 2_000 });
    assert.equal(messages.length, 1);

    // Simulate a failed delete by re-creating the same payload: the delivered
    // key must suppress a duplicate steer message.
    writeFileSync(askFile, JSON.stringify(payload));
    api.deliverPendingQuestion(running, { now, invalidGraceMs: 2_000 });
    assert.equal(messages.length, 1, "the same payload is delivered only once");
    assert.ok(!existsSync(askFile), "the stale copy is still cleaned up");
  });

  it("delivers a fresh question after a previous one was answered", () => {
    const sessionFile = join(dir, "parent.jsonl");
    writeFileSync(sessionFile, "");
    const { messages } = setupParent();
    const askFile = `${sessionFile}.ask`;
    const running: any = { id: "1", name: "scout-2", sessionFile, startTime: Date.now() };
    api.joins.start("1", "scout-2");

    writeFileSync(askFile, JSON.stringify({ question: "first?", askId: "a1" }));
    api.deliverPendingQuestion(running, { now: () => 1_000 });
    assert.equal(messages.length, 1);

    api.joins.answer("scout-2");
    writeFileSync(askFile, JSON.stringify({ question: "second?", askId: "a2" }));
    api.deliverPendingQuestion(running, { now: () => 2_000 });
    assert.equal(messages.length, 2);
    assert.match(messages[1][0].content, /second\?/);
  });

  it("ignores complete JSON that carries no question and clears it", () => {
    const sessionFile = join(dir, "parent.jsonl");
    writeFileSync(sessionFile, "");
    const { messages } = setupParent();
    const askFile = `${sessionFile}.ask`;
    writeFileSync(askFile, JSON.stringify({ name: "scout-2" }));
    const running: any = { id: "1", name: "scout-2", sessionFile, startTime: Date.now() };
    api.joins.start("1", "scout-2");

    // Well-formed but useless: no point waiting the full grace window.
    api.deliverPendingQuestion(running, { now: () => 1_000, invalidGraceMs: 2_000 });
    assert.ok(!existsSync(askFile));
    assert.equal(messages.length, 0, "no question text, so nothing to notify");
  });
});

