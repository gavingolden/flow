// Pure parsing for docs/eval/supervisor-skill-payload.ts. Standalone: no
// bin/lib imports, so it runs on any checkout. Transcript parsing is reused
// from supervisor-turns.ts (session detection, turn segmentation).
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { segmentSession } from "./supervisor-turns";

export type SessionStats = {
  skillLoads: number;
  loadDeltaTokens: number[];
  compactions: number;
  reattachChars: number[];
  docReads: Record<string, number>;
  phasesReached: string[];
  turns: number;
  reloadedAfterCompaction: boolean;
};

const skillBase = (s: string) => s.replace(/^(?:plugin:)?[a-z0-9-]+:/, "");
const DOC = /\/flow-pipeline\/(SKILL\.md|references\/.+\.md)$/;
const PHASE = /flow-state-update\b[^\n;&|]*?--phase[ =]+([a-z0-9.-]+)/g;
const ctxOf = (u: any) =>
  (u?.cache_read_input_tokens || 0) +
  (u?.cache_creation_input_tokens || 0) +
  (u?.input_tokens || 0);

// Claude Code writes one JSONL line per content block of an API request, so a
// request's usage is on its LAST line. Loads are measured as the context of
// the request after the skill body arrived minus the request that called Skill.
export function analyzeSession(lines: string[]): SessionStats {
  const out: SessionStats = {
    skillLoads: 0,
    loadDeltaTokens: [],
    compactions: 0,
    reattachChars: [],
    docReads: {},
    phasesReached: [],
    turns: 0,
    reloadedAfterCompaction: false,
  };
  const ctx: number[] = [];
  const idx = new Map<string, number>();
  const loadAt: number[] = [];
  for (const l of lines) {
    let j: any;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j?.type === "system" && j.subtype === "compact_boundary")
      out.compactions++;
    if (j?.type === "attachment" && j.attachment?.type === "invoked_skills")
      for (const s of j.attachment.skills ?? [])
        if (skillBase(String(s.name)) === "flow-pipeline")
          out.reattachChars.push(String(s.content ?? "").length);
    if (j?.type !== "assistant" || j.message?.model === "<synthetic>") continue;
    const id = String(j.message?.id ?? j.uuid ?? l);
    if (!idx.has(id)) idx.set(id, ctx.push(0) - 1);
    if (j.message?.usage) ctx[idx.get(id)!] = ctxOf(j.message.usage);
    for (const b of Array.isArray(j.message?.content)
      ? j.message.content
      : []) {
      if (b?.type !== "tool_use") continue;
      const after = out.compactions > 0;
      if (
        b.name === "Skill" &&
        skillBase(String(b.input?.skill)) === "flow-pipeline"
      ) {
        out.skillLoads++;
        loadAt.push(idx.get(id)!);
        if (after) out.reloadedAfterCompaction = true;
      }
      const m = b.name === "Read" && DOC.exec(String(b.input?.file_path ?? ""));
      if (m) {
        out.docReads[m[1]] = (out.docReads[m[1]] ?? 0) + 1;
        if (after) out.reloadedAfterCompaction = true;
      }
    }
  }
  for (const i of loadAt)
    if (ctx[i + 1] && ctx[i]) out.loadDeltaTokens.push(ctx[i + 1] - ctx[i]);
  const turns = segmentSession(lines, 0);
  out.turns = turns.length;
  const seen = new Set<string>();
  for (const cmd of turns.flatMap((t) => t.bashCommands))
    for (const m of cmd.matchAll(PHASE)) seen.add(m[1]);
  out.phasesReached = [...seen];
  return out;
}

export type StaticSizes = {
  coreChars: number;
  docs: Record<string, number>;
  residentAtStep: Record<string, number>;
};

const mdFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? mdFiles(join(dir, e.name)).map((f) => join(e.name, f))
          : e.name.endsWith(".md")
            ? [e.name]
            : [],
      )
    : [];

const byStep = (r: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(r).sort((a, b) => Number(a[0]) - Number(b[0])),
  );

// Happy-path resident text at the entry to each step: the core plus every
// phase doc a dispatch row at or before that step names. An unsplit tree has
// no dispatch table, so the whole file is resident from the first turn.
export function staticSizes(skillDir: string): StaticSizes {
  const core = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const docs: Record<string, number> = {};
  for (const f of mdFiles(join(skillDir, "references")))
    docs[`references/${f}`] = readFileSync(
      join(skillDir, "references", f),
      "utf8",
    ).length;
  const resident: Record<string, number> = {};
  const rows = core
    .split("\n")
    .filter((l) => l.startsWith("|") && l.includes("references/phases/"));
  if (!rows.length) {
    for (const m of core.matchAll(/^## Step (\d+(?:\.\d+)?)/gm))
      resident[m[1]] = core.length;
    return { coreChars: core.length, docs, residentAtStep: byStep(resident) };
  }
  const parsed = rows.map((r) => ({
    step: Number(/(\d+(?:\.\d+)?)/.exec(r.split("|")[1] ?? "")?.[1] ?? NaN),
    docs: [
      ...r.matchAll(/references\/phases\/[\w.-]+\.md/g),
      // A dispatch row may name its second doc by bare file name; resolve it
      // against references/phases/ like the full-path form.
      ...(r.split("|")[4] ?? "").matchAll(/`(?!references\/)([\w.-]+\.md)`/g),
    ].map((m) => (m[1] ? `references/phases/${m[1]}` : m[0])),
  }));
  for (const { step } of parsed.filter((p) => !Number.isNaN(p.step))) {
    const open = new Set(
      parsed.filter((p) => p.step <= step).flatMap((p) => p.docs),
    );
    resident[String(step)] =
      core.length + [...open].reduce((n, d) => n + (docs[d] ?? 0), 0);
  }
  return { coreChars: core.length, docs, residentAtStep: byStep(resident) };
}
