/**
 * The `gh` observation layer for the CI/Copilot wait — every function here
 * shells out via an injected `GhRunner`. Moved from `bin/flow-ci-wait.ts` as
 * part of the flow-ci-check split (`.flow-tmp/plan.md` Task 2); the pure
 * decision matrix lives in `./ci-decision`. `flow-ci-check.ts` is the only
 * production consumer that wires this layer's observations into
 * `decideOnPoll`; `bin/flow-request-copilot.ts` also imports the retrigger
 * + reviewer-read surface directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  COPILOT_REQUEST_SLUG,
  copilotAuthorMatch,
  matchesCopilot,
  readCopilotAutoReview,
  readCopilotClaimDeadlineSec,
  readCopilotLogin as readCopilotLoginFromConfig,
} from "./copilot-config";
import { resolveSlugFromEnv } from "./session-identity";
import { readRows, registryPath } from "./proc-registry";
import { FLOW_STATE_DIR } from "./paths";
import {
  deriveCopilotRulesetEnabled,
  hasQualifyingWorkflowTrigger,
  FIX_APPLIER_COMMIT_MARKER,
  SMALL_FOLLOWUP_MAX_FILES,
  SMALL_FOLLOWUP_MAX_LOC,
  type Check,
  type PrState,
  type Review,
} from "./ci-decision";

type CmdResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (argv: string[]) => CmdResult;

export const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

/**
 * Returns true iff `.github/workflows/` contains at least one workflow
 * whose `on:` block lists a qualifying PR trigger. Short-circuits on the
 * first match. Filesystem-only — no API call.
 */
export function defaultReadWorkflowsDir(cwd: string): boolean {
  const dir = path.join(cwd, ".github", "workflows");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!(e.isFile() || e.isSymbolicLink())) continue;
    if (!/\.(ya?ml)$/i.test(e.name)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, e.name), "utf8");
    } catch {
      continue;
    }
    if (hasQualifyingWorkflowTrigger(text)) return true;
  }
  return false;
}

/**
 * Reads the Copilot login from ~/.flow/config.json `bots.copilot` via the
 * shared tolerant boundary reader (accepts both the bare-string login and
 * the `{ login, globs }` object form). Falls back to GitHub's default
 * reviewer login when the file or the field is absent.
 */
export function defaultReadCopilotLogin(): string {
  return readCopilotLoginFromConfig();
}

/** Default claim-deadline reader: the global `bots.copilotClaimDeadlineSec` override, or undefined. */
export function defaultReadClaimDeadline(): number | undefined {
  return readCopilotClaimDeadlineSec();
}

/**
 * Self-registration diagnostic: warns (stderr-only, never blocking, never
 * signal-sending) when this process is running inside a pipeline (a
 * `FLOW_SLUG` resolves) but has no row for its own pid in the process
 * registry — the visible symptom of a runbook site that launched it
 * directly instead of through the `flow-spawn` wrapper. `baseDir` has no
 * default other than the real `FLOW_STATE_DIR`, so a caller that forgets to
 * sandbox it in a test reads the developer's actual `~/.flow/state/procs/`
 * (see vitest.setup.ts's documented HOME-sandbox gap) — pass an explicit
 * `baseDir` from every test.
 *
 * A registry FILE that doesn't exist at all is deliberately treated as
 * silent-null, not a warning — that shape is indistinguishable from "no
 * `flow-spawn`-wrapped process has recorded anything yet under this slug",
 * which is unremarkable early in a pipeline, and is also what `readRows`
 * reports on its own internal read failures (it swallows its own errors and
 * reports zero rows). Only a registry that DOES have rows recorded — proving
 * the mechanism is live — but none for this pid is positive evidence this
 * process specifically bypassed the wrapper, which is the one case worth a
 * warning.
 */
export function registrySelfCheck(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
  baseDir: string = FLOW_STATE_DIR,
): string | null {
  const slug = resolveSlugFromEnv(env);
  if (slug === null) return null;
  if (!fs.existsSync(registryPath(slug, baseDir))) return null;
  const { rows } = readRows(slug, baseDir);
  if (rows.some((r) => r.pid === pid)) return null;
  return `running inside pipeline '${slug}' with no process-registry row for pid ${pid} — likely launched without the flow-spawn wrapper`;
}

/** Fetches the PR's requested-reviewers list (used at loop entry, per-poll, and for post-POST verification). Returns lowercased logins. */
export function fetchRequestedReviewers(
  prNumber: number,
  gh: GhRunner,
): string[] {
  // GitHub's GraphQL `reviewRequests` projection can omit a genuinely-queued
  // Copilot bot reviewer that the REST `requested_reviewers` endpoint still
  // reports (verified live 2026-06-11 on gavingolden/pokemon#251 — after
  // `gh pr edit --add-reviewer @copilot`, REST showed Copilot as a queued Bot
  // while `gh pr view --json reviewRequests` returned []). Union both reads so
  // a REST-only-visible Copilot is still detected by the `matchesCopilot`
  // callers. The two reads fail open independently, so one source erroring
  // never zeroes the other.
  return unionLogins(
    fetchReviewRequestLogins(prNumber, gh),
    fetchRequestedReviewersRest(prNumber, gh),
  );
}

/** GraphQL `reviewRequests` projection of the requested reviewers. Fail-open: non-zero exit / malformed JSON => []. Lowercased logins. */
function fetchReviewRequestLogins(prNumber: number, gh: GhRunner): string[] {
  const r = gh(["pr", "view", String(prNumber), "--json", "reviewRequests"]);
  if (r.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout) as {
      reviewRequests?: Array<{ login?: string }>;
    };
    return (parsed.reviewRequests ?? [])
      .map((rr) => rr.login)
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * REST `requested_reviewers` projection. The GraphQL `reviewRequests` field
 * can miss a queued Copilot bot reviewer that this endpoint reports, so the
 * pending-detection path unions both. Routed through the injected `gh` runner
 * (`gh api ...`) so it stays deterministically stubbable. Fail-open: any
 * non-zero exit or malformed JSON contributes zero logins (degrade to
 * GraphQL-only), never throws — mirroring the file's other boundary readers.
 * Returns lowercased logins (user `login`s and team `slug`s).
 */
function fetchRequestedReviewersRest(prNumber: number, gh: GhRunner): string[] {
  const r = gh([
    "api",
    `repos/{owner}/{repo}/pulls/${prNumber}/requested_reviewers`,
    "--jq",
    "[.users[]?.login, .teams[]?.slug]",
  ]);
  if (r.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.toLowerCase());
  } catch {
    return [];
  }
}

/** Lowercased set-union of two login lists, order-stable on first appearance. */
function unionLogins(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Detects whether the configured Copilot login has reviewed any of the
 * recent merged PRs on the current repo. Used as a fallback when the
 * in-flight PR's `reviewRequests` list is empty: org / repo-level
 * auto-review configurations don't populate `reviewRequests` even when
 * Copilot is guaranteed to post a review, and the supervisor must not
 * race past it (the PR #78 / 2026-05-03 incident).
 *
 * Implementation: list the last `n` merged PRs (`gh pr list --state
 * merged --limit n --json number`), then per-PR `gh pr view --json
 * reviews` and short-circuit on first match. `gh pr list --json` does
 * not expose `reviews`, so a single-call solution is unavailable; the
 * list+view pattern is repo-agnostic and reuses the injected `gh`
 * runner. Errors and malformed JSON collapse to `false`.
 *
 * why this is a LAGGING proxy, not ground truth: it infers "auto-review
 * is configured" from "Copilot reviewed recent merged PRs". After a user
 * DISABLES repo auto-review, the last `n` (~5) merged PRs still carry
 * their pre-change Copilot reviews, so this keeps returning true for ~5
 * more merged PRs until the window rolls past them. The documented escape
 * for that stale-positive is `flow-request-copilot --override always`
 * (PR #265), which hard-forces past this heuristic. The authoritative
 * signal is the `copilot_code_review` repository-ruleset rule, readable
 * via `GET /repos/{owner}/{repo}/rules/branches/{branch}` and parsed by
 * `deriveCopilotRulesetEnabled` / `observeCopilotRuleset`; but that
 * endpoint returns HTTP 403 ("Upgrade to GitHub Pro or make this
 * repository public") for private repos on a free personal account
 * (flow's own repo), so this 5-PR heuristic remains the floor whenever
 * the ruleset read is unreachable.
 */
export function fetchHistoricalBotReview(
  login: string,
  gh: GhRunner,
  n = 5,
): boolean {
  const target = copilotAuthorMatch(login);
  const list = gh([
    "pr",
    "list",
    "--state",
    "merged",
    "--limit",
    String(n),
    "--json",
    "number",
  ]);
  if (list.exitCode !== 0) return false;
  let prs: Array<{ number: number }>;
  try {
    const parsed = JSON.parse(list.stdout) as Array<{ number?: number }>;
    if (!Array.isArray(parsed)) return false;
    prs = parsed.filter(
      (p): p is { number: number } => typeof p.number === "number",
    );
  } catch {
    return false;
  }
  for (const pr of prs) {
    const view = gh(["pr", "view", String(pr.number), "--json", "reviews"]);
    if (view.exitCode !== 0) continue;
    try {
      const parsed = JSON.parse(view.stdout) as {
        reviews?: Array<{ author?: { login?: string } }>;
      };
      const matched = (parsed.reviews ?? []).some(
        (rv) =>
          typeof rv.author?.login === "string" &&
          copilotAuthorMatch(rv.author.login) === target,
      );
      if (matched) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export type PrObservation = {
  state: PrState;
  url: string;
  reviews: Review[];
  /** Current HEAD SHA of the PR branch. Empty string when `gh` omits it. */
  headRefOid: string;
  /**
   * Logins currently in `requested_reviewers` (lowercased). Re-projected
   * per poll because GitHub auto-removes Copilot after its first review,
   * so a loop-entry snapshot can stale during the wait. Empty when `gh`
   * omits `reviewRequests`. The REST union that recovers logins GraphQL
   * drops only fires when `includeRestReviewers` is true — its sole
   * consumer (`deriveCopilotSkipReason`) sits behind the `copilotConfigured`
   * guard, so the extra REST subprocess is dead work otherwise.
   */
  requestedReviewers: string[];
};

export function observePr(
  prNumber: number,
  gh: GhRunner,
  includeRestReviewers = true,
): PrObservation | null {
  const r = gh([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "state,url,reviews,headRefOid,reviewRequests",
  ]);
  if (r.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as {
      state?: string;
      url?: string;
      reviews?: Array<{
        author?: { login?: string };
        state?: string;
        commit?: { oid?: string } | null;
      }>;
      headRefOid?: string;
      reviewRequests?: Array<{ login?: string }>;
    };
    if (
      typeof parsed.url !== "string" ||
      (parsed.state !== "OPEN" &&
        parsed.state !== "MERGED" &&
        parsed.state !== "CLOSED")
    ) {
      return null;
    }
    const reviews: Review[] = (parsed.reviews ?? [])
      .filter(
        (
          rv,
        ): rv is {
          author: { login: string };
          state: string;
          commit?: { oid?: string } | null;
        } =>
          typeof rv.author?.login === "string" && typeof rv.state === "string",
      )
      .map((rv) => ({
        author: { login: rv.author.login },
        state: rv.state,
        commitOid:
          rv.commit &&
          typeof rv.commit.oid === "string" &&
          rv.commit.oid.length > 0
            ? rv.commit.oid
            : null,
      }));
    const headRefOid =
      typeof parsed.headRefOid === "string" ? parsed.headRefOid : "";
    const requestedReviewers = unionLogins(
      (parsed.reviewRequests ?? [])
        .map((rr) => rr.login)
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.toLowerCase()),
      includeRestReviewers ? fetchRequestedReviewersRest(prNumber, gh) : [],
    );
    return {
      state: parsed.state,
      url: parsed.url,
      reviews,
      headRefOid,
      requestedReviewers,
    };
  } catch {
    return null;
  }
}

/**
 * Reads the PR's mergeability projection (`mergeable` + `mergeStateStatus`).
 * FAIL-OPEN: any non-zero exit or malformed JSON returns null. This is the
 * OPPOSITE conservative direction from the sibling readers (which fail toward
 * firing a POST) — here a false `conflicting` is the expensive error (it
 * routes a non-conflicted PR to the merge path), so null (= not conflicting)
 * is the safe failure mode.
 */
export function observeMergeState(
  prNumber: number,
  gh: GhRunner,
): { mergeable: string; mergeStateStatus: string } | null {
  const r = gh([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "mergeable,mergeStateStatus",
  ]);
  if (r.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as {
      mergeable?: unknown;
      mergeStateStatus?: unknown;
    };
    return {
      mergeable: typeof parsed.mergeable === "string" ? parsed.mergeable : "",
      mergeStateStatus:
        typeof parsed.mergeStateStatus === "string"
          ? parsed.mergeStateStatus
          : "",
    };
  } catch {
    return null;
  }
}

/**
 * Reads the authoritative `copilot_code_review` ruleset signal via the
 * effective-rules API. Tri-state by design (NOT the `observeMergeState`
 * null convention): "unknown" is the explicit fall-through token the
 * `readHistoricalBotReview` default branches on to reach the heuristic
 * floor. Returns "unknown" on every unreadable path — default-branch
 * resolution failure, a non-zero `gh api` exit (covers the 403 a free
 * personal/private repo returns, plus 404/network), or malformed JSON —
 * so "couldn't read" never collapses to a definitive "off".
 */
export function observeCopilotRuleset(gh: GhRunner): boolean | "unknown" {
  const branchResult = gh([
    "repo",
    "view",
    "--json",
    "defaultBranchRef",
    "--jq",
    ".defaultBranchRef.name",
  ]);
  if (branchResult.exitCode !== 0) return "unknown";
  const branch = branchResult.stdout.trim();
  if (branch === "") return "unknown";
  // gh auto-expands {owner}/{repo} from repo context.
  const rules = gh(["api", `repos/{owner}/{repo}/rules/branches/${branch}`]);
  if (rules.exitCode !== 0) return "unknown";
  try {
    return deriveCopilotRulesetEnabled(JSON.parse(rules.stdout));
  } catch {
    return "unknown";
  }
}

/**
 * Three-tier "is Copilot review configured" resolver. Precedence: a defined
 * `bots.copilotAutoReview` config override wins outright (short-circuiting BOTH
 * the authoritative ruleset read AND the 5-PR heuristic — zero gh calls); then
 * the authoritative ruleset read; then, only when the ruleset is "unknown"
 * (unreadable — e.g. a 403 on a private free-tier repo), the historical 5-PR
 * heuristic floor.
 */
export function resolveCopilotConfigured(login: string, gh: GhRunner): boolean {
  const override = readCopilotAutoReview();
  if (override !== undefined) return override;
  const ruleset = observeCopilotRuleset(gh);
  return ruleset === "unknown" ? fetchHistoricalBotReview(login, gh) : ruleset;
}

/**
 * A `gh pr checks` row extended with the check's `startedAt`/`completedAt`
 * timestamps — the GitHub-side signal `flow-ci-check` prefers for
 * `ciTerminalAt` (a suspended/slept process can never inflate this the way
 * an in-process clock could). Absent on older `gh` (pre-2.93.0); tolerated.
 */
export type TimedCheck = Check & { startedAt?: string; completedAt?: string };

export function observeChecks(prNumber: number, gh: GhRunner): TimedCheck[] {
  const r = gh([
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "name,state,startedAt,completedAt",
  ]);
  if (r.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout) as Array<{
      name?: unknown;
      state?: unknown;
      startedAt?: unknown;
      completedAt?: unknown;
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (
          c,
        ): c is {
          name: string;
          state: string;
          startedAt?: unknown;
          completedAt?: unknown;
        } => typeof c.name === "string" && typeof c.state === "string",
      )
      .map((c) => ({
        name: c.name,
        state: c.state,
        ...(typeof c.startedAt === "string" ? { startedAt: c.startedAt } : {}),
        ...(typeof c.completedAt === "string"
          ? { completedAt: c.completedAt }
          : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * Returns true iff every commit between `fromSha` (exclusive) and
 * `toSha` (inclusive) is a merge commit (has >= 2 parents).
 *
 * Why: merging main into a PR branch as a pre-merge integration step
 * advances `headRefOid` without introducing author-authored changes
 * that warrant another Copilot pass — the diff vs base is unchanged
 * from Copilot's perspective. Firing the stale-review retrigger in
 * that case burns the one-shot budget on a no-op review.
 *
 * Failure semantics — fail-open: any `gh` non-zero exit, malformed
 * JSON, or empty commits array collapses to `false` so the caller
 * proceeds to fire the retrigger. A transient `gh` hiccup must not
 * suppress a real retrigger.
 *
 * Conservative direction: false negative = one wasted POST on a no-op
 * review (cheap — one HTTP request per invocation); false positive =
 * re-introduces PR #161's "merged before Copilot reviewed the fix"
 * bug (expensive — silent correctness regression). The cheaper
 * failure mode is to fire the POST.
 */
export function allMergeCommitsBetween(
  fromSha: string,
  toSha: string,
  gh: GhRunner,
): boolean {
  const r = gh([
    "api",
    `repos/{owner}/{repo}/compare/${fromSha}...${toSha}`,
    "--jq",
    ".commits",
  ]);
  if (r.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(parsed)) return false;
    if (parsed.length === 0) return false;
    return parsed.every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        Array.isArray((c as { parents?: unknown }).parents) &&
        (c as { parents: unknown[] }).parents.length >= 2,
    );
  } catch {
    return false;
  }
}

/**
 * Returns true iff the commits between `fromSha` (exclusive) and
 * `toSha` (inclusive) are a 'small follow-up' — a change unlikely to
 * surface new Copilot findings, so re-requesting a review would waste
 * a paid Copilot credit on a no-op pass.
 *
 * A follow-up is small when EITHER signal matches (OR composition):
 *  - Kind signal: every intervening commit subject carries the
 *    `/flow-pr-review` fix-applier marker (FIX_APPLIER_COMMIT_MARKER). A
 *    fix-applier commit is by construction a narrow review-fix.
 *  - Size signal: total changed LOC (additions + deletions summed
 *    across files) <= SMALL_FOLLOWUP_MAX_LOC AND distinct files
 *    touched <= SMALL_FOLLOWUP_MAX_FILES (LOC and files compose with
 *    AND).
 *
 * Failure semantics — fail-open: any `gh` non-zero exit, malformed
 * JSON, or empty `messages` array collapses to `false` so the caller
 * proceeds to fire the retrigger. A transient `gh` hiccup must not
 * suppress a real retrigger.
 *
 * Conservative direction: false negative = one wasted POST on a no-op
 * review (cheap — one HTTP request per invocation); false positive =
 * suppresses a real fix's Copilot review, re-introducing PR #161's
 * stale-review correctness regression (expensive). The cheaper
 * failure mode is to fire the POST. Mirrors `allMergeCommitsBetween`.
 */
export function isSmallFollowup(
  fromSha: string,
  toSha: string,
  gh: GhRunner,
): boolean {
  const r = gh([
    "api",
    `repos/{owner}/{repo}/compare/${fromSha}...${toSha}`,
    "--jq",
    "{ messages: [.commits[].commit.message], files: [.files[]? | { additions, deletions, filename }] }",
  ]);
  if (r.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const messages = (parsed as { messages?: unknown }).messages;
    const files = (parsed as { files?: unknown }).files;
    if (!Array.isArray(messages) || messages.length === 0) return false;

    // Kind signal: every intervening commit is a /flow-pr-review fix-applier
    // review-fix commit (subject line carries the (pr-review #N) marker).
    const allFixApplier = messages.every(
      (m) =>
        typeof m === "string" &&
        FIX_APPLIER_COMMIT_MARKER.test(m.split("\n")[0]),
    );
    if (allFixApplier) return true;

    // Size signal: small total diff AND few distinct files touched.
    if (!Array.isArray(files)) return false;
    let loc = 0;
    const names = new Set<string>();
    for (const f of files) {
      if (typeof f !== "object" || f === null) continue;
      const fo = f as {
        additions?: unknown;
        deletions?: unknown;
        filename?: unknown;
      };
      if (typeof fo.additions === "number") loc += fo.additions;
      if (typeof fo.deletions === "number") loc += fo.deletions;
      if (typeof fo.filename === "string") names.add(fo.filename);
    }
    return (
      loc <= SMALL_FOLLOWUP_MAX_LOC && names.size <= SMALL_FOLLOWUP_MAX_FILES
    );
  } catch {
    return false;
  }
}

/**
 * Re-requests Copilot on the PR via gh's native Copilot-reviewer support
 * (`gh pr edit <pr> --add-reviewer @copilot`) — the verified request mechanism
 * (gh 2.88.x). The older `gh api … requested_reviewers` POST with the
 * `<login>[bot]` form 422'd because the request slug is `@copilot`, not the
 * review-author login. The same call backs both the stale-review retrigger
 * here and `flow-request-copilot`'s initial request.
 *
 * Returns `{ ok: true, stderr: "" }` on `exitCode === 0`, `{ ok: false,
 * stderr: r.stderr }` otherwise. No retry logic; the caller (the run
 * loop) consumes the one-shot retrigger budget regardless of POST
 * success per the PRD's recorded-on-failure rule.
 */
export function retriggerCopilotReview(
  prNumber: number,
  gh: GhRunner,
): { ok: boolean; stderr: string } {
  const r = gh([
    "pr",
    "edit",
    String(prNumber),
    "--add-reviewer",
    COPILOT_REQUEST_SLUG,
  ]);
  if (r.exitCode === 0) return { ok: true, stderr: "" };
  return { ok: false, stderr: r.stderr };
}
