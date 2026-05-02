/**
 * LLM judge for the eval harness. Runs `claude -p` with a fixed model + effort
 * and asks for a YES/NO verdict on each soft-criterion in a fixture's rubric.
 *
 * The judge is identical across configs by design: we measure the implementor,
 * not the judge. Hard-coded to Claude Opus 4.7 at xhigh effort.
 *
 * Tests inject a stub binary via FLOW_EVAL_CLAUDE_BIN so the suite never
 * burns Opus tokens. Production runs leave that env var unset and we shell
 * out to whatever `claude` is on PATH.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseStreamJsonText, type CostResult } from "./eval-cost";

export const JUDGE_MODEL = "claude-opus-4-7";
export const JUDGE_EFFORT = "xhigh";

// Why no `--bare`: that flag forbids keychain reads, which kills OAuth/subscription
// auth (the default for Claude Code users). The harness instead achieves the same
// "no surprise context" goal by running the judge in an empty cwd (no CLAUDE.md to
// auto-discover) and disabling tools + slash commands explicitly below.
export const JUDGE_FLAGS: readonly string[] = [
  "-p",
  "--model",
  JUDGE_MODEL,
  "--effort",
  JUDGE_EFFORT,
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--disable-slash-commands",
  "--tools",
  "",
];

export type Verdict = {
  criterion: string;
  verdict: "yes" | "no";
  reason: string;
};

export type SoftResult = {
  pass: boolean;
  verdicts: Verdict[];
  judgeCost: CostResult;
  /** Raw stream-json captured from the judge invocation. Persisted as judge.jsonl. */
  rawStream: string;
  /** The assistant's final text response (extracted from the stream). */
  rawResponse: string;
};

export type JudgeInput = {
  prompt: string;
  diff: string;
  criteria: string[];
};

export function buildJudgePrompt(input: JudgeInput): string {
  const numbered = input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    "You are evaluating an AI-generated code change against a list of criteria.",
    "",
    "ORIGINAL FEATURE REQUEST:",
    "<<<",
    input.prompt.trim(),
    ">>>",
    "",
    "RESULTING DIFF:",
    "<<<",
    input.diff.trim() || "(empty diff — no changes)",
    ">>>",
    "",
    "CRITERIA (judge each YES or NO based strictly on the diff and the request):",
    numbered,
    "",
    "INSTRUCTIONS:",
    "- Output one JSON object per criterion, one per line. No prose, no markdown.",
    '- Format: {"criterion": "<verbatim criterion text>", "verdict": "yes" | "no", "reason": "<one-sentence explanation>"}',
    "- Use the criterion text VERBATIM from the list above.",
    "- A criterion is YES only if the diff fully satisfies it; partial → NO.",
    "- If the diff is empty, every criterion is NO with reason 'no changes'.",
    "",
    "OUTPUT (one JSON object per line, newline-separated):",
  ].join("\n");
}

/** Run the judge against one fixture's soft criteria. */
export async function runSoftChecks(input: JudgeInput): Promise<SoftResult> {
  if (input.criteria.length === 0) {
    return {
      pass: true,
      verdicts: [],
      judgeCost: { usd: 0, authoritative: true, tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }, perModel: {} },
      rawStream: "",
      rawResponse: "",
    };
  }

  const prompt = buildJudgePrompt(input);
  const rawStream = await invokeClaude(prompt);
  const judgeCost = parseStreamJsonText(rawStream);
  const rawResponse = extractAssistantText(rawStream);
  const verdicts = parseVerdicts(rawResponse, input.criteria);

  const allYes = verdicts.length === input.criteria.length && verdicts.every((v) => v.verdict === "yes");
  return { pass: allYes, verdicts, judgeCost, rawStream, rawResponse };
}

/**
 * Spawn `claude -p` (or the test stub) and return the raw stream-json output.
 *
 * Tools disabled (judge never needs to run code), slash commands disabled (no
 * risk of accidentally invoking a skill), and `--no-session-persistence` (a
 * one-shot inference, nothing to resume). cwd is an empty tmpdir so no
 * CLAUDE.md or `.claude/` from the parent process leaks into the judge's
 * context.
 */
export async function invokeClaude(prompt: string): Promise<string> {
  const bin = process.env.FLOW_EVAL_CLAUDE_BIN ?? "claude";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-eval-judge-"));
  try {
    const r = spawnSync(bin, [...JUDGE_FLAGS], {
      input: prompt,
      cwd: tmp,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) {
      throw new Error(`judge invocation failed (exit ${r.status}): ${(r.stderr ?? "").trim() || "(no stderr)"}`);
    }
    return r.stdout ?? "";
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Walk the stream-json events and concatenate every assistant text block. */
export function extractAssistantText(stream: string): string {
  const chunks: string[] = [];
  for (const line of stream.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(event) || event.type !== "assistant") continue;
    const message = event.message;
    if (!isObject(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isObject(block) && block.type === "text" && typeof block.text === "string") {
        chunks.push(block.text);
      }
    }
  }
  return chunks.join("");
}

/**
 * Parse the judge's response. Expects one JSON object per line — matches each
 * to its criterion by `criterion` field; missing or malformed entries
 * implicitly fail (verdict "no" with reason "judge produced no verdict").
 */
export function parseVerdicts(text: string, criteria: string[]): Verdict[] {
  const byCriterion = new Map<string, Verdict>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(obj)) continue;
    const c = typeof obj.criterion === "string" ? obj.criterion : "";
    const v = obj.verdict === "yes" || obj.verdict === "no" ? obj.verdict : null;
    const r = typeof obj.reason === "string" ? obj.reason : "";
    if (!c || !v) continue;
    byCriterion.set(c, { criterion: c, verdict: v, reason: r });
  }
  return criteria.map((c) =>
    byCriterion.get(c) ?? { criterion: c, verdict: "no", reason: "judge produced no verdict" },
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
