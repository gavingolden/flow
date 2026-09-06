export const meta = {
  name: "flow-stage-a",
  description:
    "flow pipeline stage A: implement → verify → CI wait → review → gate read (never merges)",
  phases: [
    { title: "Read state" },
    { title: "Implement" },
    { title: "Verify" },
    { title: "CI wait" },
    { title: "Review" },
    { title: "Gate read" },
  ],
};

/**
 * args contract:
 * {
 *   slug, worktree, skillDir,   // abs path of the installed flow-module-core skills dir
 *   request, planPath, effort,
 *   models: { implement, review, consolidator, fixApplier, mergeResolver }, // each may be ''
 *   copilotReview, waitForCopilot, launchedAt, lens
 * }
 *
 * Result (validated against bin/lib/workflow-result-schema.ts before return):
 * { stage: "A", outcome, decision?, reason?, pr, prUrl, ran, loops, artifacts, summary }
 */

const RESULT_PATH = `${args.worktree}/.flow-tmp/stage-a-result.json`;
// flow-workflow-result-schema is not on PATH until `flow install --upgrade`
// re-symlinks it; fall back to invoking the source module directly.
const VALIDATE_CMD =
  `flow-workflow-result-schema --validate ${RESULT_PATH} 2>/dev/null || ` +
  `bun "$(dirname "$(readlink -f "$(command -v flow-state-update)")")/lib/workflow-result-schema.ts" --validate ${RESULT_PATH}`;

// Shared schema shapes (kept as single-line consts so every call site
// below is one statement instead of a multi-line inline literal).
const BOOL = (k) => ({ type: "object", required: [k], properties: { [k]: { type: "boolean" } } });
const NUM = (k) => ({ type: "object", required: [k], properties: { [k]: { type: "number" } } });
const WRITTEN_ARTIFACT = { type: "object", required: ["written", "artifact"], properties: { written: { type: "boolean" }, artifact: { type: "string" } } };
const WIDEN_ARTIFACT = { type: "object", required: ["widen", "artifact"], properties: { widen: { type: "boolean" }, artifact: { type: "string" } } };
const REVIEW_STATUS = { type: "object", required: ["status", "missed_steps", "escalation_tag"], properties: { status: { type: "string" }, missed_steps: { type: "array", items: { type: "string" } }, escalation_tag: { type: ["string", "null"] } } };

function modelArg(model) {
  return model ? { model } : {};
}

function helperAgent(prompt, label, phaseTitle, schema) {
  return agent(prompt, { agentType: "general-purpose", label, phase: phaseTitle, effort: "low", schema });
}

function implementAgent(prompt, label) {
  return agent(prompt, {
    agentType: "general-purpose",
    label,
    phase: "Implement",
    effort: args.effort,
    ...modelArg(args.models.implement),
    schema: { type: "object", required: ["committed", "headSha", "summary"], properties: { committed: { type: "boolean" }, headSha: { type: "string" }, summary: { type: "string" } } },
  });
}

function verifyAgent(prompt) {
  return agent(prompt, {
    agentType: "general-purpose",
    label: "verify",
    phase: "Verify",
    effort: args.effort,
    ...modelArg(args.models.implement),
    schema: { type: "object", required: ["clean", "excerpt", "uiSmoke"], properties: { clean: { type: "boolean" }, excerpt: { type: "string" }, uiSmoke: { type: "string", enum: ["passed", "skipped", "n/a"] }, screenshots: { type: "array", items: { type: "string" } } } },
  });
}

function reviewLensAgent(lens) {
  return agent(`Read ${args.worktree}/.flow-tmp/lens-prompt-${lens}.md and follow it exactly.`, {
    agentType: `flow-module-core:flow-review-${lens}`,
    label: `review:${lens}`,
    phase: "Review",
    effort: args.effort,
    ...modelArg(args.models.review),
    schema: WRITTEN_ARTIFACT,
  });
}

function intentGuessAgent() {
  return agent(`Read ${args.worktree}/.flow-tmp/lens-prompt-intent-guess.md and follow it exactly.`, {
    agentType: "flow-module-core:flow-review-intent-guess",
    label: "review:intent-guess",
    phase: "Review",
    effort: args.effort,
    ...modelArg(args.models.review),
    schema: WRITTEN_ARTIFACT,
  });
}

async function writeAndValidate(path, jsonText, label, phaseTitle) {
  return helperAgent(
    `Using the Bash tool: 1) write EXACTLY this JSON text to ${path} (create parent dirs first with mkdir -p): ${jsonText} 2) run exactly: ${VALIDATE_CMD} 3) report {written:true, validated:<true iff step 2 printed {"ok":true}>}. Do nothing else.`,
    label,
    phaseTitle,
    { type: "object", required: ["written", "validated"], properties: { written: { type: "boolean" }, validated: { type: "boolean" } } },
  );
}

async function finish(result) {
  await writeAndValidate(RESULT_PATH, JSON.stringify(result), "write-result", "Gate read");
  return result;
}

// needsHuman/needsStageB assemble + finish() a terminal early-exit result so
// every escalation site stays a one-liner instead of repeating all 8 fields.
function needsHuman(reason, summary, ctx) {
  return finish({ stage: "A", outcome: "needs-human", reason, pr: ctx.pr, prUrl: ctx.prUrl, ran: ctx.ran, loops: ctx.loops, artifacts: ctx.artifacts, summary });
}

function needsStageB(reason, summary, ctx) {
  return finish({ stage: "A", outcome: "needs-stage-b", reason, pr: ctx.pr, prUrl: ctx.prUrl, ran: ctx.ran, loops: ctx.loops, artifacts: ctx.artifacts, summary });
}

phase("Read state");

const state = await helperAgent(
  `Using the Bash tool, run exactly: jq -r '{phases: [.phaseLog[]?.phase], pr: (.pr // null), prUrl: (.prUrl // ""), loops: {ciFix: (.loops.ciFix // 0), reviewFix: (.loops.reviewFix // 0)}} | @json' "$HOME/.flow/state/${args.slug}.json". Also run: [ -s "${args.worktree}/.flow-tmp/ci-wait-result.json" ] && jq empty "${args.worktree}/.flow-tmp/ci-wait-result.json" >/dev/null 2>&1 && echo true || echo false — report that as ciWaitDecided. Return the parsed jq object's fields plus ciWaitDecided. Do nothing else.`,
  "read-state",
  "Read state",
  {
    type: "object",
    required: ["phases", "pr", "prUrl", "loops", "ciWaitDecided"],
    properties: {
      phases: { type: "array", items: { type: "string" } },
      pr: { type: ["number", "null"] },
      prUrl: { type: "string" },
      loops: { type: "object", required: ["ciFix", "reviewFix"], properties: { ciFix: { type: "number" }, reviewFix: { type: "number" } } },
      ciWaitDecided: { type: "boolean" },
    },
  },
);

const ran = { implement: false, resymlink: false, verify: false, ciWait: false, review: false, gateRead: false };
const loops = { ...state.loops };
const artifacts = [];
let pr = state.pr;
let prUrl = state.prUrl;
const implementDone = pr !== null;

phase("Implement");

if (implementDone) {
  log(`implement already done (pr=${pr}) — skipping`);
} else {
  const prompt = args.planPath
    ? `/flow-new-feature ${args.request}\nPLAN: ${args.planPath}`
    : `/flow-new-feature ${args.request}`;
  await helperAgent(
    `Using the Bash tool, run exactly: FLOW_SLUG=${args.slug} flow-state-update --phase implementing --slug ${args.slug}`,
    "implement-phase-write",
    "Implement",
    BOOL("ok"),
  );
  let impl = await implementAgent(
    `Read ${args.skillDir}/flow-new-feature/SKILL.md and execute it in ${args.worktree} for the following verbatim request. It may spawn the scout/edit-applier subagents per that skill. Commit and push; do NOT open the PR. Request:\n${prompt}`,
    "implement",
  );
  if (!impl.committed) {
    impl = await implementAgent(
      `Retry: the prior implement attempt did not commit. Read ${args.skillDir}/flow-new-feature/SKILL.md and execute it in ${args.worktree} for this request, then commit and push (do NOT open the PR): ${prompt}`,
      "implement-retry",
    );
  }
  if (!impl.committed) {
    return needsHuman("implement-failed", impl.summary, { pr: 0, prUrl: "", ran, loops, artifacts });
  }
  ran.implement = true;

  const openPr = await helperAgent(
    `Using the Bash tool: 1) compose the PR body at ${args.worktree}/.flow-tmp/pr-body.md from ${args.worktree}/.flow-tmp/pr-description-draft.md if present (else a minimal conventional body), 2) run: PR_URL=$(flow-open-pr --body-file "${args.worktree}/.flow-tmp/pr-body.md" --title "<conventional-commit summary>"); SLUG=${args.slug}; PR=$(jq -r '.pr' ~/.flow/state/"$SLUG".json). 3) then inline step 5.5: DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||'); DEFAULT_BRANCH="\${DEFAULT_BRANCH:-main}"; ADDED=$(git diff --name-only --diff-filter=A "origin/$DEFAULT_BRANCH...HEAD" | grep -E '^(skills|agents|workflows)/' || true); if [ -n "$ADDED" ]; then flow install --upgrade --source "${args.worktree}"; flow-followups add --command "flow install --upgrade" --reason "new skills/agents/workflows added on this branch — re-symlink home install post-merge" --auto --registered-by "flow-stage-a:step-5.5"; fi. Report pr (number), prUrl (string), and resymlinked (true iff ADDED was non-empty).`,
    "open-pr",
    "Implement",
    { type: "object", required: ["pr", "prUrl", "resymlinked"], properties: { pr: { type: "number" }, prUrl: { type: "string" }, resymlinked: { type: "boolean" } } },
  );
  pr = openPr.pr;
  prUrl = openPr.prUrl;
  ran.resymlink = openPr.resymlinked;
}

phase("Verify");

await helperAgent(
  `Using the Bash tool, run exactly: FLOW_SLUG=${args.slug} flow-state-update --phase verifying --slug ${args.slug}`,
  "verify-phase-write",
  "Verify",
  BOOL("ok"),
);

let verify = await verifyAgent(
  `Read ${args.skillDir}/flow-verify/SKILL.md and execute it in ${args.worktree} (its own inner loop caps at 5 re-runs). Return clean, a failure excerpt (empty string when clean), uiSmoke ('passed'|'skipped'|'n/a'), and any screenshot paths.`,
);
let verifyAttempts = 1;
while (!verify.clean && verifyAttempts < 3) {
  verifyAttempts += 1;
  verify = await verifyAgent(
    `Re-run: Read ${args.skillDir}/flow-verify/SKILL.md and execute it again in ${args.worktree}. Prior attempt's excerpt: ${verify.excerpt}`,
  );
}
if (!verify.clean) {
  return needsHuman("verify-exhausted", verify.excerpt, { pr, prUrl, ran, loops, artifacts });
}
ran.verify = true;

phase("CI wait");

await helperAgent(
  `Using the Bash tool, run exactly: FLOW_SLUG=${args.slug} flow-state-update --phase ci-wait --slug ${args.slug}`,
  "ci-wait-phase-write",
  "CI wait",
  BOOL("ok"),
);

async function ciCheckOnce() {
  const copilotCheck = await helperAgent(
    `Using the Bash tool, run: flow-module-status --check copilot >/dev/null 2>&1; echo $?. Report copilotDeselected true iff the printed exit code is non-zero.`,
    "copilot-precheck",
    "CI wait",
    BOOL("copilotDeselected"),
  );
  let notRequestedFlag = "";
  if (copilotCheck.copilotDeselected) {
    notRequestedFlag = "--copilot-not-requested";
  } else {
    const req = await helperAgent(
      `Using the Bash tool against PR ${pr}: OVERRIDE=$(jq -r '.copilotReview // "auto"' ~/.flow/state/${args.slug}.json); GLOB_CLASS=$(gh pr diff ${pr} --name-only | flow-request-copilot --classify); DECISION_ARG=""; if [ "$GLOB_CLASS" = "ambiguous" ]; then DECISION_ARG="--decision non-trivial"; fi; VERDICT=$(gh pr diff ${pr} --name-only | flow-request-copilot --pr ${pr} --override "$OVERRIDE" $DECISION_ARG); echo "$VERDICT". Report requested (VERDICT.requestCopilot), requestable (VERDICT.copilotRequestable, default true), declineKind (VERDICT.declineKind or empty string).`,
      "ci-copilot-request",
      "CI wait",
      { type: "object", required: ["requested", "requestable", "declineKind"], properties: { requested: { type: "boolean" }, requestable: { type: "boolean" }, declineKind: { type: "string" } } },
    );
    if (req.requested === false || req.requestable === false) notRequestedFlag = "--copilot-not-requested";
  }
  const waitFlag = args.waitForCopilot ? "--wait-for-copilot" : "";
  return helperAgent(
    `Using the Bash tool: VERDICT_FILE="${args.worktree}/.flow-tmp/ci-wait-result.json"; rm -f "$VERDICT_FILE"; FLOW_SLUG=${args.slug} flow-ci-check ${pr} ${notRequestedFlag} ${waitFlag} --out "$VERDICT_FILE" > "${args.worktree}/.flow-tmp/ci-check-stdout.json"; cat "${args.worktree}/.flow-tmp/ci-check-stdout.json". Report the printed JSON's status, decision (or empty string), nextCheckSec (or 60), and ciFailedChecks (array of strings, or empty array).`,
    "ci-check",
    "CI wait",
    { type: "object", required: ["status", "decision", "nextCheckSec", "ciFailedChecks"], properties: { status: { type: "string" }, decision: { type: "string" }, nextCheckSec: { type: "number" }, ciFailedChecks: { type: "array", items: { type: "string" } } } },
  );
}

async function waitUntilDecided(initial, waitLabel) {
  let c = initial;
  let waits = 0;
  while (c.status === "waiting" && waits < 3) {
    waits += 1;
    await helperAgent(
      `Using the Bash tool (set the tool call's own timeout generously): flow-spawn --class default -- flow-ci-wait ${pr} --min-sec ${c.nextCheckSec} --max-sec 540. Report done:true once it returns.`,
      waitLabel,
      "CI wait",
      BOOL("done"),
    );
    c = await ciCheckOnce();
  }
  return c;
}

let check = await waitUntilDecided(await ciCheckOnce(), "ci-wait-sleep");
let ciOutcome = check.decision;
// waitUntilDecided caps at 3 polls; a status still "waiting" (empty
// decision) after that cap means CI genuinely never resolved — escalate
// rather than silently falling through to Review with an undecided CI run.
if (check.status === "waiting" && ciOutcome === "") {
  return needsHuman("ci-wait-undecided", `flow-ci-check still reported status=waiting after the poll cap; last checks: ${check.ciFailedChecks.join("\n")}`, { pr, prUrl, ran, loops, artifacts });
}
if (ciOutcome === "ci-failed") {
  // Bounded fix-loop: keep retrying implement-ci-fix while the ciFix
  // counter is still under budget (3), not just once per run.
  while (ciOutcome === "ci-failed" && loops.ciFix < 3) {
    const incr = await helperAgent(
      `Using the Bash tool, run: FLOW_SLUG=${args.slug} flow-state-update --increment-loop ciFix --slug ${args.slug}; jq -r '.loops.ciFix // 0' ~/.flow/state/${args.slug}.json. Report ciFix as that printed number.`,
      "loop-prep-ci",
      "CI wait",
      NUM("ciFix"),
    );
    loops.ciFix = incr.ciFix;
    if (loops.ciFix > 3) break;
    const fixed = await implementAgent(
      `/flow-new-feature mode:fix\nPRIOR FAILURE LOG:\n${check.ciFailedChecks.join("\n")}\nRead ${args.skillDir}/flow-new-feature/SKILL.md and execute it in ${args.worktree}. Commit and push; do NOT open a new PR.`,
      "implement-ci-fix",
    );
    if (!fixed.committed) break;
    check = await waitUntilDecided(await ciCheckOnce(), "ci-wait-sleep-after-fix");
    ciOutcome = check.decision;
    if (check.status === "waiting" && ciOutcome === "") {
      return needsHuman("ci-wait-undecided", `flow-ci-check still reported status=waiting after a ci-fix retry; last checks: ${check.ciFailedChecks.join("\n")}`, { pr, prUrl, ran, loops, artifacts });
    }
  }
  if (ciOutcome === "ci-failed" || loops.ciFix >= 3) {
    return needsHuman("ci-fix-exhausted", check.ciFailedChecks.join("\n"), { pr, prUrl, ran, loops, artifacts });
  }
}
if (ciOutcome === "pr-conflicted") {
  return needsStageB("pr-conflicted", "Branch conflicts with base; routing to stage B's merge path.", { pr, prUrl, ran, loops, artifacts });
}
if (ciOutcome === "pr-closed" || ciOutcome === "pr-blocked" || ciOutcome === "ci-hang" || ciOutcome === "merged-externally") {
  return needsHuman(ciOutcome, `flow-ci-check returned ${ciOutcome}`, { pr, prUrl, ran, loops, artifacts });
}
ran.ciWait = true;

phase("Review");

await helperAgent(
  `Using the Bash tool, run exactly: FLOW_SLUG=${args.slug} flow-state-update --phase reviewing --slug ${args.slug}`,
  "reviewing-phase-write",
  "Review",
  BOOL("ok"),
);

let reviewClean = false;
let reviewFixed = false;
for (let reviewAttempt = 0; reviewAttempt < 2 && !reviewClean; reviewAttempt += 1) {
  const prep = await agent(
    `Read ${args.skillDir}/flow-pr-review/SKILL.md and run it against PR ${pr} with \`${pr} --stop-after 3-prep\`. Write each filled lens prompt to ${args.worktree}/.flow-tmp/lens-prompt-<lens>.md and the intent-guess prompt to ${args.worktree}/.flow-tmp/lens-prompt-intent-guess.md.`,
    {
      agentType: "general-purpose",
      label: "review-prep",
      phase: "Review",
      effort: args.effort,
      ...modelArg(args.models.review),
      schema: { type: "object", required: ["skip", "lenses", "widenAllowed"], properties: { skip: { type: "boolean" }, skipKind: { type: "string" }, lenses: { type: "array", items: { type: "string" } }, widenAllowed: { type: "boolean" } } },
    },
  );

  if (!prep.skip) {
    const results = await parallel([...prep.lenses.map((lens) => () => reviewLensAgent(lens)), () => intentGuessAgent()]);
    results.forEach((r) => r.artifact && artifacts.push(r.artifact));

    let consolidator = await agent(
      `Read ${args.skillDir}/flow-consolidator-instructions/SKILL.md and consolidate the per-lens artifacts under ${args.worktree}/.flow-tmp/. Write ${args.worktree}/.flow-tmp/consolidator-result.json.`,
      { agentType: "flow-module-core:flow-consolidator", label: "consolidator", phase: "Review", effort: args.effort, ...modelArg(args.models.consolidator), schema: WIDEN_ARTIFACT },
    );
    artifacts.push(consolidator.artifact);

    if (consolidator.widen && prep.widenAllowed) {
      const widenedResults = await parallel(prep.lenses.map((lens) => () => reviewLensAgent(lens)));
      widenedResults.forEach((r) => r.artifact && artifacts.push(r.artifact));
      consolidator = await agent(
        `Re-consolidate: read ${args.skillDir}/flow-consolidator-instructions/SKILL.md and consolidate again over the widened per-lens artifacts under ${args.worktree}/.flow-tmp/. Write ${args.worktree}/.flow-tmp/consolidator-result.json.`,
        { agentType: "flow-module-core:flow-consolidator", label: "consolidator-widen", phase: "Review", effort: args.effort, ...modelArg(args.models.consolidator), schema: WIDEN_ARTIFACT },
      );
      artifacts.push(consolidator.artifact);
    }

    const tail1 = await agent(
      `Read ${args.skillDir}/flow-pr-review/SKILL.md and resume it against PR ${pr} with \`${pr} --resume-from 3.5 --stop-after 7.5\`.`,
      { agentType: "general-purpose", label: "review-tail-1", phase: "Review", effort: args.effort, ...modelArg(args.models.review), schema: { type: "object", required: ["fixCount", "criticalUnfixed"], properties: { fixCount: { type: "number" }, criticalUnfixed: { type: "number" } } } },
    );

    const fixApplier = await agent(
      `Read ${args.skillDir}/flow-fix-applier-instructions/SKILL.md and apply the findings the consolidator/tail recorded against PR ${pr}. Run flow-pre-commit, commit, push. Write ${args.worktree}/.flow-tmp/fix-applier-result.json. Report written (true iff the artifact was written) and commitCount (the number of entries in the artifact's top-level "commits" array — read it back with \`jq '.commits | length' ${args.worktree}/.flow-tmp/fix-applier-result.json\`, 0 if absent/missing).`,
      { agentType: "flow-module-core:flow-fix-applier", label: "fix-applier", phase: "Review", effort: "low", ...modelArg(args.models.fixApplier), schema: { type: "object", required: ["written", "commitCount"], properties: { written: { type: "boolean" }, commitCount: { type: "number" } } } },
    );

    await agent(
      `Read ${args.skillDir}/flow-pr-review/SKILL.md and resume it against PR ${pr} with \`${pr} --resume-from 8c\`. Write ${args.worktree}/.flow-tmp/pr-review-result.json.`,
      { agentType: "general-purpose", label: "review-tail-2", phase: "Review", effort: args.effort, ...modelArg(args.models.review), schema: REVIEW_STATUS },
    );

    const validated = await helperAgent(
      `Using the Bash tool, run: flow-pr-review-result-schema --validate ${args.worktree}/.flow-tmp/pr-review-result.json. Report the printed JSON.`,
      "validate-review",
      "Review",
      { type: "object", required: ["ok"], properties: { ok: { type: "boolean" }, reason: { type: "string" } } },
    );
    if (!validated.ok) {
      return needsHuman("pr-review-missing-artifact", "pr-review-result.json failed schema validation", { pr, prUrl, ran, loops, artifacts });
    }

    const readBack = await helperAgent(
      `Using the Bash tool, run: cat ${args.worktree}/.flow-tmp/pr-review-result.json. Report status, missed_steps, escalation_tag.`,
      "read-review-result",
      "Review",
      REVIEW_STATUS,
    );

    if (readBack.status === "escalated") {
      return needsHuman(readBack.escalation_tag || "review-escalated", "flow-pr-review escalated.", { pr, prUrl, ran, loops, artifacts });
    }
    if (readBack.status === "partial") {
      const retry = await agent(
        `Read ${args.skillDir}/flow-pr-review/SKILL.md and resume it against PR ${pr} with \`${pr} --resume-from ${readBack.missed_steps[0]}\`.`,
        { agentType: "general-purpose", label: "review-partial-retry", phase: "Review", effort: args.effort, ...modelArg(args.models.review), schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } } },
      );
      if (retry.status !== "clean") {
        return needsHuman("review-partial", readBack.missed_steps.join(","), { pr, prUrl, ran, loops, artifacts });
      }
    }

    if (fixApplier.commitCount > 0 || tail1.fixCount > 0) {
      reviewFixed = true;
      const incr = await helperAgent(
        `Using the Bash tool, run: FLOW_SLUG=${args.slug} flow-state-update --increment-loop reviewFix --slug ${args.slug}; jq -r '.loops.reviewFix // 0' ~/.flow/state/${args.slug}.json. Report reviewFix as that number.`,
        "loop-prep-review",
        "Review",
        NUM("reviewFix"),
      );
      loops.reviewFix = incr.reviewFix;
      if (loops.reviewFix >= 2) {
        return needsHuman("review-fix-exhausted", "Review fix loop exhausted (cap 2).", { pr, prUrl, ran, loops, artifacts });
      }
    } else {
      reviewClean = true;
    }
  } else {
    reviewClean = true;
  }

  if (!reviewClean && reviewFixed) {
    // A review fix commit landed; a fresh CI cycle governs before we
    // re-enter review, per SKILL.md step 8's "return to step 7" rule.
    check = await waitUntilDecided(await ciCheckOnce(), "ci-wait-sleep-review");
    if (check.decision !== "proceed-to-review" && check.decision !== "proceed-to-review-no-bot") {
      return needsHuman(check.decision || "ci-failed", "CI did not return to review-ready after a review fix commit.", { pr, prUrl, ran, loops, artifacts });
    }
  }
}
ran.review = true;

phase("Gate read");

const gate = await helperAgent(
  `Using the Bash tool, run: FLOW_SLUG=${args.slug} flow-gate-decide ${pr} --slug ${args.slug}. Report the printed JSON's decision, prUrl, reason (or empty string), and validationItems (array of strings, or empty array). This is a read-only gate check — do not attempt to merge or otherwise modify the PR.`,
  "gate-read",
  "Gate read",
  { type: "object", required: ["decision", "prUrl", "reason", "validationItems"], properties: { decision: { type: "string" }, prUrl: { type: "string" }, reason: { type: "string" }, validationItems: { type: "array", items: { type: "string" } } } },
);
ran.gateRead = true;

return finish({
  stage: "A",
  outcome: "gate-ready",
  decision: gate.decision,
  reason: gate.reason || undefined,
  pr,
  prUrl: gate.prUrl || prUrl,
  ran,
  loops,
  artifacts,
  summary: `Stage A reached gate-ready with decision=${gate.decision} at ${args.launchedAt}.`,
});
