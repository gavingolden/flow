import { describe, expect, it } from "vitest";
import {
  formatBytes,
  holdReasonText,
  renderWorktreeSweepText,
} from "./worktree-sweep-render";
import type { HoldReason } from "./worktree-sweep-rules";
import type { SweepItem, SweepResult } from "./worktree-sweep-state";

function result(
  items: SweepItem[],
  over: Partial<SweepResult> = {},
): SweepResult {
  return {
    mode: "worktrees",
    at: "2026-01-01T00:00:00.000Z",
    acted: false,
    items,
    danglingMounts: [],
    deadlineHit: false,
    totals: { removed: 0, held: 0, failed: 0, bytesFreed: 0 },
    ...over,
  };
}

const merged: SweepItem = {
  kind: "worktree",
  path: "/code/repo-a",
  repo: "/code/repo",
  branch: "a",
  pr: 5,
  outcome: "would-remove",
  reason: "pr-merged",
  bytes: 3 * 1024 ** 3,
};
const husk: SweepItem = {
  kind: "husk",
  path: "/code/repo-old",
  repo: "/code/repo",
  outcome: "would-remove",
  reason: "husk-empty",
  cause: "unused-launch-folder",
};
const kept: SweepItem = {
  kind: "worktree",
  path: "/code/repo-b",
  repo: "/code/repo",
  outcome: "held",
  reason: "pr-open",
  detail: "#289",
};

describe("renderWorktreeSweepText", () => {
  it("opens with a plain-words Summary and a closing line naming --yes in preview", () => {
    const out = renderWorktreeSweepText(result([merged, husk, kept]));
    expect(out.split("\n")[0]).toBe(
      "Summary: would remove 1 folder (3.0 GB) and 1 leftover folder; kept 1 for safety",
    );
    expect(out).toContain("PR #289 is still open");
    expect(out).toContain(
      "an empty folder reserved by a launch that never filled it",
    );
    expect(out.trimEnd().split("\n").pop()).toContain("--yes");
  });

  it("uses past tense and omits the preview line once acted", () => {
    const out = renderWorktreeSweepText(
      result([{ ...merged, outcome: "removed" }], { acted: true }),
    );
    expect(out).toContain("Summary: removed 1 folder");
    expect(out).not.toContain("Preview only");
  });

  it("names the container and the fix for a dangling mount, from the repo's main checkout", () => {
    const out = renderWorktreeSweepText(
      result([kept], {
        danglingMounts: [
          { container: "supabase_db", source: "/code/repo-gone/supabase" },
        ],
      }),
    );
    expect(out).toContain("supabase_db mounts /code/repo-gone/supabase");
    expect(out).toContain(
      "`supabase stop` then `supabase start` from /code/repo",
    );
  });

  it("explains skips and the checks it could not make", () => {
    expect(
      renderWorktreeSweepText(result([], { skipped: "disabled" })),
    ).toContain("turned off");
    expect(
      renderWorktreeSweepText(result([], { skipped: "throttled" })),
    ).toContain("less than an hour");
    expect(
      renderWorktreeSweepText(result([], { skipped: "locked" })),
    ).toContain("already running");
    const out = renderWorktreeSweepText(
      result([], {
        dockerSkipped: "docker-not-installed",
        processesSkipped: "ps-unavailable",
        ghUnreachable: true,
      }),
    );
    expect(out).toContain("Docker was not checked");
    expect(out).toContain("could not be checked");
    expect(out).toContain("GitHub could not be reached");
    expect(out).toContain("Summary: nothing to remove");
  });

  it("lists failures with their message", () => {
    const out = renderWorktreeSweepText(
      result([{ ...merged, outcome: "failed", detail: "has changes" }], {
        acted: true,
      }),
    );
    expect(out).toContain("Could not remove");
    expect(out).toContain("/code/repo-a — has changes");
  });
});

describe("holdReasonText", () => {
  const known: Record<HoldReason, true> = {
    locked: true,
    "flow-source": true,
    "contains-launch-dir": true,
    "no-branch": true,
    "live-session": true,
    "session-unknown": true,
    "in-use-process": true,
    "in-use-container": true,
    "gh-unreachable": true,
    "no-pr": true,
    "pr-open": true,
    "uncommitted-changes": true,
    "local-config-differs": true,
    "head-not-on-github": true,
    "deadline-reached": true,
    "registered-worktree": true,
    "reserved-by-pipeline": true,
    "too-recent": true,
    "too-large-to-scan": true,
    "unrecognized-contents": true,
  };
  const reasons = Object.keys(known) as HoldReason[];

  it.each(reasons)(
    "gives %s a plain-words phrase with no internal identifiers",
    (reason) => {
      const text = holdReasonText(reason, "x");
      expect(text.length).toBeGreaterThan(5);
      if (reason.includes("-")) expect(text).not.toContain(reason);
    },
  );

  it("words an unreadable Docker specifically", () => {
    expect(holdReasonText("in-use-container", "could not check Docker")).toBe(
      "flow could not check whether a Docker container is using it",
    );
  });

  it("words the unreadable process table specifically", () => {
    expect(
      holdReasonText("in-use-process", "could not read running processes"),
    ).toBe("flow could not check what is running in it");
  });
});

describe("formatBytes", () => {
  it.each([
    [3 * 1024 ** 3, "3.0 GB"],
    [5 * 1024 ** 2, "5.0 MB"],
    [2048, "2 KB"],
    [0, "1 KB"],
  ])("formats %d as %s", (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
});
