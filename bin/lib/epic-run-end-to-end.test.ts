/**
 * End-to-end drift-scenario integration for the /flow-epic-run PLAYBOOK primitives —
 * the safe-write actuators (`flow epic bind` / `flow epic launch`), the
 * hypothesis board (`flow epic status --json`), and the deterministic frontier
 * (`computeFrontier`), exercised through the real `runEpicCli` surface with
 * temp dirs + an injected `flow feature create` spawn seam.
 *
 * The three acceptance scenarios (plan Stories 1–3):
 *   1. slug-drift → `bind --force` repoints → status --json reflects the new
 *      slug → frontier excludes the launched node (no duplicate launch).
 *   2. out-of-band merge → `bind --external` → dependents become ready → the
 *      node is never relaunched.
 *   3. `launch` records the binding atomically on success, writes NOTHING on
 *      failure — plus old-run.json tolerance across a bind rewrite.
 *
 * tmux is mocked (the bind/launch/status paths never spawn a window, but
 * runEpicCli imports ./tmux at module load).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmuxMock = vi.hoisted(() => ({
  windowExists: vi.fn(() => false),
  isPaneAlive: vi.fn(() => false),
  createWindowVerified: vi.fn(() => ({ status: "started", stderr: "" })),
  respawnWindowVerified: vi.fn(() => ({ status: "started", stderr: "" })),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

import { runEpicCli } from "./epic";
import { computeFrontier } from "../flow-epic-dag";
import { readEpicRunState, writeEpicRunState } from "./epic-run-state";
import type { EpicManifest } from "./epic-manifest-schema";
import { writeState } from "./state";

let logs!: string[];
let repoDir!: string;
let epicsDir!: string;
let stateDir!: string;

beforeEach(() => {
  logs = [];
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epicrun-e2e-"));
  epicsDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epicrun-e2e-epics-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epicrun-e2e-state-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(epicsDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write a committed manifest at .flow/epics/<slug>/manifest.json. */
function writeManifest(
  slug: string,
  features: { id: string; dependsOn?: string[] }[],
): EpicManifest {
  const dir = path.join(repoDir, ".flow", "epics", slug);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: EpicManifest = {
    epicId: slug,
    prompt: "p",
    createdAt: "2026-06-28",
    features: features.map((f) => ({
      id: f.id,
      title: f.id.toUpperCase(),
      description: `build ${f.id}`,
      dependsOn: f.dependsOn ?? [],
    })),
  };
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

const manifestPathFor = (slug: string) =>
  path.join(repoDir, ".flow", "epics", slug, "manifest.json");

/** A parsed `status --json` payload (last logged line). */
function statusJson(slug: string): {
  board: { id: string; status: string; slug?: string; external?: boolean }[];
  source: string;
} {
  logs.length = 0;
  const code = runEpicCli(["status", slug, "--json"], {
    epicsDir,
    readFeatureState: (s) => {
      // Resolve each launched slug's phase from the injected pipeline state dir.
      try {
        const raw = fs.readFileSync(path.join(stateDir, `${s}.json`), "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
  });
  expect(code).toBe(0);
  return JSON.parse(logs[0]!);
}

describe("epic-run e2e — scenario 1: slug drift rebind", () => {
  it("bind --force repoints, status --json reflects the new slug, frontier excludes the launched node", () => {
    const m = writeManifest("epic1", [
      { id: "feat-a" },
      { id: "feat-b", dependsOn: ["feat-a"] },
    ]);
    // run.json binds feat-a → old-slug, but the real pipeline now runs as new-slug.
    writeEpicRunState(
      {
        epicSlug: "epic1",
        repo: repoDir,
        manifestPath: manifestPathFor("epic1"),
        manifestSha: "sha",
        maxParallel: 3,
        createdAt: "t",
        updatedAt: "t",
        features: { "feat-a": { slug: "old-slug", launchedAt: "t" } },
      },
      epicsDir,
    );
    writeState(
      {
        slug: "new-slug",
        phase: "implementing",
        repo: repoDir,
        updatedAt: "t",
      },
      stateDir,
    );

    // Rebind.
    const code = runEpicCli(
      ["bind", "epic1", "feat-a", "new-slug", "--force"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(code).toBe(0);
    const rec = readEpicRunState("epic1", epicsDir)!.features["feat-a"];
    expect(rec.slug).toBe("new-slug");
    expect(rec.priorSlugs).toEqual(["old-slug"]);

    // status --json reflects the new slug + its live phase.
    const status = statusJson("epic1");
    const row = status.board.find((r) => r.id === "feat-a")!;
    expect(row.slug).toBe("new-slug");
    expect(row.status).toBe("running"); // 'implementing' is non-terminal
    // The hypothesis framing is machine-visible.
    expect(status.source).toMatch(/cache|stale|hint/i);

    // Frontier with feat-a launched excludes it (no duplicate launch).
    const frontier = computeFrontier(m.features, {
      completed: [],
      launched: ["feat-a"],
    });
    expect(frontier.map((f) => f.id)).not.toContain("feat-a");
  });
});

describe("epic-run e2e — scenario 2: out-of-band external merge", () => {
  it("bind --external unblocks dependents and never relaunches the completed node", () => {
    const m = writeManifest("epic2", [
      { id: "feat-a" },
      { id: "feat-b", dependsOn: ["feat-a"] },
    ]);
    // No run.json yet — bind must init it on missing.
    const code = runEpicCli(
      ["bind", "epic2", "feat-a", "--external", "PR #123"],
      { cwd: repoDir, epicsDir, stateDir },
    );
    expect(code).toBe(0);
    const rec = readEpicRunState("epic2", epicsDir)!.features["feat-a"];
    expect(rec.external).toBe("PR #123");
    expect(rec.slug).toBeUndefined();
    expect(rec.completedAt).toBeDefined();

    // status --json: feat-a merged (external), feat-b ready.
    const status = statusJson("epic2");
    const a = status.board.find((r) => r.id === "feat-a")!;
    expect(a.status).toBe("merged");
    expect(a.external).toBe(true);
    expect(status.board.find((r) => r.id === "feat-b")!.status).toBe("ready");

    // The completed-external node never re-enters the frontier.
    const frontier = computeFrontier(m.features, {
      completed: ["feat-a"],
      launched: [],
    });
    expect(frontier.map((f) => f.id)).toEqual(["feat-b"]);
  });
});

describe("epic-run e2e — scenario 3: atomic launch + old-run.json tolerance", () => {
  it("launch records the binding on success and writes NOTHING on failure", () => {
    writeManifest("epic3", [{ id: "feat-c" }]);
    // Success.
    const okSpawn = vi.fn(() => ({
      status: 0,
      stdout: "flow:feat-c-minted\n",
      stderr: "",
    }));
    expect(
      runEpicCli(["launch", "epic3", "feat-c"], {
        cwd: repoDir,
        epicsDir,
        spawn: okSpawn,
      }),
    ).toBe(0);
    expect(readEpicRunState("epic3", epicsDir)!.features["feat-c"].slug).toBe(
      "feat-c-minted",
    );

    // Failure on a DIFFERENT epic: nothing recorded.
    writeManifest("epic3b", [{ id: "feat-c" }]);
    const failSpawn = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "window collision",
    }));
    expect(
      runEpicCli(["launch", "epic3b", "feat-c"], {
        cwd: repoDir,
        epicsDir,
        spawn: failSpawn,
      }),
    ).not.toBe(0);
    // No run.json record was written on the failed launch.
    expect(
      readEpicRunState("epic3b", epicsDir)?.features["feat-c"],
    ).toBeUndefined();
  });

  it("an OLD run.json carrying dropped judgment-era fields survives a bind rewrite", () => {
    writeManifest("epic-legacy", [{ id: "feat-a" }]);
    // Hand-craft an old-era run.json with obsolete top-level + per-feature keys.
    const dir = path.join(epicsDir, "epic-legacy");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        epicSlug: "epic-legacy",
        repo: repoDir,
        manifestPath: manifestPathFor("epic-legacy"),
        manifestSha: "sha",
        maxParallel: 3,
        createdAt: "t",
        updatedAt: "t",
        runnerPhase: "running",
        features: {
          "feat-a": {
            slug: "legacy-slug",
            launchedAt: "t",
            retryCount: 2,
            lastJudgment: { action: "retry", reason: "flake", at: "t" },
          },
        },
      }),
    );
    writeState(
      {
        slug: "fresh-slug",
        phase: "implementing",
        repo: repoDir,
        updatedAt: "t",
      },
      stateDir,
    );

    // A bind read-modify-writes the file; obsolete keys must round-trip.
    expect(
      runEpicCli(["bind", "epic-legacy", "feat-a", "fresh-slug", "--force"], {
        cwd: repoDir,
        epicsDir,
        stateDir,
      }),
    ).toBe(0);
    const reread = JSON.parse(
      fs.readFileSync(path.join(dir, "run.json"), "utf8"),
    );
    expect(reread.runnerPhase).toBe("running");
    expect(reread.features["feat-a"].slug).toBe("fresh-slug");
    expect(reread.features["feat-a"].priorSlugs).toEqual(["legacy-slug"]);
  });
});
