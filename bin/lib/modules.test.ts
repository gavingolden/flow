/**
 * Completeness lint for the module registry: drives off the LIVE discovery
 * functions in `sources.ts`, not `docs/target-architecture.md`'s prose, so
 * it reds on any orphan, double-assignment, or phantom row as soon as the
 * source tree and the registry diverge.
 *
 * Deviation from the plan contract's literal "iterate resolveArtifactSet
 * over ALL module ids" wording: `resolveArtifactSet` always folds
 * `MANDATORY_MODULE` ("core") into every selection by design (see
 * `modules.ts`), so calling it once per module id would make every core
 * artifact appear in every non-core module's resolved set — breaking the
 * "exactly one module" assertion this lint exists to make. The partition
 * checks below instead read `MODULES` rows directly (still exported,
 * still the live registry), which is the only way to test
 * one-artifact-one-module without the mandatory-fold noise. The
 * union-equals-discovery check *does* use `resolveArtifactSet` exactly as
 * instructed, over the full `moduleIds()` selection (the `--all`-equivalent
 * case), which is where the mandatory fold is a no-op (core is already
 * selected).
 */

import { describe, expect, it } from "vitest";
import {
  discoverAgents,
  discoverHelpers,
  discoverSkills,
  discoverValidators,
} from "./sources";
import { resolveFlowSource } from "./paths";
import {
  MANDATORY_MODULE,
  MODULES,
  isKnownModule,
  moduleForArtifactName,
  moduleIds,
  resolveArtifactSet,
} from "./modules";

const flowSource = resolveFlowSource();

function multiset(rows: string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const name of row) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/** Asserts the one-artifact-one-module partition for one artifact kind. */
function expectExactPartition(discoveredNames: string[], rows: string[][]) {
  const counts = multiset(rows);
  for (const name of discoveredNames) {
    // No orphan (count 0) and no double-assignment (count > 1).
    expect(counts.get(name) ?? 0, `discovered artifact '${name}'`).toBe(1);
  }
  // No phantom row: every registry entry must be a real discovered artifact.
  for (const name of counts.keys()) {
    expect(discoveredNames, `registry row '${name}'`).toContain(name);
  }
}

describe("modules registry completeness (live discovery, not doc prose)", () => {
  it("partitions every discovered skill into exactly one module's skills[]", () => {
    const discovered = discoverSkills(flowSource).map((e) => e.displayName);
    expect(discovered.length).toBeGreaterThan(0);
    expectExactPartition(
      discovered,
      MODULES.map((m) => m.skills),
    );
  });

  it("partitions every discovered agent into exactly one module's agents[]", () => {
    const discovered = discoverAgents(flowSource).map((e) => e.displayName);
    expect(discovered.length).toBeGreaterThan(0);
    expectExactPartition(
      discovered,
      MODULES.map((m) => m.agents),
    );
  });

  it("partitions every discovered PATH-bound helper into exactly one module's helpers[]", () => {
    const discovered = discoverHelpers(flowSource).map((e) => e.displayName);
    expect(discovered.length).toBeGreaterThan(0);
    // Decided refinement: flow-release is maintainer-only and must never
    // surface from discoverHelpers in the first place (sources.ts's job),
    // and must never appear in the registry either (modules.ts's job).
    expect(discovered).not.toContain("flow-release");
    expectExactPartition(
      discovered,
      MODULES.map((m) => m.helpers),
    );
  });

  it("partitions every discovered validator into exactly one module's validators[]", () => {
    const discovered = discoverValidators(flowSource).map((e) => e.displayName);
    expect(discovered.length).toBeGreaterThan(0);
    expectExactPartition(
      discovered,
      MODULES.map((m) => m.validators),
    );
  });

  it("resolveArtifactSet(all module ids) set-equals live discovery for every kind (the --all byte-parity precondition)", () => {
    const all = resolveArtifactSet(moduleIds());
    expect(new Set(all.skills)).toEqual(
      new Set(discoverSkills(flowSource).map((e) => e.displayName)),
    );
    expect(new Set(all.agents)).toEqual(
      new Set(discoverAgents(flowSource).map((e) => e.displayName)),
    );
    expect(new Set(all.helpers)).toEqual(
      new Set(discoverHelpers(flowSource).map((e) => e.displayName)),
    );
    expect(new Set(all.validators)).toEqual(
      new Set(discoverValidators(flowSource).map((e) => e.displayName)),
    );
  });

  it("MANDATORY_MODULE (core) is folded into every selection even when not named", () => {
    const core = resolveArtifactSet([MANDATORY_MODULE]);
    const svelteOnly = resolveArtifactSet(["stack-svelte"]);
    for (const s of core.skills) expect(svelteOnly.skills).toContain(s);
    for (const h of core.helpers) expect(svelteOnly.helpers).toContain(h);
  });

  it("resolveArtifactSet([]) (empty selection) still returns core's full artifact set", () => {
    const empty = resolveArtifactSet([]);
    const core = MODULES.find((m) => m.id === MANDATORY_MODULE)!;
    expect(new Set(empty.skills)).toEqual(new Set(core.skills));
    expect(new Set(empty.helpers)).toEqual(new Set(core.helpers));
    expect(new Set(empty.validators)).toEqual(new Set(core.validators));
  });

  it("moduleIds() / isKnownModule() agree with the MODULES table", () => {
    expect(moduleIds()).toEqual(MODULES.map((m) => m.id));
    for (const id of moduleIds()) expect(isKnownModule(id)).toBe(true);
    expect(isKnownModule("bogus-module")).toBe(false);
  });

  it("moduleForArtifactName resolves a real artifact to its owning module and returns undefined for the always-core residue", () => {
    expect(moduleForArtifactName("flow-pre-commit")).toBe("core");
    expect(moduleForArtifactName("flow-svelte")).toBe("stack-svelte");
    expect(moduleForArtifactName("flow-request-copilot")).toBe("copilot");
    expect(moduleForArtifactName("flow-delegate")).toBe("research");
    // The wrapper and shell completions are never module rows.
    expect(moduleForArtifactName("flow")).toBeUndefined();
    expect(moduleForArtifactName("flow.bash")).toBeUndefined();
  });

  it("decided refinement: epic-manifest-schema is a 4th core validator row", () => {
    const core = MODULES.find((m) => m.id === "core")!;
    expect(core.validators).toContain("flow-epic-manifest-schema");
    expect(core.validators.length).toBe(4);
  });

  it("materialized testing split: generic flow-testing is a core skill, Svelte flow-testing-svelte is a stack-svelte skill", () => {
    const core = MODULES.find((m) => m.id === "core")!;
    const svelte = MODULES.find((m) => m.id === "stack-svelte")!;
    expect(core.skills).toContain("flow-testing");
    expect(core.skills).not.toContain("flow-testing-svelte");
    expect(svelte.skills).toContain("flow-testing-svelte");
    expect(svelte.skills).toEqual(["flow-svelte", "flow-testing-svelte"]);
  });
});
