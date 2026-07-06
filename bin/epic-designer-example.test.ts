import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F4 acceptance surface. The committed worked example under
 * `.flow/epics/build-the-epic-designer/` IS the proof the one-shot epic-grain
 * designer produces a backbone-plus-critique, schema-valid, well-formed-DAG design; the
 * cyclic fixture is the single negative-path proof that F4 relies on the DAG
 * gate (not a re-test of F2's internals, which `flow-epic-dag.test.ts` owns).
 * Paths resolve via __dirname because spawnSync's cwd is the vitest runner's,
 * not bin/.
 */

const DAG_SCRIPT = path.resolve(__dirname, "flow-epic-dag.ts");
const SCHEMA_SCRIPT = path.resolve(__dirname, "lib", "epic-manifest-schema.ts");

const EPIC_DIR = path.resolve(
  __dirname,
  "..",
  ".flow",
  "epics",
  "build-the-epic-designer",
);
const COMMITTED_MANIFEST = path.resolve(EPIC_DIR, "manifest.json");
const COMMITTED_DESIGN = path.resolve(EPIC_DIR, "design.md");
const CYCLIC_FIXTURE = path.resolve(
  __dirname,
  "fixtures",
  "epic-cyclic-manifest.json",
);

function runCli(
  script: string,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [script, ...args], { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const REQUIRED_HEADINGS = [
  "## 1. Problem & intent",
  "## 2. Clarified requirements",
  "## 3. High-level design",
  "## 4. Feature decomposition",
  "## 5. Dependency DAG",
  "## 6. Open Questions",
  "## Recommendation",
  "## Plan risks",
];

describe("committed design.md — the backbone + critique review surface", () => {
  const design = readFileSync(COMMITTED_DESIGN, "utf8");

  it.each(REQUIRED_HEADINGS)("contains the heading %s", (heading) => {
    expect(design).toContain(heading);
  });

  // Beyond bare headings: REQUIRED_HEADINGS is eight entries — the six
  // `## N.` backbone headings plus `## Recommendation` and `## Plan risks` —
  // so an empty shell with only the six numbered lines now FAILS the grep
  // above (it's missing the two critique headings). These minimal content
  // assertions further pin the load-bearing artifacts §4d/§4a require, so
  // even a shell carrying all eight bare headings with empty bodies can't
  // go green.
  it("renders the §5 dependency DAG as an inline Mermaid fence", () => {
    expect(design).toContain("```mermaid");
  });

  it("expresses at least one EARS acceptance criterion (THE SYSTEM SHALL)", () => {
    expect(design).toContain("SHALL");
  });

  // The worked example deliberately OMITS `## Decision analysis` to demo the
  // omit-when-empty convention plus the consumer-side gate's graceful skip
  // (epic-create Step 4.5). Pin the omission so a future edit that adds the
  // section back is caught rather than silently changing what this example
  // demonstrates.
  it("omits `## Decision analysis` (demoing the omit-when-empty convention)", () => {
    expect(design).not.toContain("## Decision analysis");
  });
});

describe("committed design.md ↔ manifest.json — methodology consistency invariant", () => {
  // epic-discovery-instructions.md §5b mandates the two artifacts stay "100%
  // consistent … same ids, titles, and edges", and the §6 Verification bullet
  // restates it — but the schema validator only checks manifest shape and
  // flow-epic-dag only checks graph well-formedness, so absent this the two
  // committed files could silently drift (a renamed id or a DAG edge present
  // in one but not the other) with the whole suite still green.
  const design = readFileSync(COMMITTED_DESIGN, "utf8");
  const manifest = JSON.parse(readFileSync(COMMITTED_MANIFEST, "utf8")) as {
    features: { id: string; dependsOn: string[] }[];
  };
  const ids = manifest.features.map((f) => f.id);

  it("every manifest feature id appears verbatim in design.md", () => {
    for (const id of ids) {
      expect(design, `manifest id '${id}' missing from design.md`).toContain(
        id,
      );
    }
  });

  it("every dependsOn edge references a feature id that exists in the manifest", () => {
    const idSet = new Set(ids);
    for (const f of manifest.features) {
      for (const dep of f.dependsOn) {
        expect(
          idSet.has(dep),
          `feature '${f.id}' dependsOn '${dep}', which is not a manifest feature id`,
        ).toBe(true);
      }
    }
  });
});

describe("committed manifest.json — passes both validators", () => {
  it("flow-epic-manifest-schema --validate exits 0", () => {
    const result = runCli(SCHEMA_SCRIPT, "--validate", COMMITTED_MANIFEST);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true });
  });

  it("flow-epic-dag --validate exits 0", () => {
    const result = runCli(DAG_SCRIPT, "--validate", COMMITTED_MANIFEST);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true });
  });
});

describe("cyclic fixture — F4 relies on the DAG gate to reject bad graphs", () => {
  it("is shape-valid (flow-epic-manifest-schema --validate exits 0)", () => {
    const result = runCli(SCHEMA_SCRIPT, "--validate", CYCLIC_FIXTURE);
    expect(result.status).toBe(0);
  });

  it("flow-epic-dag --validate exits non-zero and names the cycle", () => {
    const result = runCli(DAG_SCRIPT, "--validate", CYCLIC_FIXTURE);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dependency cycle: a -> b -> a");
  });
});
