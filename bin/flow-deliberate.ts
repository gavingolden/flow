#!/usr/bin/env bun
/**
 * Blind second-opinion judge. Runs ONE bounded, spend-capped headless
 * Claude call over a single logical question and emits one JSON envelope
 * carrying the judge's recommendation, an anchor-derived confidence, and
 * the path to a human-readable note.
 *
 * A Bash fan-out over `flow-claude-headless`, NOT a Task-tool spawn — see
 * `.claude/rules/flow-supervisor-contracts.md` "Don'ts" and
 * `skills/pipeline/flow-pipeline/references/headless-claude.md`. That is
 * what lets a Task-spawned sub-agent (discovery) call it: a sub-agent may
 * never spawn a nested Task, but it may always shell out.
 *
 * Sibling of `bin/flow-blind-survey.ts`: same prompt-lib + CLI split, same
 * `ran`-field branching, same "spawn the sibling helper by bare PATH name"
 * rule. Differs in the model (Claude, not agy) and in the subject (one
 * question, not a method survey).
 *
 * Every non-usage path exits 0 with `{ran:false, skipReason}` — callers
 * branch on `ran`, never on the exit code, so an unavailable judge degrades
 * to the caller's existing escape rather than failing the pipeline.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeliberatePrompt,
  isClosedFormAnchor,
  parseDeliberation,
  type Confidence,
} from "./lib/deliberate-prompt";
import { briefLeaksCorpus as briefLeaksCorpusImpl } from "./lib/blind-survey-prompt";
import { readDefaultModel } from "./lib/models-config";
import { recordEvent } from "./lib/telemetry";
import { resolveProductBrief } from "./flow-product-brief";

export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_MAX_BUDGET_USD = 2;
export const DEFAULT_MAX_TURNS = 15;
export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_TASK = "deliberate";

/**
 * Every terminal skip. The first five are this helper's own — though
 * `bad-args` is dual-sourced: it's also the flag flow-claude-headless
 * itself would report, since a usage error here never reaches the child.
 * The rest are forwarded verbatim from `flow-claude-headless` so a caller
 * reading `skipReason` sees the real cause rather than a flattened "it
 * failed".
 */
export const SKIP_REASONS = [
  "question-unreadable",
  "question-not-blind",
  "worktree-not-found",
  "headless-error",
  "unparseable-result",
  // forwarded from flow-claude-headless
  "bad-args",
  "claude-not-found",
  "claude-not-logged-in",
  "claude-error",
  "claude-timeout",
  "incomplete-result",
  "headless-depth-exceeded",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export type Args = {
  questionFile: string;
  blindToFile?: string;
  worktree: string;
  model?: string;
  effort: string;
  maxBudgetUsd: number;
  maxTurns: number;
  timeoutSec: number;
  task: string;
};

const USAGE =
  "usage: flow-deliberate --question-file <path> [--blind-to-file <path>] " +
  "[--worktree <dir>] [--model <alias>] [--effort <lvl>] " +
  "[--max-budget-usd <n>] [--max-turns <n>] [--timeout-sec <n>] [--task <name>]";

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) return { error: `missing value for ${flag}` };
    switch (flag) {
      case "--question-file":
        out.questionFile = value;
        break;
      case "--blind-to-file":
        out.blindToFile = value;
        break;
      case "--worktree":
        out.worktree = value;
        break;
      case "--model":
        out.model = value;
        break;
      case "--effort":
        out.effort = value;
        break;
      case "--max-budget-usd": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          return { error: `--max-budget-usd must be a positive number` };
        }
        out.maxBudgetUsd = n;
        break;
      }
      case "--max-turns": {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          return { error: `--max-turns must be a positive integer` };
        }
        out.maxTurns = n;
        break;
      }
      case "--timeout-sec": {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          return { error: `--timeout-sec must be a positive integer` };
        }
        out.timeoutSec = n;
        break;
      }
      case "--task":
        out.task = value;
        break;
      default:
        return { error: `unknown flag ${flag}` };
    }
    i += 2;
  }

  if (!out.questionFile) return { error: `--question-file is required` };

  return {
    questionFile: out.questionFile,
    blindToFile: out.blindToFile,
    worktree: out.worktree ?? process.cwd(),
    model: out.model,
    effort: out.effort ?? DEFAULT_EFFORT,
    maxBudgetUsd: out.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    maxTurns: out.maxTurns ?? DEFAULT_MAX_TURNS,
    timeoutSec: out.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    task: out.task ?? DEFAULT_TASK,
  };
}

/** The `flow-claude-headless` stdout envelope, as far as we read it. */
export type HeadlessEnvelope = {
  ran?: boolean;
  skipReason?: string;
  artifact?: string;
  model?: string;
  total_cost_usd?: number;
  stderrTail?: string;
};

export type Deps = {
  spawnHeadless: (argv: string[], opts: { cwd: string }) => HeadlessEnvelope;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  fileExists: (path: string) => boolean;
  dirExists: (path: string) => boolean;
  mkdirp: (dir: string) => void;
  mkdtemp: () => string;
  removeDir: (dir: string) => void;
  writeOut: (line: string) => void;
  briefLeaksCorpus: (brief: string, corpus: string) => boolean;
  recordEvent: (
    event: "deliberate.call",
    attrs: Record<string, unknown>,
  ) => void;
  resolveConfigModel: () => string | undefined;
  /** The repo's standing product brief, when one exists, else null. */
  readProductBrief: (worktree: string) => string | null;
};

function emit(deps: Deps, envelope: Record<string, unknown>): number {
  deps.writeOut(JSON.stringify(envelope));
  return 0;
}

function skip(
  deps: Deps,
  task: string,
  skipReason: SkipReason,
  extra: Record<string, unknown> = {},
  costUsd?: number,
): number {
  deps.recordEvent("deliberate.call", {
    task,
    ran: false,
    skip_reason: skipReason,
    ...(costUsd === undefined ? {} : { total_cost_usd: costUsd }),
  });
  return emit(deps, { ran: false, task, skipReason, ...extra });
}

export function run(argv: string[], depsOverride?: Partial<Deps>): number {
  const deps = resolveDeps(depsOverride);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    deps.writeOut(
      JSON.stringify({
        ran: false,
        task: DEFAULT_TASK,
        skipReason: "bad-args",
        error: parsed.error,
      }),
    );
    return 2;
  }

  try {
    return runInner(parsed, deps);
  } catch (e) {
    return skip(deps, parsed.task, "headless-error", {
      stderrTail: e instanceof Error ? e.message : String(e),
    });
  }
}

function runInner(args: Args, deps: Deps): number {
  if (!deps.fileExists(args.questionFile)) {
    return skip(deps, args.task, "question-unreadable");
  }
  let question: string;
  try {
    question = deps.readFile(args.questionFile).trim();
  } catch {
    return skip(deps, args.task, "question-unreadable");
  }
  if (question.length === 0) {
    return skip(deps, args.task, "question-unreadable");
  }

  if (!deps.dirExists(args.worktree)) {
    return skip(deps, args.task, "worktree-not-found");
  }

  // Blindness guard. A question carrying a verbatim run of the caller's own
  // lean is not a blind question — refuse BEFORE spending anything, so the
  // caller repairs the question rather than paying for an echo.
  if (args.blindToFile) {
    if (!deps.fileExists(args.blindToFile)) {
      return skip(deps, args.task, "question-unreadable", {
        stderrTail: `--blind-to-file not found: ${args.blindToFile}`,
      });
    }
    let corpus = "";
    try {
      corpus = deps.readFile(args.blindToFile);
    } catch {
      return skip(deps, args.task, "question-unreadable", {
        stderrTail: `--blind-to-file unreadable: ${args.blindToFile}`,
      });
    }
    if (deps.briefLeaksCorpus(question, corpus)) {
      return skip(deps, args.task, "question-not-blind");
    }
  }

  const model = args.model ?? deps.resolveConfigModel() ?? DEFAULT_MODEL;
  const prompt = buildDeliberatePrompt({
    question,
    worktreePath: args.worktree,
    productBrief: deps.readProductBrief(args.worktree),
  });

  // The prompt file lives OUTSIDE the worktree: the child is told not to
  // read `.flow-tmp/`, and putting the prompt (which restates the question)
  // there would be a needless self-contradiction — plus a `--blind-to`
  // corpus for a LATER consult must never find this pass's question on disk.
  const scratch = deps.mkdtemp();
  const promptPath = join(scratch, "deliberate-prompt.md");
  const childOut = `${args.worktree}/.flow-tmp/headless-deliberate-${args.task}.json`;

  let envelope: HeadlessEnvelope;
  try {
    deps.writeFile(promptPath, prompt);
    deps.mkdirp(`${args.worktree}/.flow-tmp`);
    envelope = deps.spawnHeadless(
      [
        "--prompt-file",
        promptPath,
        "--model",
        model,
        "--effort",
        args.effort,
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--max-turns",
        String(args.maxTurns),
        "--allowed-tools",
        "Read,Grep,Glob",
        "--timeout-sec",
        String(args.timeoutSec),
        "--task",
        `deliberate-${args.task}`,
        "--out",
        childOut,
      ],
      { cwd: args.worktree },
    );
  } finally {
    deps.removeDir(scratch);
  }

  if (envelope.ran !== true) {
    // Forward the headless skip verbatim rather than flattening it — the
    // caller's degrade is the same either way, but the reason is what the
    // user reads when a consult silently produced nothing.
    const forwarded = (SKIP_REASONS as readonly string[]).includes(
      envelope.skipReason ?? "",
    )
      ? (envelope.skipReason as SkipReason)
      : "headless-error";
    return skip(deps, args.task, forwarded, {
      ...(envelope.stderrTail ? { stderrTail: envelope.stderrTail } : {}),
    });
  }

  const answer = readChildResult(deps, envelope.artifact);
  if (answer === null) {
    return skip(
      deps,
      args.task,
      "unparseable-result",
      { total_cost_usd: envelope.total_cost_usd },
      envelope.total_cost_usd,
    );
  }

  const deliberation = parseDeliberation(answer);
  if (deliberation === null) {
    return skip(
      deps,
      args.task,
      "unparseable-result",
      { total_cost_usd: envelope.total_cost_usd },
      envelope.total_cost_usd,
    );
  }

  // Anchor demotion. A judge may only claim `high`/`medium` on an anchor a
  // caller can mechanically re-verify (a path, an `adjacent:` precedent, or
  // a quotation of the asker). A `weighing:`/`inference` anchor is free text
  // no lint can check, so it is demoted to `low` — which routes the item to
  // the caller's existing escape instead of laundering speculation into an
  // adopted default. This is a mechanical demotion, not a prompt request:
  // the prompt already asks for it, and this is what makes it true.
  const closedForm = isClosedFormAnchor(deliberation.anchor);
  const confidence: Confidence =
    closedForm || deliberation.confidence === "low"
      ? deliberation.confidence
      : "low";
  const demoted = confidence !== deliberation.confidence;

  const artifact = `${args.worktree}/.flow-tmp/deliberation-${args.task}.md`;
  deps.writeFile(
    artifact,
    renderNote({
      task: args.task,
      question,
      model: envelope.model ?? model,
      costUsd: envelope.total_cost_usd,
      confidence,
      declaredConfidence: deliberation.confidence,
      demoted,
      recommendation: deliberation.recommendation,
      anchor: deliberation.anchor,
      body: deliberation.rationale.length > 0 ? deliberation.rationale : answer,
    }),
  );

  deps.recordEvent("deliberate.call", {
    task: args.task,
    ran: true,
    model: envelope.model ?? model,
    confidence,
    declared_confidence: deliberation.confidence,
    anchor_demoted: demoted,
    total_cost_usd: envelope.total_cost_usd,
  });

  return emit(deps, {
    ran: true,
    task: args.task,
    recommendation: deliberation.recommendation,
    confidence,
    anchor: deliberation.anchor,
    anchorDemoted: demoted,
    artifact,
    total_cost_usd: envelope.total_cost_usd,
    model: envelope.model ?? model,
  });
}

/** Reads the `result` text out of the headless child's own artifact. */
function readChildResult(
  deps: Deps,
  artifactPath: string | undefined,
): string | null {
  if (!artifactPath || !deps.fileExists(artifactPath)) return null;
  try {
    const parsed = JSON.parse(deps.readFile(artifactPath)) as {
      result?: unknown;
    };
    return typeof parsed.result === "string" && parsed.result.trim().length > 0
      ? parsed.result
      : null;
  } catch {
    return null;
  }
}

function renderNote(input: {
  task: string;
  question: string;
  model: string;
  costUsd: number | undefined;
  confidence: Confidence;
  declaredConfidence: Confidence;
  demoted: boolean;
  recommendation: string;
  anchor: string;
  body: string;
}): string {
  const cost =
    input.costUsd === undefined ? "unknown" : `$${input.costUsd.toFixed(4)}`;
  const demotionNote = input.demoted
    ? `\n> [!NOTE]\n> The judge declared \`${input.declaredConfidence}\`, demoted to \`low\`: the anchor is not a closed form a caller can re-verify (a \`path[:line]\`, an \`adjacent:\` precedent, or a \`user: "…"\` quotation).\n`
    : "";

  return `# Deliberation: ${input.task}

- **Recommendation:** ${input.recommendation}
- **Confidence:** ${input.confidence}
- **Anchor:** ${input.anchor}
- **Model:** ${input.model} — cost ${cost}
${demotionNote}
## Question asked

${input.question}

## Judge's answer

${input.body}
`;
}

function resolveDeps(o?: Partial<Deps>): Deps {
  return {
    spawnHeadless:
      o?.spawnHeadless ??
      ((argv, opts) => {
        const r = Bun.spawnSync(["flow-claude-headless", ...argv], {
          cwd: opts.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : "";
        const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
        return JSON.parse(line) as HeadlessEnvelope;
      }),
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    writeFile: o?.writeFile ?? ((p, c) => writeFileSync(p, c)),
    fileExists: o?.fileExists ?? ((p) => existsSync(p)),
    dirExists:
      o?.dirExists ?? ((p) => existsSync(p) && statSync(p).isDirectory()),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    mkdtemp:
      o?.mkdtemp ?? (() => mkdtempSync(join(tmpdir(), "flow-deliberate-"))),
    removeDir:
      o?.removeDir ?? ((d) => void rmSync(d, { recursive: true, force: true })),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
    briefLeaksCorpus: o?.briefLeaksCorpus ?? briefLeaksCorpusImpl,
    recordEvent:
      o?.recordEvent ?? ((event, attrs) => recordEvent(event, attrs)),
    // The existing `config.models.default` resolver — same one `feature.ts`
    // and `epic.ts` use at launch, so a judge inherits exactly the default the
    // rest of flow already honours (and its alias validation, which silently
    // drops a typo'd value rather than forwarding it to `claude --model`).
    resolveConfigModel: o?.resolveConfigModel ?? (() => readDefaultModel()),
    // Shared with the sibling judge (`flow-plan-review.ts`): the git-root
    // walk, `normaliseBriefText`'s fence-closing, and the char cap all live
    // in one place so a worktree that isn't the repo root, an unclosed code
    // fence, or an oversized brief are handled identically everywhere.
    readProductBrief:
      o?.readProductBrief ??
      ((w) => {
        const brief = resolveProductBrief({ cwd: w });
        return brief.found ? brief.text : null;
      }),
  };
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  process.exit(run(process.argv.slice(2)));
}
