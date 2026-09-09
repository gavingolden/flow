/**
 * Pure, spawn-free judge library backing `flow-explain-judge` — the
 * advisory PM-readability check the PR-body site
 * (`skills/pipeline/flow-pipeline/SKILL.md` Step 5) shells out to.
 *
 * This module never imports `node:child_process` and never calls
 * `Bun.spawn`/`Bun.spawnSync` itself: the real headless-child spawn is
 * injected via `Deps.runHeadless`, mirroring `bin/lib/claude-headless.ts`'s
 * own spawn-free discipline (the concrete spawn lives in the sibling
 * `bin/flow-explain-judge.ts` CLI, exactly as `bin/flow-claude-headless.ts`
 * supplies `bin/lib/claude-headless.ts`'s real `runClaude`). The judge
 * itself is the ONE downstream consumer of `flow-claude-headless`, never a
 * second raw `claude -p` site.
 */

import * as fs from "node:fs";
import { resolveProductBrief, type ProductBrief } from "../flow-product-brief";
import type { Effort } from "./claude-headless";

export const JUDGE_MODEL = "sonnet";
export const JUDGE_EFFORT: Effort = "low";
export const JUDGE_MAX_BUDGET_USD = 0.25;
export const JUDGE_TIMEOUT_SEC = 120;
export const JUDGE_TEXT_CHAR_CAP = 12000;

export const JUDGE_RUBRIC =
  "You are judging whether a piece of writing is readable by a product manager who has never opened the code. Ask yourself: could a reader who has not opened the code understand the consequence and act on this? Reject writing that leads with file names, function names, line numbers, or diff mechanics instead of the user-visible consequence — a rewrite verdict, not a pass, whenever mechanism substitutes for consequence.";

export type JudgeArgs = {
  textFile: string;
  site: string;
  maxBudgetUsd: number;
  sections?: string[];
  expect?: "pass" | "rewrite";
  model: string;
  effort: Effort;
};

export function parseArgs(argv: string[]): JudgeArgs | { error: string } {
  const out: Partial<JudgeArgs> = {};
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      return { error: `missing value for ${flag}` };
    }
    switch (flag) {
      case "--text-file":
        out.textFile = value;
        break;
      case "--site":
        out.site = value;
        break;
      case "--max-budget-usd": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return { error: `--max-budget-usd must be a number, got ${value}` };
        }
        out.maxBudgetUsd = n;
        break;
      }
      case "--sections":
        out.sections = value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      case "--expect":
        if (value !== "pass" && value !== "rewrite") {
          return { error: "--expect must be one of pass|rewrite" };
        }
        out.expect = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i += 2;
  }

  if (!out.textFile) {
    return { error: "--text-file is required" };
  }
  if (!out.site) {
    return { error: "--site is required" };
  }

  return {
    textFile: out.textFile,
    site: out.site,
    maxBudgetUsd: out.maxBudgetUsd ?? JUDGE_MAX_BUDGET_USD,
    sections: out.sections,
    expect: out.expect,
    model: JUDGE_MODEL,
    effort: JUDGE_EFFORT,
  };
}

/**
 * Tolerant `product.judge` read, mirroring `readTolerantBool` in
 * `bin/flow-review-scope.ts:282-295` (not exported there — re-implemented
 * here rather than imported). Absent file, malformed JSON, `product: null`,
 * and a missing key are all read as ENABLED — only a strict `false` opts
 * out.
 */
export function readJudgeEnabled(
  readFile: (p: string) => string | null,
): boolean {
  const raw = readFile("config");
  if (raw === null) return true;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.product?.judge !== false;
  } catch {
    return true;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * For each heading, matches case-insensitively at `##` or `###` depth,
 * takes the LAST occurrence, and slices from that heading line to the next
 * line matching `^#{2,3} ` (or EOF). Returns the concatenation in the
 * order the headings were given, or `null` when ANY heading is absent —
 * deliberately no full-body fallback, since the skip is itself a signal.
 */
export function extractSections(
  text: string,
  headings: string[],
): string | null {
  const lines = text.split("\n");
  const sections: string[] = [];
  for (const rawHeading of headings) {
    const bare = rawHeading.replace(/^#{1,6}\s*/, "").trim();
    const headingRe = new RegExp(`^#{2,3}\\s+${escapeRegExp(bare)}\\s*$`, "i");
    let lastIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (headingRe.test(lines[i])) lastIdx = i;
    }
    if (lastIdx === -1) return null;
    let endIdx = lines.length;
    for (let i = lastIdx + 1; i < lines.length; i++) {
      if (/^#{2,3}\s+/.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    sections.push(lines.slice(lastIdx, endIdx).join("\n").trim());
  }
  return sections.join("\n\n");
}

/** Head/tail-safe truncation at `JUDGE_TEXT_CHAR_CAP` by default. */
export function capText(
  text: string,
  cap: number = JUDGE_TEXT_CHAR_CAP,
): string {
  if (text.length <= cap) return text;
  const marker = "\n\n… [truncated for judge budget] …\n\n";
  const keep = Math.max(0, cap - marker.length);
  const headLen = Math.ceil(keep / 2);
  const tailLen = keep - headLen;
  return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
}

const RANKED_PRIORITIES_PHRASE = "ranked priorities";

/**
 * Builds the judge prompt. Byte-identical to the fixed generic rubric when
 * `brief.found` is false — this is the load-bearing property (mirrors
 * `renderProductBriefBlock` in `bin/lib/plan-review-prompt.ts` returning ""
 * when absent).
 */
export function buildPrompt(text: string, brief: ProductBrief): string {
  const briefBlock = brief.found
    ? `\n\n<PRODUCT_BRIEF>\n${brief.text}\n</PRODUCT_BRIEF>\n\nWeigh the text below against this product brief's ${RANKED_PRIORITIES_PHRASE} and its Use/Avoid vocabulary — a pass that satisfies a lower priority while under-serving a higher-ranked one is still a rewrite.`
    : "";
  return (
    `${JUDGE_RUBRIC}${briefBlock}\n\n` +
    `Reply with EXACTLY one JSON object of the shape {"verdict":"pass"|"rewrite","reasons":["..."]} and nothing else — no prose before or after it, no markdown fence.\n\n` +
    `<TEXT_TO_JUDGE>\n${text}\n</TEXT_TO_JUDGE>`
  );
}

/** Tolerant of surrounding prose and ```json fences; null on no valid object. */
export function parseVerdict(
  result: string,
): { verdict: "pass" | "rewrite"; reasons: string[] } | null {
  if (typeof result !== "string") return null;
  let candidate = result.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(first, last + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.verdict !== "pass" && obj.verdict !== "rewrite") return null;
  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.filter((r): r is string => typeof r === "string")
    : [];
  return { verdict: obj.verdict, reasons };
}

export type JudgeEnvelope =
  | {
      ran: true;
      verdict: "pass" | "rewrite";
      reasons: string[];
      site: string;
      model: string;
      effort: Effort;
      total_cost_usd: number;
      brief: "repo" | "user" | "none";
    }
  | {
      ran: false;
      site: string;
      skipReason: string;
      error?: string;
    };

export type Deps = {
  readFile: (p: string) => string | null;
  fileExists: (p: string) => boolean;
  readConfig: () => string | null;
  resolveBrief: () => ProductBrief;
  runHeadless: (
    argv: string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string }>;
  mkdtemp: () => string;
  removeDir: (dir: string) => void;
  env: NodeJS.ProcessEnv;
  writeOut: (line: string) => void;
  record: (attrs: Record<string, unknown>) => void;
};

export function exitCodeFor(
  envelope: JudgeEnvelope,
  expect?: "pass" | "rewrite",
): number {
  if (expect === undefined) return 0;
  if (!envelope.ran) return 3;
  return envelope.verdict === expect ? 0 : 1;
}

type HeadlessEnvelope = {
  ran?: boolean;
  skipReason?: string;
  error?: string;
  artifact?: string;
  total_cost_usd?: number;
};

function tryParseJson(raw: string): HeadlessEnvelope | null {
  const line = raw.trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as HeadlessEnvelope;
  } catch {
    return null;
  }
}

function dropFlag(argv: string[], flag: string): string[] {
  const idx = argv.indexOf(flag);
  if (idx === -1) return argv;
  return [...argv.slice(0, idx), ...argv.slice(idx + 2)];
}

/**
 * Recovers `--expect` from raw argv independently of `parseArgs`. Both
 * `ran:false` exit paths below (bad-args, and `run()`'s catch-all) fire
 * exactly when the full parse is unavailable or never ran — a raw scan is
 * the point, so grader mode (`--expect pass|rewrite`) still gets its
 * documented exit 3 instead of a false-green 0.
 */
function expectFromArgv(argv: string[]): "pass" | "rewrite" | undefined {
  const idx = argv.indexOf("--expect");
  const v = idx === -1 ? undefined : argv[idx + 1];
  return v === "pass" || v === "rewrite" ? v : undefined;
}

/** Recovers `--site` from raw argv for `run()`'s catch-all, so a throw that
 * fires after a clean parse still reports the real site instead of
 * `"unknown"`. */
function siteFromArgv(argv: string[]): string {
  const idx = argv.indexOf("--site");
  const v = idx === -1 ? undefined : argv[idx + 1];
  return v ?? "unknown";
}

const briefScopeOf = (brief: ProductBrief): "repo" | "user" | "none" =>
  brief.found ? brief.scope : "none";

export async function run(
  argv: string[],
  depsOverride: Partial<Deps> = {},
): Promise<number> {
  const deps: Deps = {
    readFile: () => null,
    fileExists: () => false,
    readConfig: () => null,
    resolveBrief: () => resolveProductBrief(),
    runHeadless: async () => ({ exitCode: 1, stdout: "" }),
    mkdtemp: () => ".",
    removeDir: () => {},
    env: process.env,
    writeOut: (line) => console.log(line),
    record: () => {},
    ...depsOverride,
  };

  try {
    return await runInner(argv, deps);
  } catch (e) {
    const envelope: JudgeEnvelope = {
      ran: false,
      site: siteFromArgv(argv),
      skipReason: "claude-error",
      error: e instanceof Error ? e.message : String(e),
    };
    deps.writeOut(JSON.stringify(envelope));
    deps.record({
      site: envelope.site,
      ran: false,
      skipReason: envelope.skipReason,
      model: JUDGE_MODEL,
      effort: JUDGE_EFFORT,
      text_chars: 0,
      brief_scope: "none",
    });
    return exitCodeFor(envelope, expectFromArgv(argv));
  }
}

async function runInner(argv: string[], deps: Deps): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    const envelope: JudgeEnvelope = {
      ran: false,
      site: "unknown",
      skipReason: "bad-args",
      error: parsed.error,
    };
    deps.writeOut(JSON.stringify(envelope));
    deps.record({
      site: envelope.site,
      ran: false,
      skipReason: "bad-args",
      model: JUDGE_MODEL,
      effort: JUDGE_EFFORT,
      text_chars: 0,
      brief_scope: "none",
    });
    return exitCodeFor(envelope, expectFromArgv(argv));
  }

  const site = parsed.site;

  const emit = (
    envelope: JudgeEnvelope,
    extra: Record<string, unknown> = {},
  ): number => {
    deps.writeOut(JSON.stringify(envelope));
    const attrs: Record<string, unknown> = {
      site,
      ran: envelope.ran,
      model: JUDGE_MODEL,
      effort: JUDGE_EFFORT,
      expect: parsed.expect,
      ...(envelope.ran
        ? {
            verdict: envelope.verdict,
            total_cost_usd: envelope.total_cost_usd,
            reasons_count: envelope.reasons.length,
            brief_scope: envelope.brief,
          }
        : { skipReason: envelope.skipReason }),
      ...extra,
    };
    deps.record(attrs);
    return exitCodeFor(envelope, parsed.expect);
  };

  const enabled = readJudgeEnabled(() => deps.readConfig());
  if (!enabled) {
    return emit(
      { ran: false, site, skipReason: "judge-disabled" },
      { text_chars: 0, brief_scope: "none" },
    );
  }

  if (deps.env.FLOW_HEADLESS_DEPTH) {
    return emit(
      { ran: false, site, skipReason: "headless-depth-exceeded" },
      { text_chars: 0, brief_scope: "none" },
    );
  }

  if (!deps.fileExists(parsed.textFile)) {
    return emit(
      { ran: false, site, skipReason: "text-empty" },
      { text_chars: 0, brief_scope: "none" },
    );
  }

  const raw = deps.readFile(parsed.textFile);
  if (raw === null) {
    return emit(
      { ran: false, site, skipReason: "text-empty" },
      { text_chars: 0, brief_scope: "none" },
    );
  }

  let textToJudge: string;
  if (parsed.sections && parsed.sections.length > 0) {
    const extracted = extractSections(raw, parsed.sections);
    if (extracted === null) {
      return emit(
        { ran: false, site, skipReason: "sections-not-found" },
        { text_chars: 0, brief_scope: "none" },
      );
    }
    textToJudge = extracted;
  } else {
    textToJudge = raw;
  }

  if (textToJudge.trim() === "") {
    return emit(
      { ran: false, site, skipReason: "text-empty" },
      { text_chars: 0, brief_scope: "none" },
    );
  }

  const capped = capText(textToJudge, JUDGE_TEXT_CHAR_CAP);
  const brief = deps.resolveBrief();
  const prompt = buildPrompt(capped, brief);
  const briefScope = briefScopeOf(brief);

  const cwd = deps.mkdtemp();
  try {
    const promptPath = `${cwd}/prompt.txt`;
    const outPath = `${cwd}/result.json`;
    try {
      fs.writeFileSync(promptPath, prompt, "utf8");
    } catch {
      // The spawn below will surface a normal child-reported skipReason
      // (e.g. incomplete-result) off a missing prompt file — no
      // special-casing needed here.
    }

    const baseArgv = [
      "--prompt-file",
      promptPath,
      "--model",
      JUDGE_MODEL,
      "--effort",
      JUDGE_EFFORT,
      "--max-budget-usd",
      String(parsed.maxBudgetUsd),
      "--max-turns",
      "1",
      "--allowed-tools",
      "",
      "--tools",
      "",
      "--timeout-sec",
      String(JUDGE_TIMEOUT_SEC),
      "--task",
      `explain-judge-${site}`,
      "--out",
      outPath,
    ];

    let toolsFallback = false;
    let { stdout } = await deps.runHeadless(baseArgv, cwd);
    let headless = tryParseJson(stdout);

    // The installed flow-claude-headless may predate --tools until this
    // branch merges and is reinstalled; its parseArgs turns the unknown
    // flag into {ran:false,skipReason:"bad-args"}. Retry exactly once
    // without --tools so the judge isn't a silent no-op until reinstall.
    if (headless?.skipReason === "bad-args") {
      toolsFallback = true;
      const retryArgv = dropFlag(baseArgv, "--tools");
      const retry = await deps.runHeadless(retryArgv, cwd);
      stdout = retry.stdout;
      headless = tryParseJson(stdout);
    }

    const textChars = textToJudge.length;

    if (!headless || headless.ran !== true) {
      const skipReason = headless?.skipReason ?? "incomplete-result";
      return emit(
        { ran: false, site, skipReason },
        {
          text_chars: textChars,
          brief_scope: briefScope,
          ...(toolsFallback ? { tools_fallback: true } : {}),
        },
      );
    }

    const artifactPath = headless.artifact ?? outPath;
    const artifactRaw = deps.readFile(artifactPath);
    let resultText: string | null = null;
    if (artifactRaw !== null) {
      try {
        const artifactEnvelope = JSON.parse(artifactRaw);
        resultText =
          typeof artifactEnvelope.result === "string"
            ? artifactEnvelope.result
            : null;
      } catch {
        resultText = null;
      }
    }

    if (resultText === null) {
      return emit(
        { ran: false, site, skipReason: "unparseable-verdict" },
        {
          text_chars: textChars,
          brief_scope: briefScope,
          ...(toolsFallback ? { tools_fallback: true } : {}),
        },
      );
    }

    const verdict = parseVerdict(resultText);
    if (verdict === null) {
      return emit(
        { ran: false, site, skipReason: "unparseable-verdict" },
        {
          text_chars: textChars,
          brief_scope: briefScope,
          ...(toolsFallback ? { tools_fallback: true } : {}),
        },
      );
    }

    const envelope: JudgeEnvelope = {
      ran: true,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      site,
      model: JUDGE_MODEL,
      effort: JUDGE_EFFORT,
      total_cost_usd: headless.total_cost_usd ?? 0,
      brief: briefScope,
    };
    return emit(envelope, {
      text_chars: textChars,
      ...(toolsFallback ? { tools_fallback: true } : {}),
    });
  } finally {
    deps.removeDir(cwd);
  }
}
