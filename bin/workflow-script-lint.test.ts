import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_LENS_MAP } from "./flow-pr-agent-lens";
import {
  allAgentTypes,
  checkWorkflowScriptSyntax,
  everyAgentCallHasEffortAndModel,
  extractWorkflowAgentSites,
  findAgentCallSites,
  parseAgentSitesDoc,
  reviewLensAgentTypeSuffixes,
} from "./lib/workflow-script-lint";

const ROOT = join(import.meta.dirname, "..");
const STAGE_A = join(ROOT, "workflows/core/flow-stage-a.workflow.js");
const STAGE_B = join(ROOT, "workflows/core/flow-stage-b.workflow.js");
const SITES_DOC = join(ROOT, "references/workflow-agent-sites.md");

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
