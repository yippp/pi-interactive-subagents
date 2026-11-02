import { it } from "node:test";
import assert from "node:assert/strict";
import { SubagentJoin } from "../pi-extension/subagents/join.ts";

it("all joins complete in any order; failure is terminal and listeners clean up", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  join.start("2", "b");
  const waiting = join.wait(["a", "b", "a"], "all", 1000);
  join.finish("2", "b", true);
  assert.equal(join.listenerCount, 1);
  join.finish("1", "a");
  const result = await waiting;
  assert.equal(result.reason, "completed");
  assert.deepEqual(result.runs.map((r) => r.status), ["completed", "failed"]);
  assert.equal(join.listenerCount, 0);
});

it("any returns after the first completion", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  join.start("2", "b");
  const waiting = join.wait(["a", "b"], "any", 1000);
  join.finish("1", "a");
  assert.equal((await waiting).reason, "completed");
  assert.equal(join.snapshot()[1].status, "running");
});

it("already finished names return without polling", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  join.finish("1", "a");
  assert.equal((await join.wait(["a"], "all", 1000)).reason, "completed");
  assert.equal(join.listenerCount, 0);
});

it("unknown/empty names fail promptly", () => {
  const join = new SubagentJoin();
  assert.throws(() => join.wait(["missing"], "all", 1000), /Unknown/);
  assert.throws(() => join.wait([], "all", 1000), /at least one/);
});

it("timeout releases the tool without cancelling children", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  assert.equal((await join.wait(["a"], "all", 0)).reason, "timeout");
  assert.equal(join.snapshot()[0].status, "running");
  assert.equal(join.listenerCount, 0);
});

it("abort and pre-abort clean listeners without cancelling children", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  const abort = new AbortController();
  const waiting = join.wait(["a"], "all", 1000, abort.signal);
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  await assert.rejects(join.wait(["a"], "all", 1000, abort.signal), /cancelled/);
  assert.equal(join.listenerCount, 0);
  assert.equal(join.snapshot()[0].status, "running");
});

it("any child's question interrupts a join, including questions already pending", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  join.start("2", "b");
  const waiting = join.wait(["a"], "all", 1000);
  join.question("2", "b", "Which version?");
  assert.equal((await waiting).reason, "question");
  assert.equal((await join.wait(["a"], "all", 1000)).reason, "question");
  join.answer("b");
  join.finish("1", "a");
  assert.equal((await join.wait(["a"], "all", 1000)).reason, "completed");
});

it("a blocked native UI also interrupts a join", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  const waiting = join.wait(["a"], "all", 1000);
  join.blocked("1", "a", true);
  const result = await waiting;
  assert.equal(result.reason, "question");
  assert.equal(result.questions[0].blocked, true);
  join.blocked("1", "a", false);
  join.finish("1", "a");
  assert.equal((await join.wait(["a"], "all", 1000)).reason, "completed");
});

it("resume generations ignore late old completion and release old joins", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  const waiting = join.wait(["a"], "all", 1000);
  join.start("2", "a");
  assert.equal((await waiting).reason, "runtime_changed");
  join.finish("1", "a");
  assert.equal(join.snapshot()[0].status, "running");
});

it("runtime shutdown releases waiters and cleans state", async () => {
  const join = new SubagentJoin();
  join.start("1", "a");
  const waiting = join.wait(["a"], "all", 1000);
  join.reset();
  assert.equal((await waiting).reason, "runtime_changed");
  assert.equal(join.listenerCount, 0);
  assert.deepEqual(join.snapshot(), []);
});
