import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_LENS_MAP } from "./flow-pr-agent-lens";
import {
  allAgentTypes,
  checkWorkflowScriptSyntax,
  everyAgentCallHasEffortAndModel,
  extractLoopCaps,
  extractWorkflowAgentSites,
  findAgentCallSites,
  parseAgentSitesDoc,
  parseDocumentedCaps,
  pluginAgentTypes,
  reviewLensAgentTypeSuffixes,
} from "./lib/workflow-script-lint";

const ROOT = join(import.meta.dirname, "..");
const STAGE_A = join(ROOT, "workflows/core/flow-stage-a.workflow.js");
const STAGE_B = join(ROOT, "workflows/core/flow-stage-b.workflow.js");
const SITES_DOC = join(ROOT, "references/workflow-agent-sites.md");
const FAILURE_RECOVERY = join(
  ROOT,
  "skills/pipeline/flow-pipeline/references/failure-recovery.md",
);

const stageA = readFileSync(STAGE_A, "utf8");
const stageB = readFileSync(STAGE_B, "utf8");
const AGENTS_CORE_DIR = join(ROOT, "agents/core");

describe("workflow scripts — structural lint", () => {
  it.each([
    ["flow-stage-a.workflow.js", stageA],
    ["flow-stage-b.workflow.js", stageB],
  ])(
    "%s: first statement is `export const meta = {` with name/description/phases",
    (_name, src) => {
      expect(src.startsWith("export const meta = {")).toBe(true);
      expect(src).toMatch(/name:\s*"flow-stage-[ab]"/);
      expect(src).toMatch(/description:\s*\n?\s*"/);
      expect(src).toMatch(/phases:\s*\[/);
    },
  );

  it.each([
    ["flow-stage-a.workflow.js", stageA],
    ["flow-stage-b.workflow.js", stageB],
  ])(
    "%s: no import/require/Date.now/Math.random/new Date/process./fs. tokens",
    (_name, src) => {
      for (const token of [
        "import ",
        "require(",
        "Date.now(",
        "Math.random(",
        "new Date(",
        "process.",
        "fs.",
      ]) {
        expect(
          src.includes(token),
          `unexpected token ${JSON.stringify(token)}`,
        ).toBe(false);
      }
    },
  );

  it.each([
    ["flow-stage-a.workflow.js", stageA],
    ["flow-stage-b.workflow.js", stageB],
  ])(
    "%s: every agent() call site passes effort: and a model key/spread",
    (_name, src) => {
      const sites = findAgentCallSites(src);
      expect(sites.length).toBeGreaterThan(0);
      const result = everyAgentCallHasEffortAndModel(src);
      expect(
        result.ok,
        `offending call offsets: ${result.offenders.join(",")}`,
      ).toBe(true);
    },
  );

  it.each([
    ["flow-stage-a.workflow.js", stageA],
    ["flow-stage-b.workflow.js", stageB],
  ])(
    "%s: every agentType resolves to agents/core/<x>.md or is general-purpose",
    (_name, src) => {
      for (const t of allAgentTypes(src)) {
        if (t === "general-purpose") continue;
        expect(
          t.startsWith("flow-module-core:"),
          `unexpected agentType ${t}`,
        ).toBe(true);
        const basename = t.replace("flow-module-core:", "");
        expect(
          existsSync(join(AGENTS_CORE_DIR, `${basename}.md`)),
          `agents/core/${basename}.md missing`,
        ).toBe(true);
      }
    },
  );

  it.each([
    ["flow-stage-a.workflow.js", STAGE_A, stageA],
    ["flow-stage-b.workflow.js", STAGE_B, stageB],
  ])("%s: is ≤600 lines (the two exempted files)", (_name, path, src) => {
    expect(src.split("\n").length).toBeLessThanOrEqual(600);
  });

  it("flow-stage-a.workflow.js: never runs `gh pr merge` or `--record-override`", () => {
    expect(stageA.includes("gh pr merge")).toBe(false);
    expect(stageA.includes("--record-override")).toBe(false);
  });

  it("flow-stage-b.workflow.js: flow-merge-guard precedes gh pr merge; exactly one merge-resolver agentType; no --record-override", () => {
    const guardIdx = stageB.indexOf("flow-merge-guard");
    const mergeIdx = stageB.indexOf("gh pr merge");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mergeIdx);
    const resolverCount = (
      stageB.match(/flow-module-core:flow-merge-resolver/g) ?? []
    ).length;
    expect(resolverCount).toBe(1);
    expect(stageB.includes("--record-override")).toBe(false);
  });

  it('flow-stage-b.workflow.js: only guard.rc === 0 may reach phase("Merge") — every other rc is guard-blocked', () => {
    const mergePhaseIdx = stageB.indexOf('phase("Merge")');
    expect(mergePhaseIdx).toBeGreaterThan(-1);
    const beforeMerge = stageB.slice(0, mergePhaseIdx);
    // The rc !== 0 fail-closed gate must appear before the Merge phase, and
    // its guard-blocked terminal branch must reference the helper-missing
    // hint so an unexpected exit code never falls through to `gh pr merge`.
    expect(beforeMerge.includes("guard.rc !== 0")).toBe(true);
    expect(beforeMerge.includes("guard-blocked")).toBe(true);
    expect(beforeMerge).toMatch(/flow-merge-guard installed and on PATH/);
  });

  it.each([
    ["flow-stage-a.workflow.js", stageA],
    ["flow-stage-b.workflow.js", stageB],
  ])(
    "%s: writes stage-<x>-result.json before the final return",
    (name, src) => {
      const stage = name.includes("stage-a") ? "a" : "b";
      const writeIdx = src.indexOf(`stage-${stage}-result.json`);
      const lastReturn = src.lastIndexOf("return finish(");
      expect(writeIdx).toBeGreaterThan(-1);
      expect(lastReturn).toBeGreaterThan(-1);
      expect(writeIdx).toBeLessThan(lastReturn);
    },
  );

  it("flow-stage-a.workflow.js: lens parity with AGENT_LENS_MAP (templated agentType covers every lens by construction)", () => {
    const suffixes = reviewLensAgentTypeSuffixes(stageA);
    // A templated `flow-module-core:flow-review-${lens}` agentType (the
    // shape stage A uses) trivially tracks AGENT_LENS_MAP by construction —
    // there is no fixed literal set to diff. A literal-enumeration shape
    // would instead need `suffixes` to equal Object.keys(AGENT_LENS_MAP).
    if (suffixes.length > 0) {
      expect(new Set(suffixes)).toEqual(new Set(Object.keys(AGENT_LENS_MAP)));
    }
  });

  it("both scripts: syntax-check clean once wrapped in an async function body (see checkWorkflowScriptSyntax doc comment)", () => {
    for (const src of [stageA, stageB]) {
      const result = checkWorkflowScriptSyntax(src);
      expect(result.ok, result.stderr).toBe(true);
    }
  });

  it("symmetry: extractWorkflowAgentSites() vs references/workflow-agent-sites.md", () => {
    expect(existsSync(SITES_DOC)).toBe(true);
    const doc = readFileSync(SITES_DOC, "utf8");
    expect(doc).toMatch(
      /Label\s*\|\s*agentType\s*\|\s*Model key\s*\|\s*Effort\s*\|\s*Artifact\s*\|\s*May nest/,
    );

    const scriptSites = new Set(
      [
        ...extractWorkflowAgentSites(stageA),
        ...extractWorkflowAgentSites(stageB),
        // reviewLensAgent's label/agentType are templated on the runtime
        // lens list — expand them the same way reviewLensAgentTypeSuffixes
        // already does for the lens-parity test above.
        ...Object.keys(AGENT_LENS_MAP).map((lens) => ({
          label: `review:${lens}`,
          agentType: `flow-module-core:flow-review-${lens}`,
        })),
      ].map((s) => `${s.label} ${s.agentType}`),
    );
    const docSites = new Set(
      parseAgentSitesDoc(doc).map((r) => `${r.label} ${r.agentType}`),
    );

    const missingFromDoc = [...scriptSites].filter((s) => !docSites.has(s));
    const missingFromScript = [...docSites].filter((s) => !scriptSites.has(s));
    expect(
      { missingFromDoc, missingFromScript },
      `doc rows missing sites the scripts declare: ${JSON.stringify(missingFromDoc)}; ` +
        `doc rows with no matching script site: ${JSON.stringify(missingFromScript)}`,
    ).toEqual({ missingFromDoc: [], missingFromScript: [] });
  });
});

describe("workflow scripts — loop-cap parity with failure-recovery.md", () => {
  const documented = parseDocumentedCaps(
    readFileSync(FAILURE_RECOVERY, "utf8"),
  );

  it("loop caps in the script match the documented caps in failure-recovery.md", () => {
    const inScript = extractLoopCaps(stageA);
    // No null on either side: a cap the extractor or the doc parser cannot
    // find must fail loudly rather than compare equal by absence.
    for (const [side, caps] of [
      ["script", inScript],
      ["failure-recovery.md", documented],
    ] as const) {
      for (const [name, value] of Object.entries(caps)) {
        expect(value, `${side}: cap '${name}' not found`).not.toBeNull();
      }
    }
    expect(inScript).toEqual(documented);
  });

  it("[negative] a doctored script literal breaks the parity", () => {
    const doctored = stageA.replace("verifyAttempts < 3", "verifyAttempts < 4");
    expect(doctored).not.toBe(stageA);
    expect(extractLoopCaps(doctored)).not.toEqual(documented);
  });

  it("[negative] a doctored doc cell breaks the parity", () => {
    const md = readFileSync(FAILURE_RECOVERY, "utf8").replace(
      "**2 fix-loops total**",
      "**5 fix-loops total**",
    );
    expect(parseDocumentedCaps(md)).not.toEqual(extractLoopCaps(stageA));
  });

  it("[negative] each helper returns null rather than a wrong number when its pattern is absent", () => {
    expect(extractLoopCaps("const x = 1;")).toEqual({
      verify: null,
      ciFix: null,
      reviewFix: null,
    });
    expect(parseDocumentedCaps("no table here")).toEqual({
      verify: null,
      ciFix: null,
      reviewFix: null,
    });
  });
});

describe("workflow script lint — negative fixtures", () => {
  // Every exported helper in bin/lib/workflow-script-lint.ts gets at least
  // one synthetic source proving the lint can FAIL. Without these the suite
  // only ever ran against the two real scripts, which pass — so a helper
  // silently returning nothing would have looked identical to a clean tree.

  it("[negative] findAgentCallSites: a source whose only `agent(` is inside `helperAgent(` yields zero sites", () => {
    const src = 'const r = helperAgent("p", "l", "Phase", BOOL("ok"));';
    expect(findAgentCallSites(src)).toEqual([]);
  });

  it("findAgentCallSites: balances nested and quoted parens inside a call body", () => {
    const src =
      'await agent(`p (with paren) ${f(1)}`, { label: "l", effort: "low", note: ")" });\nconst after = 1;';
    const sites = findAgentCallSites(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].body.endsWith(")")).toBe(true);
    expect(sites[0].body.includes("const after")).toBe(false);
  });

  it("[negative] everyAgentCallHasEffortAndModel: a call with no effort: reports its offset", () => {
    const src =
      'await agent("p", { agentType: "general-purpose", label: "l", model: "opus" });';
    const result = everyAgentCallHasEffortAndModel(src);
    expect(result.ok).toBe(false);
    expect(result.offenders).toHaveLength(1);
  });

  it("[negative] everyAgentCallHasEffortAndModel: general-purpose + non-low effort with no model is rejected, low is accepted", () => {
    const high =
      'await agent("p", { agentType: "general-purpose", label: "l", effort: "high" });';
    const low =
      'await agent("p", { agentType: "general-purpose", label: "l", effort: "low" });';
    expect(everyAgentCallHasEffortAndModel(high).ok).toBe(false);
    expect(everyAgentCallHasEffortAndModel(low).ok).toBe(true);
  });

  it("[negative] pluginAgentTypes/allAgentTypes: a non-core plugin prefix is not collected as a core type", () => {
    const src = 'agentType: "flow-module-other:flow-review-security"';
    expect(pluginAgentTypes(src)).toEqual([]);
    expect(allAgentTypes(src)).toEqual([
      "flow-module-other:flow-review-security",
    ]);
  });

  it("[negative] reviewLensAgentTypeSuffixes: a lens outside AGENT_LENS_MAP is surfaced, not dropped", () => {
    const src = 'agentType: "flow-module-core:flow-review-made-up-lens"';
    const suffixes = reviewLensAgentTypeSuffixes(src);
    expect(suffixes).toEqual(["made-up-lens"]);
    expect(Object.keys(AGENT_LENS_MAP)).not.toContain("made-up-lens");
  });

  it("[negative] extractWorkflowAgentSites: a call with a label but no agentType emits no half-filled row", () => {
    const src = 'await agent("p", { label: "orphan", effort: "low" });';
    expect(extractWorkflowAgentSites(src)).toEqual([]);
  });

  it("[negative] parseAgentSitesDoc: a row missing the agentType column is not parsed as a valid row", () => {
    const doc = ["| Label | agentType |", "| --- | --- |", "| `lonely` |"].join(
      "\n",
    );
    expect(parseAgentSitesDoc(doc)).toEqual([]);
  });

  it("[negative] checkWorkflowScriptSyntax: an unbalanced brace returns ok:false with a non-empty stderr", () => {
    const result = checkWorkflowScriptSyntax(
      'export const meta = {\n  name: "x",\n};\nif (true) {\n',
    );
    expect(result.ok).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
