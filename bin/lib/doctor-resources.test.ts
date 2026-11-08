import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPipelineState } from "./doctor-pipelines";
import { checkLeakedProcesses } from "./doctor-processes";
import { checkStaleWorktrees } from "./doctor-resources";
import {
  writeLastSweep,
  type SweepItem,
  type SweepResult,
} from "./worktree-sweep-state";
import { makeDeps } from "./doctor-test-deps";
import type { ReapOutcome } from "./reap";
import type { ReapCliResult } from "./reap-cli";
import type { PipelineState } from "./state";

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doctor-res-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function state(over: Partial<PipelineState>): PipelineState {
  return {
    slug: "s",
    phase: "implementing",
    repo: "/nowhere",
    updatedAt: "2023-11-14T00:00:00.000Z",
    ...over,
  } as PipelineState;
}

const NOW = 1_700_000_000_000;

function item(over: Partial<SweepItem>): SweepItem {
  return {
    kind: "worktree",
    path: path.join(root, "repo-a"),
    repo: path.join(root, "repo"),
    outcome: "held",
    reason: "uncommitted-changes",
    ...over,
  };
}

function sweep(
  items: SweepItem[],
  over: Partial<SweepResult> = {},
): SweepResult {
  return {
    mode: "worktrees",
    at: new Date(NOW - 3_600_000).toISOString(),
    acted: true,
    items,
    danglingMounts: [],
    deadlineHit: false,
    totals: { removed: 0, held: 0, failed: 0, bytesFreed: 0 },
    ...over,
  };
}

function check(result: SweepResult | null, io: object = {}) {
  return checkStaleWorktrees(makeDeps(root), {
    readLastSweep: () => result,
    nowMs: () => NOW,
    exists: () => true,
    ...io,
  });
}

describe("checkStaleWorktrees", () => {
  it("warns with the fix when the cleanup has never run", () => {
    const out = check(null);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "leftovers-worktrees",
      status: "warn",
      summary: "the worktree cleanup has never run",
      fix: "flow reap --worktrees",
    });
  });

  it("summarises the last sweep in a pass row and counts open-PR holds without warning", () => {
    const out = check(
      sweep([
        item({ outcome: "removed", reason: "pr-merged", bytes: 2 * 1024 ** 3 }),
        item({
          kind: "husk",
          outcome: "removed",
          reason: "husk-empty",
          path: "/x/h",
        }),
        item({ reason: "pr-open", detail: "#289", path: "/x/open" }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("pass");
    expect(out[0].summary).toBe(
      "last sweep 1 h ago: removed 1 folders (2.0 GB), 1 leftover folders; kept 1 whose PR is still open",
    );
  });

  it("warns once per other kept folder with a plain reason and a fix", () => {
    const out = check(
      sweep([
        item({ reason: "uncommitted-changes", path: "/x/dirty", repo: "/x" }),
        item({
          reason: "in-use-process",
          path: "/x/busy",
          detail: "vite (pid 4)",
        }),
        item({ reason: "no-pr", path: "/x/nopr", repo: "/x" }),
      ]),
    );
    const warns = out.filter((c) => c.status === "warn");
    expect(warns.map((c) => c.id)).toEqual([
      "leftovers-worktrees:dirty",
      "leftovers-worktrees:busy",
      "leftovers-worktrees:nopr",
    ]);
    expect(warns[0].summary).toBe("dirty has changes that are not committed");
    expect(warns[0].fix).toContain("commit or discard");
    expect(warns[1].fix).toBe("flow reap --yes --include-strays");
    expect(warns[2].fix).toBe("cd /x && flow-remove-worktree /x/nopr");
  });

  it("never warns about a folder in use right now or too new to judge", () => {
    const out = check(
      sweep([
        item({ reason: "live-session", path: "/x/live" }),
        item({ kind: "husk", reason: "too-recent", path: "/x/new" }),
        item({ kind: "husk", reason: "reserved-by-pipeline", path: "/x/res" }),
      ]),
    );
    expect(out.map((c) => c.status)).toEqual(["pass"]);
    expect(out[0].summary).toContain("3 in use or too new to judge");
  });

  it("drops a recorded folder whose path no longer exists", () => {
    const out = check(sweep([item({ path: "/x/gone" })]), {
      exists: () => false,
    });
    expect(out.map((c) => c.status)).toEqual(["pass"]);
  });

  it("groups folders with unrecognized contents into one warning", () => {
    const out = check(
      sweep([
        item({
          kind: "husk",
          reason: "unrecognized-contents",
          path: "/x/a",
          detail: "logs",
        }),
        item({
          kind: "husk",
          reason: "unrecognized-contents",
          path: "/x/b",
          detail: "run.sh",
        }),
      ]),
    );
    const warns = out.filter((c) => c.status === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].summary).toContain("2 leftover folder(s)");
    expect(warns[0].details).toEqual(["/x/a (logs)", "/x/b (run.sh)"]);
  });

  it("warns per container that mounts a deleted folder", () => {
    const out = check(
      sweep([], {
        danglingMounts: [
          { container: "supabase_db", source: "/x/gone/supabase" },
        ],
      }),
    );
    const w = out.find(
      (c) => c.id === "leftovers-worktrees:container:supabase_db",
    )!;
    expect(w.status).toBe("warn");
    expect(w.fix).toContain("supabase stop");
  });

  it("reports a failed removal and a result over 7 days old", () => {
    const out = check(
      sweep([item({ outcome: "failed", detail: "timed out" })], {
        at: new Date(NOW - 8 * 86_400_000).toISOString(),
      }),
    );
    const ids = out.filter((c) => c.status === "warn").map((c) => c.id);
    expect(ids).toEqual([
      "leftovers-worktrees:stale-result",
      "leftovers-worktrees:repo-a",
    ]);
    expect(
      out.find((c) => c.id === "leftovers-worktrees:repo-a")?.summary,
    ).toContain("timed out");
  });

  it("reads the last result from deps.stateDir by default", () => {
    const deps = makeDeps(root);
    writeLastSweep(
      sweep([], { at: new Date(deps.nowMs()).toISOString() }),
      deps.stateDir,
    );
    expect(checkStaleWorktrees(deps)[0].status).toBe("pass");
    expect(
      checkStaleWorktrees(makeDeps(path.join(root, "empty")))[0].status,
    ).toBe("warn");
  });
});

describe("checkPipelineState", () => {
  const noWindows = () => [];

  it("warns per unresumable pipeline: unfinished, worktree recorded, directory missing", () => {
    const live = path.join(root, "live-wt");
    fs.mkdirSync(live);
    const out = checkPipelineState(makeDeps(root), {
      listStates: () => [
        state({
          slug: "lost",
          phase: "implementing",
          worktree: path.join(root, "missing"),
        }),
        state({ slug: "here", phase: "implementing", worktree: live }),
        state({
          slug: "done",
          phase: "merged",
          worktree: path.join(root, "gone-too"),
        }),
        state({
          slug: "epic",
          phase: "epic-approved",
          worktree: path.join(root, "gone-3"),
        }),
      ],
      listWindows: noWindows,
    });
    const warns = out.filter((c) => c.id.startsWith("leftovers-unresumable:"));
    expect(warns.map((c) => c.id)).toEqual(["leftovers-unresumable:lost"]);
    expect(warns[0].fix).toBe("flow done lost");
    expect(warns[0].details.join(" ")).toContain("can no longer be resumed");
  });

  it("counts only merged/cancelled records as unclosed, with flow done --merged", () => {
    const out = checkPipelineState(makeDeps(root), {
      listStates: () => [
        state({ slug: "a", phase: "merged" }),
        state({ slug: "b", phase: "cancelled" }),
        state({ slug: "c", phase: "epic-approved" }),
      ],
      listWindows: noWindows,
    });
    const c = out.find((x) => x.id === "leftovers-unclosed")!;
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("2 merged or cancelled");
    expect(c.fix).toBe("flow done --merged");
  });

  it("warns per never-started orphan past the grace window with flow done <slug>", () => {
    const deps = makeDeps(root);
    const fresh = new Date(deps.nowMs() - 5_000).toISOString();
    const out = checkPipelineState(deps, {
      listStates: () => [
        state({ slug: "stuck", phase: "starting" }),
        state({ slug: "cold-start", phase: "starting", updatedAt: fresh }),
      ],
      listWindows: noWindows,
    });
    const warns = out.filter((c) =>
      c.id.startsWith("leftovers-never-started:"),
    );
    expect(warns.map((c) => c.fix)).toEqual(["flow done stuck"]);
  });

  it("never marks a live pipeline dead for having no tmux window", () => {
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    const out = checkPipelineState(makeDeps(root), {
      listStates: () => [
        state({ slug: "running", phase: "implementing", worktree: wt }),
        state({ slug: "waiting", phase: "gated", worktree: wt }),
      ],
      listWindows: noWindows,
    });
    expect(out.every((c) => c.status === "pass")).toBe(true);
  });

  it("reads states from deps.stateDir by default", () => {
    const dir = path.join(root, "home", ".flow", "state");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "old-one.json"),
      JSON.stringify(state({ slug: "old-one", phase: "merged" })),
    );
    const out = checkPipelineState(makeDeps(root), { listWindows: noWindows });
    expect(out.find((c) => c.id === "leftovers-unclosed")?.status).toBe("warn");
  });
});

describe("checkLeakedProcesses", () => {
  const report = (over: Partial<ReapCliResult>): ReapCliResult =>
    ({
      mode: "reap",
      yes: false,
      includeStrays: false,
      registry: { mode: "sweep", yes: false, slugs: [] },
      heuristic: { ran: true, found: [], foundServers: [], signalled: [] },
      agy: { ran: true, found: [], signalled: [], killed: [], stillAlive: [] },
      ...over,
    }) as unknown as ReapCliResult;

  const slugRow = (
    slug: string,
    counts: Partial<Record<ReapOutcome, number>>,
    skipped?: "deadline-exceeded",
  ) => ({
    slug,
    reap: { counts },
    reported: { dead: 0, alive: 0, unknown: 0 },
    classified: [
      { verdict: "dead", row: { argv: ["node", "--token=SUPERSECRET"] } },
    ],
    ...(skipped ? { skipped } : {}),
  });

  const registry = (slugs: unknown[]) =>
    ({
      mode: "sweep",
      yes: false,
      slugs,
    }) as unknown as ReapCliResult["registry"];

  it("runs report-only against deps.reapBaseDir with a bounded deadline", () => {
    let seen: unknown;
    const deps = makeDeps(root);
    checkLeakedProcesses(deps, (opts) => {
      seen = opts;
      return report({});
    });
    expect(seen).toEqual({
      yes: false,
      baseDir: deps.reapBaseDir,
      stateDir: deps.stateDir,
      deadlineMs: 5000,
    });
  });

  it("passes when nothing leaked", () => {
    const out = checkLeakedProcesses(makeDeps(root), () => report({}));
    expect(out.map((c) => c.status)).toEqual(["pass", "pass"]);
  });

  it("warns on would-reap rows with slugs and counts, never argv", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: registry([
          slugRow("alpha", { "would-reap": 2 }),
          slugRow("beta", {}),
        ]),
      }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c).toMatchObject({ status: "warn", fix: "flow reap --yes" });
    expect(c.summary).toContain("2 process(es) still running");
    expect(c.details.join(" ")).toContain("alpha");
    expect(c.details.join(" ")).not.toContain("beta");
    expect(JSON.stringify(out)).not.toMatch(/SUPERSECRET|--token/);
  });

  it("passes when only already-dead rows remain, noting the stale entries", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: registry([
          slugRow("alpha", { "already-dead": 1000 }),
          slugRow("beta", { "already-dead": 662 }),
        ]),
      }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c.status).toBe("pass");
    expect(c.summary).toBe("no processes left running by ended pipelines");
    expect(c.details.join(" ")).toContain("1662 stale registry entries");
    expect(c.details.join(" ")).toContain("flow reap --yes");
    expect(JSON.stringify(out)).not.toMatch(/SUPERSECRET|--token/);
  });

  it("singularises a lone stale registry entry", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({ registry: registry([slugRow("a", { "already-dead": 1 })]) }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c.details.join(" ")).toContain("1 stale registry entry ");
  });

  it("never counts a reused pid (skipped-epoch-mismatch) as a leak", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: registry([slugRow("a", { "skipped-epoch-mismatch": 4 })]),
      }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c.status).toBe("pass");
    expect(c.details).toEqual([]);
  });

  it("warns to inspect (report-only fix) on dead-leader and failed rows", () => {
    for (const outcome of [
      "skipped-dead-leader",
      "still-alive",
      "failed",
    ] as const) {
      const out = checkLeakedProcesses(makeDeps(root), () =>
        report({ registry: registry([slugRow("a", { [outcome]: 3 })]) }),
      );
      const c = out.find((x) => x.id === "leftovers-processes")!;
      expect(c).toMatchObject({ status: "warn", fix: "flow reap" });
      expect(c.summary).toContain("3 process(es)");
      expect(c.summary).toContain("need a look");
      expect(JSON.stringify(out)).not.toMatch(/SUPERSECRET|--token/);
    }
  });

  it("reports running and needs-a-look counts together", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: registry([
          slugRow("a", { "would-reap": 1 }),
          slugRow("b", { failed: 2 }),
        ]),
      }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c.fix).toBe("flow reap --yes");
    expect(c.summary).toContain("1 process(es) still running");
    expect(c.summary).toContain("2 process(es) from ended pipelines need");
  });

  it("caps the slug list so a large registry stays one short line", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      slugRow(`slug-${i}`, { "would-reap": 1 }),
    );
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({ registry: registry(many) }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c.summary).toContain("12 process(es)");
    expect(c.details[0]).toContain("(+7 more)");
    expect(c.details[0]).not.toContain("slug-11");
  });

  it("warns about strays as host-wide with the include-strays fix", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        heuristic: {
          ran: true,
          found: [{ pid: 1, argv: "chrome --key=SECRET" }],
          foundServers: [{ pid: 2, command: "mcp --token=SECRET" }],
          signalled: [],
        } as unknown as ReapCliResult["heuristic"],
      }),
    );
    const c = out.find((x) => x.id === "leftovers-strays")!;
    expect(c.status).toBe("warn");
    expect(c.fix).toBe("flow reap --yes --include-strays");
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  const agyStray = {
    pid: 9,
    pgid: 9,
    startEpochMs: 1,
    ageMs: 99,
    timeLimitSec: 720,
    overdue: true,
  };

  it("warns about orphaned agy runs with their count and the include-strays fix", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        agy: {
          ran: true,
          found: [agyStray, { ...agyStray, pid: 10 }],
          signalled: [],
          killed: [],
          stillAlive: [],
        },
      }),
    );
    const c = out.find((x) => x.id === "leftovers-strays")!;
    expect(c.status).toBe("warn");
    expect(c.title).toBe("Stray browsers, servers, and agy runs");
    expect(c.summary).toBe("2 agy run(s) look orphaned");
    expect(c.fix).toBe("flow reap --yes --include-strays");
  });

  it("says which agy runs reap will not stop yet (still within their time limit)", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        agy: {
          ran: true,
          found: [agyStray, { ...agyStray, pid: 10, overdue: false }],
          signalled: [],
          killed: [],
          stillAlive: [],
        },
      }),
    );
    expect(out.find((x) => x.id === "leftovers-strays")?.summary).toBe(
      "2 agy run(s) look orphaned (1 still within their time limit; reap stops them once past it)",
    );
  });

  it("appends the agy count to the browser and server summary", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        heuristic: {
          ran: true,
          found: [{ pid: 1 }],
          foundServers: [],
          signalled: [],
        } as unknown as ReapCliResult["heuristic"],
        agy: {
          ran: true,
          found: [agyStray],
          signalled: [],
          killed: [],
          stillAlive: [],
        },
      }),
    );
    expect(out.find((x) => x.id === "leftovers-strays")?.summary).toBe(
      "1 browser(s) and 0 MCP server(s) look orphaned and 1 agy run(s) look orphaned",
    );
  });

  it("tolerates a report with no agy field (older fixtures)", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({ agy: undefined }),
    );
    expect(out.find((x) => x.id === "leftovers-strays")?.status).toBe("pass");
  });

  it("skips the stray scan when ps is unavailable", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        heuristic: {
          ran: false,
          skipReason: "ps-unavailable",
          found: [],
          foundServers: [],
          signalled: [],
        },
      }),
    );
    expect(out.find((x) => x.id === "leftovers-strays")?.status).toBe("skip");
  });

  it("warns when the sweep deadline left slugs unchecked", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: {
          mode: "sweep",
          yes: false,
          slugs: [slugRow("slow", {}, "deadline-exceeded")],
        } as unknown as ReapCliResult["registry"],
      }),
    );
    expect(out.find((x) => x.id === "leftovers-processes")).toMatchObject({
      status: "warn",
      fix: "flow reap",
    });
  });

  it("warns when only some rows of a slug were never reached before the deadline", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: registry([slugRow("partial", { "deadline-exceeded": 2 })]),
      }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("not checked before the sweep deadline");
    expect(c.details.join(" ")).toContain("partial");
  });
});
