export const meta = {
  name: "flow-f5-probe-resume",
  description:
    "Resume probe: same-session interrupt/resume (4a) and fresh-relaunch idempotency keyed on state.json's phaseLog (4b).",
  phases: [
    { title: "Read state", detail: "read the scratch state's phaseLog" },
    { title: "Phase A", detail: "write phase verifying + touch a marker" },
    {
      title: "Phase B",
      detail: "wait for the release marker, then write phase ci-wait",
    },
    { title: "Phase C", detail: "read back the final phaseLog" },
  ],
};

const STATE = `$HOME/.flow/state/${args.scratchSlug}.json`;

phase("Read state");

const read = await agent(
  `Nonce: ${args.nonce}. Using the Bash tool, run exactly: jq -r '[.phaseLog[]?.phase] | @json' ${STATE}. Return the parsed array as phases (an empty array if there is none). Do nothing else.`,
  {
    label: "read-phaselog",
    phase: "Read state",
    schema: {
      type: "object",
      required: ["phases"],
      properties: {
        phases: { type: "array", items: { type: "string" } },
      },
    },
  },
);

const hasA = read.phases.includes("verifying");
const hasB = read.phases.includes("ci-wait");

const RESUME_SCHEMA = {
  type: "object",
  required: ["exitCode", "wroteVia"],
  properties: {
    exitCode: { type: "number" },
    wroteVia: { type: "string", enum: ["flow-state-update", "jq"] },
  },
};

const PHASE_B_SCHEMA = {
  type: "object",
  required: ["exitCode", "wroteVia", "waitedSeconds", "released"],
  properties: {
    exitCode: { type: "number" },
    wroteVia: { type: "string", enum: ["flow-state-update", "jq", "skipped"] },
    waitedSeconds: { type: "number" },
    released: { type: "boolean" },
  },
};

phase("Phase A");

let a = null;

if (hasA) {
  log("phase A already logged — skipping");
} else {
  a = await agent(
    `Nonce: ${args.nonce}. Using the Bash tool: 1) run exactly \`FLOW_SLUG=${args.scratchSlug} flow-state-update --slug ${args.scratchSlug} --phase verifying\`. 2) If it exits non-zero, fall back to running exactly \`jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.phaseLog += [{phase:"verifying", at:$at}]' ${STATE} > ${STATE}.tmp && mv ${STATE}.tmp ${STATE}\` and report wroteVia "jq"; otherwise report wroteVia "flow-state-update". 3) Then run exactly \`touch ${args.worktree}/.flow-tmp/spike-phase-a.done\`. Report the step-1 (or step-2 fallback) helper's exit code and wroteVia. Do nothing else.`,
    {
      label: "phase-a-write",
      phase: "Phase A",
      schema: RESUME_SCHEMA,
    },
  );
}

phase("Phase B");

let b = null;

if (hasB) {
  log("phase B already logged — skipping");
} else {
  b = await agent(
    `Nonce: ${args.nonce}. Using the Bash tool (set the tool call's own timeout to 600000 ms): 1) first wait for the supervisor's release marker with exactly this loop: n=0; until [ -f ${args.worktree}/.flow-tmp/spike-release-b ]; do sleep 2; n=$((n+2)); [ $n -ge 540 ] && break; done; echo waited=$n released=$([ -f ${args.worktree}/.flow-tmp/spike-release-b ] && echo true || echo false) — record the printed waitedSeconds and released values. 2) If released is false, report exitCode -1, wroteVia "skipped", the waitedSeconds, and released false, and do nothing else — do NOT run flow-state-update or the jq fallback. 3) Otherwise run exactly \`FLOW_SLUG=${args.scratchSlug} flow-state-update --slug ${args.scratchSlug} --phase ci-wait\`; if it exits non-zero, fall back to running exactly \`jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.phaseLog += [{phase:"ci-wait", at:$at}]' ${STATE} > ${STATE}.tmp && mv ${STATE}.tmp ${STATE}\` and report wroteVia "jq"; otherwise report wroteVia "flow-state-update". Report exitCode, wroteVia, waitedSeconds, and released true. Do nothing else.`,
    {
      label: "phase-b-write",
      phase: "Phase B",
      schema: PHASE_B_SCHEMA,
    },
  );
}

phase("Phase C");

const c = await agent(
  `Nonce: ${args.nonce}. Using the Bash tool, run exactly: jq -c '.phaseLog' ${STATE}. Return it as phaseLog verbatim. Do nothing else.`,
  {
    label: "read-final-phaselog",
    phase: "Phase C",
    schema: {
      type: "object",
      required: ["phaseLog"],
      properties: {
        phaseLog: { type: "array", items: { type: "object" } },
      },
    },
  },
);

return {
  phaseLog: c.phaseLog,
  ran: { a: !hasA, b: !hasB },
  wroteVia: { a: a?.wroteVia ?? "skipped", b: b?.wroteVia ?? "skipped" },
  waitedSeconds: b?.waitedSeconds ?? null,
  released: b?.released ?? null,
  nonce: args.nonce,
};
