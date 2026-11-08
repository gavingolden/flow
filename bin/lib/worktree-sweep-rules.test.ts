import { describe, expect, it } from "vitest";
import {
  decideHusk,
  decideWorktree,
  HUSK_MIN_AGE_MS,
  pickDecisivePr,
  type HuskFacts,
  type WorktreeFacts,
} from "./worktree-sweep-rules";

const NOW = 1_800_000_000_000;

function facts(over: Partial<WorktreeFacts> = {}): WorktreeFacts {
  return {
    path: "/code/repo-feat",
    repo: "/code/repo",
    branch: "feat",
    locked: false,
    isFlowSource: false,
    containsLaunchDir: false,
    owners: [],
    processesInside: [],
    containersMounting: [],
    prs: [{ number: 7, state: "MERGED", headOid: "abc" }],
    dirty: false,
    localConfigDiffers: false,
    headContained: true,
    deadlineReached: false,
    ...over,
  };
}

function husk(over: Partial<HuskFacts> = {}): HuskFacts {
  return {
    path: "/code/repo-old",
    repo: "/code/repo",
    files: [],
    topLevel: [],
    scanTruncated: false,
    newestMtimeMs: NOW - 2 * HUSK_MIN_AGE_MS,
    nowMs: NOW,
    registered: false,
    reservedByActive: false,
    processesInside: [],
    processesUnknown: false,
    containsLaunchDir: false,
    containersMounting: [],
    ...over,
  };
}

describe("decideWorktree", () => {
  it("removes a merged, clean, contained folder and deletes its branch", () => {
    expect(decideWorktree(facts())).toEqual({
      action: "remove",
      reason: "pr-merged",
      pr: 7,
      headOid: "abc",
      deleteBranch: true,
    });
  });

  it("removes a closed-unmerged folder but keeps its branch", () => {
    const v = decideWorktree(
      facts({ prs: [{ number: 9, state: "CLOSED", headOid: "def" }] }),
    );
    expect(v).toMatchObject({
      action: "remove",
      reason: "pr-closed",
      deleteBranch: false,
    });
  });

  const owner = (
    over: Partial<WorktreeFacts["owners"][number]>,
  ): WorktreeFacts["owners"] => [
    {
      slug: "s",
      phase: "implementing",
      liveness: "stale",
      windowOpen: false,
      ...over,
    },
  ];

  const cases: Array<[string, Partial<WorktreeFacts>]> = [
    ["locked", { locked: true }],
    ["flow-source", { isFlowSource: true }],
    ["contains-launch-dir", { containsLaunchDir: true }],
    ["no-branch", { branch: undefined }],
    ["live-session", { owners: owner({ liveness: "alive" }) }],
    ["live-session", { owners: owner({ windowOpen: true }) }],
    ["session-unknown", { owners: owner({ liveness: "unknown" }) }],
    ["in-use-process", { processesInside: [{ pid: 1, command: "node" }] }],
    ["in-use-process", { processesInside: "unknown" }],
    ["in-use-container", { containersMounting: ["supabase_db"] }],
    ["in-use-container", { containersMounting: "unknown" }],
    ["gh-unreachable", { prs: "unreachable" }],
    ["no-pr", { prs: [] }],
    ["pr-open", { prs: [{ number: 3, state: "OPEN", headOid: "x" }] }],
    ["uncommitted-changes", { dirty: true }],
    ["uncommitted-changes", { dirty: "unknown" }],
    ["local-config-differs", { localConfigDiffers: true }],
    ["head-not-on-github", { headContained: false }],
    ["head-not-on-github", { headContained: "unknown" }],
    ["deadline-reached", { deadlineReached: true }],
  ];

  it.each(cases)("holds with %s when only that guard fails", (reason, over) => {
    expect(decideWorktree(facts(over))).toMatchObject({
      action: "hold",
      reason,
    });
  });

  it("reports an unreadable Docker in plain words", () => {
    expect(decideWorktree(facts({ containersMounting: "unknown" }))).toEqual({
      action: "hold",
      reason: "in-use-container",
      detail: "could not check Docker",
    });
  });

  it("reports a spent deadline instead of the unchecked placeholders", () => {
    expect(
      decideWorktree(
        facts({
          deadlineReached: true,
          dirty: "unknown",
          headContained: "unknown",
        }),
      ),
    ).toMatchObject({ action: "hold", reason: "deadline-reached" });
  });

  it("does not hold on a finished owner with unknown liveness", () => {
    const v = decideWorktree(
      facts({ owners: owner({ liveness: "unknown", phase: "merged" }) }),
    );
    expect(v.action).toBe("remove");
  });

  it("does not hold on a dead or stale owner session", () => {
    for (const liveness of ["dead", "stale"] as const) {
      expect(
        decideWorktree(facts({ owners: owner({ liveness }) })).action,
      ).toBe("remove");
    }
  });

  it("holds on an open PR even when an older PR merged", () => {
    const v = decideWorktree(
      facts({
        prs: [
          { number: 1, state: "MERGED", headOid: "a" },
          { number: 2, state: "OPEN", headOid: "b" },
        ],
      }),
    );
    expect(v).toMatchObject({ action: "hold", reason: "pr-open" });
  });

  it("reports the unreadable process table in plain words", () => {
    expect(decideWorktree(facts({ processesInside: "unknown" }))).toEqual({
      action: "hold",
      reason: "in-use-process",
      detail: "could not read running processes",
    });
  });

  it("picks the newest merged PR over a newer closed one", () => {
    expect(
      pickDecisivePr([
        { number: 5, state: "MERGED", headOid: "m" },
        { number: 8, state: "CLOSED", headOid: "c" },
      ])?.number,
    ).toBe(5);
  });
});

describe("decideHusk", () => {
  it("removes an empty old folder as husk-empty", () => {
    expect(decideHusk(husk())).toEqual({
      action: "remove",
      reason: "husk-empty",
      cause: "unused-launch-folder",
    });
  });

  it("removes a supabase-only folder (zero files) and names the cause", () => {
    expect(decideHusk(husk({ topLevel: ["supabase"] }))).toMatchObject({
      action: "remove",
      cause: "supabase-container-mounts",
    });
  });

  it("removes a .vite-only folder as dev-server-cache", () => {
    expect(
      decideHusk(husk({ files: [".vite/deps/a.js"], topLevel: [".vite"] })),
    ).toEqual({
      action: "remove",
      reason: "husk-cache-only",
      cause: "dev-server-cache",
    });
  });

  it("labels mixed caches", () => {
    expect(
      decideHusk(
        husk({ files: [".vite/a", "node_modules/x/y.js"], topLevel: [] }),
      ),
    ).toMatchObject({ action: "remove", cause: "mixed-caches" });
  });

  it("holds an .idea-only folder as unrecognized with the ide cause", () => {
    expect(
      decideHusk(husk({ files: [".idea/shelf/a.xml"], topLevel: [".idea"] })),
    ).toMatchObject({
      action: "hold",
      reason: "unrecognized-contents",
      cause: "ide-project-files",
    });
  });

  it("holds a flow-sdd-eval-shaped folder (logs + script)", () => {
    expect(
      decideHusk(
        husk({
          files: ["logs/run.log", "run.sh"],
          topLevel: ["logs", "run.sh"],
        }),
      ),
    ).toMatchObject({
      action: "hold",
      reason: "unrecognized-contents",
      topLevel: ["logs", "run.sh"],
    });
  });

  const cases: Array<[string, Partial<HuskFacts>]> = [
    ["registered-worktree", { registered: true }],
    ["reserved-by-pipeline", { reservedByActive: true }],
    ["contains-launch-dir", { containsLaunchDir: true }],
    ["in-use-container", { containersMounting: "unknown" }],
    ["in-use-process", { processesUnknown: true }],
    ["in-use-process", { processesInside: [{ pid: 4, command: "vite" }] }],
    ["too-recent", { newestMtimeMs: NOW - 60_000 }],
    ["too-large-to-scan", { scanTruncated: true }],
  ];
  it.each(cases)("holds with %s when only that guard fails", (reason, over) => {
    expect(decideHusk(husk(over))).toMatchObject({ action: "hold", reason });
  });

  it("holds an empty folder whose own directory mtime is under an hour", () => {
    expect(
      decideHusk(husk({ files: [], newestMtimeMs: NOW - 5 * 60_000 })),
    ).toMatchObject({ action: "hold", reason: "too-recent" });
  });

  it("reclaims an empty folder reserved by a dead session (not reserved-by-pipeline)", () => {
    expect(decideHusk(husk({ reservedByActive: false })).action).toBe("remove");
  });
});
