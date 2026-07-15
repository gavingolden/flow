/**
 * Attributes a pipeline's context/token spend to pipeline phase and to
 * tool-call class, from Claude Code session JSONL. Companion to
 * `cost.ts`'s $-only rollup: this module answers *where* the spend went,
 * not just how much it cost.
 *
 * Reuses `cost.ts`'s session-discovery (`encodeProjectSegment`,
 * `findSessionJsonls`) and `message.usage` field names rather than
 * re-deriving them.
 *
 * Schema-break contract: `message.usage` is per-turn, and per-tool-class
 * numbers are therefore an injected-payload-size proxy, never a fabricated
 * per-class token split (see docs/context-economy-audit.md for the full
 * method). If a transcript's shape no longer matches what this module
 * expects (a renamed/missing `message.usage` field, an unexpected
 * `attributionSkill` type), `analyzeTranscripts` returns
 * `{ status: "schema-break" }` rather than silently emitting a
 * partial or wrong aggregate — see `checkSchemaShape`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  defaultProjectsRoot,
  encodeProjectSegment,
  findSessionJsonls,
} from "./cost";

export type Phase =
  | "supervisor"
  | "plan"
  | "implement"
  | "verify"
  | "review"
  | "unattributed";

export type ToolClass =
  | "edit"
  | "diff"
  | "verify-log"
  | "skill-body"
  | "sub-agent-return"
  | "other";

export type UsageTotals = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
};

export type ToolClassStats = {
  count: number;
  payloadChars: number;
};

export type SubAgentSpend = {
  completedCount: number;
  /** Backgrounded (`status: "async_launched"`) Agent/Task calls whose
   * spend is not yet observable in this transcript — kept distinct from
   * zero rather than silently folded into it. */
  pendingAsyncCount: number;
  totalTokens: number;
};

export type EditSizeDistribution = {
  count: number;
  min: number;
  median: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
};

export type FrontmatterEstimate = {
  perSkill: Record<string, number>;
  total: number;
  charsPerToken: number;
};

export type AnalyzeOk = {
  status: "ok";
  /** Strict headline: null-attribution records land in "unattributed",
   * never silently carried onto the preceding skill. */
  phaseTotals: Record<Phase, UsageTotals>;
  /** Secondary, clearly-labelled disclosure view: null-attribution
   * records inherit the previous attributed record's phase. */
  carryForwardTotals: Record<Phase, UsageTotals>;
  toolClassStats: Record<ToolClass, ToolClassStats>;
  subAgentSpend: SubAgentSpend;
  editSizeDistribution: EditSizeDistribution;
};

export type AnalyzeResult =
  | AnalyzeOk
  | { status: "no-data" }
  | { status: "schema-break"; reason: string };

const PHASES: Phase[] = [
  "supervisor",
  "plan",
  "implement",
  "verify",
  "review",
  "unattributed",
];

const TOOL_CLASSES: ToolClass[] = [
  "edit",
  "diff",
  "verify-log",
  "skill-body",
  "sub-agent-return",
  "other",
];

const SKILL_TO_PHASE: Record<string, Phase> = {
  "flow-pipeline": "supervisor",
  "flow-product-planning": "plan",
  "flow-new-feature": "implement",
  "flow-coder": "implement",
  "flow-verify": "verify",
  "flow-pr-review": "review",
};

/** Anthropic ships no offline Claude tokenizer; this is a documented
 * floor, not a point estimate — structural YAML and dense logs tokenize
 * denser than prose, so a flat divisor under-counts exactly those
 * classes. See docs/context-economy-audit.md. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

type RawRecord = Record<string, unknown>;

export async function resolveSessionJsonls(
  slug: string,
  repoAbsPath: string,
  projectsRoot = defaultProjectsRoot(),
): Promise<string[]> {
  const projectDir = path.join(projectsRoot, encodeProjectSegment(repoAbsPath));
  return findSessionJsonls(projectDir, slug);
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function emptyPhaseTotals(): Record<Phase, UsageTotals> {
  const out = {} as Record<Phase, UsageTotals>;
  for (const p of PHASES) out[p] = emptyUsage();
  return out;
}

function emptyToolClassStats(): Record<ToolClass, ToolClassStats> {
  const out = {} as Record<ToolClass, ToolClassStats>;
  for (const c of TOOL_CLASSES) out[c] = { count: 0, payloadChars: 0 };
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function addUsage(totals: UsageTotals, usage: RawRecord): void {
  totals.input += num(usage.input_tokens);
  totals.output += num(usage.output_tokens);
  totals.cacheCreation += num(usage.cache_creation_input_tokens);
  totals.cacheRead += num(usage.cache_read_input_tokens);
}

function mergeUsageInto(target: UsageTotals, src: UsageTotals): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheCreation += src.cacheCreation;
  target.cacheRead += src.cacheRead;
}

async function readLines(file: string): Promise<string[]> {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream });
  const lines: string[] = [];
  try {
    for await (const line of rl) {
      if (line) lines.push(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return lines;
}

function tryParse(line: string): RawRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as RawRecord)
      : null;
  } catch {
    return null;
  }
}

const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

/**
 * Narrow, conservative schema-shape guard: fires only when a record looks
 * like it's trying to be a known shape but has none of the expected
 * sub-fields. Absence of optional structure (no Agent calls this session,
 * no attributionSkill at all) is normal variation, not a break.
 */
function checkSchemaShape(record: RawRecord): string | null {
  if (record.type === "assistant") {
    const message = record.message;
    if (message && typeof message === "object") {
      const usage = (message as RawRecord).usage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const u = usage as RawRecord;
        if (!USAGE_FIELDS.some((k) => k in u)) {
          return "assistant record's message.usage is present but has none of the expected fields (input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens) — the JSONL schema may have changed and this tool needs a feature update to support it";
        }
      }
    }
  }
  if ("attributionSkill" in record) {
    const a = record.attributionSkill;
    if (a !== null && a !== undefined && typeof a !== "string") {
      return `attributionSkill field has unexpected type '${typeof a}' (expected string or null) — the JSONL schema may have changed and this tool needs a feature update to support it`;
    }
  }
  return null;
}

type FileAnalysis = {
  phaseTotals: Record<Phase, UsageTotals>;
  carryForwardTotals: Record<Phase, UsageTotals>;
  toolClassStats: Record<ToolClass, ToolClassStats>;
  subAgentSpend: SubAgentSpend;
  editSamples: number[];
  sawAnyData: boolean;
};

type FileResult = FileAnalysis | { schemaBreak: string };

async function analyzeOneFile(file: string): Promise<FileResult> {
  const lines = await readLines(file);
  const records: RawRecord[] = [];
  for (const line of lines) {
    const parsed = tryParse(line);
    if (!parsed) continue; // a lone unparseable line (e.g. a crash-truncated tail) isn't proof of schema drift
    const shapeIssue = checkSchemaShape(parsed);
    if (shapeIssue)
      return { schemaBreak: `${path.basename(file)}: ${shapeIssue}` };
    records.push(parsed);
  }

  const phaseTotals = emptyPhaseTotals();
  const carryForwardTotals = emptyPhaseTotals();
  const toolClassStats = emptyToolClassStats();
  const subAgentSpend: SubAgentSpend = {
    completedCount: 0,
    pendingAsyncCount: 0,
    totalTokens: 0,
  };
  const editSamples: number[] = [];
  let sawAnyData = false;
  let lastAttributedPhase: Phase | null = null;

  for (const record of records) {
    if (record.type !== "assistant") continue;
    const message = record.message as RawRecord | undefined;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object") continue;
    sawAnyData = true;

    const attribution = record.attributionSkill;
    const phase: Phase =
      typeof attribution === "string" && attribution in SKILL_TO_PHASE
        ? SKILL_TO_PHASE[attribution]
        : "unattributed";
    addUsage(phaseTotals[phase], usage as RawRecord);

    const carryPhase: Phase =
      phase !== "unattributed"
        ? phase
        : (lastAttributedPhase ?? "unattributed");
    addUsage(carryForwardTotals[carryPhase], usage as RawRecord);
    if (phase !== "unattributed") lastAttributedPhase = phase;
  }

  const pendingToolUses = new Map<string, { name: string; input: RawRecord }>();
  let awaitingSkillBody = false;

  for (const record of records) {
    if (record.type === "assistant") {
      const message = record.message as RawRecord | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            (block as RawRecord).type === "tool_use"
          ) {
            const b = block as RawRecord;
            const id = String(b.id ?? "");
            if (id) {
              pendingToolUses.set(id, {
                name: String(b.name ?? ""),
                input: (b.input as RawRecord) ?? {},
              });
            }
          }
        }
      }
      continue;
    }

    if (record.type !== "user") {
      awaitingSkillBody = false;
      continue;
    }

    // Skill-body structural adjacency: the record immediately after a
    // Skill tool_result carries the real skill-body text as a single
    // text-only content block (the Skill tool_result itself is a ~30-char
    // launch stub — see the "Don't classify skill-body from the Skill
    // tool's own result" anti-pattern in scout.md).
    if (awaitingSkillBody) {
      awaitingSkillBody = false;
      const message = record.message as RawRecord | undefined;
      const content = message?.content;
      if (
        Array.isArray(content) &&
        content.length === 1 &&
        content[0] &&
        typeof content[0] === "object" &&
        (content[0] as RawRecord).type === "text"
      ) {
        const text = String((content[0] as RawRecord).text ?? "");
        toolClassStats["skill-body"].count++;
        toolClassStats["skill-body"].payloadChars += text.length;
        sawAnyData = true;
        continue;
      }
    }

    const message = record.message as RawRecord | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as RawRecord;
      if (b.type !== "tool_result") continue;
      const toolUseId = String(b.tool_use_id ?? "");
      const pending = pendingToolUses.get(toolUseId);
      if (!pending) continue;
      pendingToolUses.delete(toolUseId);
      sawAnyData = true;

      const toolUseResult = record.toolUseResult as RawRecord | undefined;
      const resultContent = b.content;
      const resultChars =
        typeof resultContent === "string"
          ? resultContent.length
          : JSON.stringify(resultContent ?? "").length;

      switch (pending.name) {
        case "Edit":
        case "Write": {
          const stats = toolClassStats["edit"];
          stats.count++;
          let added = 0;
          let removed = 0;
          if (toolUseResult && toolUseResult.type === "create") {
            const createdContent = toolUseResult.content;
            if (typeof createdContent === "string") {
              added =
                createdContent.length === 0
                  ? 0
                  : createdContent.split("\n").length;
              stats.payloadChars += createdContent.length;
            }
          } else if (
            toolUseResult &&
            Array.isArray(toolUseResult.structuredPatch)
          ) {
            for (const hunk of toolUseResult.structuredPatch) {
              const hunkLines = (hunk as RawRecord)?.lines;
              if (!Array.isArray(hunkLines)) continue;
              for (const l of hunkLines) {
                if (typeof l !== "string") continue;
                if (l.startsWith("+")) added++;
                else if (l.startsWith("-")) removed++;
                stats.payloadChars += l.length;
              }
            }
          }
          editSamples.push(added + removed);
          break;
        }
        case "Bash": {
          const command = String(pending.input.command ?? "");
          const cls: ToolClass = /\bgit\s+(diff|show|status|log)\b/.test(
            command,
          )
            ? "diff"
            : /\b(flow-pre-commit|vitest|npm run (test|verify)|bun\s+\S*\.test\.ts)\b/.test(
                  command,
                )
              ? "verify-log"
              : "other";
          toolClassStats[cls].count++;
          toolClassStats[cls].payloadChars += resultChars;
          break;
        }
        case "Read": {
          const filePath = String(pending.input.file_path ?? "");
          const cls: ToolClass = /SKILL\.md$|AGENTS\.md$/.test(filePath)
            ? "skill-body"
            : "other";
          toolClassStats[cls].count++;
          toolClassStats[cls].payloadChars += resultChars;
          break;
        }
        case "Skill": {
          awaitingSkillBody = true;
          break;
        }
        case "Agent":
        case "Task": {
          const stats = toolClassStats["sub-agent-return"];
          stats.count++;
          const status = toolUseResult?.status;
          if (status === "completed") {
            subAgentSpend.completedCount++;
            subAgentSpend.totalTokens += num(toolUseResult?.totalTokens);
            const returnContent = toolUseResult?.content;
            if (Array.isArray(returnContent)) {
              for (const c of returnContent) {
                const t = (c as RawRecord)?.text;
                if (typeof t === "string") stats.payloadChars += t.length;
              }
            }
          } else {
            subAgentSpend.pendingAsyncCount++;
          }
          break;
        }
        default: {
          toolClassStats["other"].count++;
          toolClassStats["other"].payloadChars += resultChars;
        }
      }
    }
  }

  return {
    phaseTotals,
    carryForwardTotals,
    toolClassStats,
    subAgentSpend,
    editSamples,
    sawAnyData,
  };
}

function computeDistribution(samples: number[]): EditSizeDistribution {
  if (samples.length === 0) {
    return { count: 0, min: 0, median: 0, max: 0, p50: 0, p90: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[idx];
  };
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(50),
    max: sorted[sorted.length - 1],
    p50: percentile(50),
    p90: percentile(90),
    p99: percentile(99),
  };
}

export async function analyzeTranscripts(
  jsonlPaths: string[],
): Promise<AnalyzeResult> {
  const phaseTotals = emptyPhaseTotals();
  const carryForwardTotals = emptyPhaseTotals();
  const toolClassStats = emptyToolClassStats();
  const subAgentSpend: SubAgentSpend = {
    completedCount: 0,
    pendingAsyncCount: 0,
    totalTokens: 0,
  };
  const editSamples: number[] = [];
  let sawAnyData = false;

  const perFileResults = await Promise.all(jsonlPaths.map(analyzeOneFile));

  for (const result of perFileResults) {
    if ("schemaBreak" in result) {
      return { status: "schema-break", reason: result.schemaBreak };
    }
    for (const p of PHASES) {
      mergeUsageInto(phaseTotals[p], result.phaseTotals[p]);
      mergeUsageInto(carryForwardTotals[p], result.carryForwardTotals[p]);
    }
    for (const c of TOOL_CLASSES) {
      toolClassStats[c].count += result.toolClassStats[c].count;
      toolClassStats[c].payloadChars += result.toolClassStats[c].payloadChars;
    }
    subAgentSpend.completedCount += result.subAgentSpend.completedCount;
    subAgentSpend.pendingAsyncCount += result.subAgentSpend.pendingAsyncCount;
    subAgentSpend.totalTokens += result.subAgentSpend.totalTokens;
    editSamples.push(...result.editSamples);
    if (result.sawAnyData) sawAnyData = true;
  }

  if (!sawAnyData) return { status: "no-data" };

  return {
    status: "ok",
    phaseTotals,
    carryForwardTotals,
    toolClassStats,
    subAgentSpend,
    editSizeDistribution: computeDistribution(editSamples),
  };
}

async function findSkillMdFiles(root: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push(...(await findSkillMdFiles(full)));
    } else if (e.isFile() && e.name === "SKILL.md") {
      out.push(full);
    }
  }
  return out;
}

function extractFrontmatter(raw: string): string | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

export async function estimateFrontmatterCost(
  skillsDir: string,
): Promise<FrontmatterEstimate> {
  const skillFiles = await findSkillMdFiles(skillsDir);
  const perSkill: Record<string, number> = {};
  let total = 0;
  for (const file of skillFiles) {
    const raw = await fs.promises.readFile(file, "utf8");
    const frontmatter = extractFrontmatter(raw);
    if (frontmatter === null) continue;
    const tokens = estimateTokens(frontmatter.length);
    const name = path.basename(path.dirname(file));
    perSkill[name] = (perSkill[name] ?? 0) + tokens;
    total += tokens;
  }
  return { perSkill, total, charsPerToken: CHARS_PER_TOKEN };
}
