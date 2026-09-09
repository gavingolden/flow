/**
 * Tests for `discoverPluginRoots` and the `MAINTAINER_ONLY` correction
 * (`isPathBoundHelper` must never surface the plugin probe/lint tools onto
 * a user's PATH). Read-only discovery against the real flow checkout,
 * matching the "real-registry name matching" convention in `setup.test.ts`.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_TARGETS,
  discoverAgents,
  discoverAll,
  discoverPluginRoots,
  discoverSelected,
  discoverSkills,
  isPathBoundHelper,
} from "./sources";
import { MANDATORY_MODULE, moduleForArtifactName, moduleIds } from "./modules";
import { pluginRootName } from "./plugin-manifest";
import { resolveFlowSource } from "./paths";

const realFlowSource = resolveFlowSource();

describe(discoverPluginRoots, () => {
  it('returns exactly one entry per selected id, each with kind:"plugin" and target <skillsDir>/flow-module-<id>', () => {
    const entries = discoverPluginRoots(realFlowSource, ["core", "research"]);
    expect(entries).toHaveLength(2);
    for (const id of ["core", "research"] as const) {
      const entry = entries.find((e) => e.displayName === pluginRootName(id));
      expect(entry).toBeDefined();
      expect(entry!.kind).toBe("plugin");
      expect(entry!.target).toBe(
        path.join(DEFAULT_TARGETS.skillsDir, pluginRootName(id)),
      );
    }
  });

  it("returns [] for []", () => {
    expect(discoverPluginRoots(realFlowSource, [])).toEqual([]);
  });
});

describe(discoverSelected, () => {
  it("includes the plugin entries alongside the skill/agent/bin/completion entries", async () => {
    const entries = await discoverSelected(realFlowSource, realFlowSource, [
      "core",
    ]);
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds.has("skill")).toBe(true);
    expect(kinds.has("plugin")).toBe(true);
    expect(entries.some((e) => e.displayName === pluginRootName("core"))).toBe(
      true,
    );
    // Deselected optional module: no plugin root for it.
    expect(
      entries.some((e) => e.displayName === pluginRootName("stack-svelte")),
    ).toBe(false);
  });
});

describe(discoverAll, () => {
  it("emits a plugin root for every id in moduleIds() and for no other name", () => {
    const entries = discoverAll(realFlowSource, realFlowSource);
    const pluginEntries = entries.filter((e) => e.kind === "plugin");
    const expected = new Set(moduleIds().map(pluginRootName));
    expect(new Set(pluginEntries.map((e) => e.displayName))).toEqual(expected);
    expect(pluginEntries).toHaveLength(moduleIds().length);
  });
});

describe(isPathBoundHelper, () => {
  it("is false for flow-plugin-probe, flow-plugin-contract-lint, and flow-eval (never on a user's PATH)", () => {
    expect(isPathBoundHelper("flow-plugin-probe.ts")).toBe(false);
    expect(isPathBoundHelper("flow-plugin-contract-lint.ts")).toBe(false);
    expect(isPathBoundHelper("flow-eval.ts")).toBe(false);
  });

  it("is true for a normal helper like flow-new-worktree", () => {
    expect(isPathBoundHelper("flow-new-worktree.ts")).toBe(true);
  });
});

describe("plugin roots never collide with skill targets", () => {
  it("no discoverPluginRoots target collides with any discoverSkills target (the flow-research collision guard)", () => {
    const pluginTargets = new Set(
      discoverPluginRoots(realFlowSource, moduleIds()).map((e) => e.target),
    );
    const skillTargets = new Set(
      discoverSkills(realFlowSource).map((e) => e.target),
    );
    for (const target of pluginTargets) {
      expect(skillTargets.has(target)).toBe(false);
    }
  });
});

describe("discoverSkills root-internal targets", () => {
  it("every skill's target lives under its owning module's plugin root at <root>/skills/<name>", () => {
    const entries = discoverSkills(realFlowSource);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const owner =
        moduleForArtifactName(entry.displayName) ?? MANDATORY_MODULE;
      expect(entry.target).toBe(
        path.join(
          DEFAULT_TARGETS.skillsDir,
          pluginRootName(owner),
          "skills",
          entry.displayName,
        ),
      );
    }
  });

  it("routes a registry-unknown skill into flow-module-core's root, never a flat top-level skills-home path", () => {
    const tmpSource = fs.mkdtempSync(
      path.join(os.tmpdir(), "sources-unknown-skill-"),
    );
    try {
      const skillDir = path.join(
        tmpSource,
        "skills",
        "universal",
        "flow-not-a-real-skill",
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# fixture\n");
      const entries = discoverSkills(tmpSource);
      const entry = entries.find(
        (e) => e.displayName === "flow-not-a-real-skill",
      );
      expect(entry).toBeDefined();
      expect(entry!.target).toBe(
        path.join(
          DEFAULT_TARGETS.skillsDir,
          pluginRootName(MANDATORY_MODULE),
          "skills",
          "flow-not-a-real-skill",
        ),
      );
    } finally {
      fs.rmSync(tmpSource, { recursive: true, force: true });
    }
  });
});

describe("discoverAgents root-internal targets", () => {
  // Regression guard for the defect this PR fixes: Claude Code's
  // plugin-root component discovery follows a symlinked DIRECTORY but not a
  // symlinked FILE (verified experimentally against an isolated fixture
  // HOME — see the PR's context note), so materializing one symlink PER
  // AGENT FILE silently produces `Agents (0)` in `claude plugin details`.
  // `discoverAgents` must therefore emit exactly one entry PER MODULE
  // SUBDIRECTORY, whose target is the module's `agents` directory itself —
  // never a per-`.md`-file target. A future refactor that reverts to
  // per-file targets must fail this test, not silently ship a broken
  // install.
  it("emits one entry per module subdirectory under agents/, targeting <root>/agents (a directory), never a per-file path", () => {
    const entries = discoverAgents(realFlowSource);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.target.endsWith(`${path.sep}agents`)).toBe(true);
      expect(entry.target.endsWith(".md")).toBe(false);
      expect(entry.displayName.startsWith("agents/")).toBe(true);
    }
  });

  it("every agent entry's target lives under its owning module's plugin root at <root>/agents", () => {
    const entries = discoverAgents(realFlowSource);
    for (const entry of entries) {
      const moduleId = entry.displayName.replace(/^agents\//, "");
      expect(entry.target).toBe(
        path.join(
          DEFAULT_TARGETS.skillsDir,
          pluginRootName(moduleId as Parameters<typeof pluginRootName>[0]),
          "agents",
        ),
      );
    }
  });

  it("routes a fixture module's agents subdirectory into that module's own root, never the global agents dir", () => {
    const tmpSource = fs.mkdtempSync(
      path.join(os.tmpdir(), "sources-unknown-agent-"),
    );
    try {
      fs.mkdirSync(path.join(tmpSource, "agents", "core"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmpSource, "agents", "core", "flow-not-a-real-agent.md"),
        "---\nname: flow-not-a-real-agent\n---\n",
      );
      const entries = discoverAgents(tmpSource);
      const entry = entries.find((e) => e.displayName === "agents/core");
      expect(entry).toBeDefined();
      expect(entry!.target).toBe(
        path.join(
          DEFAULT_TARGETS.skillsDir,
          pluginRootName(MANDATORY_MODULE),
          "agents",
        ),
      );
      expect(entry!.target).not.toBe(DEFAULT_TARGETS.agentsDir);
      // A stray non-directory entry directly under agents/ (a leftover
      // README, an editor scratch file) must never surface as an entry.
      fs.writeFileSync(path.join(tmpSource, "agents", "NOTES.md"), "# n\n");
      expect(discoverAgents(tmpSource)).toHaveLength(1);
    } finally {
      fs.rmSync(tmpSource, { recursive: true, force: true });
    }
  });
});
