import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeFixture } from "./eval-fixture";
import { evalSlug, type ResolvedScenario } from "./eval-suite";
import { checkpointBodyPath, checkpointDir } from "./checkpoint-freshness";
import { checkpointMarkerPath } from "../flow-checkpoint";
import { statePath } from "./state";
import { registryPath } from "./proc-registry";
import { turnTrackingPath } from "./stop-turn-tracking";

let scenarioRoot!: string;
let stateDir!: string;

beforeEach(() => {
  scenarioRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-eval-scenario-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-eval-state-"));

  const repoSrc = path.join(scenarioRoot, "fixture");
  fs.mkdirSync(path.join(repoSrc, "flow-tmp"), { recursive: true });
  fs.writeFileSync(path.join(repoSrc, "flow-tmp", "plan.md"), "# plan\n");
  fs.writeFileSync(path.join(repoSrc, "base.txt"), "base\n");

  const overlaySrc = path.join(scenarioRoot, "overlay");
  fs.mkdirSync(overlaySrc, { recursive: true });
  fs.writeFileSync(path.join(overlaySrc, "overlay.txt"), "overlay\n");

  fs.writeFileSync(
    path.join(scenarioRoot, "state.json"),
    JSON.stringify({
      phase: "implementing",
      launcher: "plain",
      phaseLog: [
        { phase: "triage", at: "2020-01-01T00:00:00.000Z" },
        { phase: "implementing", at: "2020-01-02T00:00:00.000Z" },
      ],
    }),
  );

  fs.writeFileSync(path.join(scenarioRoot, "checkpoint.md"), "approved — go\n");

  fs.writeFileSync(
    path.join(scenarioRoot, "gh"),
    "#!/usr/bin/env bun\nconsole.log('shim')\n",
  );
  fs.chmodSync(path.join(scenarioRoot, "gh"), 0o644); // committed non-executable; materializer must chmod
});

afterEach(() => {
  fs.rmSync(scenarioRoot, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function buildScenario(
  overrides: Partial<ResolvedScenario> = {},
): ResolvedScenario {
  return {
    id: "s1",
    title: "S1",
    provenance: "test",
    prompt: "prompt.md",
    runs: 1,
    maxBudgetUsd: 1,
    timeoutSec: 60,
    allowedTools: ["Bash"],
    dir: scenarioRoot,
    fixture: {
      repo: "fixture",
      overlay: "overlay",
      state: "state.json",
      checkpoint: { body: "checkpoint.md", site: "plan-approval", armed: true },
      shims: ["gh"],
    },
    graders: [{ id: "g1", kind: "file", file: "$REPO/base.txt", exists: true }],
    ...overrides,
  };
}

function git(args: string[], cwd: string): string {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
}

describe("materializeFixture", () => {
  it("creates a repo on branch eval with a resolvable merge-base against origin/main", () => {
    const fixture = materializeFixture(buildScenario(), "my-suite", 1, {
      stateDir,
    });
    try {
      expect(git(["branch", "--show-current"], fixture.repoDir)).toBe("eval");
      const mergeBase = spawnSync(
        "git",
        ["merge-base", "origin/main", "HEAD"],
        {
          cwd: fixture.repoDir,
          encoding: "utf8",
        },
      );
      expect(mergeBase.status).toBe(0);
      expect(mergeBase.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      fixture.teardown();
    }
  });

  it("applies the overlay as exactly one commit on top of origin/main", () => {
    const fixture = materializeFixture(buildScenario(), "my-suite", 1, {
      stateDir,
    });
    try {
      expect(fs.existsSync(path.join(fixture.repoDir, "overlay.txt"))).toBe(
        true,
      );
      const log = git(
        ["log", "--oneline", "origin/main..HEAD"],
        fixture.repoDir,
      )
        .split("\n")
        .filter(Boolean);
      expect(log).toHaveLength(1);
    } finally {
      fixture.teardown();
    }
  });

  it("renames a committed flow-tmp/ to .flow-tmp/ and registers the git exclude, leaving a clean tree", () => {
    const fixture = materializeFixture(buildScenario(), "my-suite", 1, {
      stateDir,
    });
    try {
      expect(fs.existsSync(path.join(fixture.repoDir, "flow-tmp"))).toBe(false);
      expect(
        fs.existsSync(path.join(fixture.repoDir, ".flow-tmp", "plan.md")),
      ).toBe(true);
      // .flow-tmp/ and .flow-branch are excluded, so a fully-committed
      // fixture reports a clean porcelain status with no untracked entries.
      expect(git(["status", "--porcelain"], fixture.repoDir)).toBe("");
    } finally {
      fixture.teardown();
    }
  });

  it("seeds state.json under the eval slug, merging the fixture's partial with materializer-owned fields", () => {
    const fixture = materializeFixture(buildScenario(), "my-suite", 1, {
      stateDir,
    });
    try {
      const state = JSON.parse(
        fs.readFileSync(statePath(fixture.slug, stateDir), "utf8"),
      );
      expect(state.slug).toBe(fixture.slug);
      expect(state.repo).toBe(fixture.repoDir);
      expect(state.worktree).toBe(fixture.repoDir);
      expect(state.phase).toBe("implementing");
      expect(state.launcher).toBe("plain");
    } finally {
      fixture.teardown();
    }
  });

  it("arms a fresh checkpoint whose armedAt is strictly newer than every phaseLog entry", () => {
    const fixture = materializeFixture(buildScenario(), "my-suite", 1, {
      stateDir,
    });
    try {
      expect(fs.existsSync(checkpointBodyPath(fixture.slug, stateDir))).toBe(
        true,
      );
      expect(fs.existsSync(checkpointMarkerPath(fixture.slug, stateDir))).toBe(
        true,
      );
      const state = JSON.parse(
        fs.readFileSync(statePath(fixture.slug, stateDir), "utf8"),
      );
      expect(state.checkpoint.site).toBe("plan-approval");
      const armedAt: string = state.checkpoint.armedAt;
      for (const entry of state.phaseLog) {
        expect(armedAt > entry.at).toBe(true);
      }
    } finally {
      fixture.teardown();
    }
  });

  it("copies a declared shim into shimDir as an executable file", () => {
    const fixture = materializeFixture(buildScenario(), "my-suite", 1, {
      stateDir,
    });
    try {
      const shimPath = path.join(fixture.shimDir, "gh");
      expect(fs.existsSync(shimPath)).toBe(true);
      const mode = fs.statSync(shimPath).mode & 0o777;
      expect(mode & 0o100).toBeTruthy();
    } finally {
      fixture.teardown();
    }
  });

  it("materializes the flow-module-core plugin root", () => {
    const fixture = materializeFixture(buildScenario(), "my-suite", 1, {
      stateDir,
    });
    try {
      expect(fixture.pluginRoots).toHaveLength(1);
      expect(
        fs.existsSync(
          path.join(fixture.pluginRoots[0], ".claude-plugin", "plugin.json"),
        ),
      ).toBe(true);
    } finally {
      fixture.teardown();
    }
  });

  it("teardown removes root/state/checkpoints/turns/procs and never throws when called twice", () => {
    const fixture = materializeFixture(buildScenario(), "my-suite", 1, {
      stateDir,
    });
    fixture.teardown();
    expect(fs.existsSync(fixture.root)).toBe(false);
    expect(fs.existsSync(statePath(fixture.slug, stateDir))).toBe(false);
    expect(fs.existsSync(checkpointDir(fixture.slug, stateDir))).toBe(false);
    expect(fs.existsSync(turnTrackingPath(fixture.slug, stateDir))).toBe(false);
    expect(fs.existsSync(registryPath(fixture.slug, stateDir))).toBe(false);
    expect(() => fixture.teardown()).not.toThrow();
  });
});

describe("evalSlug cap behaviour (used by materializeFixture)", () => {
  it("truncates only the scenario segment while keeping the run suffix, staying within the 60-char cap", () => {
    const slug = evalSlug("my-suite", "s".repeat(80), 2);
    expect(slug.endsWith("-r2")).toBe(true);
    expect(slug.length).toBeLessThanOrEqual(60);
  });
});
