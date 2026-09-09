/**
 * Composes `/flow-pr-review`'s mechanical wrap-up (Step 11e's body write,
 * Step 12's telemetry + audit-line plumbing, Step 13's result artifact +
 * `pr-review-last-sha` marker + untracked-follow-up seeding) into one
 * call — the mirror image of `bin/lib/review-prep.ts`'s setup composition.
 * Every payload comes from an EXISTING helper run BY SUBPROCESS, never
 * re-implemented.
 *
 * The PR-body upsert runs FIRST and its two exec calls are back-to-back:
 * `flow-md-validate --fix-pr-body <file>` immediately before
 * `gh pr edit <pr> --body-file <file>`, never after, never skipped — this
 * is the property `bin/skill-md-lint.test.ts`'s BODY_EDIT_SITES lint
 * protects for the hand-written recipes this call replaces.
 *
 * JUDGMENT STAYS OUT: the PR-description quality read and the
 * intent-mismatch resolution are not absorbed here — only transcription.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validatePrReviewResult } from "./pr-review-result-schema";

export type ExecResult = { stdout: string; stderr: string; exitCode: number };
export type ExecFn = (argv: string[], opts?: { cwd?: string }) => ExecResult;

export type ReviewFinalizeSkip = { step: string; reason: string };

export type ReviewFinalize = {
  body_updated: boolean;
  result_artifact: string;
  result_valid: boolean;
  telemetry_recorded: boolean;
  untracked_added: number;
  last_sha: string;
  tier_copied: boolean;
  lens_models_forwarded: number;
  lens_tokens_forwarded: number;
  skips: ReviewFinalizeSkip[];
};

/** Isolates one sub-step: a thrown error becomes a named `skips[]` entry
 * rather than aborting the whole wrap-up — mirrors `bin/lib/review-prep.ts`'s
 * `runStep`. A missing PATH binary (e.g. a helper this PR just added, not
 * yet picked up by `flow install --upgrade`) throws from `Bun.spawnSync`;
 * without this wrapper that abort could land after the PR body was already
 * pushed, leaving the rest of the wrap-up silently undone. */
function runStep(
  skips: ReviewFinalizeSkip[],
  step: string,
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    skips.push({ step, reason: errMessage(err) });
  }
}

// Canonical step labels this skill numbers — see flow-pr-review/SKILL.md's
// "# Result artifact" contract. Default `completed_steps` on the clean
// path only; partial/escalated callers must pass their own.
const CANONICAL_STEPS = [
  "1",
  "1.5",
  "2",
  "3",
  "3.5",
  "3.6",
  "4",
  "5",
  "6",
  "7",
  "7.5",
  "8",
  "8c",
  "9",
  "10",
  "11",
  "12",
  "13",
];

export type ReviewFinalizeOptions = {
  pr: number;
  worktree: string;
  bodyFile: string;
  status: "clean" | "partial" | "escalated";
  completedSteps?: string[];
  missedSteps?: string[];
  escalationTag?: string | null;
  summary?: string;
  sessionId?: string;
  ran?: number;
  total?: number;
  prosePromoted?: number;
  reasons?: string[];
  /** Repeatable `--lens-model <lens>=<alias>` pairs, forwarded verbatim. */
  lensModels?: string[];
  /** Repeatable `--lens-tokens <lens>=<n>` pairs — the real, currently
   * supported `flow-review-telemetry collect` flag (see `bin/flow-review-telemetry.ts`). */
  lensTokens?: string[];
  /** Forwarded verbatim as `--widened <reason>` when the consolidator
   * widened scope this run. */
  widened?: string;
  exec?: ExecFn;
  readFile?: (p: string) => string | null;
  writeFile?: (p: string, content: string) => void;
};

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

export async function runReviewFinalize(
  opts: ReviewFinalizeOptions,
): Promise<ReviewFinalize> {
  const exec = opts.exec ?? defaultExec;
  const readFile = opts.readFile ?? defaultReadFile;
  const writeFile = opts.writeFile ?? defaultWriteFile;
  const dir = path.join(opts.worktree, ".flow-tmp");
  const prStr = String(opts.pr);
  const skips: ReviewFinalizeSkip[] = [];

  // 1. Body upsert — flow-md-validate --fix-pr-body ALWAYS runs, and its
  // exec call is immediately followed by gh pr edit, with no other exec
  // call in between. `--fix-pr-body` always exits 0 (see flow-md-validate.ts),
  // so a non-zero exitCode here means the process itself failed to run.
  let body_updated = false;
  {
    let bodyStale = false;
    runStep(skips, "body_repair", () => {
      // A stale `.flow-tmp/body.md` from a prior run must never clobber
      // the live PR body — verify it exists and is non-empty first.
      const existing = readFile(opts.bodyFile);
      if (existing === null || existing.trim() === "") {
        bodyStale = true;
        throw new Error(`body file missing or empty: ${opts.bodyFile}`);
      }
      const fix = exec(["flow-md-validate", "--fix-pr-body", opts.bodyFile]);
      if (fix.exitCode !== 0) {
        throw new Error(fix.stderr || "flow-md-validate --fix-pr-body failed");
      }
    });
    if (!bodyStale) {
      runStep(skips, "body_edit", () => {
        const edit = exec([
          "gh",
          "pr",
          "edit",
          prStr,
          "--body-file",
          opts.bodyFile,
        ]);
        if (edit.exitCode !== 0) {
          throw new Error(edit.stderr || "gh pr edit --body-file failed");
        }
        body_updated = true;
      });
    } else {
      skips.push({
        step: "body_edit",
        reason: "skipped — no fresh body file to push",
      });
    }
  }

  // 2. Telemetry. `--lens-model` is a sibling pipeline's addition that may
  // not have landed yet, so forwarding has to work in BOTH merge orders.
  //
  // Try-then-fall-back rather than a `--help` probe: `flow-review-telemetry`
  // has no working `--help` — it answers `unknown flag: --help` on stderr
  // AND exits 2, same as any other unrecognised flag — so a probe that
  // reads help output would report "unsupported" forever, and the exit
  // code alone can't distinguish "unknown flag" from a genuine failure
  // (both are non-zero). So attempt the call with the flags, detect the
  // helper's own `unknown flag:` reply for this flag in its output, and
  // on that one signal retry without them.
  let lens_models_forwarded = 0;
  let lens_tokens_forwarded = 0;
  let telemetry_recorded = false;
  {
    const lensModels = opts.lensModels ?? [];
    const lensTokens = opts.lensTokens ?? [];
    const baseArgs = [
      "flow-review-telemetry",
      "collect",
      "--worktree",
      opts.worktree,
      "--pr",
      prStr,
      ...(opts.sessionId ? ["--session-id", opts.sessionId] : []),
      ...lensTokens.flatMap((pair) => ["--lens-tokens", pair]),
      ...(opts.widened ? ["--widened", opts.widened] : []),
    ];
    if (lensTokens.length > 0) lens_tokens_forwarded = lensTokens.length;
    const lensModelArgs = lensModels.flatMap((pair) => ["--lens-model", pair]);
    let collect = exec([...baseArgs, ...lensModelArgs, "--append"]);
    const rejectedFlag =
      lensModels.length > 0 &&
      /unknown flag:\s*--lens-model/.test(`${collect.stdout}${collect.stderr}`);
    if (rejectedFlag) {
      skips.push({
        step: "lens_models",
        reason:
          "installed flow-review-telemetry does not accept --lens-model yet; " +
          "retried without it",
      });
      collect = exec([...baseArgs, "--append"]);
    } else if (lensModels.length > 0) {
      lens_models_forwarded = lensModels.length;
    }
    if (collect.exitCode !== 0) {
      skips.push({
        step: "telemetry",
        reason: collect.stderr || "flow-review-telemetry collect failed",
      });
    } else {
      telemetry_recorded = true;
    }
  }

  // 3. Tier pass-through from review-scope.json — copy verbatim, never
  // synthesise a default.
  let tier: unknown;
  let tier_reasons: unknown;
  let tier_copied = false;
  {
    const raw = readFile(path.join(dir, "review-scope.json"));
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if ("tier" in parsed && "tier_reasons" in parsed) {
          tier = parsed.tier;
          tier_reasons = parsed.tier_reasons;
          tier_copied = true;
        }
      } catch (err) {
        skips.push({ step: "tier", reason: errMessage(err) });
      }
    }
  }

  // 3b. Read-before-overwrite escalation guard — computed ONCE and reused
  // by both the marker write below and the result-artifact write in step
  // 5, so an already-escalated review can never be re-marked "reviewed as
  // of this sha" by a later clean/partial run through this same path.
  const resultPath = path.join(dir, "pr-review-result.json");
  let existingEscalated = false;
  {
    const existingRaw = readFile(resultPath);
    if (existingRaw !== null) {
      try {
        existingEscalated = JSON.parse(existingRaw).status === "escalated";
      } catch {
        // unparsable prior artifact — treated as not-escalated
      }
    }
  }
  const escalationWins = existingEscalated && opts.status !== "escalated";

  // 4. last_sha — LOCAL HEAD only, never `gh pr view` (head-sync stall).
  let last_sha = "";
  {
    const r = exec(["git", "rev-parse", "HEAD"], { cwd: opts.worktree });
    if (r.exitCode === 0) {
      last_sha = r.stdout.trim();
    } else {
      skips.push({
        step: "last_sha",
        reason: r.stderr || "git rev-parse HEAD failed",
      });
    }
  }
  // The marker is scoped ONLY to the clean-completion path — escalated/
  // partial runs must not write it (see flow-pr-review/SKILL.md Step 13).
  // It also must not overwrite when a PRIOR run already escalated this PR
  // — otherwise the next run's metadata triage reads the marker and
  // wrongly skips the re-review the escalation demands.
  if (opts.status === "clean" && last_sha && !escalationWins) {
    writeFile(path.join(dir, "pr-review-last-sha"), `${last_sha}\n`);
  }

  // 4b. Automation-precedence audit line — folds Step 12's
  // `flow-classify-step` call in as the default result-artifact summary
  // (only when the caller passed --ran/--total and no explicit --summary;
  // transcription of the helper's own stdout, not a judgment call).
  let auditLine: string | undefined;
  if (
    opts.summary === undefined &&
    opts.ran !== undefined &&
    opts.total !== undefined
  ) {
    const classifyArgs = [
      "flow-classify-step",
      "--ran",
      String(opts.ran),
      "--total",
      String(opts.total),
      "--prose-promoted",
      String(opts.prosePromoted ?? 0),
      ...(opts.reasons ?? []).flatMap((r) => ["--reason", r]),
    ];
    const classify = exec(classifyArgs);
    if (classify.exitCode === 0) {
      auditLine = classify.stdout.trim();
    } else {
      skips.push({
        step: "classify_step",
        reason: classify.stderr || "flow-classify-step failed",
      });
    }
  }

  // 5. Result artifact — reuses the escalation guard computed in step 3b
  // (escalation always wins over a later clean/partial write from this
  // same path), then validates before writing to the real path; on
  // failure leave the invalid candidate at `<path>.tmp` for inspection.
  let result_valid = false;
  {
    if (escalationWins) {
      skips.push({
        step: "result_artifact",
        reason: "prior status=escalated wins — left untouched",
      });
      result_valid = true;
    } else {
      const completed_steps =
        opts.completedSteps ?? (opts.status === "clean" ? CANONICAL_STEPS : []);
      const resultObj: Record<string, unknown> = {
        status: opts.status,
        completed_steps,
        missed_steps: opts.missedSteps ?? [],
        escalation_tag: opts.escalationTag ?? null,
        summary:
          opts.summary ??
          auditLine ??
          `PR #${opts.pr} review finalize: status=${opts.status}`,
      };
      if (tier_copied) {
        resultObj.tier = tier;
        resultObj.tier_reasons = tier_reasons;
      }
      const validated = validatePrReviewResult(resultObj);
      result_valid = validated.ok;
      if (result_valid) {
        writeFile(resultPath, JSON.stringify(resultObj));
      } else {
        writeFile(`${resultPath}.tmp`, JSON.stringify(resultObj));
        skips.push({
          step: "result_artifact",
          reason: validated.ok ? "" : validated.reason,
        });
      }
    }
  }

  // 6. Untracked follow-ups — guarded: a standalone run has no pipeline
  // state and `flow-untracked add` exits 2 there.
  let untracked_added = 0;
  {
    const guard = exec(["flow-untracked", "list", "--json"]);
    if (guard.exitCode !== 0) {
      skips.push({
        step: "untracked",
        reason: "no pipeline state (standalone run)",
      });
    } else {
      const raw = readFile(path.join(dir, "fix-applier-result.json"));
      if (raw === null) {
        skips.push({
          step: "untracked",
          reason: "fix-applier-result.json missing",
        });
      } else {
        try {
          const parsed = JSON.parse(raw);
          const titles: string[] = [];
          for (const d of parsed.deferred ?? []) {
            if (d.tracker_entry_url === "")
              titles.push(`${d.finding_id}: ${d.reason}`);
          }
          for (const a of parsed.anti_patterns_found ?? []) {
            if (a.introduced_by_this_pr === false) titles.push(a.pattern);
          }
          for (const title of titles) {
            if (!title) continue;
            const add = exec([
              "flow-untracked",
              "add",
              "--title",
              title,
              "--source",
              "pr-review",
            ]);
            if (add.exitCode === 0) untracked_added++;
          }
        } catch (err) {
          skips.push({ step: "untracked", reason: errMessage(err) });
        }
      }
    }
  }

  return {
    body_updated,
    result_artifact: resultPath,
    result_valid,
    telemetry_recorded,
    untracked_added,
    last_sha,
    tier_copied,
    lens_models_forwarded,
    lens_tokens_forwarded,
    skips,
  };
}
