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
 *     `flow-delegate` (model "Gemini 3.1 Pro (High)", flow-delegate's
 *     default 5m timeout).
 *  3. Branch on the flow-delegate envelope's `ran` field (NEVER the exit
 *     code): `ran:false` → propagate the skipReason, finalize nothing.
 *  4. `ran:true` → read the raw agy artifact, defensively extract the JSON
 *     object (extractJsonObject tolerates a prose/markdown-fence wrapper),
 *     parse, validate the four-key shape. Any unusable output → dropped
 *     result + skipReason, NO `intent-guess-gemini.json` left behind
 *     (write-only-on-success).
 *  5. Valid → write the guess object to `--out` →
 *     `{ran:true,findingsPath}`.
 *
 * Exit codes: 0 on every graceful path (callers branch on `ran`); 2 only
 * on a usage error (missing required flag).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

const MODEL = "Gemini 3.1 Pro (High)";
const DEFAULT_TASK = "gemini-intent-guess";

export type Args = {
  worktree: string;
  diffFile: string;
  out: string;
  config: string;
  task: string;
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

// Recover the JSON object from a raw agy artifact that may wrap it in a
// leading/trailing prose sentence or a ```json fence. Returns the substring
// from the first '{' to the matching last '}' (inclusive), or null when no
// brace pair is present. NEVER throws — JSON.parse validity is the caller's
// concern.
export function extractJsonObject(raw: string): string | null {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  return raw.slice(first, last + 1);
}

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
  return `You are guessing the purpose of a pull request from its diff alone. You have NOT been given the PR title, description, plan, or commit messages — guess blind, the same way a second independent reviewer would before reading any of that context. You have read access to the working directory for surrounding source context, but you must NOT open \`.flow-tmp/fetch.md\`, \`.flow-tmp/pr-body.md\`, \`.flow-tmp/pr-body-current.md\`, \`.flow-tmp/pr-metadata.json\`, \`.flow-tmp/pr-description-draft.md\`, \`.flow-tmp/commits.txt\`, \`.flow-tmp/plan.md\`, \`.flow-tmp/checkpoint.md\`, \`.flow-tmp/scout.md\`, any other \`.flow-tmp/\` PR-metadata artifact, or the git log — doing so unblinds you and defeats this check.

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
      "usage: flow-gemini-intent-guess --worktree <dir> --diff-file <path> --out <path> [--config <path>] [--task <name>]",
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
    });
  }

  // The raw agy artifact is a scratch sibling of --out; finalize --out only
  // on a fully-valid payload so downstream consumers never see a half-baked
  // file.
  const rawPath = `${parsed.out}.agy-raw`;
  const promptPath = `${parsed.out}.prompt`;

  // Pre-clean any stale --out from a prior run on this reused worktree.
  deps.removeFile(parsed.out);

  const cleanScratch = () => {
    deps.removeFile(promptPath);
    deps.removeFile(rawPath);
  };
  const skip = (skipReason: string): number => {
    cleanScratch();
    return emit(deps, { ran: false, skipReason });
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
  } catch {
    return skip("gemini-intent-guess-prep-failed");
  }

  const envelope = deps.runDelegate([
    "--prompt-file",
    promptPath,
    "--model",
    MODEL,
    "--add-dir",
    parsed.worktree,
    "--out",
    rawPath,
    "--task",
    parsed.task,
  ]);

  // Branch on the `ran` field (NEVER the exit code): flow-delegate exits 0
  // even on a graceful agy-absent skip.
  if (!envelope.ran) {
    return skip(envelope.skipReason ?? "agy-skip");
  }

  let raw: string;
  try {
    raw = deps.readFile(envelope.artifactPath ?? rawPath);
  } catch {
    return skip("gemini-intent-guess-output-unreadable");
  }

  const objText = extractJsonObject(raw);
  if (objText === null) {
    return skip("gemini-intent-guess-output-unparseable");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(objText);
  } catch {
    return skip("gemini-intent-guess-output-unparseable");
  }

  const validation = validateIntentGuess(parsedJson);
  if (!validation.ok) {
    return skip("gemini-intent-guess-output-schema-invalid");
  }

  try {
    deps.writeFile(parsed.out, JSON.stringify(validation.value, null, 2));
  } catch {
    return skip("gemini-intent-guess-finalize-failed");
  }

  cleanScratch();
  return emit(deps, {
    ran: true,
    findingsPath: parsed.out,
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
          return { ran: false, skipReason: "agy-error" };
        }
      }),
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    writeFile: o?.writeFile ?? ((p, c) => writeFileSync(p, c)),
    removeFile: o?.removeFile ?? ((p) => void rmSync(p, { force: true })),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
