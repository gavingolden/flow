#!/usr/bin/env bun
/**
 * Cross-model (Gemini) intent-guess for `/flow-pr-review`'s Step 3 fan-out.
 *
 * The diff-only intent-guess agent (`agents/flow-review-intent-guess.md`)
 * produces ONE blind guess at a PR's purpose on the Claude model family.
 * This helper adds a SECOND, independently-model blind guess through
 * Gemini, delegated to the user's idle Google AI Ultra quota via
 * `flow-delegate` (agy) at no Claude-credit cost. It is config-gated
 * (`review.gemini === true`), opt-in, and purely additive: any failure
 * path is a graceful skip, never a hard-fail of the review.
 *
 * Flow:
 *  1. GATE — read `~/.flow/config.json` tolerantly; enable ONLY on strict
 *     boolean `review.gemini === true` (isGeminiIntentGuessEnabled).
 *     Disabled → `{ran:false,skipReason:"gemini-intent-guess-disabled"}`.
 *  2. Build the embedded blind-guess prompt (diff + file list ONLY, no PR
 *     title/body/plan/commit messages — mirrors the diff-only agent's
 *     blindness contract) and delegate ONE bounded agy call via
 *     `flow-delegate` (model "Gemini 3.1 Pro (High)", `--timeout` from
 *     `resolveDelegateTimeout("intentGuess")` — `delegate.timeouts.intentGuess`,
 *     default 5m, clamped to a 9m sync ceiling).
 *  3. Branch on the flow-delegate envelope's `ran` field (NEVER the exit
 *     code): `ran:false` → propagate the skipReason, finalize nothing.
 *  4. `ran:true` → read the raw agy artifact and decode it through the
 *     rung-ordered ladder in `bin/lib/structured-response.ts`
 *     (`decodeDelegateArtifact`): the envelope's wire-level
 *     `structured_output` (from `--json-schema INTENT_GUESS_JSON_SCHEMA`)
 *     first, then `parseStructured` over the response prose, then a naive
 *     salvage — validating the four-key shape at each rung. Any unusable
 *     output → dropped result + skipReason, NO `intent-guess-gemini.json`
 *     left behind (write-only-on-success).
 *  5. Valid → write the guess object to `--out` →
 *     `{ran:true,findingsPath,decodedVia}`.
 *
 * Exit codes: 0 on every graceful path (callers branch on `ran`); 2 only
 * on a usage error (missing required flag).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { resolveDelegateModel } from "./lib/delegate-models";
import {
  clampDelegateTimeout,
  resolveDelegateTimeout,
} from "./lib/delegate-timeouts";
import { decodeDelegateArtifact } from "./lib/structured-response";
import { classifyDelegateSkip } from "./lib/delegate-skip-class";

// The model routes through resolveDelegateModel("intentGuess") — the default
// lives in DELEGATE_MODEL_DEFAULTS; a `delegate.models.intentGuess` config
// value re-points this surface without a code change.
const DEFAULT_TASK = "gemini-intent-guess";

export type Args = {
  worktree: string;
  diffFile: string;
  out: string;
  config: string;
  task: string;
  timeout?: string;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--worktree":
        out.worktree = value;
        break;
      case "--diff-file":
        out.diffFile = value;
        break;
      case "--out":
        out.out = value;
        break;
      case "--config":
        out.config = value;
        break;
      case "--task":
        out.task = value;
        break;
      case "--timeout":
        out.timeout = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  const REQUIRED_FLAG = {
    worktree: "--worktree",
    diffFile: "--diff-file",
    out: "--out",
  } as const;
  for (const k of ["worktree", "diffFile", "out"] as const) {
    if (out[k] === undefined)
      return { error: `${REQUIRED_FLAG[k]} is required` };
  }
  return {
    worktree: out.worktree as string,
    diffFile: out.diffFile as string,
    out: out.out as string,
    config: out.config ?? `${homedir()}/.flow/config.json`,
    task: out.task ?? DEFAULT_TASK,
    timeout: out.timeout,
  };
}

// Strict-boolean gate: enable ONLY when the parsed config is an object with
// `review` an object and `review.gemini === true`. Tolerant on input — an
// absent/malformed config (unparseable JSON, wrong shape) is `false`, never
// a throw. Mirrors flow-gemini-lens.ts's isGeminiLensEnabled.
export function isGeminiIntentGuessEnabled(rawConfigText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigText);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const review = (parsed as Record<string, unknown>).review;
  if (typeof review !== "object" || review === null) return false;
  return (review as Record<string, unknown>).gemini === true;
}

// Wire-level `--json-schema` contract for the agy call. Every property
// carries a `description` — load-bearing: a description-less schema was
// observed to produce a degenerate `confidence: 1` in probing. `reasoning`
// is a LEADING scratchpad-only field (not part of `IntentGuess` /
// `validateIntentGuess`, which still projects exactly the other four keys)
// — a leading reasoning field measurably improves constrained JSON output
// quality without itself being graded.
export const INTENT_GUESS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "reasoning",
    "guessed_purpose",
    "key_changes",
    "justification",
    "confidence",
  ],
  properties: {
    reasoning: {
      type: "string",
      description:
        "Use this exclusively for scratchpad reasoning; every finding you want reported must go in the other fields, never here.",
    },
    guessed_purpose: {
      type: "string",
      description: "One or two sentences: what you believe this diff is for.",
    },
    key_changes: {
      type: "array",
      items: { type: "string" },
      description:
        "The specific changes that support guessed_purpose, one per array entry.",
    },
    justification: {
      type: "string",
      description:
        "Why you believe guessed_purpose — cite specific diff hunks by file.",
    },
    confidence: {
      type: "number",
      description:
        "0-100. Low confidence is a valid, expected answer when the diff is genuinely uninformative about intent.",
    },
  },
};

export type IntentGuess = {
  guessed_purpose: string;
  key_changes: string[];
  justification: string;
  confidence: number;
};

// Validates the four-key shape the diff-only agent's artifact also carries
// (agents/flow-review-intent-guess.md). Tolerant on shape mismatch — returns
// ok:false rather than throwing.
export function validateIntentGuess(
  value: unknown,
): { ok: true; value: IntentGuess } | { ok: false } {
  if (typeof value !== "object" || value === null) return { ok: false };
  const v = value as Record<string, unknown>;
  if (typeof v.guessed_purpose !== "string") return { ok: false };
  if (
    !Array.isArray(v.key_changes) ||
    !v.key_changes.every((c) => typeof c === "string")
  )
    return { ok: false };
  if (typeof v.justification !== "string") return { ok: false };
  if (typeof v.confidence !== "number") return { ok: false };
  return {
    ok: true,
    value: {
      guessed_purpose: v.guessed_purpose,
      key_changes: v.key_changes as string[],
      justification: v.justification,
      confidence: v.confidence,
    },
  };
}

function buildPrompt(diff: string, fileList: string): string {
  return `You are guessing the purpose of a pull request from its diff alone. You have NOT been given the PR title, description, plan, or commit messages — guess blind, the same way a second independent reviewer would before reading any of that context. You have read access to the working directory for surrounding source context, but you must NOT open \`.flow-tmp/fetch.md\`, \`.flow-tmp/pr-body.md\`, \`.flow-tmp/pr-body-current.md\`, \`.flow-tmp/pr-metadata.json\`, \`.flow-tmp/pr-description-draft.md\`, \`.flow-tmp/commits.txt\`, \`.flow-tmp/plan.md\`, \`.flow-tmp/checkpoint.md\`, \`.flow-tmp/checkpoint.consumed.md\`, \`~/.flow/state/checkpoints/<slug>/checkpoint.md\`, \`~/.flow/state/checkpoints/<slug>/checkpoint.consumed.md\`, \`.flow-tmp/scout.md\`, any other \`.flow-tmp/\` PR-metadata artifact, or the git log — doing so unblinds you and defeats this check.

Changed files:
${fileList}

## Output format (LOAD-BEARING)

Output ONLY a single JSON object — no prose, no preamble, no markdown code fence. The very first character of your output must be '{' and the last must be '}'.

{
  "guessed_purpose": "one or two sentences — what you believe this PR is for",
  "key_changes": ["change 1", "change 2", "..."],
  "justification": "why you believe this — cite specific diff hunks",
  "confidence": 0-100
}

Every claim in guessed_purpose and justification must cite a specific diff hunk (file + the change it made). A purpose broad or generic enough to fit any PR ("improves code quality", "adds functionality") is a contract violation — if the diff is genuinely uninformative about intent, say so explicitly and set a low confidence rather than inventing a vague-but-plausible-sounding purpose.

## Diff

${diff}`;
}

export type DelegateEnvelope = {
  ran?: boolean;
  skipReason?: string;
  artifactPath?: string;
  exitCode?: number;
  stderrTail?: string;
  agyStatus?: string;
  agyError?: string;
};

export type Deps = {
  readConfig: (path: string) => string;
  // Runs flow-delegate with the given argv and returns its parsed one-line
  // JSON envelope.
  runDelegate: (argv: string[]) => DelegateEnvelope;
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  removeFile: (path: string) => void;
  mkdirp: (dir: string) => void;
  writeOut: (line: string) => void;
  fileExists: (path: string) => boolean;
};

function emit(deps: Deps, envelope: Record<string, unknown>): number {
  deps.writeOut(JSON.stringify(envelope));
  return 0;
}

export function run(argv: string[], depsOverride?: Partial<Deps>): number {
  const deps = resolveDeps(depsOverride);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-gemini-intent-guess: ${parsed.error}`);
    console.error(
      "usage: flow-gemini-intent-guess --worktree <dir> --diff-file <path> --out <path> [--config <path>] [--task <name>] [--timeout <godur>]",
    );
    return 2;
  }

  // Gate: read the config tolerantly and enable only on strict boolean true.
  let rawConfig = "";
  try {
    rawConfig = deps.readConfig(parsed.config);
  } catch {
    rawConfig = "";
  }
  if (!isGeminiIntentGuessEnabled(rawConfig)) {
    return emit(deps, {
      ran: false,
      skipReason: "gemini-intent-guess-disabled",
      skipClass: classifyDelegateSkip("gemini-intent-guess-disabled"),
    });
  }

  // The raw agy artifact is a scratch sibling of --out; finalize --out only
  // on a fully-valid payload so downstream consumers never see a half-baked
  // file.
  const rawPath = `${parsed.out}.agy-raw`;
  const promptPath = `${parsed.out}.prompt`;
  const schemaPath = `${parsed.out}.schema.json`;

  // Pre-clean any stale --out from a prior run on this reused worktree. Also
  // pre-clean rawPath: a ran-unusable skip retains it as partialArtifactPath
  // (below), so a prior run's .agy-raw must not be reported as THIS run's
  // evidence when this run never reaches dispatch.
  deps.removeFile(parsed.out);
  deps.removeFile(rawPath);

  const cleanScratch = (retain: string[] = []) => {
    const retainSet = new Set(retain);
    for (const p of [promptPath, rawPath, schemaPath]) {
      if (!retainSet.has(p)) deps.removeFile(p);
    }
  };
  // diag carries the flow-delegate envelope's own diagnostics through to
  // this helper's skip envelope, omit-when-absent; partialArtifactPath is
  // set ONLY for a ran-unusable skip (a dispatched agy call whose output
  // couldn't be used) whose raw artifact still exists on disk.
  const skip = (
    skipReason: string,
    diag?: Pick<
      DelegateEnvelope,
      "exitCode" | "stderrTail" | "agyStatus" | "agyError"
    >,
  ): number => {
    const skipClass = classifyDelegateSkip(skipReason);
    const partialArtifactPath =
      skipClass === "ran-unusable" && deps.fileExists(rawPath)
        ? rawPath
        : undefined;
    cleanScratch(partialArtifactPath ? [partialArtifactPath] : []);
    const envelope: Record<string, unknown> = {
      ran: false,
      skipReason,
      skipClass,
    };
    if (diag?.exitCode !== undefined) envelope.exitCode = diag.exitCode;
    if (diag?.stderrTail) envelope.stderrTail = diag.stderrTail;
    if (diag?.agyStatus) envelope.agyStatus = diag.agyStatus;
    if (diag?.agyError) envelope.agyError = diag.agyError;
    if (partialArtifactPath) envelope.partialArtifactPath = partialArtifactPath;
    return emit(deps, envelope);
  };

  let diff = "";
  try {
    diff = deps.readFile(parsed.diffFile);
  } catch {
    return skip("gemini-intent-guess-diff-unreadable");
  }

  // Derive a bounded changed-file list from the diff's `--- a/` / `+++ b/`
  // markers rather than requiring a separate flag — keeps the CLI surface
  // minimal. `+++ b/` alone misses deletions (whose destination header is
  // `+++ /dev/null`), so pull the source path too.
  const changedFiles = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- a/"))
      changedFiles.add(line.slice("--- a/".length));
    if (line.startsWith("+++ b/"))
      changedFiles.add(line.slice("+++ b/".length));
  }
  const fileList =
    Array.from(changedFiles).join("\n") ||
    "(unable to derive file list from diff)";

  try {
    deps.mkdirp(dirname(parsed.out));
    deps.writeFile(promptPath, buildPrompt(diff, fileList));
    deps.writeFile(schemaPath, JSON.stringify(INTENT_GUESS_JSON_SCHEMA));
  } catch {
    return skip("gemini-intent-guess-prep-failed");
  }

  const envelope = deps.runDelegate([
    "--output-format",
    "json",
    "--json-schema",
    schemaPath,
    "--prompt-file",
    promptPath,
    "--model",
    // Non-null: only the "scout" surface's default is null; intentGuess's
    // default and every well-typed override are strings.
    resolveDelegateModel("intentGuess") as string,
    "--add-dir",
    parsed.worktree,
    "--out",
    rawPath,
    "--task",
    parsed.task,
    "--timeout",
    parsed.timeout
      ? clampDelegateTimeout(parsed.timeout, "intentGuess")
      : resolveDelegateTimeout("intentGuess"),
  ]);

  // Branch on the `ran` field (NEVER the exit code): flow-delegate exits 0
  // even on a graceful agy-absent skip. Diagnostics (exitCode/stderrTail/
  // agyStatus/agyError) forward through so a caller can distinguish a
  // print-timeout kill from a generic agy-error.
  if (!envelope.ran) {
    return skip(envelope.skipReason ?? "agy-skip", {
      exitCode: envelope.exitCode,
      stderrTail: envelope.stderrTail,
      agyStatus: envelope.agyStatus,
      agyError: envelope.agyError,
    });
  }

  let raw: string;
  try {
    raw = deps.readFile(envelope.artifactPath ?? rawPath);
  } catch {
    return skip("gemini-intent-guess-output-unreadable");
  }

  const decoded = decodeDelegateArtifact(raw, validateIntentGuess);
  if (!decoded.ok) {
    // The former -output-unparseable and -output-schema-invalid reasons
    // collapse into one: the ladder folds validation into decoding, so once
    // no rung both parses AND validates, the two are no longer
    // distinguishable from the caller's side.
    return skip("gemini-intent-guess-output-unparseable");
  }

  try {
    deps.writeFile(parsed.out, JSON.stringify(decoded.value, null, 2));
  } catch {
    return skip("gemini-intent-guess-finalize-failed");
  }

  cleanScratch();
  return emit(deps, {
    ran: true,
    findingsPath: parsed.out,
    decodedVia: decoded.via,
  });
}

function resolveDeps(o?: Partial<Deps>): Deps {
  return {
    readConfig: o?.readConfig ?? ((p) => readFileSync(p, "utf8")),
    runDelegate:
      o?.runDelegate ??
      ((argv) => {
        const r = Bun.spawnSync(["flow-delegate", ...argv], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : "";
        const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
        try {
          return JSON.parse(line) as DelegateEnvelope;
        } catch {
          return { ran: false, skipReason: "delegate-envelope-unparseable" };
        }
      }),
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    writeFile: o?.writeFile ?? ((p, c) => writeFileSync(p, c)),
    removeFile: o?.removeFile ?? ((p) => void rmSync(p, { force: true })),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
    fileExists: o?.fileExists ?? ((p) => existsSync(p)),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
