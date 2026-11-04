/**
 * Runtime-surface detection shared by flow-plan-lint's `## Instrumentation`
 * and `### Runtime design` checks: the path heuristics that decide whether a
 * plan's tasks touch a runtime surface, the plan-section slicing helpers, and
 * the Runtime design check itself.
 */

export const RUNTIME_PATH_RE =
  /(?<![\w-])(?:api|server|workers?|jobs?|queues?|cron)\/|\+server\.|\+(?:page|layout)\.server\.|hooks\.server\./;

export const NON_RUNTIME_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.md$/i;

/** Eval fixtures are synthetic repos; a path inside one is not a runtime surface of this repo. */
export const EVAL_FIXTURE_PATH_RE = /(?:^|\/)evals\/[^/]+\/[^/]+\/fixture\//;

/** Slice `text` from `startIdx` up to (but not including) the next top-level
 * (`# `) or second-level (`## `) heading — whichever comes first. Bounds a
 * section body without assuming a specific closing heading. */
export function sliceToNextHeading(text: string, startIdx: number): string {
  const rest = text.slice(startIdx);
  const next = rest.search(/^#{1,2} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The `# PRD` top-level section wraps the whole structured PRD, which
 * itself opens with a nested `# [Feature Name]` heading (per
 * discovery-instructions.md step 8) — so bounding "the PRD section" by
 * "the next `# ` heading" would false-negative on that nested title. Bound
 * instead by the next KNOWN sibling top-level section
 * (`# Candidate follow-up issues` / `# Task breakdown` /
 * `# PR description draft`), or end-of-file when none is present.
 */
export function findPrdSectionEnd(planText: string, startIdx: number): number {
  const rest = planText.slice(startIdx);
  const siblingRe =
    /^# (?:Candidate follow-up issues|Task breakdown|PR description draft)\s*$/m;
  const m = rest.match(siblingRe);
  return m ? startIdx + (m.index ?? rest.length) : planText.length;
}

/**
 * Joins a sub-bullet's soft-wrapped continuation lines into one logical
 * line: starting at `startIndex` within `text`, consume lines up to (but
 * not including) the next line that starts a new sub-bullet (`/^\s*- /`),
 * the next markdown heading line (`/^#{1,6} /`), or the end of the text, and
 * join them with single spaces. Markdown in
 * this repo is routinely soft-wrapped (see `example-prd.md`'s
 * `**Recommended:**` and `## Recommendation` verdict entries), so matching
 * only the first physical line misses a trailing tag pair that lands on a
 * later wrapped line.
 */
export function joinLogicalLine(text: string, startIndex: number): string {
  const rest = text.slice(startIndex);
  // Match a NEW bullet line, i.e. one preceded by a newline — `^` under the
  // `m` flag also matches index 0 of `rest` (the current bullet's own start),
  // which would end the join before it begins.
  const nextBulletMatch = rest.match(/\n\s*- |\n#{1,6} /);
  const end =
    nextBulletMatch && nextBulletMatch.index !== undefined
      ? nextBulletMatch.index
      : rest.length;
  return rest
    .slice(0, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

/** Runtime-surface paths named on the plan's task `**Files:**` lines. */
export function listTaskRuntimeFiles(planText: string): string[] {
  return [...planText.matchAll(/^\s*- \*\*Files:\*\*/gm)]
    .map((m) => joinLogicalLine(planText, m.index ?? 0))
    .flatMap((line) =>
      line
        .replace(/^- \*\*Files:\*\*\s*/, "")
        .split(/[,;\s]+/)
        .map((tok) => tok.replace(/^`|`$/g, ""))
        .filter((tok) => !NON_RUNTIME_FILE_RE.test(tok))
        .filter((tok) => !EVAL_FIXTURE_PATH_RE.test(tok)),
    )
    .filter((tok) => RUNTIME_PATH_RE.test(tok));
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/** Body after the heading at `match`, bounded at the next `#`, `##` or `###` heading. */
function sliceToNextSubHeading(text: string, startIdx: number): string {
  const rest = text.slice(startIdx);
  const next = rest.search(/^#{1,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * `### Runtime design` is always-present inside the `# PRD` section's
 * `## Architecture Decisions`: a spec table plus `**Proportionality:**` line
 * for a plan that touches a runtime surface, or one `none — <reason>` line.
 * Scoped to the PRD so a copy in the `# PR description draft` never
 * satisfies it.
 */
export function checkRuntimeDesign(planText: string, misses: string[]): void {
  const prdMatch = planText.match(/^# PRD\s*$/m);
  if (!prdMatch) return;
  const afterPrd = (prdMatch.index ?? 0) + prdMatch[0].length;
  const prdBody = stripComments(
    planText.slice(afterPrd, findPrdSectionEnd(planText, afterPrd)),
  );
  const adMatch = prdBody.match(/^## Architecture Decisions\s*$/m);
  const adBody = adMatch
    ? sliceToNextHeading(prdBody, (adMatch.index ?? 0) + adMatch[0].length)
    : "";
  const match = adBody.match(/^### Runtime design\s*$/m);
  if (!match) {
    misses.push(
      "missing '### Runtime design' under '## Architecture Decisions' — every plan must spec its execution model or affirm none with a reason",
    );
    return;
  }
  const body = sliceToNextSubHeading(
    adBody,
    (match.index ?? 0) + match[0].length,
  ).trim();
  if (body === "") {
    misses.push(
      "'### Runtime design' is empty — spec the runtime operations or write 'none — <reason>'",
    );
    return;
  }
  if (!/^none\b/i.test(body)) {
    if (!/^\|/m.test(body)) {
      misses.push(
        "'### Runtime design' names a spec but carries no markdown table row — add the Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound table",
      );
    }
    if (!/^\*\*Proportionality:\*\*/m.test(body)) {
      misses.push(
        "'### Runtime design' names a spec but carries no '**Proportionality:**' line — name what was deliberately left out",
      );
    }
    return;
  }
  const reason = body.match(/^none\s*(?:—|–|--?|:)\s*(\S[\s\S]*)$/i);
  if (!reason) {
    misses.push(
      "'### Runtime design' says 'none' with no reason — write 'none — <reason>' naming why no handler, job, queue consumer, scheduler or outbound call changes",
    );
    return;
  }
  const instrMatch = prdBody.match(/^## Instrumentation\s*$/m);
  if (instrMatch) {
    const instrBody = sliceToNextHeading(
      prdBody,
      (instrMatch.index ?? 0) + instrMatch[0].length,
    ).trim();
    if (instrBody !== "" && !/^none\b/i.test(instrBody)) {
      misses.push(
        "'### Runtime design' says 'none' but the plan's metrics spec covers a runtime surface — spec the execution model, or reconcile the two sections",
      );
    }
  }
  if (/refactor-only|no behaviou?r change/i.test(reason[1])) return;
  if (listTaskRuntimeFiles(planText).length > 0) {
    misses.push(
      "'### Runtime design' says 'none' but a task's **Files:** names a runtime path (route, server, worker, job, queue or cron) — spec the execution model, or say the change is refactor-only / has no behaviour change",
    );
  }
}
