import { it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import extension, { __test__ as api } from "../pi-extension/subagents/index.ts";
import {
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void) {
  const dir = tempDir(prefix);
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function loadout(overrides: Partial<SubagentLoadout> = {}): SubagentLoadout {
  return {
    agent: "scout",
    toolAllowlist: "read,grep,find,ls,ask_question",
    model: null,
    thinking: null,
    systemPromptMode: null,
    identity: null,
    spawnable: null,
    autoExit: true,
    cwd: null,
    agentDir: null,
    ...overrides,
  };
}

function mockExtension(tools: any[] = []) {
  extension({
    on() {
      return () => {};
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    getAllTools: () => tools,
    sendMessage() {},
  } as any);
}

function runningRun(overrides: Record<string, unknown> = {}): any {
  return {
    id: "run-1",
    name: "a",
    task: "do work",
    surface: "herdr:1",
    startTime: Date.now(),
    sessionFile: "",
    interactive: false,
    statusState: {},
    ...overrides,
  };
}

function attemptResult(overrides: Record<string, unknown> = {}): any {
  return {
    name: "a",
    task: "do work",
    summary: "attempt summary",
    exitCode: 0,
    elapsed: 1,
    ...overrides,
  };
}

function retryDeps(overrides: Record<string, unknown> = {}): any {
  const delivered: any[] = [];
  const finished: any[] = [];
  const removed: string[] = [];
  const deps: any = {
    delivered,
    finished,
    removed,
    watch: async () => attemptResult(),
    retry: async () => ({ error: "unused" }),
    deliver: (content: string, details: Record<string, unknown>) =>
      delivered.push({ content, details }),
    finish: (id: string, name: string, failed: boolean) => finished.push({ id, name, failed }),
    remove: (id: string) => removed.push(id),
    summarize: (_running: any, _baseline: number, result: any) => result.summary,
    ...overrides,
  };
  return deps;
}

beforeEach(() => {
  api.joins.reset();
});

it("retry loop resumes a provider error, keeps the run id, and finishes once", async () => {
  await withTempDir("pi-retry-loop-", async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    writeSubagentLoadout(sessionFile, loadout({ toolAllowlist: "read,ask_question" }));

    let watches = 0;
    let retrySawRunningIdentity = false;
    const deps = retryDeps();
    deps.watch = async () => {
      watches += 1;
      return watches === 1
        ? attemptResult({ exitCode: 1, errorMessage: "429 overloaded", summary: "failed turn" })
        : attemptResult({ summary: "recovered output" });
    };
    deps.retry = async (options: any) => {
      retrySawRunningIdentity = options.id === "run-1" && deps.finished.length === 0;
      return {
        running: runningRun({ sessionFile, retrying: false }),
        entryCountBefore: 7,
      };
    };

    await api.watchSubagentWithRetry(
      {
        running: runningRun({ sessionFile }),
        signal: new AbortController().signal,
        ctx: { sessionManager: { getSessionId: () => "s", getSessionDir: () => dir } },
        entryCountBefore: 0,
      },
      deps,
    );

    assert.equal(watches, 2);
    assert.ok(retrySawRunningIdentity, "the failed run must keep its identity while retrying");
    assert.deepEqual(deps.finished, [{ id: "run-1", name: "a", failed: false }]);
    assert.deepEqual(deps.removed, ["run-1"]);
    assert.equal(deps.delivered.length, 1);
    assert.match(deps.delivered[0].content, /recovered output/);
    assert.equal(deps.delivered[0].details.attempts, 2);
  });
});

it("retry exhaustion reports one failure after the configured attempts", async () => {
  await withTempDir("pi-retry-exhaust-", async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    writeSubagentLoadout(sessionFile, loadout({ toolAllowlist: "read,ask_question" }));
    let retries = 0;
    const deps = retryDeps({
      watch: async () => attemptResult({ exitCode: 1, errorMessage: "overloaded", summary: "failed" }),
      retry: async () => {
        retries += 1;
        return { running: runningRun({ sessionFile }), entryCountBefore: 3 };
      },
    });

    await api.watchSubagentWithRetry(
      {
        running: runningRun({ sessionFile }),
        signal: new AbortController().signal,
        ctx: { sessionManager: { getSessionId: () => "s", getSessionDir: () => dir } },
        entryCountBefore: 0,
      },
      deps,
    );

    assert.equal(retries, api.SUBAGENT_RETRY_MAX);
    assert.equal(deps.delivered[0].details.attempts, api.SUBAGENT_RETRY_MAX + 1);
    assert.deepEqual(deps.finished, [{ id: "run-1", name: "a", failed: true }]);
    assert.deepEqual(deps.removed, ["run-1"]);
  });
});

it("a retry that cannot start reports the original error plus the start failure", async () => {
  await withTempDir("pi-retry-cannot-start-", async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    writeSubagentLoadout(sessionFile, loadout({ toolAllowlist: "read,ask_question" }));
    const deps = retryDeps({
      watch: async () => attemptResult({ exitCode: 1, errorMessage: "429", summary: "failed" }),
      retry: async () => ({ error: "no pane available" }),
    });

    await api.watchSubagentWithRetry(
      {
        running: runningRun({ sessionFile }),
        signal: new AbortController().signal,
        ctx: { sessionManager: { getSessionId: () => "s", getSessionDir: () => dir } },
        entryCountBefore: 0,
      },
      deps,
    );

    assert.equal(deps.delivered.length, 1);
    assert.match(deps.delivered[0].content, /429/);
    assert.match(deps.delivered[0].content, /could not start: no pane available/);
    assert.deepEqual(deps.finished, [{ id: "run-1", name: "a", failed: true }]);
  });
});

it("retry, summary, and delivery failures are caught and still finish the join", async () => {
  await withTempDir("pi-retry-errors-", async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    writeSubagentLoadout(sessionFile, loadout({ toolAllowlist: "read,ask_question" }));
    const base = {
      running: runningRun({ sessionFile }),
      signal: new AbortController().signal,
      ctx: { sessionManager: { getSessionId: () => "s", getSessionDir: () => dir } },
      entryCountBefore: 0,
    };

    const retryThrows = retryDeps({
      watch: async () => attemptResult({ exitCode: 1, errorMessage: "429" }),
      retry: async () => {
        throw new Error("retry exploded");
      },
    });
    await assert.doesNotReject(api.watchSubagentWithRetry(base, retryThrows));
    assert.deepEqual(retryThrows.finished, [{ id: "run-1", name: "a", failed: true }]);
    assert.deepEqual(retryThrows.removed, ["run-1"]);
    assert.match(retryThrows.delivered[0].content, /retry exploded/);

    const summaryThrows = retryDeps({
      summarize: () => {
        throw new Error("jsonl exploded");
      },
    });
    await assert.doesNotReject(api.watchSubagentWithRetry(base, summaryThrows));
    assert.deepEqual(summaryThrows.finished, [{ id: "run-1", name: "a", failed: true }]);
    assert.deepEqual(summaryThrows.removed, ["run-1"]);
    assert.match(summaryThrows.delivered[0].content, /jsonl exploded/);

    const deliveryThrows = retryDeps({
      deliver: () => {
        throw new Error("channel closed");
      },
    });
    await assert.doesNotReject(api.watchSubagentWithRetry(base, deliveryThrows));
    assert.deepEqual(deliveryThrows.finished, [{ id: "run-1", name: "a", failed: false }]);
    assert.deepEqual(deliveryThrows.removed, ["run-1"]);
  });
});

it("missing or corrupt transcripts are reported without throwing", async () => {
  await withTempDir("pi-retry-transcript-", async (dir) => {
    const missing = join(dir, "missing.jsonl");
    const missingSummary = api.summarizeAttempt(
      runningRun({ sessionFile: missing }),
      0,
      attemptResult({ summary: "ignored" }),
    );
    assert.match(missingSummary, /exited without output/);
    assert.match(missingSummary, /Session transcript could not be read/);

    const corrupt = join(dir, "corrupt.jsonl");
    writeFileSync(corrupt, '{"type":"message"\nnot json\n');
    const corruptSummary = api.summarizeAttempt(
      runningRun({ sessionFile: corrupt }),
      0,
      attemptResult({ summary: "ignored" }),
    );
    assert.match(corruptSummary, /Session transcript could not be read/);
  });
});

it("the summary baseline skips seeded parent entries", async () => {
  await withTempDir("pi-retry-baseline-", async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "parent answer" }] },
      }) + "\n",
    );
    const noNewOutput = attemptResult({ exitCode: 0, summary: "ignored" });
    assert.equal(
      api.summarizeAttempt(runningRun({ sessionFile }), 1, noNewOutput),
      "Sub-agent exited without output",
      "a seeded fork must not report the parent's last answer",
    );
    assert.match(
      api.summarizeAttempt(runningRun({ sessionFile }), 0, noNewOutput),
      /parent answer/,
      "baseline 0 would leak the seeded parent answer",
    );
  });
});

it("parallel retrying runs keep independent identities and both finish", async () => {
  await withTempDir("pi-retry-parallel-", async (dir) => {
    const makeSession = (name: string) => {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, "");
      writeSubagentLoadout(file, loadout({ toolAllowlist: "read,ask_question" }));
      return file;
    };
    const finished: any[] = [];
    const removed: string[] = [];
    const delivered: any[] = [];
    const shared = {
      finish: (id: string, name: string, failed: boolean) => finished.push({ id, name, failed }),
      remove: (id: string) => removed.push(id),
      deliver: (content: string) => delivered.push(content),
    };
    const run = async (id: string, name: string) => {
      const sessionFile = makeSession(name);
      let calls = 0;
      const deps = retryDeps({
        ...shared,
        watch: async () => {
          calls += 1;
          return calls === 1
            ? attemptResult({ name, task: name, exitCode: 1, errorMessage: "429" })
            : attemptResult({ name, task: name, summary: `${name} done` });
        },
        retry: async () => ({
          running: runningRun({ id, name, task: name, sessionFile }),
          entryCountBefore: 1,
        }),
      });
      await api.watchSubagentWithRetry(
        {
          running: runningRun({ id, name, task: name, sessionFile }),
          signal: new AbortController().signal,
          ctx: { sessionManager: { getSessionId: () => "s", getSessionDir: () => dir } },
          entryCountBefore: 0,
        },
        deps,
      );
    };

    await Promise.all([run("run-a", "alpha"), run("run-b", "beta")]);
    assert.deepEqual(
      finished.map((entry) => entry.name).sort(),
      ["alpha", "beta"],
    );
    assert.deepEqual(removed.sort(), ["run-a", "run-b"]);
    assert.equal(delivered.length, 2);
    assert.ok(delivered.some((text) => text.includes("alpha done")));
    assert.ok(delivered.some((text) => text.includes("beta done")));
  });
});

it("MCP tools are refused instead of loading builtin:mcp", () => {
  mockExtension([
    {
      name: "mcp__github__search",
      sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "user", origin: "top-level" },
    },
  ]);
  assert.equal(api.getToolExtensionPath("mcp__github__search"), undefined);
  assert.throws(
    () => api.resolveToolExtensions("read,mcp__github__search"),
    /MCP tool .* cannot be granted .* would expose every configured MCP server/,
  );
});

it("a null model replays the pinned Anthropic auth transport extension", async () => {
  await withTempDir("pi-auth-snapshot-", (dir) => {
    const authEntry = join(dir, "pi-anthropic-auth", "src", "index.ts");
    mkdirSync(dirname(authEntry), { recursive: true });
    writeFileSync(authEntry, "export default () => {};");
    const parts: string[] = [];
    api.applySandboxToParts(
      parts,
      loadout({ model: null, providerAuthExtension: authEntry }),
      { artifactDir: dir, name: "x" },
    );
    assert.ok(parts.some((part) => part.includes(authEntry)));
  });
});

it("pinned provider and auth extensions that disappeared fail before spawn", async () => {
  await withTempDir("pi-pinned-missing-", (dir) => {
    const gone = join(dir, "gone-provider.ts");
    assert.throws(
      () =>
        api.applySandboxToParts(
          [],
          loadout({ model: null, providerExtensions: [gone] }),
          { artifactDir: dir, name: "x" },
        ),
      /pinned provider extension/,
    );
    const goneAuth = join(dir, "gone-auth.ts");
    assert.throws(
      () =>
        api.applySandboxToParts(
          [],
          loadout({ model: null, providerAuthExtension: goneAuth }),
          { artifactDir: dir, name: "x" },
        ),
      /pinned Anthropic auth extension/,
    );
  });
});
