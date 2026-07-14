import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint for the `flow feature create --research` / `forceResearch` wiring.
 *
 * The force-research feature is a contract spread across five surfaces — the
 * `forceResearch` state field + validator, the `--research` CLI parse/strip,
 * the discovery Step 1.5 skip-note ("force with `flow feature create --research`"), the
 * `flow feature create --help` documentation, and the `RESEARCH: force-on` marker token
 * that threads the force-on signal supervisor -> /flow-product-planning -> discovery
 * across three skill files. None of the five is import-coupled to the others,
 * so a future edit could silently drop one (e.g. remove the help line, the
 * skip-note prose, or rename the marker in one file) and leave the rest
 * dangling. This lint freezes their co-presence: removing any one wiring point
 * goes red on `npm run verify`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATE_TS_PATH = path.resolve(HERE, "lib", "state.ts");
const FEATURE_TS_PATH = path.resolve(HERE, "lib", "feature.ts");
const HELP_TS_PATH = path.resolve(HERE, "lib", "help.ts");
const DISCOVERY_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "references",
  "discovery-instructions.md",
);
const PIPELINE_SKILL_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "SKILL.md",
);
const PLANNING_SKILL_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "SKILL.md",
);

const state = fs.readFileSync(STATE_TS_PATH, "utf8");
const featureTs = fs.readFileSync(FEATURE_TS_PATH, "utf8");
const help = fs.readFileSync(HELP_TS_PATH, "utf8");
const discovery = fs.readFileSync(DISCOVERY_INSTRUCTIONS_PATH, "utf8");
const pipelineSkill = fs.readFileSync(PIPELINE_SKILL_PATH, "utf8");
const planningSkill = fs.readFileSync(PLANNING_SKILL_PATH, "utf8");

describe("forceResearch wiring lint", () => {
  it("(a) declares the forceResearch field AND its validator guard in state.ts", () => {
    expect(
      state.includes("forceResearch?: boolean"),
      "bin/lib/state.ts must declare the optional `forceResearch?: boolean` field on PipelineState.",
    ).toBe(true);
    expect(
      state.includes("o.forceResearch"),
      "bin/lib/state.ts isPipelineState must guard `o.forceResearch` (reject non-boolean).",
    ).toBe(true);
  });

  it("(b) parses and strips the --research flag in feature.ts", () => {
    expect(
      featureTs.includes('args.includes("--research")'),
      "bin/lib/feature.ts must detect the `--research` flag via args.includes.",
    ).toBe(true);
    expect(
      featureTs.includes('a !== "--research"'),
      "bin/lib/feature.ts must strip the `--research` token before slugify (filter predicate).",
    ).toBe(true);
  });

  it("(c) keeps the discovery skip-note 'force with ... --research' contract string", () => {
    expect(
      /force with .*--research/.test(discovery),
      "discovery-instructions.md must carry the skip-note contract matching /force with .*--research/.",
    ).toBe(true);
  });

  it("(d) documents --research in the flow feature create help text", () => {
    expect(
      help.includes("--research"),
      "bin/lib/help.ts must document the `--research` flag in `flow feature create --help`.",
    ).toBe(true);
  });

  it("(f) wires the deterministic flow-research-note backstop in the supervisor", () => {
    // The supervisor's step-3 `flow-research-note ensure` call is the reliable
    // surface for the research skip-note when the discovery subagent omits its
    // best-effort `> [!NOTE]`. Freeze both the helper's existence and the
    // supervisor's invocation of it — dropping either silently un-wires the
    // backstop with every other test green.
    const helperPath = path.resolve(HERE, "flow-research-note.ts");
    expect(
      fs.existsSync(helperPath),
      "bin/flow-research-note.ts (the deterministic note backstop helper) must exist.",
    ).toBe(true);
    expect(
      pipelineSkill.includes("flow-research-note"),
      "flow-pipeline/SKILL.md step 3 must call the `flow-research-note` backstop so the research skip-note is reliable independent of the discovery subagent.",
    ).toBe(true);
  });

  it("(g) wires the deterministic forced-research runner (flow-research-run)", () => {
    // `flow feature create --research` must execute research deterministically, not rely on
    // the discovery subagent's observed-skippable Step 1.5. Freeze both the
    // helper's existence and the supervisor's step-3 forced-path call to it —
    // dropping either silently un-wires forced research with every other test
    // green.
    const runnerPath = path.resolve(HERE, "flow-research-run.ts");
    expect(
      fs.existsSync(runnerPath),
      "bin/flow-research-run.ts (the deterministic forced-research runner) must exist.",
    ).toBe(true);
    expect(
      pipelineSkill.includes("flow-research-run"),
      "flow-pipeline/SKILL.md step 3 must call `flow-research-run` on the forced path so research executes deterministically independent of the discovery subagent.",
    ).toBe(true);
  });

  it("(e) co-locates the 'RESEARCH: force-on' threading marker across all three skill files", () => {
    // The skip-note string in (c) is distinct from the marker token that
    // actually threads the force-on signal supervisor -> /flow-product-planning ->
    // discovery. Renaming the marker in any one file silently severs threading
    // with every other test green — freeze its co-presence here.
    for (const [name, src] of [
      ["flow-pipeline/SKILL.md", pipelineSkill],
      ["flow-product-planning/SKILL.md", planningSkill],
      ["discovery-instructions.md", discovery],
    ] as const) {
      expect(
        src.includes("RESEARCH: force-on"),
        `${name} must carry the 'RESEARCH: force-on' threading marker that wires the force-on signal across the discovery handoff.`,
      ).toBe(true);
    }
  });
});
