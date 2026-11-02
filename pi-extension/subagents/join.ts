// Await lifecycle notifications, not shell sleeps or a second filesystem poller.
// Results still arrive through the existing steer channel, exactly once.
export interface RunState {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  question?: string;
  blocked?: boolean;
}
export class SubagentJoin {
  private runs = new Map<string, RunState>();
  private listeners = new Set<() => void>();
  private notify() { for (const listener of [...this.listeners]) listener(); }
  start(id: string, name: string) {
    this.runs.set(name, { id, name, status: "running" });
    this.notify();
  }
  finish(id: string, name: string, failed = false) {
    const run = this.runs.get(name);
    if (!run || run.id !== id) return;
    run.status = failed ? "failed" : "completed";
    delete run.question;
    delete run.blocked;
    this.notify();
  }
  question(id: string, name: string, question: string) {
    const run = this.runs.get(name);
    if (!run || run.id !== id) return;
    run.question = question;
    this.notify();
  }
  blocked(id: string, name: string, blocked: boolean) {
    const run = this.runs.get(name);
    if (!run || run.id !== id) return;
    run.blocked = blocked;
    this.notify();
  }
  answer(name: string) {
    const run = this.runs.get(name);
    if (run) delete run.question;
  }
  reset() { this.runs.clear(); this.notify(); }
  snapshot() { return [...this.runs.values()].map(run => ({ ...run })); }
  get listenerCount() { return this.listeners.size; }

  wait(names: string[], mode: "all" | "any", timeoutMs: number, signal?: AbortSignal) {
    const selected = [...new Set(names)];
    if (!selected.length) throw new Error("Specify at least one subagent name returned by subagent().");
    const targets = selected.map(name => {
      const run = this.runs.get(name);
      if (!run) {
        const known = [...this.runs.keys()].join(", ") || "(none)";
        throw new Error(`Unknown subagent "${name}" in this runtime (known: ${known}). After /reload, spawn a fresh run or resume it by name first.`);
      }
      return { ...run };
    });
    return new Promise<{ reason: string; runs: RunState[]; questions: RunState[] }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.listeners.delete(check);
      };
      const finish = (reason: string) => {
        cleanup();
        resolve({ reason, runs: targets.map(target => ({ ...(this.runs.get(target.name) ?? target) })),
          questions: this.snapshot().filter(run => run.question || run.blocked) });
      };
      const abort = () => { cleanup(); reject(new Error("Subagent wait cancelled; children are still running.")); };
      const check = () => {
        if (signal?.aborted) return abort();
        if (targets.some(target => this.runs.get(target.name)?.id !== target.id)) return finish("runtime_changed");
        // ANY unanswered child question must release the parent tool call;
        // queued steer messages cannot be answered while a tool is blocked.
        if (this.snapshot().some(run => run.question || run.blocked)) return finish("question");
        const done = targets.map(target => this.runs.get(target.name)!.status !== "running");
        if (mode === "all" ? done.every(Boolean) : done.some(Boolean)) finish("completed");
      };
      this.listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      check();
    });
  }
}
