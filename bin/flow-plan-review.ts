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
 * `no-decision-analysis` (omit-when-empty ⇒ nothing to review), `agy-not-found`
 * (propagated from a `ran:false` delegate), `agy-error` (delegate output
 * unparseable), and the local IO-throw defensive skips `plan-prep-failed`,
 * `plan-output-unreadable`, `plan-finalize-failed`. Exit 2 only on a usage error.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

const MODEL = "Gemini 3.1 Pro (High)";
const DEFAULT_TASK = "plan-review";

export type Args = {
  planFile: string;
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
  const REQUIRED_FLAG = {
    planFile: "--plan-file",
    out: "--out",
  } as const;
  for (const k of ["planFile", "out"] as const) {
    if (out[k] === undefined)
      return { error: `${REQUIRED_FLAG[k]} is required` };
  }
  return {
    planFile: out.planFile as string,
    out: out.out as string,
    config: out.config ?? `${homedir()}/.flow/config.json`,
    task: out.task ?? DEFAULT_TASK,
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
    return 2;
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
