export const meta = {
  name: "flow-f5-probe-capabilities",
  description:
    "Linear capability probe: PATH-bound helpers, plugin-qualified agents (model/effort pins + tools allowlist), and a gate hand-back that never merges.",
  phases: [
    { title: "Preflight", detail: "confirm the run-time environment" },
    { title: "Helpers", detail: "invoke a PATH-bound helper via an agent" },
    {
      title: "Agents",
      detail: "spawn plugin-qualified agents and observe pins",
    },
    { title: "Gate", detail: "map the real gate decision to a stop verdict" },
  ],
};

phase("Preflight");

const preflight = await agent(
  `Nonce: ${args.nonce}. Using the Bash tool, run exactly these commands and report their raw outputs: 1) \`printenv CLAUDE_CODE_SUBAGENT_MODEL || true\` (report null if it printed nothing), 2) \`command -v flow-gate-decide\`, 3) \`command -v flow-state-update\`, 4) \`printenv FLOW_SLUG || true\` (report null if it printed nothing). Take no other action.`,
  {
    label: "preflight-env",
    phase: "Preflight",
    schema: {
      type: "object",
      required: [
        "subagentModelEnv",
        "gateDecidePath",
        "stateUpdatePath",
        "flowSlugEnv",
      ],
      properties: {
        subagentModelEnv: { type: ["string", "null"] },
        gateDecidePath: { type: "string" },
        stateUpdatePath: { type: "string" },
        flowSlugEnv: { type: ["string", "null"] },
      },
    },
  },
);

phase("Helpers");

const helpers = await agent(
  `Nonce: ${args.nonce}. Using the Bash tool, run exactly this command (bare command name — do NOT resolve or prefix a path): \`FLOW_SLUG=${args.scratchSlug} flow-gate-decide ${args.pr} --slug ${args.scratchSlug}\`. Capture its stdout JSON and its exit code. Return the JSON's decision, prState, and prUrl fields plus the exit code verbatim. Run nothing else, never edit or merge anything.`,
  {
    label: "gate-decide-helper",
    phase: "Helpers",
    schema: {
      type: "object",
      required: ["decision", "prState", "prUrl", "autoMerge", "rawExitCode"],
      properties: {
        decision: { type: "string" },
        prState: { type: "string" },
        prUrl: { type: "string" },
        autoMerge: { type: "boolean" },
        rawExitCode: { type: "number" },
      },
    },
  },
);

phase("Agents");

const MODEL_SCHEMA = {
  type: "object",
  required: ["model", "done"],
  properties: {
    model: { type: "string" },
    done: { type: "boolean" },
  },
};

const MODEL_PROMPT = `Nonce: ${args.nonce}. Reply via the structured output with your exact model id/name as you know it (the model you are running as) and done: true. Run no commands, read no files, take no other action.`;

const [gatekeeper, fixApplier, control, toolsProbe] = await parallel([
  () =>
    agent(MODEL_PROMPT, {
      agentType: "flow-module-core:flow-gatekeeper",
      label: "pin-model-haiku",
      phase: "Agents",
      schema: MODEL_SCHEMA,
    }),
  () =>
    agent(MODEL_PROMPT, {
      agentType: "flow-module-core:flow-fix-applier",
      label: "pin-effort-low",
      phase: "Agents",
      schema: MODEL_SCHEMA,
    }),
  () =>
    agent(MODEL_PROMPT, {
      agentType: "general-purpose",
      label: "control-general-purpose",
      phase: "Agents",
      schema: MODEL_SCHEMA,
    }),
  () =>
    agent(
      `Nonce: ${args.nonce}. Using the Bash tool, attempt to run exactly: echo ${args.nonce}. Then reply via the structured output with bashAvailable true if the Bash tool executed the command, false if the Bash tool was unavailable/denied to you, and error set to the exact error text if any (null otherwise). Do nothing else.`,
      {
        agentType: "flow-module-core:flow-review-bug-detection",
        label: "tools-allowlist-no-bash",
        phase: "Agents",
        schema: {
          type: "object",
          required: ["bashAvailable", "error"],
          properties: {
            bashAvailable: { type: "boolean" },
            error: { type: ["string", "null"] },
          },
        },
      },
    ),
]);

const models = { gatekeeper, fixApplier, control };

phase("Gate");

const decision = helpers ? helpers.decision : null;
const verdict = decision === "auto-merge" ? "would-auto-merge" : "stop";
log(
  `gate verdict: ${verdict} (decision=${decision}) — handing control back, no merge`,
);

return {
  verdict,
  decision,
  prState: helpers?.prState ?? null,
  prUrl: helpers?.prUrl ?? null,
  autoMerge: helpers?.autoMerge ?? null,
  models,
  toolsProbe,
  preflight,
  nonce: args.nonce,
};
