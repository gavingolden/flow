/**
 * Fixture-manifest cases for `resolveModuleActivity` and its callers.
 * Every case injects `readSelection`/`readManifest` via the `deps` params —
 * never touches real `~/.flow` — modelled on `modules-config.test.ts`'s
 * `reader` seam pattern.
 */

import { describe, expect, it } from "vitest";
import type { Manifest, SymlinkRecord } from "./manifest";
import { MANDATORY_MODULE, MODULES } from "./modules";
import {
  inactiveOptionalModules,
  isModuleActive,
  isSkillActive,
  noticeLine,
  skipEnvelope,
  resolveModuleActivity,
} from "./module-status";

const EMPTY_MANIFEST: Manifest = { version: 1, symlinks: [] };

function record(name: string): SymlinkRecord {
  return {
    source: `/fake/src/${name}`,
    target: `/fake/home/${name}`,
    kind: "bin",
  };
}

/** Links every declared artifact of every module — the `--all` no-op case. */
function fullManifest(): Manifest {
  const symlinks: SymlinkRecord[] = [];
  for (const m of MODULES) {
    for (const name of [
      ...m.skills,
      ...m.agents,
      ...m.helpers,
      ...m.validators,
    ]) {
      symlinks.push(record(name));
    }
  }
  return { version: 1, symlinks };
}

/** Links only `core`'s declared artifacts — the `--modules core` shape. */
function coreOnlyManifest(): Manifest {
  const core = MODULES.find((m) => m.id === "core")!;
  const symlinks = [
    ...core.skills,
    ...core.agents,
    ...core.helpers,
    ...core.validators,
  ].map(record);
  return { version: 1, symlinks };
}

/** Links some-but-not-all of `research`'s declared artifacts. */
function partialResearchManifest(): Manifest {
  const research = MODULES.find((m) => m.id === "research")!;
  expect(research.helpers.length).toBeGreaterThan(1);
  const linked = research.helpers.slice(0, research.helpers.length - 1);
  return { version: 1, symlinks: linked.map(record) };
}

function activityFor(
  id: string,
  activity: ReturnType<typeof resolveModuleActivity>,
) {
  const found = activity.find((m) => m.id === id);
  if (!found) throw new Error(`no activity row for module '${id}'`);
  return found;
}

describe("resolveModuleActivity", () => {
  it("(a) FULL manifest: every module active, inactiveOptionalModules is empty", () => {
    const deps = { readManifest: () => fullManifest() };
    const activity = resolveModuleActivity(deps);
    for (const m of activity) {
      expect(m.active, `module '${m.id}' should be active`).toBe(true);
    }
    expect(inactiveOptionalModules(deps)).toEqual([]);
  });

  it("(b) '--modules core' shape: only core active, every optional 'not-linked'", () => {
    const deps = { readManifest: () => coreOnlyManifest() };
    const activity = resolveModuleActivity(deps);
    expect(activityFor("core", activity)).toEqual({
      id: "core",
      active: true,
      reason: "selected",
    });
    for (const m of activity) {
      if (m.id === "core") continue;
      expect(m.active, `module '${m.id}' should be inactive`).toBe(false);
      expect(m.reason).toBe("not-linked");
    }
  });

  it("(c) empty manifest + recorded selection ['copilot']: copilot + core active (selected), others deselected", () => {
    const deps = {
      readManifest: () => EMPTY_MANIFEST,
      readSelection: () => ["copilot"],
    };
    const activity = resolveModuleActivity(deps);
    expect(activityFor("core", activity)).toEqual({
      id: "core",
      active: true,
      reason: "selected",
    });
    expect(activityFor("copilot", activity)).toEqual({
      id: "copilot",
      active: true,
      reason: "selected",
    });
    for (const id of [
      "stack-svelte",
      "stack-tailwind-shadcn",
      "stack-supabase",
      "stack-cloudflare-pages",
      "research",
    ]) {
      expect(activityFor(id, activity)).toEqual({
        id,
        active: false,
        reason: "deselected",
      });
    }
  });

  it("(d) unset selection (undefined) + empty manifest: core-only active, all optionals deselected", () => {
    const deps = {
      readManifest: () => EMPTY_MANIFEST,
      readSelection: () => undefined,
    };
    const activity = resolveModuleActivity(deps);
    expect(activityFor("core", activity).active).toBe(true);
    for (const m of activity) {
      if (m.id === "core") continue;
      expect(m.active).toBe(false);
      expect(m.reason).toBe("deselected");
    }
  });

  it("(e) PARTIAL manifest: a module with some-but-not-all declared artifacts linked reads inactive ('not-linked')", () => {
    const deps = { readManifest: () => partialResearchManifest() };
    const activity = resolveModuleActivity(deps);
    expect(activityFor("research", activity)).toEqual({
      id: "research",
      active: false,
      reason: "not-linked",
    });
  });
});

describe("isModuleActive", () => {
  it("core is always active, even against a broken/empty deps override", () => {
    const deps = {
      readManifest: () => EMPTY_MANIFEST,
      readSelection: () => undefined,
    };
    expect(isModuleActive(MANDATORY_MODULE, deps)).toBe(true);
  });

  it("tracks resolveModuleActivity for a non-core module", () => {
    const inactiveDeps = {
      readManifest: () => EMPTY_MANIFEST,
      readSelection: () => undefined,
    };
    expect(isModuleActive("copilot", inactiveDeps)).toBe(false);
    expect(
      isModuleActive("copilot", { readManifest: () => fullManifest() }),
    ).toBe(true);
  });
});

describe("isSkillActive", () => {
  it("tracks the owning module's activity for a known skill ('svelte')", () => {
    const deselected = {
      readManifest: () => EMPTY_MANIFEST,
      readSelection: () => undefined,
    };
    expect(isSkillActive("svelte", deselected)).toBe(false);
    expect(
      isSkillActive("svelte", { readManifest: () => fullManifest() }),
    ).toBe(true);
  });

  it("an unknown skill is always active (not gated by module selection)", () => {
    const deselected = {
      readManifest: () => EMPTY_MANIFEST,
      readSelection: () => undefined,
    };
    expect(isSkillActive("not-a-real-skill", deselected)).toBe(true);
  });
});

describe("noticeLine", () => {
  it("names the module id, its description, and the re-enable command", () => {
    const line = noticeLine("research");
    expect(line).toContain("research");
    expect(line).toContain(
      MODULES.find((m) => m.id === "research")!.description.replace(/\.$/, ""),
    );
    expect(line).not.toContain(".;");
    expect(line).toContain("flow install --modules research");
  });
});

describe("skipEnvelope", () => {
  it("matches the shared graceful-skip envelope shape", () => {
    expect(skipEnvelope("research")).toEqual({
      ran: false,
      skipReason: "research-module-deselected",
    });
  });
});
