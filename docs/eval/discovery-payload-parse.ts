// Pure parsing and statistics for docs/eval/discovery-payload.ts. Standalone
// on purpose: no bin/lib imports, so it runs on any checkout. Pricing comes
// from the sibling token-spend-audit.ts so dollars never diverge from it.
import { basename } from "path";
import { priceTurn, PRICING_DATE } from "./token-spend-audit";

export { PRICING_DATE };
export const DEFAULT_INSTRUCTIONS = [
  "discovery-instructions.md",
  "discovery-research.md",
  "discovery-ui.md",
  "discovery-revision.md",
  "discovery-survey-epic.md",
  "discovery-prompt-interpretation.md",
];
export const SIBLING_REFS = [
  "prd-template.md",
  "architecture-patterns.md",
  "discovery-playbook.md",
  "example-prd.md",
];

export type SpawnPayload = {
  model: string;
  mode: "feature" | "revision" | "epic";
  firstContext: number;
  firstWrite: number;
  taskTextChars: number;
  instructionTokens: number;
  instructionChunks: number;
  turnsAfterInstructions: number;
  referencesRead: string[];
  usd: number;
};

export const blocks = (row: any): any[] =>
  Array.isArray(row?.message?.content) ? row.message.content : [];
export const textOf = (row: any): string => {
  const c = row?.message?.content;
  if (typeof c === "string") return c;
  return blocks(row)
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
};
const isReference = (name: string) =>
  /^discovery-.*\.md$/.test(name) || SIBLING_REFS.includes(name);

export function measureSpawn(
  rows: unknown[],
  opts: { instructionNames?: string[] } = {},
): SpawnPayload | null {
  const names = new Set(
    (opts.instructionNames ?? DEFAULT_INSTRUCTIONS).map((n) => basename(n)),
  );
  const reqs = new Map<string, { model: string; usage: any }>();
  const instrIds = new Set<string>();
  const bashIds = new Set<string>();
  const instrReqs = new Set<string>();
  const refs: string[] = [];
  let firstUser: string | null = null;
  let firstReq: string | null = null;
  let pending = false;
  let spillArmed = false;
  let chunks = 0;
  let after = new Set<string>();
  rows.forEach((r: any, i) => {
    if (r?.type === "user") {
      if (firstUser === null) {
        const t = textOf(r);
        if (t && !blocks(r).some((b) => b?.type === "tool_result"))
          firstUser = t;
      }
      spillArmed = false;
      for (const b of blocks(r)) {
        if (b?.type === "tool_result" && instrIds.has(b.tool_use_id)) {
          chunks++;
          pending = true;
          after = new Set();
          if (bashIds.has(b.tool_use_id)) spillArmed = true;
        }
      }
      return;
    }
    if (r?.type !== "assistant" || !r.message?.usage) return;
    if (r.message.model === "<synthetic>") return;
    const id = String(r.message.id ?? r.uuid ?? `row-${i}`);
    if (!reqs.has(id)) {
      firstReq ??= id;
      if (pending) instrReqs.add(id);
      pending = false;
    }
    reqs.set(id, {
      model: r.message.model || "unknown",
      usage: r.message.usage,
    });
    after.add(id);
    for (const b of blocks(r)) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "Bash") {
        const cmd = String(b.input?.command ?? "");
        const words = cmd.split(/[\s'";|&()<>]+/).map((w) => basename(w));
        if (words.some((w) => names.has(w))) {
          instrIds.add(b.id);
          bashIds.add(b.id);
        }
        for (const w of words)
          if (isReference(w) && !refs.includes(w)) refs.push(w);
        continue;
      }
      if (b.name !== "Read") continue;
      const path = String(b.input?.file_path ?? "");
      const file = basename(path);
      if (names.has(file)) instrIds.add(b.id);
      else if (spillArmed && path.includes("/tool-results/")) {
        instrIds.add(b.id);
        spillArmed = false;
      }
      if (isReference(file) && !refs.includes(file)) refs.push(file);
    }
  });
  if (firstReq === null) return null;
  const first = reqs.get(firstReq)!.usage;
  const write = (u: any) => u?.cache_creation_input_tokens || 0;
  const text: string = firstUser ?? "";
  let usd = 0;
  for (const { model, usage } of reqs.values()) usd += priceTurn(usage, model);
  return {
    model: reqs.get(firstReq)!.model,
    mode: text.includes("REVISION:")
      ? "revision"
      : /Read the full instructions at:\s*\S*epic-discovery-instructions\.md/.test(
            text,
          )
        ? "epic"
        : "feature",
    firstContext:
      (first.input_tokens || 0) +
      (first.cache_read_input_tokens || 0) +
      write(first),
    firstWrite: write(first),
    taskTextChars: text.length,
    instructionTokens: [...instrReqs].reduce(
      (s, id) => s + write(reqs.get(id)!.usage),
      0,
    ),
    instructionChunks: chunks,
    turnsAfterInstructions: chunks ? after.size : 0,
    referencesRead: refs,
    usd,
  };
}

export const METRICS = [
  "firstContext",
  "firstWrite",
  "taskTextChars",
  "instructionTokens",
  "instructionChunks",
  "turnsAfterInstructions",
  "usd",
] as const;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(spawns: SpawnPayload[]) {
  const median: Record<string, number> = {};
  const p25: Record<string, number> = {};
  const p75: Record<string, number> = {};
  for (const m of METRICS) {
    const v = spawns.map((s) => s[m]).sort((a, b) => a - b);
    median[m] = quantile(v, 0.5);
    p25[m] = quantile(v, 0.25);
    p75[m] = quantile(v, 0.75);
  }
  const by: Record<string, number[]> = {};
  for (const s of spawns) (by[s.model] ||= []).push(s.usd);
  const usdPerRunByModel: Record<string, number> = {};
  for (const [m, v] of Object.entries(by))
    usdPerRunByModel[m] = v.reduce((a, b) => a + b, 0) / v.length;
  return { median, p25, p75, usdPerRunByModel };
}

export function sectionSizes(markdown: string) {
  const out: { heading: string; chars: number }[] = [];
  let fence = 0;
  for (const line of markdown.split("\n")) {
    const f = line.match(/^\s*(`{3,})(.*)$/);
    if (f) {
      if (!fence) fence = f[1].length;
      else if (f[1].length >= fence && f[2].trim() === "") fence = 0;
    }
    const h = !fence && !f && line.match(/^#{1,6}\s+(.*)$/);
    if (h) out.push({ heading: line.trim(), chars: 0 });
    if (out.length) out[out.length - 1].chars += line.length + 1;
  }
  return out;
}

export function referenceOpenRates(
  spawns: { referencesRead: string[] }[],
  references: string[],
): Record<string, { opened: number; total: number }> {
  const out: Record<string, { opened: number; total: number }> = {};
  for (const r of references)
    out[r] = {
      opened: spawns.filter((s) => s.referencesRead.includes(r)).length,
      total: spawns.length,
    };
  return out;
}
