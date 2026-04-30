import fsp from "node:fs/promises";
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
}

export interface PhaseAggregate {
  name: string;
  attempts: number;
  usd: number;
  // True iff *any* file under this phase reported `hasResult === false`.
  // Per the PRD this is "incomplete log" — the partial flag never
  // propagates up to the task-level aggregate unless every phase reports
  // it; the task-level `partial` is true if *any* phase is partial.
  partial: boolean;
}

export interface TaskCost {
  total: number;
  partial: boolean;
  phases: PhaseAggregate[];
}

export async function parsePhaseCost(filePath: string): Promise<PhaseCostFile> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return { usd: 0, hasResult: false };
  }
  let usd = 0;
  let hasResult = false;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const ev = obj as Record<string, unknown>;
    if (ev["type"] !== "result") continue;
    hasResult = true;
    const cost = ev["total_cost_usd"];
    if (typeof cost === "number" && Number.isFinite(cost)) usd += cost;
  }
  return { usd, hasResult };
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
    { attempts: number; usd: number; missingResultCount: number }
  >();
  for (const f of files) {
    if (!byPhase.has(f.phase)) {
      order.push(f.phase);
      byPhase.set(f.phase, { attempts: 0, usd: 0, missingResultCount: 0 });
    }
    const bucket = byPhase.get(f.phase)!;
    const parsed = await parsePhaseCost(f.path);
    bucket.attempts++;
    bucket.usd += parsed.usd;
    if (!parsed.hasResult) bucket.missingResultCount++;
  }

  let total = 0;
  let partial = false;
  const phases: PhaseAggregate[] = order.map((name) => {
    const b = byPhase.get(name)!;
    total += b.usd;
    const p = b.missingResultCount > 0;
    if (p) partial = true;
    return { name, attempts: b.attempts, usd: b.usd, partial: p };
  });
  return { total, partial, phases };
}
