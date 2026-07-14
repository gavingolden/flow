import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { renderEpicBlock } from "./flow-epic-membership";
import type { ReconcileResult } from "./lib/epic-reconcile";
import type { EpicManifest, Feature } from "./lib/epic-manifest-schema";
import type { EpicRunState, FeatureRunRecord } from "./lib/epic-run-state";
import type { PipelineState } from "./lib/state";

const REPO_ROOT = path.resolve(__dirname, "..");

function feat(id: string, dependsOn: string[] = []): Feature {
  return {
    id,
    title: id.toUpperCase(),
    description: `feature ${id}`,
    dependsOn,
  };
}

function manifest(features: Feature[]): EpicManifest {
  return {
    epicId: "watchlist",
    prompt: "build the watchlist",
    createdAt: "2026-06-28",
    features,
  };
}

function runResult(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    board: [
      {
        id: "a",
        status: "merged",
        slug: "flow-a",
        dependsOn: [],
      },
    ],
    summary: { ready: 0, running: 0, blocked: 0, merged: 1, total: 1 },
    toLaunch: [],
    epicStatus: "running",
    ...overrides,
  };
}

function assertNoStopGuardSentinel(output: string): void {
  const lines = output.split("\n");
  for (const line of lines) {
    expect(line).not.toBe("MERGED");
    expect(line.startsWith("GATED:")).toBe(false);
    expect(line.startsWith("NEEDS HUMAN:")).toBe(false);
    expect(line).not.toBe("cancelled");
  }
}

describe("renderEpicBlock — Story 1: header + board", () => {
  it("includes the membership line and the EPIC status line", () => {
    const out = renderEpicBlock({
      epicSlug: "watchlist",
      result: runResult(),
      terminalState: "merged",
    });
    expect(out).toContain("Part of epic watchlist");
    expect(out).toContain("EPIC watchlist");
    assertNoStopGuardSentinel(out);
  });
});

describe("renderEpicBlock — Story 2: footer matrix", () => {
  it("merged + done → complete, archive hint, no 'flow epic run'", () => {
    const out = renderEpicBlock({
      epicSlug: "e",
      result: runResult({ epicStatus: "done" }),
      terminalState: "merged",
    });
    expect(out).toContain("is complete");
    expect(out).toContain("flow epic done");
    expect(out).not.toContain("flow epic run");
    assertNoStopGuardSentinel(out);
  });

  it("merged + blocked → 'flow epic run' + deadlock hint", () => {
    const out = renderEpicBlock({
      epicSlug: "e",
      result: runResult({ epicStatus: "blocked" }),
      terminalState: "merged",
    });
    expect(out).toContain("flow epic run");
    expect(out).toContain("deadlock");
    assertNoStopGuardSentinel(out);
  });

  it("merged + running → plain 'flow epic run', no deadlock/complete language", () => {
    const out = renderEpicBlock({
      epicSlug: "e",
      result: runResult({ epicStatus: "running" }),
      terminalState: "merged",
    });
    expect(out).toContain("flow epic run");
    expect(out).not.toContain("deadlock");
    expect(out).not.toContain("is complete");
    assertNoStopGuardSentinel(out);
  });

  it("gated → gated hint + 'flow epic run'", () => {
    const out = renderEpicBlock({
      epicSlug: "e",
      result: runResult({ epicStatus: "running" }),
      terminalState: "gated",
    });
    expect(out).toContain("gated");
    expect(out).toContain("flow epic run");
    assertNoStopGuardSentinel(out);
  });

  it("needs-human → escalation hint + 'flow epic run'", () => {
    const out = renderEpicBlock({
      epicSlug: "e",
      result: runResult({ epicStatus: "running" }),
      terminalState: "needs-human",
    });
    expect(out).toContain("escalation");
    expect(out).toContain("flow epic run");
    assertNoStopGuardSentinel(out);
  });

  it("merged-externally + running behaves like merged + running", () => {
    const out = renderEpicBlock({
      epicSlug: "e",
      result: runResult({ epicStatus: "running" }),
      terminalState: "merged-externally",
    });
    expect(out).toContain("flow epic run");
    expect(out).not.toContain("deadlock");
    expect(out).not.toContain("is complete");
    assertNoStopGuardSentinel(out);
  });
});

describe("flow-epic-membership CLI", () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function run(args: string[], home: string) {
    return spawnSync("bun", ["bin/flow-epic-membership.ts", ...args], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
  }

  it("[Story 3] no .epic field on state → silent no-op, exit 0", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-membership-"));
    const stateDir = path.join(tmpHome, ".flow", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "my-feature.json"),
      JSON.stringify({
        slug: "my-feature",
        phase: "merged",
        repo: "/tmp/repo",
        updatedAt: "2026-06-28T00:00:00Z",
      } satisfies PipelineState),
    );

    const result = run(
      ["--slug", "my-feature", "--terminal-state", "merged"],
      tmpHome,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("[Story 4] epic slug set but run.json/manifest missing → degradation block", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-membership-"));
    const stateDir = path.join(tmpHome, ".flow", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "my-feature.json"),
      JSON.stringify({
        slug: "my-feature",
        phase: "merged",
        repo: "/tmp/repo",
        updatedAt: "2026-06-28T00:00:00Z",
        epic: { slug: "e", featureId: "f" },
      } satisfies PipelineState),
    );
    // No ~/.flow/epics/e/run.json written at all.

    const result = run(
      ["--slug", "my-feature", "--terminal-state", "merged"],
      tmpHome,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Part of epic");
    expect(result.stdout).toContain("(epic status unavailable)");
    assertNoStopGuardSentinel(result.stdout);
  });

  it("[Story 5] unknown --terminal-state value → exit 2", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-membership-"));
    const result = run(
      ["--slug", "my-feature", "--terminal-state", "bogus"],
      tmpHome,
    );
    expect(result.status).toBe(2);
  });

  it("[Story 1] epic slug + valid run.json + manifest → membership header rendered", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-membership-"));
    const stateDir = path.join(tmpHome, ".flow", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "my-feature.json"),
      JSON.stringify({
        slug: "my-feature",
        phase: "merged",
        repo: "/tmp/repo",
        updatedAt: "2026-06-28T00:00:00Z",
        epic: { slug: "e", featureId: "a" },
      } satisfies PipelineState),
    );

    const epicDir = path.join(tmpHome, ".flow", "epics", "e");
    fs.mkdirSync(epicDir, { recursive: true });
    const manifestPath = path.join(epicDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest([feat("a")])));

    const features: Record<string, FeatureRunRecord> = {
      a: { slug: "my-feature", launchedAt: "2026-06-28T00:00:00Z" },
    };
    const rs: EpicRunState = {
      epicSlug: "e",
      repo: "/tmp/repo",
      manifestPath,
      manifestSha: "sha",
      maxParallel: 1,
      createdAt: "2026-06-28T00:00:00Z",
      updatedAt: "2026-06-28T00:00:00Z",
      features,
    };
    fs.writeFileSync(path.join(epicDir, "run.json"), JSON.stringify(rs));

    const result = run(
      ["--slug", "my-feature", "--terminal-state", "merged"],
      tmpHome,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("epic e");
    assertNoStopGuardSentinel(result.stdout);
  });
});
