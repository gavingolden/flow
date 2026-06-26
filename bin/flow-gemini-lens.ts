#!/usr/bin/env bun
/**
 * Cross-model (Gemini) review lens for `/pr-review`'s multi-agent review.
 *
 * `/pr-review`'s six review agents all run on the same Claude model family,
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
 *     "Gemini 3.1 Pro (High)", flow-delegate's default 5m timeout).
 *  3. Branch on the flow-delegate envelope's `ran` field (NEVER the exit
 *     code): `ran:false` → propagate the skipReason, finalize nothing.
 *  4. `ran:true` → read the raw agy artifact, defensively extract the JSON
 *     object (extractJsonObject tolerates a prose/markdown-fence wrapper),
 *     parse, validate via the in-repo agent-finding schema. Any unusable
 *     output → dropped result + skipReason, NO consolidator-valid
 *     `agent-output-gemini.json` left behind (write-only-on-success).
 *  5. Valid → write the normalized `{findings:[...]}` to `--out` →
 *     `{ran:true,findingsPath,findingCount}`.
 *
 * Exit codes: 0 on every graceful path (callers branch on `ran`); 2 only
 * on a usage error (missing required flag).
 *
 * The agy artifact has NO `agent_source` tag — it is a plain `{findings}`
 * object identical to the six Claude agents; `agent_source:"gemini"` is
 * assigned consolidator-side at Step 3.5.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import {
  normalizeParsedFindings,
  validateAgentFindings,
} from "./lib/agent-finding-schema";

const MODEL = "Gemini 3.1 Pro (High)";
const DEFAULT_TASK = "gemini-review";

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

function buildPrompt(diff: string): string {
  return `You are a cross-model code reviewer. A separate set of reviewers running on a different model family is reviewing this same pull request; your job is to catch real issues their model family systematically under-weights. Review the whole diff below from every angle (correctness, security, performance, consistency, test coverage, supply-chain).

Read the changed files in full for surrounding context — the working tree is your current directory. The full diff is at the end of this prompt.

## Output format (LOAD-BEARING)

Output ONLY a single JSON object of shape {"findings": [...]} — no prose, no preamble, no markdown code fence. The very first character of your output must be '{' and the last must be '}'.

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

If you find nothing noteworthy, return {"findings": []}.

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
    console.error(`flow-gemini-lens: ${parsed.error}`);
    console.error(
      "usage: flow-gemini-lens --worktree <dir> --diff-file <path> --out <path> [--config <path>] [--task <name>]",
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
    return emit(deps, { ran: false, skipReason: "gemini-lens-disabled" });
  }

  // The raw agy artifact is a scratch sibling of --out; finalize --out only
  // on a fully-valid payload so the consolidator never sees a half-baked file.
  const rawPath = `${parsed.out}.agy-raw`;
  const promptPath = `${parsed.out}.prompt`;

  // Pre-clean any stale --out from a prior run on this reused worktree: every
  // path past the gate either rewrites --out (success) or leaves it absent
  // (skip), so the consolidator never consumes a previous run's findings as
  // the current review. removeFile is idempotent (force:true) — absent is fine.
  deps.removeFile(parsed.out);

  // Scratch files (prompt + raw agy output) are transient; clear both on every
  // exit so they don't accumulate in the worktree's .flow-tmp/.
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
    return skip("gemini-diff-unreadable");
  }
  try {
    deps.mkdirp(dirname(parsed.out));
    deps.writeFile(promptPath, buildPrompt(diff));
  } catch {
    return skip("gemini-prep-failed");
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
    return skip("gemini-output-unreadable");
  }

  const objText = extractJsonObject(raw);
  if (objText === null) {
    return skip("gemini-output-unparseable");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(objText);
  } catch {
    return skip("gemini-output-unparseable");
  }

  const normalized = normalizeParsedFindings(parsedJson);
  const validation = validateAgentFindings(normalized);
  if (!validation.ok) {
    return skip("gemini-output-schema-invalid");
  }

  try {
    deps.writeFile(parsed.out, JSON.stringify(validation.value, null, 2));
  } catch {
    return skip("gemini-finalize-failed");
  }

  cleanScratch();
  return emit(deps, {
    ran: true,
    findingsPath: parsed.out,
    findingCount: validation.value.findings.length,
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
