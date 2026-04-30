import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { listLogFiles } from "./log/discover.js";

export interface PhaseCostFile {
  // Sum of `total_cost_usd` from every Anthropic `type:"result"` event in
  // the file. Script-phase results (flow's own `kind:"result"` rows) carry
  // no `total_cost_usd` and contribute nothing.
  usd: number;
  // True iff at least one Anthropic `type:"result"` event was observed.
  // The flow side-channel `kind:"result"` does NOT count here — it's
  // emitted by the orchestrator after the LLM stream ends, not by Claude.
  // Without that distinction, a crashed LLM phase that still got a flow
  // result line (from the throw branch in `runner.ts`) would look complete.
  hasResult: boolean;
  // True iff at least one Anthropic stream event (any line with a `type:`
  // field) was observed. Lets the aggregator distinguish a *script-only*
  // phase log (worktree, ci-wait — flow `kind:` events only, no LLM call)
  // from a *crashed* LLM phase log (Anthropic events present but no
  // `type:"result"` ever arrived). Without this split, every healthy run
  // through worktree/ci-wait was being flagged `partial`.
  hasAnthropicEvent: boolean;
}

export interface PhaseAggregate {
  name: string;
  attempts: number;
  usd: number;
  // True iff at least one attempt produced Anthropic stream events but
  // never reached a `type:"result"` — i.e. an incomplete LLM phase. A
  // script-only attempt (no Anthropic events at all) is NOT partial; it's
  // legitimately a `$0` script phase. The task-level `partial` is true
  // if *any* phase is partial.
  partial: boolean;
}

export interface TaskCost {
  total: number;
  partial: boolean;
  phases: PhaseAggregate[];
}

export async function parsePhaseCost(filePath: string): Promise<PhaseCostFile> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
  } catch {
    return { usd: 0, hasResult: false, hasAnthropicEvent: false };
  }
  // Stream line-by-line — phase jsonl files embed full Anthropic stream
  // content via `JsonlSink.pipeFrom`, so each file can be MBs. With the
  // aggregator running across every phase × every task (× archive under
  // `--all`), peak memory matters. `readline` keeps each file at one line
  // in memory at a time.
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let usd = 0;
  let hasResult = false;
  let hasAnthropicEvent = false;
  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const ev = obj as Record<string, unknown>;
      if (typeof ev["type"] !== "string") continue;
      hasAnthropicEvent = true;
      if (ev["type"] !== "result") continue;
      hasResult = true;
      const cost = ev["total_cost_usd"];
      if (typeof cost === "number" && Number.isFinite(cost)) usd += cost;
    }
  } catch {
    return { usd, hasResult, hasAnthropicEvent };
  }
  return { usd, hasResult, hasAnthropicEvent };
}

export async function aggregateTaskCost(taskDir: string): Promise<TaskCost> {
  const files = await listLogFiles(taskDir);
  if (files.length === 0) return { total: 0, partial: false, phases: [] };

  // Preserve the order phases first appear in the stamp-sorted file list
  // so the drill-down's phase column reads in execution order
  // (worktree → plan → implement → …) rather than by name.
  const order: string[] = [];
  const byPhase = new Map<
    string,
    { attempts: number; usd: number; incompleteAttempts: number }
  >();
  for (const f of files) {
    if (!byPhase.has(f.phase)) {
      order.push(f.phase);
      byPhase.set(f.phase, { attempts: 0, usd: 0, incompleteAttempts: 0 });
    }
    const bucket = byPhase.get(f.phase)!;
    const parsed = await parsePhaseCost(f.path);
    bucket.attempts++;
    bucket.usd += parsed.usd;
    // "Incomplete" = Anthropic stream started but never produced a
    // `type:"result"`. A file with no Anthropic events at all is a
    // script-only phase and is intentionally `$0`, not partial.
    if (parsed.hasAnthropicEvent && !parsed.hasResult) {
      bucket.incompleteAttempts++;
    }
  }

  let total = 0;
  let partial = false;
  const phases: PhaseAggregate[] = order.map((name) => {
    const b = byPhase.get(name)!;
    total += b.usd;
    const p = b.incompleteAttempts > 0;
    if (p) partial = true;
    return { name, attempts: b.attempts, usd: b.usd, partial: p };
  });
  return { total, partial, phases };
}
