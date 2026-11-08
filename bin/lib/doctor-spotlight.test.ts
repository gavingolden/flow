import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorktreeIndexing } from "./doctor-spotlight";
import { makeDeps, scriptedRun, type RunCall } from "./doctor-test-deps";
import type { PipelineState } from "./state";
import type { SweepItem, SweepResult } from "./worktree-sweep-state";

let root: string;
let repo: string;
let container: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "doctor-spot-")),
  );
  repo = path.join(root, "repo");
  container = path.join(root, "flow-worktrees.noindex");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const states = (): PipelineState[] => [{ repo } as PipelineState];

function sweep(items: Partial<SweepItem>[]): SweepResult {
  return {
    mode: "worktrees",
    at: "2026-11-08T00:00:00Z",
    acted: false,
    items: items.map((i) => ({
      kind: "worktree",
      repo,
      outcome: "held",
      reason: "pr-open",
      path: path.join(root, "repo-old"),
      ...i,
    })) as SweepItem[],
    danglingMounts: [],
    deadlineHit: false,
    totals: { removed: 0, held: 0, failed: 0, bytesFreed: 0 },
  };
}

function run(
  mdfind: Parameters<typeof scriptedRun>[0],
  over: {
    platform?: NodeJS.Platform;
    sweep?: SweepResult | null;
    exists?: (p: string) => boolean;
  } = {},
) {
  const calls: RunCall[] = [];
  const deps = makeDeps(root, {
    run: scriptedRun(mdfind, calls),
    platform: over.platform ?? "darwin",
  });
  const checks = checkWorktreeIndexing(deps, {
    listStates: states,
    lastSweep: () => over.sweep ?? null,
    exists: over.exists ?? fs.existsSync,
  });
  return { checks, calls };
}

describe("checkWorktreeIndexing", () => {
  it("passes as not applicable off macOS", () => {
    const { checks, calls } = run(() => ({ stdout: "9" }), {
      platform: "linux",
    });
    expect(checks[0].status).toBe("pass");
    expect(checks[0].summary).toContain("not macOS");
    expect(calls).toEqual([]);
  });

  it("passes with no container yet", () => {
    const { checks } = run(() => ({ stdout: "9" }));
    expect(checks[0].status).toBe("pass");
    expect(checks[0].summary).toBe("no worktree folder yet");
  });

  it("passes with the measurement when Spotlight reports 0, querying public.item", () => {
    fs.mkdirSync(container);
    const { checks, calls } = run(() => ({ stdout: "0\n" }));
    expect(checks[0].status).toBe("pass");
    expect(checks[0].summary).toBe(
      `Spotlight reports 0 indexed files in ${container}`,
    );
    expect(calls[0]).toEqual({
      cmd: "mdfind",
      args: [
        "-count",
        "-onlyin",
        container,
        'kMDItemContentTypeTree == "public.item"',
      ],
    });
  });

  it("warns with the count and the Search Privacy fix when files are indexed", () => {
    fs.mkdirSync(container);
    const { checks } = run(() => ({ stdout: "12\n" }));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].summary).toContain("12 files");
    expect(checks[0].fix).toContain("Search Privacy");
    expect(checks[0].fix).toContain(container);
  });

  it.each([
    ["mdfind is missing", { notFound: true, status: null }],
    ["mdfind times out", { timedOut: true, status: null }],
  ])("warns could-not-check when %s", (_n, result) => {
    fs.mkdirSync(container);
    const { checks } = run(() => result);
    expect(checks[0].status).toBe("warn");
    expect(checks[0].summary).toContain("could not check Spotlight");
  });

  it("warns could-not-check on a non-zero exit or unreadable output", () => {
    fs.mkdirSync(container);
    expect(run(() => ({ status: 1 })).checks[0].summary).toContain(
      "could not check",
    );
    expect(run(() => ({ stdout: "oops" })).checks[0].summary).toContain(
      "could not check",
    );
  });

  it("mentions older sibling worktrees from the last sweep without turning a pass into a warn", () => {
    fs.mkdirSync(container);
    const { checks } = run(() => ({ stdout: "0" }), {
      sweep: sweep([
        {},
        { path: path.join(container, "repo-new") },
        { outcome: "removed", path: path.join(root, "repo-gone") },
      ]),
      exists: () => true,
    });
    expect(checks[0].status).toBe("pass");
    expect(checks[0].details.join(" ")).toContain("1 older worktree");
    expect(checks[0].details.join(" ")).toContain("nothing to do");
    expect(checks[0].fix).toBeUndefined();
  });

  it("ignores swept worktrees whose folder is gone, that flow did not create, or husk items", () => {
    fs.mkdirSync(container);
    const gone = path.join(root, "repo-gone-already");
    const { checks } = run(() => ({ stdout: "0" }), {
      sweep: sweep([
        { path: gone },
        { path: path.join(root, "unrelated-folder") },
        {
          kind: "husk" as SweepItem["kind"],
          path: path.join(root, "repo-husk"),
        },
      ]),
      exists: (p) => p !== gone,
    });
    expect(checks[0].details).toEqual([]);
  });

  it("names every indexed container in the warn fix", () => {
    const other = path.join(root, "other-parent", "flow-worktrees.noindex");
    const otherRepo = path.join(root, "other-parent", "repo2");
    fs.mkdirSync(container);
    fs.mkdirSync(other, { recursive: true });
    const calls: RunCall[] = [];
    const deps = makeDeps(root, {
      run: scriptedRun(() => ({ stdout: "3" }), calls),
      platform: "darwin",
    });
    const checks = checkWorktreeIndexing(deps, {
      listStates: () => [
        { repo } as PipelineState,
        { repo: otherRepo } as PipelineState,
      ],
      lastSweep: () => null,
    });
    expect(checks[0].fix).toContain(container);
    expect(checks[0].fix).toContain(other);
  });
});
