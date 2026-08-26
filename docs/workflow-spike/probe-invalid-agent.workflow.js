export const meta = {
  name: "flow-f5-probe-invalid-agent",
  description:
    "Negative probe: a non-existent plugin-qualified agentType must reject, proving real agent-registry resolution.",
  phases: [
    {
      title: "Invalid agent",
      detail: "one agent() with a non-existent plugin-qualified agentType",
    },
  ],
};

phase("Invalid agent");

let invalidTypeError = null;

try {
  const r = await agent(
    `Nonce: ${args.nonce}. Reply with the single word ok. Run no commands, read no files.`,
    {
      agentType: "flow-module-core:no-such-agent",
      label: "invalid-agent-type",
      phase: "Invalid agent",
    },
  );
  log(`unexpected success: ${JSON.stringify(r)}`);
} catch (e) {
  invalidTypeError = String(e && e.message ? e.message : e);
  log(`invalid agentType rejected: ${invalidTypeError}`);
}

return { invalidTypeError, nonce: args.nonce };
