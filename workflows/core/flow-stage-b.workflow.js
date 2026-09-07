export const meta = {
  name: "flow-stage-b",
  description: "flow pipeline stage B: merge guard → squash merge → conflict resolve → post-merge sweep",
  phases: [
    { title: "Precheck" },
    { title: "Guard" },
    { title: "Merge" },
    { title: "Resolve" },
    { title: "Sweep" },
  ],
};

/**
 * args contract:
 * {
 *   slug, worktree, pr, prUrl, planPath, skillDir,
 *   models: { mergeResolver },  // may be ''
 *   effort, launchedAt
 * }
 *
 * Result (validated against bin/lib/workflow-result-schema.ts before return):
 * { stage: "B", outcome, reason?, pr, prUrl, resolver?, sweep, summary }
 */

// A supervisor that omits the optional `models` block must not crash the
// script on its first per-phase model lookup — the eval harness's s5 run
// died on `args.models.implement` of undefined before this default.
args.models = args.models || {};
// The result envelope requires a numeric `pr`; a supervisor that built args
// with jq --arg (a string) otherwise fails flow-workflow-result-schema on
// every stage exit ({"written":true,"validated":false} on the f6 fixture).
args.pr = Number(args.pr);

const RESULT_PATH = `${args.worktree}/.flow-tmp/stage-b-result.json`;
const VALIDATE_CMD =
  `flow-workflow-result-schema --validate ${RESULT_PATH} 2>/dev/null || ` +
  `bun "$(dirname "$(readlink -f "$(command -v flow-state-update)")")/lib/workflow-result-schema.ts" --validate ${RESULT_PATH}`;

const BOOL = (k) => ({ type: "object", required: [k], properties: { [k]: { type: "boolean" } } });
const EMPTY_SWEEP = { filed: [], unfiled: [], rejected: [] };

function modelArg(model) {
  return model ? { model } : {};
}

// An agent call resolves null when the subagent dies on a terminal API error after
// retries (a classifier block, a dead session) instead of throwing. Every
// result passes through guard() so a null becomes a typed AgentUnavailable,
// caught once at the bottom into a needs-human envelope — never a TypeError
// on the next field read.
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

async function finish(result) {
  await helperAgent(
    `Using the Bash tool: 1) write EXACTLY this JSON text to ${RESULT_PATH} (mkdir -p the parent dir first): ${JSON.stringify(result)} 2) run exactly: ${VALIDATE_CMD} 3) report {written:true, validated:<true iff step 2 printed {"ok":true}>}. Do nothing else.`,
    "write-result",
    "Sweep",
    { type: "object", required: ["written", "validated"], properties: { written: { type: "boolean" }, validated: { type: "boolean" } } },
  );
  return result;
}

function terminal(outcome, reason, summary, extra) {
  return finish({ stage: "B", outcome, reason, pr: args.pr, prUrl: args.prUrl, sweep: EMPTY_SWEEP, summary, ...extra });
}

async function stageB() {
  phase("Precheck");

  const precheck = await helperAgent(
    `Using the Bash tool, run exactly: gh pr view ${args.pr} --json state,mergedAt,url,baseRefName. Report state, mergedAt (string or null), url, baseRefName.`,
    "precheck",
    "Precheck",
    { type: "object", required: ["state", "mergedAt", "url", "baseRefName"], properties: { state: { type: "string" }, mergedAt: { type: ["string", "null"] }, url: { type: "string" }, baseRefName: { type: "string" } } },
  );
  if (precheck.state === "MERGED") {
    return terminal("merged", undefined, "PR was already merged before stage B ran.", {});
  }

  phase("Guard");

  const guard = await helperAgent(
    `Using the Bash tool, run: FLOW_SLUG=${args.slug} flow-merge-guard ${args.pr} --slug ${args.slug}; echo "rc=$?". Report the printed JSON's reason (empty string if none) and the rc line's number as rc.`,
    "guard",
    "Guard",
    { type: "object", required: ["rc", "reason"], properties: { rc: { type: "number" }, reason: { type: "string" } } },
  );
  if (guard.rc === 1) {
    return terminal("guard-blocked", "guard-blocked", guard.reason || "flow-merge-guard blocked: unchecked Test Steps items and no fresh override.", {});
  }
  if (guard.rc === 2) {
    return terminal("merge-failed", "merge-failed", `flow-merge-guard error: ${guard.reason}`, {});
  }
  // Fail closed: ONLY rc === 0 (guard cleared) may proceed to Merge. Any
  // other rc (unexpected helper output, missing flow-merge-guard binary,
  // a crash) must not fall through to `gh pr merge` unguarded.
  if (guard.rc !== 0) {
    return terminal(
      "guard-blocked",
      "guard-blocked",
      guard.reason || `flow-merge-guard returned unexpected rc=${guard.rc} (expected 0, 1, or 2) — is flow-merge-guard installed and on PATH?`,
      {},
    );
  }

  phase("Merge");

  async function mergeOnce(label) {
    return helperAgent(
      `Using the Bash tool: PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, ""); print; exit}'); MERGE_STDERR=$(cd "$PRIMARY" && gh pr merge --squash ${args.pr} 2>&1 1>/dev/null); MERGE_RC=$?; echo "rc=$MERGE_RC"; printf '%s' "$MERGE_STDERR". Report rc (the number after rc=) and stderr (the rest of the output verbatim).`,
      label,
      "Merge",
      { type: "object", required: ["rc", "stderr"], properties: { rc: { type: "number" }, stderr: { type: "string" } } },
    );
  }

  const CONFLICT_PATTERNS = [
    "Pull Request is not mergeable",
    "not mergeable: the merge commit cannot be cleanly created",
    "merge conflict between",
  ];

  let merge = await mergeOnce("merge");
  if (merge.rc !== 0) {
    const isConflict = CONFLICT_PATTERNS.some((p) => merge.stderr.includes(p));

    if (isConflict) {
      phase("Resolve");

      const inputs = await helperAgent(
        `Using the Bash tool against PR ${args.pr}: BASE_BRANCH=$(gh pr view ${args.pr} --json baseRefName -q .baseRefName); rm -f ${args.worktree}/.flow-tmp/merge-resolver-result.json; (cd ${args.worktree} && git fetch origin "$BASE_BRANCH") || true; CONFLICTING_FILES=$(cd ${args.worktree} && git diff --name-only --diff-filter=U); PR_DESCRIPTION=$(gh pr view ${args.pr} --json body -q .body); jq -n --arg base "$BASE_BRANCH" --arg files "$CONFLICTING_FILES" --arg desc "$PR_DESCRIPTION" '{baseBranch:$base, conflictingFiles:$files, prDescription:$desc}'. Report baseBranch, conflictingFiles (newline-joined string, may be empty), prDescription.`,
        "resolver-inputs",
        "Resolve",
        { type: "object", required: ["baseBranch", "conflictingFiles", "prDescription"], properties: { baseBranch: { type: "string" }, conflictingFiles: { type: "string" }, prDescription: { type: "string" } } },
      );

      const artifactPath = `${args.worktree}/.flow-tmp/merge-resolver-result.json`;
      const instructionsPath = `${args.skillDir}/flow-merge-resolver-instructions/SKILL.md`;
      const markerCheckCmd = "flow-conflict-marker-check";
      const resolverPrompt =
        `Read ${instructionsPath} and follow it exactly to resolve a merge conflict.\n` +
        `WORKTREE: ${args.worktree}\nPR: ${args.pr}\nBASE_BRANCH: ${inputs.baseBranch}\n` +
        `CONFLICTING_FILES: ${inputs.conflictingFiles}\nMARKER_CHECK_CMD: ${markerCheckCmd}\n` +
        `ARTIFACT_PATH: ${artifactPath}\nPR_DESCRIPTION: ${inputs.prDescription}`;

      const resolverAgentResult = await agent(resolverPrompt, {
        agentType: "flow-module-core:flow-merge-resolver",
        label: "resolver",
        phase: "Resolve",
        effort: args.effort,
        ...modelArg(args.models.mergeResolver),
        schema: { type: "object", required: ["ran"], properties: { ran: { type: "boolean" } } },
      });

      // A denied/died Task spawn surfaces as a null resolverAgentResult
      // rather than a thrown error — fold it into the same outcome as a
      // missing resolver artifact instead of falling through to
      // resolverRead, which would crash reading a file the resolver never
      // got a chance to write.
      if (resolverAgentResult === null) {
        return terminal("resolver-missing-artifact", "resolver-missing-artifact", "The merge-resolver subagent spawn was denied or the agent died before writing a result.", { resolver: { ran: false } });
      }

      const resolverRead = await helperAgent(
        `Using the Bash tool, run: test -s ${artifactPath} && cat ${artifactPath} || echo '{"exists":false}'. Report exists (boolean), push_status (string, "skipped" when absent), and summaryFirstLine (string, may be empty).`,
        "resolver-read",
        "Resolve",
        { type: "object", required: ["exists", "push_status", "summaryFirstLine"], properties: { exists: { type: "boolean" }, push_status: { type: "string" }, summaryFirstLine: { type: "string" } } },
      );

      if (!resolverRead.exists) {
        return terminal("resolver-missing-artifact", "resolver-missing-artifact", "The merge-conflict resolver did not write an artifact.", { resolver: { ran: true } });
      }
      if (resolverRead.push_status !== "succeeded") {
        return terminal("resolver-push-failed", "merge-failed", resolverRead.summaryFirstLine || "resolver push did not succeed", { resolver: { ran: true, push_status: resolverRead.push_status } });
      }

      merge = await mergeOnce("merge-retry-after-resolve");
      if (merge.rc !== 0) {
        return terminal("merge-failed", "merge-failed", resolverRead.summaryFirstLine || merge.stderr, { resolver: { ran: true, push_status: "succeeded" } });
      }
    } else {
      merge = await mergeOnce("merge-retry-non-conflict");
      if (merge.rc !== 0) {
        return terminal("merge-failed", "merge-failed", merge.stderr, {});
      }
    }
  }

  phase("Sweep");

  const sweep = await helperAgent(
    `Using the Bash tool: PLAN="${args.planPath || `${args.worktree}/.flow-tmp/plan.md`}"; FILED=(); WARN=(); REJECTED=(); if [ -f "$PLAN" ] && grep -q '^# Candidate follow-up issues' "$PLAN"; then TICKED_JSON=$(flow-candidate-issues --plan-md-file "$PLAN" --ticked); COUNT=$(printf '%s' "$TICKED_JSON" | jq -r '.ticked | length'); for ((i = 0; i < COUNT; i++)); do ITEM=$(printf '%s' "$TICKED_JSON" | jq -c ".ticked[$i]"); TITLE=$(printf '%s' "$ITEM" | jq -r '.title'); BODY_FILE="${args.worktree}/.flow-tmp/sweep-$(echo "$TITLE" | tr ' /' '__').md"; printf '%s' "$ITEM" | jq -r --arg pr "${args.pr}" '[.body, (if .details != "" then "\\n" + .details else empty end), (if .rationale then "\\n**Rationale:** " + .rationale else empty end), (if .relation then "\\n**Relation to current request:** " + .relation else empty end), "\\nSurfaced by /flow-product-planning during the pipeline that landed PR #" + $pr + "."] | join("\\n")' > "$BODY_FILE"; JSON=$(flow-create-issue --title "$TITLE" --body-file "$BODY_FILE" --label flow-agent,out-of-scope-discovery); RC=$?; if [ $RC -eq 0 ]; then FILED+=("$(printf '%s' "$JSON" | jq -r '.url')"); elif [ $RC -eq 3 ]; then REJECTED+=("$TITLE"); else WARN+=("$TITLE"); fi; done; fi; jq -n --argjson filed "$(printf '%s\\n' "\${FILED[@]:-}" | jq -R . | jq -s 'map(select(length>0))')" --argjson unfiled "$(printf '%s\\n' "\${WARN[@]:-}" | jq -R . | jq -s 'map(select(length>0))')" --argjson rejected "$(printf '%s\\n' "\${REJECTED[@]:-}" | jq -R . | jq -s 'map(select(length>0))')" '{filed:$filed, unfiled:$unfiled, rejected:$rejected}'. Report filed, unfiled, rejected (each an array of strings).`,
    "sweep",
    "Sweep",
    { type: "object", required: ["filed", "unfiled", "rejected"], properties: { filed: { type: "array", items: { type: "string" } }, unfiled: { type: "array", items: { type: "string" } }, rejected: { type: "array", items: { type: "string" } } } },
  );

  return finish({
    stage: "B",
    outcome: "merged",
    pr: args.pr,
    prUrl: args.prUrl,
    sweep,
    summary: `Stage B merged PR #${args.pr} at ${args.launchedAt}.`,
  });
}

try {
  return await stageB();
} catch (err) {
  if (!(err instanceof AgentUnavailable)) throw err;
  log(`${err.message} — escalating`);
  return terminal("merge-failed", err.message, `Subagent ${err.label} returned no result (terminal API error after retries, e.g. a classifier block); stage B cannot continue mechanically. Nothing was merged past this point.`, {});
}
