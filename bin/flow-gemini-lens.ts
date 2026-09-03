#!/usr/bin/env bun
/**
 * Cross-model (Gemini) review lens for `/flow-pr-review`'s multi-agent review.
 *
 * `/flow-pr-review`'s six review agents all run on the same Claude model family,
 * so they share that model's blind spots. This helper adds ONE additional
 * reviewer through a genuinely different model (Gemini), delegated to the
 * user's idle Google AI Ultra quota via `flow-delegate` (agy) at no
 * Claude-credit cost. It is config-gated (`review.gemini === true`),
 * opt-in, and purely additive: any failure path is a graceful skip, never
 * a hard-fail of the review.
 *
 * Flow:
 *  1. GATE — read `~/.flow/config.json` tolerantly; enable ONLY on strict
 *     boolean `review.gemini === true` (isGeminiLensEnabled). Disabled →
 *     `{ran:false,skipReason:"gemini-lens-disabled"}`.
 *  2. Build the embedded Gemini review prompt (self-contained so it works
 *     on any consumer PATH — the single source of truth for the lens prompt)
 *     and delegate ONE bounded agy call via `flow-delegate` (model
 *     "Gemini 3.1 Pro (High)", `--timeout` from
 *     `resolveDelegateTimeout("reviewLens")` — `delegate.timeouts.reviewLens`,
 *     default 8m, clamped to a 9m sync ceiling).
 *  3. Branch on the flow-delegate envelope's `ran` field (NEVER the exit
 *     code): `ran:false` → propagate the skipReason, finalize nothing.
 *  4. `ran:true` → read the raw agy artifact and decode it through the
 *     rung-ordered ladder in `bin/lib/structured-response.ts`
 *     (`decodeDelegateArtifact`): the envelope's wire-level
 *     `structured_output` (from `--json-schema AGENT_FINDINGS_JSON_SCHEMA`)
 *     first, then `parseStructured` over the response prose, then a naive
 *     salvage — normalizing (`normalizeParsedFindings`) and validating
 *     (`validateAgentFindings`) at every rung. Any unusable output →
 *     dropped result + skipReason, NO consolidator-valid
 *     `agent-output-gemini.json` left behind (write-only-on-success).
 *  5. Valid → write the normalized
 *     `{findings:[...], rejected_alternatives:[...], anti_patterns_found:[...]}`
 *     to `--out` → `{ran:true,findingsPath,findingCount,decodedVia}`. The two
 *     negative-findings arrays route through `collectLensNegatives`'s
 *     tolerant per-entry collector — a malformed entry is dropped, never
 *     sinks the whole artifact.
 *
 * Exit codes: 0 on every graceful path (callers branch on `ran`); 2 only
 * on a usage error (missing required flag).
 *
 * The agy artifact has NO `agent_source` tag — it is a plain `{findings}`
 * object identical to the six Claude agents; `agent_source:"gemini"` is
 * assigned consolidator-side at Step 3.5.
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
import {
  VALID_DECORATIONS,
  VALID_LABELS,
  classifyLensNegatives,
  collectLensNegatives,
  normalizeParsedFindings,
  validateAgentFindings,
} from "./lib/agent-finding-schema";
import { resolveDelegateModel } from "./lib/delegate-models";
import { resolveDelegateTimeout } from "./lib/delegate-timeouts";
import { classifyDelegateSkip } from "./lib/delegate-skip-class";
import { decodeDelegateArtifact } from "./lib/structured-response";

// The model routes through resolveDelegateModel("reviewLens") — the default
// lives in DELEGATE_MODEL_DEFAULTS; a `delegate.models.reviewLens` config
// value re-points this surface without a code change.
const DEFAULT_TASK = "gemini-review";

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
// a throw. Mirrors the F2 jq recipe `(.review | type == "object") and
// (.review.gemini == true)`.
export function isGeminiLensEnabled(rawConfigText: string): boolean {
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
// carries a `description` (load-bearing — a description-less schema was
// observed to produce degenerate output in probing). `reasoning` is a
// LEADING scratchpad-only field, never projected into the finalized
// `{findings}` file. `decoration` is deliberately NOT in `required` on each
// finding — `validateFinding` allows a `praise` finding to omit it. The
// `label` / `decoration` enums are built FROM the imported
// `VALID_LABELS` / `VALID_DECORATIONS` sets so the schema cannot drift from
// the validator.
export const AGENT_FINDINGS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "reasoning",
    "findings",
    "rejected_alternatives",
    "anti_patterns_found",
  ],
  properties: {
    reasoning: {
      type: "string",
      description:
        "Use this exclusively for scratchpad reasoning; every finding you want reported must go in the findings array, never here.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "line", "label", "confidence", "subject", "body"],
        properties: {
          file: { type: "string", description: "The changed file path." },
          line: { type: "number", description: "The primary line number." },
          end_line: {
            type: "number",
            description: "Optional end line for a multi-line span.",
          },
          label: {
            type: "string",
            enum: Array.from(VALID_LABELS),
            description: "The conventional-comments label for this finding.",
          },
          decoration: {
            type: "string",
            enum: Array.from(VALID_DECORATIONS),
            description:
              "The bare decoration keyword. Omit (or set null) for a praise finding; every other label requires one.",
          },
          confidence: {
            type: "number",
            description:
              "0-100. Only emit findings you are >= 80% confident are real.",
          },
          subject: {
            type: "string",
            description: "A short description of the finding.",
          },
          body: {
            type: "string",
            description:
              "Detailed explanation in conventional-comments format with a concrete fix.",
          },
        },
      },
      description: "The reviewer's findings, one entry per issue/praise/etc.",
    },
    rejected_alternatives: {
      type: "array",
      items: {
        type: "object",
        required: ["considered_approach", "why_rejected"],
        properties: {
          considered_approach: {
            type: "string",
            description:
              "An approach you considered while reviewing a hunk of the reviewed code.",
          },
          why_rejected: {
            type: "string",
            description:
              "Why the code as written is preferable to the considered approach.",
          },
        },
      },
      description:
        "Code-scoped claims about approaches you considered and rejected while reviewing. A genuine none is the empty array; do not omit this key.",
    },
    anti_patterns_found: {
      type: "array",
      items: {
        type: "object",
        required: ["location", "pattern", "recommendation"],
        properties: {
          location: {
            type: "string",
            description:
              "The file:line of the off-pattern in the reviewed code.",
          },
          pattern: {
            type: "string",
            description:
              "The off-pattern observed — not itself a findings entry.",
          },
          recommendation: {
            type: "string",
            description: "What the next person touching this code should do.",
          },
        },
      },
      description:
        "Code-scoped off-patterns you noticed but didn't surface as a findings entry. A genuine none is the empty array; do not omit this key.",
    },
  },
};

function buildPrompt(diff: string): string {
  return `You are a cross-model code reviewer. A separate set of reviewers running on a different model family is reviewing this same pull request; your job is to catch real issues their model family systematically under-weights. Review the whole diff below from every angle (correctness, security, performance, consistency, test coverage, supply-chain).

Read the changed files in full for surrounding context — the working tree is your current directory. The full diff is at the end of this prompt.

## Output format (LOAD-BEARING)

Output ONLY a single JSON object of shape {"findings": [...], "rejected_alternatives": [...], "anti_patterns_found": [...]} — no prose, no preamble, no markdown code fence. The very first character of your output must be '{' and the last must be '}'.

Each finding is an object:

{
  "file": "src/lib/store.ts",
  "line": 42,
  "end_line": 45,
  "label": "issue",
  "decoration": "blocking",
  "confidence": 92,
  "subject": "Short description of the finding",
  "body": "Detailed explanation in conventional-comments format with a concrete fix."
}

- label: one of praise | nitpick | suggestion | issue | todo | question
- decoration: one of blocking | non-blocking | if-minor — the BARE keyword, no parentheses (write "blocking", never "(blocking)"). praise findings OMIT decoration (or set null); every other label requires one.
- The short description field is named "subject" (never "title").
- Put the location in the structured "file" and "line" fields (required on every finding, praise included) — never only in subject/body prose.
- confidence: 0-100. Only emit findings you are >= 80% confident are real — a false positive that wastes a developer's time is worse than a missed finding a human reviewer will catch. When in doubt, rate lower and omit.
- Include a praise finding only when you can name the specific behaviour/file:line being praised; never content-free openers.

Alongside "findings", also emit two more arrays that capture claims about the REVIEWED CODE, not about your review process:

- "rejected_alternatives": an array of {"considered_approach": "...", "why_rejected": "..."} entries — an approach you considered while reviewing a hunk, and why the code as written is preferable.
- "anti_patterns_found": an array of {"location": "file:line", "pattern": "...", "recommendation": "..."} entries — an off-pattern you noticed in the reviewed code that isn't itself a findings entry.

Silence is not the default: if you genuinely considered no alternative and saw no off-pattern, write the true empty array [] for that key — but an absent key is a contract violation, not a synonym for none.

If you find nothing noteworthy, return {"findings": [], "rejected_alternatives": [], "anti_patterns_found": []}.

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
    console.error(`flow-gemini-lens: ${parsed.error}`);
    console.error(
      "usage: flow-gemini-lens --worktree <dir> --diff-file <path> --out <path> [--config <path>] [--task <name>] [--timeout <godur>]",
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
  if (!isGeminiLensEnabled(rawConfig)) {
    return emit(deps, {
      ran: false,
      skipReason: "gemini-lens-disabled",
      skipClass: classifyDelegateSkip("gemini-lens-disabled"),
    });
  }

  // The raw agy artifact is a scratch sibling of --out; finalize --out only
  // on a fully-valid payload so the consolidator never sees a half-baked file.
  const rawPath = `${parsed.out}.agy-raw`;
  const promptPath = `${parsed.out}.prompt`;
  const schemaPath = `${parsed.out}.schema.json`;

  // Pre-clean any stale --out from a prior run on this reused worktree: every
  // path past the gate either rewrites --out (success) or leaves it absent
  // (skip), so the consolidator never consumes a previous run's findings as
  // the current review. removeFile is idempotent (force:true) — absent is fine.
  deps.removeFile(parsed.out);

  // Scratch files (prompt + schema + raw agy output) are transient; clear
  // all three on every exit so they don't accumulate in the worktree's
  // .flow-tmp/ — UNLESS retained (a ran-unusable skip keeps rawPath as
  // partialArtifactPath evidence for the consolidator/report).
  const cleanScratch = (retain: string[] = []) => {
    const retainSet = new Set(retain);
    for (const p of [promptPath, rawPath, schemaPath]) {
      if (!retainSet.has(p)) deps.removeFile(p);
    }
  };
  // diag carries the flow-delegate envelope's own diagnostics through to
  // this helper's skip envelope, omit-when-absent; partialArtifactPath is
  // set ONLY for a ran-unusable skip (a dispatched agy call whose output
  // couldn't be used) whose raw artifact still exists on disk — an
  // environment-class skip (gate/prep/diff-read failure) never ran agy, so
  // there is nothing to point at.
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
    return skip("gemini-diff-unreadable");
  }
  try {
    deps.mkdirp(dirname(parsed.out));
    deps.writeFile(promptPath, buildPrompt(diff));
    deps.writeFile(schemaPath, JSON.stringify(AGENT_FINDINGS_JSON_SCHEMA));
  } catch {
    return skip("gemini-prep-failed");
  }

  const envelope = deps.runDelegate([
    "--output-format",
    "json",
    "--json-schema",
    schemaPath,
    "--prompt-file",
    promptPath,
    "--model",
    // Non-null: only the "scout" surface's default is null; reviewLens's
    // default and every well-typed override are strings.
    resolveDelegateModel("reviewLens") as string,
    "--add-dir",
    parsed.worktree,
    "--out",
    rawPath,
    "--task",
    parsed.task,
    "--timeout",
    parsed.timeout ?? resolveDelegateTimeout("reviewLens"),
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
    return skip("gemini-output-unreadable");
  }

  // Normalization applies to EVERY rung, including structured_output — this
  // is what lets a model's off-enum label still land through the ladder,
  // not just through the prose-parse rungs.
  const decoded = decodeDelegateArtifact(raw, (candidate) =>
    validateAgentFindings(normalizeParsedFindings(candidate)),
  );
  if (!decoded.ok) {
    // The former -output-unparseable and -output-schema-invalid reasons
    // collapse into one: the ladder folds validation into decoding, so once
    // no rung both parses AND validates, the two are no longer
    // distinguishable from the caller's side.
    return skip("gemini-output-unparseable");
  }

  try {
    // MANDATORY, not cosmetic: validateAgentFindings tolerates extra
    // top-level keys and returns the input unmodified, so writing
    // decoded.value directly would leak a schema-supplied `reasoning` key
    // into agent-output-gemini.json and hand the consolidator a non-
    // {findings, rejected_alternatives, anti_patterns_found} artifact.
    // Re-project to exactly those three keys. The two negative arrays route
    // through the TOLERANT collectLensNegatives — a wire-schema violation on
    // one malformed negative entry must never sink the whole cross-model
    // review (this helper already skips with `gemini-output-unparseable` on
    // a genuinely-broken payload; that path is for the whole artifact, not
    // one entry).
    const negatives = collectLensNegatives(decoded.value);
    const state = classifyLensNegatives(decoded.value);
    const finalized: {
      findings: unknown;
      rejected_alternatives?: unknown;
      anti_patterns_found?: unknown;
    } = { findings: decoded.value.findings };
    // Preserve genuine absence rather than laundering it into `[]`: the wire
    // schema now REQUIRES both keys from agy, but decoded.value may still
    // come from a salvage rung that never enforced that requirement. Only
    // write the key when the source actually carried an array (populated or
    // empty), so the consolidator's `classifyLensNegatives` can still tell
    // "lens omitted this" from "lens explicitly reported none".
    if (state.rejected_alternatives !== "absent") {
      finalized.rejected_alternatives = negatives.rejected_alternatives;
    }
    if (state.anti_patterns_found !== "absent") {
      finalized.anti_patterns_found = negatives.anti_patterns_found;
    }
    deps.writeFile(parsed.out, JSON.stringify(finalized, null, 2));
  } catch {
    return skip("gemini-finalize-failed");
  }

  cleanScratch();
  return emit(deps, {
    ran: true,
    findingsPath: parsed.out,
    decodedVia: decoded.via,
    findingCount: decoded.value.findings.length,
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
