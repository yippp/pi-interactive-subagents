import { it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import extension, { __test__ as api } from "../pi-extension/subagents/index.ts";
import { shellEscape } from "../pi-extension/subagents/herdr.ts";
import {
  loadoutSidecarPath,
  readSubagentLoadout,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void) {
  const dir = tempDir(prefix);
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function mockExtension(tools: any[] = []) {
  const registered = new Map<string, any>();
  const events = new Map<string, Function>();
  const messages: any[] = [];
  extension({
    on(event: string, handler: Function) {
      events.set(event, handler);
      return () => {};
    },
    registerTool(tool: any) {
      registered.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    getAllTools: () => tools,
    sendMessage: (...args: any[]) => messages.push(args),
  } as any);
  return { registered, events, messages };
}

function sourceTool(name: string, path: string) {
  return {
    name,
    sourceInfo: { path, source: "npm:test-package", scope: "user", origin: "package" },
  };
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

beforeEach(() => {
  api.joins.reset();
});

it("omitted tools default to read-only instead of all extensions", () => {
  assert.equal(api.buildSubagentToolAllowlist(undefined), "read,grep,find,ls,ask_question");
  assert.equal(api.buildSubagentToolAllowlist(""), "read,grep,find,ls,ask_question");
  const granted = new Set(
    api.buildSubagentToolAllowlist(undefined, { grantSpawning: true }).split(","),
  );
  assert.ok(granted.has("subagent"));
  assert.ok(!granted.has("bash"), "read-only default must not grant shell access");
  assert.ok(!granted.has("write"));
  assert.throws(
    () => api.buildSubagentToolAllowlist("subagent", { grantSpawning: false }),
    /subagent_agents/,
  );
});

it("legacy unrestricted snapshots are refused, not replayed with every tool", () => {
  assert.throws(() => api.resolveToolExtensions(null), /Legacy unrestricted/);
  withTempDir("pi-loadout-legacy-", (dir) => {
    assert.throws(
      () => api.applySandboxToParts([], loadout({ toolAllowlist: null }), { artifactDir: dir, name: "x" }),
      /Legacy unrestricted/,
    );
  });
});

it("sourceInfo.path resolves npm tool extensions such as pi-web-access", async () => {
  await withTempDir("pi-provenance-", (dir) => {
    const entry = join(dir, "pi-web-access dist index.ts");
    writeFileSync(entry, "export default () => {};");
    const tools = [
      sourceTool("web_search", entry),
      sourceTool("fetch_content", entry),
      sourceTool("get_search_content", entry),
      sourceTool("source_check", entry),
      sourceTool("mcp_gateway", entry),
    ];
    mockExtension(tools);

    const resolved = api.resolveToolExtensions(
      "read,fetch_content,get_search_content,source_check",
    );
    assert.equal(resolved.fetch_content, entry);
    assert.equal(resolved.get_search_content, entry);
    assert.equal(resolved.source_check, entry);
    assert.ok(!("mcp_gateway" in resolved), "provenance lookup alone must not grant a tool");

    // Pinned paths keep working even when the parent no longer loads the tool.
    mockExtension([]);
    assert.equal(api.resolveToolExtensions("fetch_content", resolved).fetch_content, entry);
    rmSync(entry);
    assert.throws(() => api.resolveToolExtensions("fetch_content", resolved), /Cannot load/);
  });
});

it("unknown and SDK-only tools fail before a pane opens", () => {
  mockExtension([
    { name: "sdk_only", sourceInfo: { path: "<sdk:test>", source: "sdk", scope: "user", origin: "package" } },
    { name: "builtin_like", sourceInfo: { path: "builtin:custom", source: "builtin", scope: "user", origin: "package" } },
  ]);
  assert.throws(() => api.resolveToolExtensions("read,definitely_missing"), /definitely_missing/);
  assert.throws(() => api.resolveToolExtensions("sdk_only"), /sdk_only/);
  assert.throws(() => api.resolveToolExtensions("builtin_like"), /builtin_like/);
});

it("ask_question resolves to subagent-done.ts and powershell stays built-in", () => {
  const ask = api.getToolExtensionPath("ask_question");
  assert.ok(ask?.endsWith(join("subagents", "subagent-done.ts")));
  assert.equal(api.getToolExtensionPath("powershell"), undefined);
  const resolved = api.resolveToolExtensions("powershell,ask_question");
  assert.deepEqual(Object.keys(resolved), ["ask_question"]);
});

it("snapshot tool extension paths survive the loadout sidecar round-trip", async () => {
  await withTempDir("pi-pinned-", (dir) => {
    const entry = join(dir, "tool.ts");
    writeFileSync(entry, "export default () => {};");
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const snapshot = loadout({
      toolAllowlist: "read,ask_question,fetch_content",
      toolExtensions: { fetch_content: entry },
    });
    writeSubagentLoadout(sessionFile, snapshot);
    assert.ok(existsSync(loadoutSidecarPath(sessionFile)));
    const restored = readSubagentLoadout(sessionFile);
    assert.deepEqual(restored?.toolExtensions, { fetch_content: entry });
    const parts: string[] = [];
    api.applySandboxToParts(parts, restored!, { artifactDir: dir, name: "x" });
    assert.ok(parts.includes("--no-extensions"));
    assert.ok(parts.some((part) => part.includes(entry)));
    assert.equal(
      parts.filter((part) => part.includes(entry)).length,
      1,
      "a shared extension entry must be deduplicated",
    );
  });
});

it("provider extension is loaded for a restricted child, and the Anthropic auth extension is kept", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  await withTempDir("pi-provider-", (dir) => {
    process.env.PI_CODING_AGENT_DIR = dir;
    const providerEntry = join(
      dir,
      "npm",
      "node_modules",
      "pi-antigravity-acp-provider",
      "extensions",
      "index.ts",
    );
    mkdirSync(dirname(providerEntry), { recursive: true });
    writeFileSync(providerEntry, "export default () => {};");
    assert.equal(
      resolve(api.providerExtensionPath("antigravity-acp")!),
      resolve(providerEntry),
    );

    const parts: string[] = [];
    api.applySandboxToParts(
      parts,
      loadout({ model: "antigravity-acp/gemini-3.8-flash", thinking: "high" }),
      { artifactDir: dir, name: "x" },
    );
    assert.ok(parts.some((part) => part.includes("antigravity-acp/gemini-3.8-flash:high")));
    assert.ok(parts.some((part) => part.includes(providerEntry)));

    const other: string[] = [];
    api.applySandboxToParts(
      other,
      loadout({ model: "deepseek/deepseek-flash" }),
      { artifactDir: dir, name: "x" },
    );
    assert.ok(!other.some((part) => part.includes(providerEntry)));

    // Upstream Anthropic OAuth transport extension remains supported.
    const authEntry = join(
      dir,
      "npm",
      "node_modules",
      "@gotgenes",
      "pi-anthropic-auth",
      "src",
      "index.ts",
    );
    mkdirSync(dirname(authEntry), { recursive: true });
    writeFileSync(authEntry, "export default () => {};");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { access: "sk-ant-oat01-token" } }));
    const anthropicParts: string[] = [];
    api.applySandboxToParts(
      anthropicParts,
      loadout({ model: "anthropic/claude-opus-5" }),
      { artifactDir: dir, name: "x" },
    );
    assert.ok(anthropicParts.some((part) => part.includes(authEntry)));
    assert.ok(!anthropicParts.some((part) => part.includes(providerEntry)));
  }).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
});

it("bundled agents resolve their declared tools with npm provenance", () => {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const dir = tempDir("pi-bundled-agents-");
  try {
    process.chdir(dir);
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    const entry = join(dir, "pi-web-access dist index.ts");
    writeFileSync(entry, "export default () => {};");
    mockExtension([
      sourceTool("web_search", entry),
      sourceTool("fetch_content", entry),
    ]);
    for (const name of ["scout", "researcher", "worker"]) {
      const definition = api.loadAgentDefaults(name);
      assert.ok(definition, `bundled ${name} must be discoverable`);
      const allow = api.buildSubagentToolAllowlist(definition.tools, {
        grantSpawning: !!definition.subagentAgents?.length,
      });
      assert.doesNotThrow(
        () => api.resolveToolExtensions(allow),
        `${name} tools must resolve after the web_fetch -> fetch_content change: ${allow}`,
      );
    }
  } finally {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("provider extension snapshot covers a profile that omits model:", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  await withTempDir("pi-provider-null-model-", (dir) => {
    process.env.PI_CODING_AGENT_DIR = dir;
    const providerEntry = join(
      dir,
      "npm",
      "node_modules",
      "pi-antigravity-acp-provider",
      "extensions",
      "index.ts",
    );
    mkdirSync(dirname(providerEntry), { recursive: true });
    writeFileSync(providerEntry, "export default () => {};");

    const parts: string[] = [];
    api.applySandboxToParts(
      parts,
      loadout({ model: null, providerExtensions: [providerEntry] }),
      { artifactDir: dir, name: "x" },
    );
    assert.ok(parts.some((part) => part.includes(providerEntry)));

    // Without a snapshot, a null model cannot name a provider: nothing is added.
    const unsnapshotted: string[] = [];
    api.applySandboxToParts(unsnapshotted, loadout({ model: null }), {
      artifactDir: dir,
      name: "x",
    });
    assert.ok(!unsnapshotted.some((part) => part.includes(providerEntry)));
  }).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
});

it("Windows absolute cwd is not joined onto the current directory", () => {
  const windowsPath = "G:\\repo\\nested";
  const resolved = api.resolveSubagentPaths({ agent: "scout", task: "t", cwd: windowsPath }, null);
  if (process.platform === "win32") {
    assert.equal(resolved.effectiveCwd, windowsPath);
  }
  const posixPath = join(sep, "tmp", "repo");
  assert.equal(
    api.resolveSubagentPaths({ agent: "scout", task: "t", cwd: posixPath }, null).effectiveCwd,
    posixPath,
  );
  const relative = api.resolveSubagentPaths({ agent: "scout", task: "t", cwd: "nested" }, null);
  assert.equal(relative.effectiveCwd, join(process.cwd(), "nested"));
});

it("Pi-Bolt hosts spawn their own executable; other hosts keep pi from PATH", () => {
  const bolt = "C:\\Program Files\\Pi-Bolt\\pi-bolt.exe";
  assert.equal(api.resolveChildPiBin(bolt), shellEscape(bolt));
  assert.equal(api.resolveChildPiBin("C:\\Pi\\pi-bolt-jit.exe"), shellEscape("C:\\Pi\\pi-bolt-jit.exe"));
  assert.equal(api.resolveChildPiBin("/usr/local/bin/pi"), "pi");
  assert.equal(api.resolveChildPiBin("/usr/bin/node", "/opt/pi-bolt bin/pi-bolt"), shellEscape("/opt/pi-bolt bin/pi-bolt"));
});

it("retry defaults, nudge, and the shared resume command", async () => {
  assert.equal(api.SUBAGENT_RETRY_MAX, 3);
  const nudge = api.retryNudge("429 overloaded", 1, 4);
  assert.match(nudge, /429 overloaded/);
  assert.match(nudge, /Continue the task/);

  await withTempDir("pi-resume-", (dir) => {
    const sessionPath = join(dir, "session.jsonl");
    writeFileSync(sessionPath, "");
    const { command, launchScriptFile, resumeMsgFile } = api.buildResumeCommand({
      id: "abc12345",
      name: "Recon Worker",
      sessionPath,
      message: "Please continue",
      loadout: loadout({ cwd: dir, agentDir: dir, spawnable: ["scout"] }),
      artifactDir: dir,
      activityFile: join(dir, "activity.json"),
      autoExit: true,
      scriptLabel: "retry-1",
    });
    assert.match(command, / (?:'[^']*'|pi) --session /);
    assert.ok(command.includes("--no-extensions"));
    assert.ok(command.includes("--tools"));
    assert.ok(command.includes("PI_SUBAGENT_ALLOWED='scout'"));
    assert.ok(command.includes("PI_SUBAGENT_AUTO_EXIT=1"));
    assert.ok(command.includes(`cd ${shellEscape(dir)} && `));
    assert.ok(command.includes("__SUBAGENT_DONE_"));
    assert.ok(resumeMsgFile && command.includes(`@${resumeMsgFile}`));
    assert.ok(launchScriptFile.includes(join("subagent-scripts", "recon-worker-retry-1-")));
    assert.ok(existsSync(resumeMsgFile!));
    assert.equal(
      command.split("subagent-done.ts").length - 1,
      1,
      "subagent-done.ts must be loaded once, via ask_question",
    );
  });
});

it("subagent_wait returns compact statuses and never duplicates the result summary", async () => {
  const { registered } = mockExtension();
  api.joins.start("1", "a");
  const wait = registered.get("subagent_wait");
  assert.ok(wait, "subagent_wait must be registered");
  const pending = wait.execute("t", { names: ["a"], timeoutMs: 1000 }, undefined);
  api.joins.finish("1", "a");
  const result = await pending;
  assert.equal(result.details.reason, "completed");
  assert.deepEqual(result.details.runs, [{ id: "1", name: "a", status: "completed" }]);
  assert.match(result.content[0].text, /a: completed/);
  assert.match(result.content[0].text, /steer/);
  assert.doesNotMatch(result.content[0].text, /summary/i);
});

it("subagent_wait releases on a real child question, and a timeout leaves children running", async () => {
  await withTempDir("pi-question-", async (dir) => {
    const { registered, messages } = mockExtension();
    api.joins.start("1", "a");
    const wait = registered.get("subagent_wait");
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile + ".ask", JSON.stringify({ question: "Which version?" }));
    const pending = wait.execute("t", { names: ["a"], timeoutMs: 1000 }, undefined);
    api.deliverPendingQuestion({ id: "1", name: "a", sessionFile, startTime: Date.now() } as any);
    const result = await pending;
    assert.equal(result.details.reason, "question");
    assert.deepEqual(result.details.questions, ["a"]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0][0].customType, "subagent_question");
    assert.deepEqual(messages[0][1], { triggerTurn: true, deliverAs: "steer" });
    api.deliverPendingQuestion({ id: "1", name: "a", sessionFile, startTime: Date.now() } as any);
    assert.equal(messages.length, 1, "an ask file is delivered once");

    api.joins.answer("a");
    const timeout = await wait.execute("t", { names: ["a"], timeoutMs: 0 }, undefined);
    assert.equal(timeout.details.reason, "timeout");
    assert.equal(api.joins.snapshot()[0].status, "running");
  });
});
