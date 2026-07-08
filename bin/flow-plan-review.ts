#!/usr/bin/env bun
/**
 * Cross-model (AGY) plan review for `/flow-pipeline` Step 3's Layer-2 pass.
 *
 * When the consumer opts into `review.gemini`, this adds ONE
 * genuinely-different-model reviewer of the PRD's `## Decision analysis`
 * decisions, delegated to the user's Google AI Ultra quota via `flow-delegate`
 * (agy). Config-gated, opt-in, purely additive: every failure path is a
 * graceful exit-0 skip; callers branch on the envelope's `ran`, never the exit
 * code. Unlike `flow-gemini-lens`, AGY's output here is RAW PROSE the
 * supervisor weighs — not a `{findings}` schema — so the raw agy artifact is
 * copied straight to `--out` with no JSON extraction/validation tail.
 *
 * Skip vocabulary: `plan-review-disabled` (gate off), `plan-unreadable`,
 * `no-decision-analysis` (omit-when-empty ⇒ nothing to review),
 * `decision-analysis-unchanged` (the `## Decision analysis` body is
 * byte-identical modulo formatting to the last reviewed revision — see the
 * hash helpers below), `agy-not-found` (propagated from a `ran:false`
 * delegate), `agy-error` (delegate output unparseable), and the local
 * IO-throw defensive skips `plan-prep-failed`, `plan-output-unreadable`,
 * `plan-finalize-failed`. Exit 2 only on a usage error.
 *
 * Revision-pass re-fire: on a step-3 re-entry the supervisor re-runs this
 * helper unconditionally; the `decision-analysis-unchanged` skip is what makes
 * the re-fire cost-free when the reviewed decisions did not change. The
 * supervisor embeds a `<!-- flow-plan-review-hash: <sha> -->` marker for the
 * next pass to compare against — but it must source that hash from the
 * compute-only `--print-hash` mode run on the FINAL plan AFTER it revises the
 * `## Decision analysis` body per AGY feedback, NOT from the `ran:true`
 * envelope's `decisionAnalysisHash` (which is computed over the pre-revision
 * body and would embed a stale marker that falsely re-fires the next pass). The
 * hash is over a NORMALIZED body (not raw bytes) so incidental whitespace /
 * bullet-char churn during an unrelated revision edit does not needlessly
 * re-fire the review; a missing or malformed prior marker re-fires
 * (safe/wasteful) and self-heals (the run re-emits the hash), never a
 * wrong-skip.
 *
 * --print-hash: a compute-only mode that prints `computeDecisionHash` of the
 * plan named by `--plan-file` with NO agy call and NO config gate — tolerant
 * (an unreadable plan or an absent section prints the empty-body hash, exit 0).
 * It is how the supervisor re-embeds a fresh marker over the final revised body.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const MODEL = "Gemini 3.1 Pro (High)";
const DEFAULT_TASK = "plan-review";

export type Args = {
  planFile: string;
  out: string;
  config: string;
  task: string;
  printHash: boolean;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // --print-hash is a valueless boolean (compute-only mode); handle it before
    // the value-required check every other flag falls through to.
    if (flag === "--print-hash") {
      out.printHash = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--plan-file":
        out.planFile = value;
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
  if (out.planFile === undefined) {
    return { error: "--plan-file is required" };
  }
  // --out gates the review mode only; --print-hash needs just --plan-file.
  if (!out.printHash && out.out === undefined) {
    return { error: "--out is required" };
  }
  return {
    planFile: out.planFile,
    out: out.out ?? "",
    config: out.config ?? `${homedir()}/.flow/config.json`,
    task: out.task ?? DEFAULT_TASK,
    printHash: out.printHash ?? false,
  };
}

// Strict-boolean gate: enable ONLY when the parsed config is an object with
// `review` an object and `review.gemini === true`. Tolerant on input — an
// absent/malformed config (unparseable JSON, wrong shape) is `false`, never a
// throw. Reuses the exact `flow-gemini-lens` isGeminiLensEnabled shape so the
// same `review.gemini` opt-in gates the PR-review lens and this plan review;
// deliberately NOT imported (the two helpers stay independent).
export function isPlanReviewEnabled(rawConfigText: string): boolean {
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

// The Layer-2 gate's second half: the PRD's omit-when-empty `## Decision
// analysis` section is the signal that discovery found ≥1 consequential
// diverging decision worth cross-reviewing. Its absence ⇒ nothing to review.
export function hasDecisionAnalysis(planText: string): boolean {
  return /^## Decision analysis/m.test(planText);
}

// --- Decision-analysis-unchanged skip (revision-pass re-fire guard) ---------

/**
 * Extracts the `## Decision analysis` section BODY — from the heading to the
 * next `## ` heading (Recommendation follows it) or EOF — EXCLUDING any
 * `### Cross-model review (AGY)` subsection this helper appends on a prior
 * run. Excluding the subsection is load-bearing: it is what lets a revision
 * that only appends/edits the review output hash equal, so the review does
 * not re-fire on its own footprint. Returns "" when the section is absent.
 */
export function extractDecisionAnalysisBody(planText: string): string {
  const lines = planText.split("\n");
  const startIdx = lines.findIndex((l) => /^## Decision analysis/.test(l));
  if (startIdx === -1) return "";
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  let bodyEnd = endIdx;
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (/^### Cross-model review \(AGY\)/.test(lines[i])) {
      bodyEnd = i;
      break;
    }
  }
  return lines.slice(startIdx + 1, bodyEnd).join("\n");
}

/**
 * Normalizes a Decision-analysis body before hashing so only a SEMANTIC
 * change re-fires the review — a byte-for-byte SHA over LLM-generated markdown
 * is fragile (the AGY cross-model review flagged this). Normalization: trim
 * per-line trailing whitespace, normalize a leading `*`/`+` bullet marker to
 * `-`, collapse blank-line runs to one, and strip leading/trailing blank
 * lines. Pure string work — never throws.
 */
export function normalizeDecisionBody(body: string): string {
  const normed = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .map((l) => l.replace(/^(\s*)[*+](\s)/, "$1-$2"));
  const collapsed: string[] = [];
  let prevBlank = false;
  for (const l of normed) {
    const blank = l.trim() === "";
    if (blank && prevBlank) continue;
    collapsed.push(l);
    prevBlank = blank;
  }
  while (collapsed.length && collapsed[0].trim() === "") collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === "")
    collapsed.pop();
  return collapsed.join("\n");
}

/**
 * sha256 (hex) of the NORMALIZED Decision-analysis body. The stable content
 * key the revision-pass re-fire guard compares against the embedded marker.
 */
export function computeDecisionHash(planText: string): string {
  const body = normalizeDecisionBody(extractDecisionAnalysisBody(planText));
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Parses the `<!-- flow-plan-review-hash: <sha> -->` marker a prior run's
 * supervisor embedded. Tolerant: returns null when the marker is absent or
 * malformed (a truncated / non-64-hex value), which re-fires the review — the
 * safe direction (wasteful, never a wrong-skip). Lowercased for a stable
 * compare against `computeDecisionHash`'s output.
 */
export function readPriorHash(planText: string): string | null {
  const m = planText.match(
    /<!--\s*flow-plan-review-hash:\s*([0-9a-fA-F]{64})\s*-->/,
  );
  return m ? m[1].toLowerCase() : null;
}

function buildPrompt(plan: string): string {
  return `You are a cross-model plan reviewer. A PRD drafted by a different model family (Claude) is below. Its author both wrote the plan and named its own risks in one context, so it shares that model's blind spots. Your job is to independently pressure-test the PRD's consequential design decisions — especially the ones in its \`## Decision analysis\` section — and surface consequences the author under-weighted.

Your output is INPUT the supervisor weighs against codebase context it can see and you cannot — it is NOT a verdict. Reason at the end-user and PRD level (named skills, pipeline steps, consumer repos). Do NOT trace code paths you cannot see: when you are uncertain whether a flow holds, flag the uncertainty explicitly — never fabricate a concrete flow to sound authoritative.

Go decision by decision. For each consequential decision the PRD forks on, apply these lenses:

1. **User-perspective branch walk-through** — for each branch, narrate the concrete downstream flow an end user experiences. Where do the branches actually diverge for the user?
2. **System-perspective flow** — for a decision that makes no user-visible difference, narrate the system/pipeline flow each branch produces instead.
3. **Second-order ripple (PRD-level)** — what does each branch trigger downstream: which named skills, pipeline steps, or consumer repos does it touch or perturb? Scope this to surfaces named in the PRD; do not invent code-level effects.
4. **Exclusivity / combination ranking** — are the decisions mutually exclusive or complementary? Enumerate the viable combinations and rank them; name the dominant one.
5. **Missing branch** — is there an option the PRD did not enumerate, including "do nothing" / reject-the-feature?
6. **Pre-mortem** — assume the chosen decision shipped and failed; narrate the most likely reason. A different model surfaces different failure modes than the author's own pre-mortem.

Write prose (or lightly-structured markdown), organized by decision. Be concrete and specific; skip praise and preamble. If a decision is genuinely well-converged, say so briefly and move on.

## PRD

${plan}`;
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
    console.error(`flow-plan-review: ${parsed.error}`);
    console.error(
      "usage: flow-plan-review --plan-file <path> --out <path> [--config <path>] [--task <name>]",
    );
    console.error("       flow-plan-review --print-hash --plan-file <path>");
    return 2;
  }

  // Compute-only mode: print the current plan's decision-analysis hash with no
  // agy call and no config gate. Tolerant — an unreadable plan hashes the empty
  // body (exit 0). The supervisor runs this on the FINAL plan (after it revises
  // `## Decision analysis` per AGY feedback) so the embedded marker reflects the
  // revised body, not the pre-revision body the ran:true envelope captured.
  if (parsed.printHash) {
    let plan = "";
    try {
      plan = deps.readFile(parsed.planFile);
    } catch {
      plan = "";
    }
    deps.writeOut(computeDecisionHash(plan));
    return 0;
  }

  // Gate: read the config tolerantly and enable only on strict boolean true.
  let rawConfig = "";
  try {
    rawConfig = deps.readConfig(parsed.config);
  } catch {
    rawConfig = "";
  }
  if (!isPlanReviewEnabled(rawConfig)) {
    return emit(deps, { ran: false, skipReason: "plan-review-disabled" });
  }

  // The raw agy artifact is a scratch sibling of --out; --out is finalized only
  // on a ran:true delegate so a skip never leaves a stale feedback file.
  const rawPath = `${parsed.out}.agy-raw`;
  const promptPath = `${parsed.out}.prompt`;
  deps.removeFile(parsed.out);
  const cleanScratch = () => {
    deps.removeFile(promptPath);
    deps.removeFile(rawPath);
  };
  const skip = (skipReason: string): number => {
    cleanScratch();
    return emit(deps, { ran: false, skipReason });
  };

  let plan: string;
  try {
    plan = deps.readFile(parsed.planFile);
  } catch {
    return skip("plan-unreadable");
  }
  if (!hasDecisionAnalysis(plan)) {
    return skip("no-decision-analysis");
  }

  // Revision-pass re-fire guard: skip the (expensive) delegate when the
  // Decision-analysis body is unchanged (modulo formatting) since the last
  // reviewed revision. Computed BEFORE the prompt/delegate so a matching hash
  // never spends agy quota. A missing/malformed prior marker re-fires.
  const priorHash = readPriorHash(plan);
  if (priorHash !== null && priorHash === computeDecisionHash(plan)) {
    return skip("decision-analysis-unchanged");
  }

  try {
    deps.mkdirp(dirname(parsed.out));
    deps.writeFile(promptPath, buildPrompt(plan));
  } catch {
    return skip("plan-prep-failed");
  }

  const envelope = deps.runDelegate([
    "--prompt-file",
    promptPath,
    "--model",
    MODEL,
    "--add-dir",
    dirname(parsed.planFile),
    "--out",
    rawPath,
    "--task",
    parsed.task,
  ]);

  // Branch on the `ran` field (NEVER the exit code): flow-delegate exits 0 even
  // on a graceful agy-absent skip, propagated verbatim.
  if (!envelope.ran) {
    return skip(envelope.skipReason ?? "agy-not-found");
  }

  let raw: string;
  try {
    raw = deps.readFile(envelope.artifactPath ?? rawPath);
  } catch {
    return skip("plan-output-unreadable");
  }
  try {
    deps.writeFile(parsed.out, raw);
  } catch {
    return skip("plan-finalize-failed");
  }

  cleanScratch();
  // Deliberately NOT emitting the pre-revision decision hash: the supervisor
  // re-embeds the marker from `--print-hash` run on the FINAL (revised) plan, so
  // a hash of the pre-revision body here would only invite a stale-marker embed.
  return emit(deps, {
    ran: true,
    feedbackPath: parsed.out,
    skipReason: null,
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
