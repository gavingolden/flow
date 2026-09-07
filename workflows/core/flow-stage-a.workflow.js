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

// A supervisor that omits the optional `models` block must not crash the
// script on its first per-phase model lookup — the eval harness's s5 run
// died on `args.models.implement` of undefined before this default.
args.models = args.models || {};

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

// An agent call resolves null when the subagent dies on a terminal API error after
// retries (a classifier block, a dead session) instead of throwing. Every
// result whose absence is fatal passes through guard(), so a null becomes a
// typed AgentUnavailable, caught once at the bottom into a needs-human
// envelope — never a TypeError on the next field read. The three deliberate
// exceptions are named at their definitions: the two PR-body upserts
// (courtesy writes) and the review fan-out members (dropped, not fatal).
class AgentUnavailable extends Error {
  constructor(label) {
    super(`agent-unavailable: ${label}`);
    this.label = label;
  }
}

async function guard(label, pending) {
  const result = await pending;
  if (result === null || result === undefined) throw new AgentUnavailable(label);
  return result;
}

function helperAgent(prompt, label, phaseTitle, schema) {
  return guard(label, agent(prompt, { agentType: "general-purpose", label, phase: phaseTitle, effort: "low", schema }));
}

function implementAgent(prompt, label) {
  return guard(label, agent(prompt, {
    agentType: "general-purpose",
    label,
    phase: "Implement",
    effort: args.effort,
    ...modelArg(args.models.implement),
    schema: { type: "object", required: ["committed", "headSha", "summary"], properties: { committed: { type: "boolean" }, headSha: { type: "string" }, summary: { type: "string" } } },
  }));
}

function verifyAgent(prompt) {
  return guard("verify", agent(prompt, {
    agentType: "general-purpose",
    label: "verify",
    phase: "Verify",
    effort: args.effort,
    ...modelArg(args.models.implement),
    schema: { type: "object", required: ["clean", "excerpt", "uiSmoke"], properties: { clean: { type: "boolean" }, excerpt: { type: "string" }, uiSmoke: { type: "string", enum: ["passed", "skipped", "n/a"] }, uiSmokeReason: { type: "string" }, screenshots: { type: "array", items: { type: "string" } } } },
  }));
}

// The two PR-body upserts SKILL.md step 6 promises. Deliberately NOT
// guard()ed: a failed courtesy upsert must never replace the real
// escalation — the user has to read `NEEDS HUMAN: verify-exhausted`, not
// `agent-unavailable: write-verify-caution`. Each call site logs the null
// and continues. Both labels are literal at their own call site so
// references/workflow-agent-sites.md's symmetry lint can see them.
function bodyUpsertPrompt(sourceStep, buildStep) {
  return `Using the Bash tool against PR ${pr}: 1) ${sourceStep} 2) run: gh pr view ${pr} --json body --jq .body > "${args.worktree}/.flow-tmp/body.md"; if body.md has no '## Test Steps' heading, append one on its own line. 3) ${buildStep} — replace a block this stage already upserted rather than appending a second copy. 4) run exactly: flow-md-validate --fix-pr-body "${args.worktree}/.flow-tmp/body.md" && gh pr edit ${pr} --body-file "${args.worktree}/.flow-tmp/body.md". Report written:true iff step 4 exited 0. Do nothing else.`;
}

async function writeVerifyCaution(excerpt) {
  const result = await agent(
    bodyUpsertPrompt(
      `write this final verify failure excerpt to ${args.worktree}/.flow-tmp/verify-caution.txt (create parent dirs first): ${excerpt}`,
      `under '## Test Steps', upsert a '> [!CAUTION]' block quoting that excerpt`,
    ),
    { agentType: "general-purpose", label: "write-verify-caution", phase: "Verify", effort: "low", schema: BOOL("written") },
  );
  if (result === null) log("write-verify-caution returned no result — PR body not updated; continuing (the escalation reason is the payload)");
  return result;
}

async function writeUiSmokeNote(reason) {
  const result = await agent(
    bodyUpsertPrompt(
      `nothing to write for this one — go straight to step 2.`,
      `under '## Test Steps', upsert the sibling line '> [!NOTE] UI changed; browser validation did not run — ${reason}'`,
    ),
    { agentType: "general-purpose", label: "write-ui-smoke-note", phase: "Verify", effort: "low", schema: BOOL("written") },
  );
  if (result === null) log("write-ui-smoke-note returned no result — PR body not updated; continuing");
  return result;
}

// Lens + intent-guess fan-out members are deliberately UNGUARDED: an agent
// call resolves null on a terminal API error rather than rejecting, and the
// documented fan-out idiom is `.filter(Boolean)` — one dead lens is dropped
// (with a log line) instead of aborting the whole review phase. Guarding
// here would also make correctness depend on parallel()'s undocumented
// behaviour for a THROWN thunk.
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

/** Unguarded for the same reason as `reviewLensAgent` — a dead intent-guess
 * is dropped by the fan-out's `.filter(Boolean)`, never an escalation. */
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

// Escalation context lives outside stageA() so the AgentUnavailable catch
// below can build a needs-human envelope from wherever the stage died.
const ran = { implement: false, resymlink: false, verify: false, ciWait: false, review: false, gateRead: false };
const loops = { ciFix: 0, reviewFix: 0 };
const artifacts = [];
let pr = null;
let prUrl = "";

async function stageA() {
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

  Object.assign(loops, state.loops);
  pr = state.pr;
  prUrl = state.prUrl;
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
      `Using the Bash tool: 1) compose the PR body at ${args.worktree}/.flow-tmp/pr-body.md from ${args.worktree}/.flow-tmp/pr-description-draft.md if present (else a minimal conventional body), 2) run: PR_URL=$(FLOW_SLUG=${args.slug} flow-open-pr --body-file "${args.worktree}/.flow-tmp/pr-body.md" --title "<conventional-commit summary>" --slug ${args.slug}); SLUG=${args.slug}; PR=$(jq -r '.pr' ~/.flow/state/"$SLUG".json). 3) then step 5.5, exactly one command (it detects branch-added skills/agents/workflows itself, installs with one retry, and registers the post-merge follow-up): flow-stage-a-resymlink --worktree "${args.worktree}" --slug ${args.slug}; capture its stdout JSON and do NOT fail the step on a non-zero exit. Report pr (number), prUrl (string), resymlinked (that JSON's .added), and installOk (that JSON's .installOk).`,
      "open-pr",
      "Implement",
      { type: "object", required: ["pr", "prUrl", "resymlinked", "installOk"], properties: { pr: { type: "number" }, prUrl: { type: "string" }, resymlinked: { type: "boolean" }, installOk: { type: "boolean" } } },
    );
    pr = openPr.pr;
    prUrl = openPr.prUrl;
    // Step 5.5's phase write is its own agent (never folded into the
    // open-pr shell block above) so a failing install cannot swallow it —
    // `installing-skills` is what flow-resume-decide and flow-stop-guard
    // key their step-6 resume rows on.
    if (openPr.resymlinked) {
      await helperAgent(
        `Using the Bash tool, run exactly: FLOW_SLUG=${args.slug} flow-state-update --phase installing-skills --slug ${args.slug}`,
        "installing-skills-phase-write",
        "Implement",
        BOOL("ok"),
      );
    }
    if (openPr.resymlinked && !openPr.installOk) {
      return needsHuman("flow-setup-upgrade-failed", "flow install --upgrade --source failed twice; branch-added skills/agents are not symlinked.", { pr: openPr.pr, prUrl: openPr.prUrl, ran, loops, artifacts });
    }
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
    `Read ${args.skillDir}/flow-verify/SKILL.md and execute it in ${args.worktree} (its own inner loop caps at 5 re-runs). Return clean, a failure excerpt (empty string when clean), uiSmoke ('passed'|'skipped'|'n/a'), uiSmokeReason (one short clause naming why, when uiSmoke is 'skipped'), and any screenshot paths.`,
  );
  let verifyAttempts = 1;
  while (!verify.clean && verifyAttempts < 3) {
    verifyAttempts += 1;
    verify = await verifyAgent(
      `Re-run: Read ${args.skillDir}/flow-verify/SKILL.md and execute it again in ${args.worktree}. Prior attempt's excerpt: ${verify.excerpt}`,
    );
  }
  if (!verify.clean) {
    if (pr !== null) {
      await writeVerifyCaution(verify.excerpt);
      artifacts.push(`${args.worktree}/.flow-tmp/verify-caution.txt`);
    }
    return needsHuman("verify-exhausted", verify.excerpt, { pr, prUrl, ran, loops, artifacts });
  }
  ran.verify = true;
  if (pr !== null && verify.uiSmoke === "skipped") {
    await writeUiSmokeNote(verify.uiSmokeReason || "browser validation did not run");
  }

  phase("CI wait");

  await helperAgent(
    `Using the Bash tool, run exactly: FLOW_SLUG=${args.slug} flow-state-update --phase ci-wait --slug ${args.slug}`,
    "ci-wait-phase-write",
    "CI wait",
    BOOL("ok"),
  );

  // The Copilot precheck + request decision is the same answer for the whole
  // stage-A run (Copilot's deselect state and the PR's diff-classified
  // override decision don't change mid-run) — compute it once and cache it
  // rather than re-running it on every ciCheckOnce() poll iteration.
  let cachedNotRequestedFlag;
  async function notRequestedFlagOnce() {
    if (cachedNotRequestedFlag !== undefined) return cachedNotRequestedFlag;
    const copilotCheck = await helperAgent(
      `Using the Bash tool, run: flow-module-status --check copilot >/dev/null 2>&1; echo $?. Report copilotDeselected true iff the printed exit code is non-zero.`,
      "copilot-precheck",
      "CI wait",
      BOOL("copilotDeselected"),
    );
    if (copilotCheck.copilotDeselected) {
      cachedNotRequestedFlag = "--copilot-not-requested";
    } else {
      const req = await helperAgent(
        `Using the Bash tool against PR ${pr}: OVERRIDE=$(jq -r '.copilotReview // "auto"' ~/.flow/state/${args.slug}.json); GLOB_CLASS=$(gh pr diff ${pr} --name-only | flow-request-copilot --classify); DECISION_ARG=""; if [ "$GLOB_CLASS" = "ambiguous" ]; then DECISION_ARG="--decision non-trivial"; fi; VERDICT=$(gh pr diff ${pr} --name-only | flow-request-copilot --pr ${pr} --override "$OVERRIDE" $DECISION_ARG); echo "$VERDICT". Report requested (VERDICT.requestCopilot), requestable (VERDICT.copilotRequestable, default true), declineKind (VERDICT.declineKind or empty string).`,
        "ci-copilot-request",
        "CI wait",
        { type: "object", required: ["requested", "requestable", "declineKind"], properties: { requested: { type: "boolean" }, requestable: { type: "boolean" }, declineKind: { type: "string" } } },
      );
      cachedNotRequestedFlag = req.requested === false || req.requestable === false ? "--copilot-not-requested" : "";
    }
    return cachedNotRequestedFlag;
  }

  async function ciCheckOnce() {
    const notRequestedFlag = await notRequestedFlagOnce();
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
    const prep = await guard("review-prep", agent(
      `Read ${args.skillDir}/flow-pr-review/SKILL.md and run it against PR ${pr} with \`${pr} --stop-after 3-prep\`. Write each filled lens prompt to ${args.worktree}/.flow-tmp/lens-prompt-<lens>.md and the intent-guess prompt to ${args.worktree}/.flow-tmp/lens-prompt-intent-guess.md.`,
      {
        agentType: "general-purpose",
        label: "review-prep",
        phase: "Review",
        effort: args.effort,
        ...modelArg(args.models.review),
        schema: { type: "object", required: ["skip", "lenses", "widenAllowed"], properties: { skip: { type: "boolean" }, skipKind: { type: "string" }, lenses: { type: "array", items: { type: "string" } }, widenAllowed: { type: "boolean" } } },
      },
    ));

    if (!prep.skip) {
      const results = await parallel([...prep.lenses.map((lens) => () => reviewLensAgent(lens)), () => intentGuessAgent()]);
      const dropped = results.filter((r) => !r).length;
      if (dropped > 0) log(`${dropped} review agents died on a terminal API error — consolidating over the artifacts that landed`);
      results.filter(Boolean).forEach((r) => r.artifact && artifacts.push(r.artifact));

      let consolidator = await guard("consolidator", agent(
        `Read ${args.skillDir}/flow-consolidator-instructions/SKILL.md and consolidate the per-lens artifacts under ${args.worktree}/.flow-tmp/. Write ${args.worktree}/.flow-tmp/consolidator-result.json.`,
        { agentType: "flow-module-core:flow-consolidator", label: "consolidator", phase: "Review", effort: args.effort, ...modelArg(args.models.consolidator), schema: WIDEN_ARTIFACT },
      ));
      artifacts.push(consolidator.artifact);

      if (consolidator.widen && prep.widenAllowed) {
        const widenedResults = await parallel(prep.lenses.map((lens) => () => reviewLensAgent(lens)));
        widenedResults.filter(Boolean).forEach((r) => r.artifact && artifacts.push(r.artifact));
        consolidator = await guard("consolidator-widen", agent(
          `Re-consolidate: read ${args.skillDir}/flow-consolidator-instructions/SKILL.md and consolidate again over the widened per-lens artifacts under ${args.worktree}/.flow-tmp/. Write ${args.worktree}/.flow-tmp/consolidator-result.json.`,
          { agentType: "flow-module-core:flow-consolidator", label: "consolidator-widen", phase: "Review", effort: args.effort, ...modelArg(args.models.consolidator), schema: WIDEN_ARTIFACT },
        ));
        artifacts.push(consolidator.artifact);
      }

      const tail1 = await guard("review-tail-1", agent(
        `Read ${args.skillDir}/flow-pr-review/SKILL.md and resume it against PR ${pr} with \`${pr} --resume-from 3.5 --stop-after 7.5\`.`,
        { agentType: "general-purpose", label: "review-tail-1", phase: "Review", effort: args.effort, ...modelArg(args.models.review), schema: { type: "object", required: ["fixCount", "criticalUnfixed"], properties: { fixCount: { type: "number" }, criticalUnfixed: { type: "number" } } } },
      ));

      const fixApplier = await guard("fix-applier", agent(
        `Read ${args.skillDir}/flow-fix-applier-instructions/SKILL.md and apply the findings the consolidator/tail recorded against PR ${pr}. Run flow-pre-commit, commit, push. Write ${args.worktree}/.flow-tmp/fix-applier-result.json. Report written (true iff the artifact was written) and commitCount (the number of entries in the artifact's top-level "commits" array — read it back with \`jq '.commits | length' ${args.worktree}/.flow-tmp/fix-applier-result.json\`, 0 if absent/missing).`,
        { agentType: "flow-module-core:flow-fix-applier", label: "fix-applier", phase: "Review", effort: "low", ...modelArg(args.models.fixApplier), schema: { type: "object", required: ["written", "commitCount"], properties: { written: { type: "boolean" }, commitCount: { type: "number" } } } },
      ));

      await guard("review-tail-2", agent(
        `Read ${args.skillDir}/flow-pr-review/SKILL.md and resume it against PR ${pr} with \`${pr} --resume-from 8c\`. Write ${args.worktree}/.flow-tmp/pr-review-result.json.`,
        { agentType: "general-purpose", label: "review-tail-2", phase: "Review", effort: args.effort, ...modelArg(args.models.review), schema: REVIEW_STATUS },
      ));

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
        const retry = await guard("review-partial-retry", agent(
          `Read ${args.skillDir}/flow-pr-review/SKILL.md and resume it against PR ${pr} with \`${pr} --resume-from ${readBack.missed_steps[0]}\`.`,
          { agentType: "general-purpose", label: "review-partial-retry", phase: "Review", effort: args.effort, ...modelArg(args.models.review), schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } } },
        ));
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
}

try {
  return await stageA();
} catch (err) {
  if (!(err instanceof AgentUnavailable)) throw err;
  log(`${err.message} — escalating to needs-human`);
  return needsHuman(err.message, `Subagent ${err.label} returned no result (terminal API error after retries, e.g. a classifier block); stage A cannot continue mechanically.`, { pr: pr ?? 0, prUrl, ran, loops, artifacts });
}
