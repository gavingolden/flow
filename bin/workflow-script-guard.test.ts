import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Executes a stage script under a stubbed Workflow-tool runtime so the
// AgentUnavailable path (an agent call resolving null — a classifier block,
// a dead session) is exercised end-to-end: the script must return a
// validated needs-human / merge-failed envelope and hand it to the
// write-result agent, never crash on the next field read (the live
// f6 fixture run died on `retry.status` of a null before this guard).
const WORKFLOWS = join(__dirname, "..", "workflows", "core");

type Call = { prompt: string; opts: Record<string, unknown> };

function runScript(
  file: string,
  args: unknown,
  respond: (label: string, call: Call) => unknown,
): Promise<{ result: unknown; calls: Call[]; logs: string[] }> {
  const src = readFileSync(join(WORKFLOWS, file), "utf8").replace(
    /^export const meta/m,
    "const meta",
  );
  const calls: Call[] = [];
  const logs: string[] = [];
  const agent = async (prompt: string, opts: Record<string, unknown>) => {
    const call = { prompt, opts };
    calls.push(call);
    return respond(String(opts.label), call);
  };
  // Strict semantics on purpose: the real `parallel()` is undocumented for a
  // THROWN thunk, so the stub does NOT swallow rejections. A lens whose
  // result must be dropped has to resolve null on its own (stage A's fan-out
  // members are deliberately unguarded) — a `.catch(() => null)` here would
  // mask a re-introduced guard() and pass a script that aborts the whole
  // review phase on one dead lens in production.
  const parallel = async (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((t) => t()));
  const body = new Function(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "workflow",
    `return (async () => {${src}\n})();`,
  );
  return body(
    agent,
    parallel,
    undefined,
    () => {},
    (m: string) => logs.push(m),
    args,
    { total: null, spent: () => 0, remaining: () => Infinity },
    undefined,
  ).then((result: unknown) => ({ result, calls, logs }));
}

/**
 * A schema-shaped stand-in for any helper agent the test does not care
 * about: every declared property answered with its type's zero value (an
 * enum's first member), so the script's field reads all succeed and the run
 * reaches the site under test.
 */
function synthesizeFromSchema(call: Call): Record<string, unknown> {
  const schema = call.opts.schema as
    | {
        properties?: Record<
          string,
          { type?: string | string[]; enum?: string[]; items?: unknown }
        >;
      }
    | undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema?.properties ?? {})) {
    const t = Array.isArray(v.type) ? v.type[0] : v.type;
    out[k] = v.enum
      ? v.enum[0]
      : t === "boolean"
        ? true
        : t === "number"
          ? 0
          : t === "array"
            ? []
            : t === "object"
              ? {}
              : "";
  }
  return out;
}

const STAGE_A_ARGS = {
  slug: "guard-test",
  worktree: "/tmp/guard-test",
  skillDir: "/tmp/skills",
  request: "docs: test",
  planPath: "",
  effort: "low",
  launchedAt: "2026-01-01T00:00:00Z",
  lens: "pm",
  models: {
    implement: "",
    review: "",
    consolidator: "",
    fixApplier: "",
    mergeResolver: "",
  },
  copilotReview: false,
  waitForCopilot: false,
};

describe("workflow scripts — AgentUnavailable guard", () => {
  it("stage A: a null read-state agent becomes a needs-human envelope handed to write-result", async () => {
    const { result, calls, logs } = await runScript(
      "flow-stage-a.workflow.js",
      STAGE_A_ARGS,
      (label) =>
        label === "read-state" ? null : { written: true, validated: true },
    );
    expect(result).toMatchObject({
      stage: "A",
      outcome: "needs-human",
      reason: "agent-unavailable: read-state",
      pr: 0,
      prUrl: "",
    });
    const write = calls.find((c) => c.opts.label === "write-result");
    expect(write?.prompt).toContain('"reason":"agent-unavailable: read-state"');
    expect(logs.some((l) => l.includes("agent-unavailable: read-state"))).toBe(
      true,
    );
  });

  it("stage A: a null lens inside the review fan-out is dropped, not dereferenced", async () => {
    // Drive the script to the review fan-out with the minimum stubs, then
    // kill one lens; the run must reach the consolidator (which we then
    // null to stop the script deterministically).
    const { result, logs } = await runScript(
      "flow-stage-a.workflow.js",
      STAGE_A_ARGS,
      (label, call) => {
        if (label === "read-state")
          return {
            phases: ["implementing"],
            pr: 7,
            prUrl: "https://x/7",
            loops: { ciFix: 0, reviewFix: 0 },
            ciWaitDecided: false,
          };
        if (label === "verify")
          return { clean: true, excerpt: "", uiSmoke: "n/a", screenshots: [] };
        if (label.startsWith("ci-check"))
          return {
            status: "decided",
            decision: "proceed-to-review",
            reason: "",
            ciFailedChecks: "",
            copilotSkipReason: "",
          };
        if (label === "review:security") return null;
        if (label.startsWith("review:"))
          return { written: true, artifact: `/tmp/${label}.json` };
        if (label === "consolidator") return null;
        const out = synthesizeFromSchema(call);
        if (label === "review-prep")
          Object.assign(out, {
            skip: false,
            lenses: ["security", "bug-detection"],
            widenAllowed: false,
          });
        return out;
      },
    );
    expect(result).toMatchObject({
      outcome: "needs-human",
      reason: "agent-unavailable: consolidator",
    });
    expect(logs.some((l) => /1 review agents died/.test(l))).toBe(true);
  });

  it("stage A: a null review-prep agent becomes a needs-human envelope, not a TypeError", async () => {
    // 97d25e7's null-guard sweep missed this one site: `prep.skip` was read
    // off a bare `await agent(...)`, so a denied/died review-prep spawn
    // crashed the script with a raw TypeError and wrote no result artifact.
    const { result, calls } = await runScript(
      "flow-stage-a.workflow.js",
      STAGE_A_ARGS,
      (label, call) => {
        if (label === "read-state")
          return {
            phases: ["implementing"],
            pr: 7,
            prUrl: "https://x/7",
            loops: { ciFix: 0, reviewFix: 0 },
            ciWaitDecided: false,
          };
        if (label === "verify")
          return { clean: true, excerpt: "", uiSmoke: "n/a", screenshots: [] };
        if (label.startsWith("ci-check"))
          return {
            status: "decided",
            decision: "proceed-to-review",
            reason: "",
            ciFailedChecks: "",
            copilotSkipReason: "",
          };
        if (label === "review-prep") return null;
        return synthesizeFromSchema(call);
      },
    );
    expect(result).toMatchObject({
      stage: "A",
      outcome: "needs-human",
      reason: "agent-unavailable: review-prep",
      pr: 7,
    });
    const write = calls.find((c) => c.opts.label === "write-result");
    expect(write?.prompt).toContain(
      '"reason":"agent-unavailable: review-prep"',
    );
  });

  it("stage B: a null precheck agent becomes a merge-failed envelope, nothing merged", async () => {
    const { result, calls } = await runScript(
      "flow-stage-b.workflow.js",
      {
        slug: "guard-test",
        worktree: "/tmp/guard-test",
        skillDir: "/tmp/skills",
        pr: 7,
        prUrl: "https://x/7",
        effort: "low",
        launchedAt: "2026-01-01T00:00:00Z",
        models: { mergeResolver: "" },
      },
      (label) =>
        label === "precheck" ? null : { written: true, validated: true },
    );
    expect(result).toMatchObject({
      stage: "B",
      outcome: "merge-failed",
      reason: "agent-unavailable: precheck",
    });
    expect(calls.some((c) => /gh pr merge/.test(c.prompt))).toBe(false);
  });
});
