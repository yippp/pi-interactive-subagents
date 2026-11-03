/**
 * Regression tests for the `system-prompt` frontmatter field.
 *
 * The field decides where an agent's identity text is delivered:
 * - `append` / `replace` → written to a file and passed as
 *   `--append-system-prompt` / `--system-prompt`.
 * - omitted or invalid → `systemPromptMode` stays undefined, so the identity
 *   is prepended to the task prompt instead.
 *
 * These tests call the shipped code (`parseAgentDefinition` through
 * `loadAgentDefaults`, and `applySandboxToParts` for the CLI flags) rather than
 * a local re-implementation, so a change in the parser or the sandbox builder
 * fails here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ as api } from "../pi-extension/subagents/index.ts";

function agentFile(frontmatter: string, body = "You are a specialized agent."): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/**
 * Load one agent file through the real loader.
 *
 * `loadAgentDefaults` searches the project dir, then the global agent dir, then
 * the bundled agents, so the fixture goes into an isolated global agent dir.
 */
/**
 * Load one agent file through the real loader.
 *
 * `loadAgentDefaults` searches the project dir, then the global agent dir, then
 * the bundled agents, so the fixture goes into an isolated global agent dir.
 * The previous `PI_CODING_AGENT_DIR` is restored afterwards.
 */
function loadAgent(frontmatter: string, body?: string): any {
  const dir = mkdtempSync(join(tmpdir(), "pi-test-spm-"));
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "spm-test.md"), agentFile(frontmatter, body));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return api.loadAgentDefaults("spm-test");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build the sandbox parts for a loadout with the given identity mode. */
function withSandboxParts(
  loadout: Record<string, unknown>,
  run: (parts: string[]) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-test-spm-sandbox-"));
  try {
    const parts: string[] = [];
    api.applySandboxToParts(
      parts,
      {
        agent: "spm-test",
        toolAllowlist: "read",
        model: "anthropic/test-model",
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: true,
        cwd: null,
        agentDir: null,
        ...loadout,
      },
      { artifactDir: dir, name: "spm-test" },
    );
    run(parts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("system-prompt frontmatter", () => {
  it("reads replace and append, and ignores anything else", () => {
    const replace = loadAgent("system-prompt: replace");
    const append = loadAgent("system-prompt: append");
    const unset = loadAgent("model: anthropic/test-model");
    const invalid = loadAgent("system-prompt: foobar");
    // Assert the file parsed at all: otherwise a rejected file would also read
    // as "undefined mode" and pass for the wrong reason.
    for (const loaded of [replace, append, unset, invalid]) assert.ok(loaded);
    assert.equal(replace.systemPromptMode, "replace");
    assert.equal(append.systemPromptMode, "append");
    assert.equal(unset.systemPromptMode, undefined);
    assert.equal(invalid.systemPromptMode, undefined);
  });

  it("keeps the agent body available for the task-prompt fallback", () => {
    const loaded = loadAgent("system-prompt: replace", "You are a specialized agent.");
    assert.equal(loaded?.body, "You are a specialized agent.");
  });
});

describe("system-prompt delivery", () => {
  it("replace mode writes the identity file and passes --system-prompt", () => {
    withSandboxParts({ systemPromptMode: "replace", identity: "You are X." }, (parts) => {
      assert.ok(parts.includes("--system-prompt"), "expected --system-prompt");
      assert.ok(!parts.includes("--append-system-prompt"));

      const file = parts[parts.indexOf("--system-prompt") + 1].replace(/^'|'$/g, "");
      assert.ok(existsSync(file), `expected the identity file to exist: ${file}`);
      assert.equal(readFileSync(file, "utf8"), "You are X.");
    });
  });

  it("append mode passes --append-system-prompt", () => {
    withSandboxParts({ systemPromptMode: "append", identity: "You are X." }, (parts) => {
      assert.ok(parts.includes("--append-system-prompt"));
      assert.ok(!parts.includes("--system-prompt"));
    });
  });

  it("treats a null mode with an identity as append (resume compatibility)", () => {
    // Older loadouts recorded the identity without a mode; they must still
    // deliver it as an appended system prompt rather than silently dropping it.
    withSandboxParts({ systemPromptMode: null, identity: "You are X." }, (parts) => {
      assert.ok(parts.includes("--append-system-prompt"));
    });
  });

  it("adds no system-prompt flag when the identity is null", () => {
    withSandboxParts({ systemPromptMode: "replace", identity: null }, (parts) => {
      assert.ok(!parts.includes("--system-prompt"));
      assert.ok(!parts.includes("--append-system-prompt"));
    });
  });
});

describe("bundled agents", () => {
  it("declare append mode so their body is not duplicated into the task", () => {
    // Read the repository's agents/*.md, not whatever shadows them in the
    // user's global agent dir: loadAgentDefaults checks that dir first.
    const dir = mkdtempSync(join(tmpdir(), "pi-test-spm-bundled-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      for (const name of ["scout", "researcher", "worker"]) {
        const loaded = api.loadAgentDefaults(name);
        assert.ok(loaded, `expected bundled agent ${name} to be discoverable`);
        assert.equal(loaded.systemPromptMode, "append", `${name} should use system-prompt: append`);
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
