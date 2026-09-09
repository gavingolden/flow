/**
 * Composes `/flow-pr-review` Step 2's fetch + Step 3's Preparation items
 * 2-6 into one call. Every payload comes from an EXISTING helper run BY
 * SUBPROCESS, never re-implemented — see each `runStep` call below for the
 * exact command (`flow-fetch-pr-review`'s `advancePhase("reviewing", ...)`
 * side effect is why it, not a re-derivation, makes Step 8's phase write
 * unskippable; `flow-review-scope`'s `review-scope.json` is READ back
 * untouched, never rewritten; static-analysis capture is stdout-only —
 * merging stderr in would corrupt the JSON envelope).
 *
 * Each sub-step runs in its own try/catch and appends a named `skips[]`
 * entry rather than aborting the others. Only sub-steps that break scope
 * computation itself (PR fetch/metadata, review-scope diff/changed-file
 * list) are `critical: true`. `completeness` is `"partial"` on ANY skip,
 * but `critical_skips` is what callers gate lens fan-out on — a
 * non-critical hiccup must never force all six lenses to run.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ExecResult = { stdout: string; stderr: string; exitCode: number };
export type ExecFn = (argv: string[], opts?: { cwd?: string }) => ExecResult;

export type ReviewPrepSkip = {
  step: string;
  reason: string;
  critical: boolean;
};

export type ReviewPrep = {
  pr: number;
  state: string;
  draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  size_band: "small" | "large" | "very-large";
  scope: "full" | "delta";
  gated_lenses: string[];
  delta_files: string[];
  prompt_interpretation_tension: boolean;
  completeness: "full" | "partial";
  critical_skips: string[];
  paths: {
    fetch: string;
    commits: string;
    static_analysis: string;
    review_scope: string;
    diff: string;
    intent_comments: string;
  };
  notices: string[];
  skips: ReviewPrepSkip[];
  tier?: unknown;
  tier_reasons?: unknown;
};

export type ReviewPrepOptions = {
  pr: number;
  worktree: string;
  exec?: ExecFn;
  readFile?: (p: string) => string | null;
  writeFile?: (p: string, content: string) => void;
};

const COMMITS_JQ =
  '.commits[] | "\\(.oid[0:7]) \\(.messageHeadline)\\n\\(.messageBody)\\n---"';

function defaultExec(argv: string[], opts?: { cwd?: string }): ExecResult {
  const r = Bun.spawnSync(argv, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    exitCode: r.exitCode ?? 1,
  };
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultWriteFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sizeBand(totalLines: number): ReviewPrep["size_band"] {
  if (totalLines >= 1000) return "very-large";
  if (totalLines >= 400) return "large";
  return "small";
}

/** Isolates one sub-step: a thrown error becomes a named, tiered `skips[]` entry. */
function runStep(
  skips: ReviewPrepSkip[],
  step: string,
  critical: boolean,
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    skips.push({ step, reason: errMessage(err), critical });
  }
}

export async function runReviewPrep(
  opts: ReviewPrepOptions,
): Promise<ReviewPrep> {
  const exec = opts.exec ?? defaultExec;
  const readFile = opts.readFile ?? defaultReadFile;
  const writeFile = opts.writeFile ?? defaultWriteFile;
  const dir = path.join(opts.worktree, ".flow-tmp");
  const prStr = String(opts.pr);

  const paths = {
    fetch: path.join(dir, "pr-review-fetch.md"),
    commits: path.join(dir, "pr-commits.md"),
    static_analysis: path.join(dir, "static-analysis.json"),
    review_scope: path.join(dir, "review-scope.json"),
    diff: path.join(dir, "diff.txt"),
    intent_comments: path.join(dir, "intent-comments.md"),
  };

  const skips: ReviewPrepSkip[] = [];
  const notices: string[] = [];
  let state = "";
  let draft = false;
  let additions = 0;
  let deletions = 0;
  let changed_files = 0;
  let scope: ReviewPrep["scope"] = "full";
  let gated_lenses: string[] = [];
  let delta_files: string[] = [];
  let tier: unknown;
  let tier_reasons: unknown;
  let prompt_interpretation_tension = false;

  runStep(skips, "fetch", true, () => {
    const fetchResult = exec(["flow-fetch-pr-review", prStr]);
    if (fetchResult.exitCode !== 0) {
      throw new Error(fetchResult.stderr || "flow-fetch-pr-review failed");
    }
    writeFile(paths.fetch, fetchResult.stdout);

    const metaResult = exec([
      "gh",
      "pr",
      "view",
      prStr,
      "--json",
      "state,isDraft,additions,deletions,changedFiles",
    ]);
    if (metaResult.exitCode !== 0) {
      throw new Error(metaResult.stderr || "gh pr view (metadata) failed");
    }
    const meta = JSON.parse(metaResult.stdout);
    state = typeof meta.state === "string" ? meta.state : "";
    draft = Boolean(meta.isDraft);
    additions = Number(meta.additions) || 0;
    deletions = Number(meta.deletions) || 0;
    changed_files = Number(meta.changedFiles) || 0;
  });

  runStep(skips, "commits", false, () => {
    const r = exec([
      "gh",
      "pr",
      "view",
      prStr,
      "--json",
      "commits",
      "-q",
      COMMITS_JQ,
    ]);
    if (r.exitCode !== 0)
      throw new Error(r.stderr || "gh pr view (commits) failed");
    writeFile(paths.commits, r.stdout);
  });

  runStep(skips, "static_analysis", false, () => {
    // Stdout-only — progress lines go to stderr; merging them in would
    // corrupt the JSON envelope this reads back.
    const r = exec(["flow-pr-static-analysis", prStr]);
    if (r.exitCode !== 0)
      throw new Error(r.stderr || "flow-pr-static-analysis failed");
    writeFile(paths.static_analysis, r.stdout);
  });

  runStep(skips, "review_scope", true, () => {
    const r = exec([
      "flow-review-scope",
      "--pr",
      prStr,
      "--worktree",
      opts.worktree,
      "--json",
    ]);
    if (r.exitCode !== 0)
      throw new Error(r.stderr || "flow-review-scope failed");
    for (const line of r.stderr.split("\n")) {
      if (line.startsWith("NOTICE")) notices.push(line);
    }
    // Pass-through, not parse-through: read the artifact flow-review-scope
    // already wrote and re-emit its fields untouched — never rewrite it.
    const raw = readFile(paths.review_scope);
    if (raw === null)
      throw new Error("review-scope.json missing after flow-review-scope run");
    const parsed = JSON.parse(raw);
    scope = parsed.scope === "delta" ? "delta" : "full";
    delta_files = Array.isArray(parsed.delta_files) ? parsed.delta_files : [];
    if (parsed.gates && typeof parsed.gates === "object") {
      gated_lenses = Object.entries(
        parsed.gates as Record<string, { run?: boolean }>,
      )
        .filter(([, verdict]) => verdict?.run === false)
        .map(([lens]) => lens);
    }
    if ("tier" in parsed) tier = parsed.tier;
    if ("tier_reasons" in parsed) tier_reasons = parsed.tier_reasons;
  });

  runStep(skips, "intent_comments", false, () => {
    const r = exec(["flow-fetch-intent-comments", prStr]);
    if (r.exitCode !== 0)
      throw new Error(r.stderr || "flow-fetch-intent-comments failed");
    writeFile(paths.intent_comments, r.stdout);
  });

  runStep(skips, "gatekeeper", false, () => {
    const raw = readFile(path.join(dir, "gatekeeper-result.json"));
    if (raw === null) return;
    const parsed = JSON.parse(raw);
    prompt_interpretation_tension = Boolean(
      parsed.prompt_interpretation_tension,
    );
  });

  const result: ReviewPrep = {
    pr: opts.pr,
    state,
    draft,
    additions,
    deletions,
    changed_files,
    size_band: sizeBand(additions + deletions),
    scope,
    gated_lenses,
    delta_files,
    prompt_interpretation_tension,
    completeness: skips.length > 0 ? "partial" : "full",
    critical_skips: skips.filter((s) => s.critical).map((s) => s.step),
    paths,
    notices,
    skips,
  };
  if (tier !== undefined) result.tier = tier;
  if (tier_reasons !== undefined) result.tier_reasons = tier_reasons;
  return result;
}
