import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeManagerRecord, type ManagerRecord } from "./manager-record";
import { stateInScope, updateScope } from "./manager-scope";
import { renderManagerStatus, writeManagerStatus } from "./manager-status";
import type { PipelineState } from "./state";

const NOW = new Date("2026-11-08T00:00:00.000Z");
const state = (over: Partial<PipelineState>): PipelineState => ({
  slug: "s",
  phase: "implementing",
  repo: "/r/flow",
  updatedAt: "2026-11-07T23:00:00.000Z",
  ...over,
});
const extra = { openProposals: 2, liveNotes: 1 };

describe("renderManagerStatus", () => {
  it("lists a gated pipeline first with its owner action and a 3d waiting age", () => {
    const out = renderManagerStatus(
      [
        state({ slug: "busy", phase: "implementing" }),
        state({
          slug: "waiting",
          phase: "gated",
          epic: { slug: "e", featureId: "f1" },
          updatedAt: "2026-11-05T00:00:00.000Z",
        }),
      ],
      NOW,
      extra,
    );
    const rows = out
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("| ") &&
          !l.startsWith("| Pipeline") &&
          !l.startsWith("| ---"),
      );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("| waiting | flow | e | gated |");
    expect(rows[0]).toContain("PR is gated");
    expect(rows[0]).toContain("| 3d |");
    expect(rows[1]).toContain("| busy |");
    expect(rows[1]).toContain("| - | 1h |");
    expect(out).toContain("open proposals: 2 · live notes: 1");
  });

  it("says an unaccepted ruling's pipeline needs an answer in its own window", () => {
    const out = renderManagerStatus(
      [state({ slug: "stuck", phase: "plan-pending-review" })],
      NOW,
      { ...extra, unpicked: ["stuck"] },
    );
    expect(out).toContain("approval not picked up — answer in window stuck");
    const plain = renderManagerStatus(
      [state({ slug: "stuck", phase: "plan-pending-review" })],
      NOW,
      extra,
    );
    expect(plain).not.toContain("not picked up");
  });

  it("measures the wait from the last phaseLog entry for the current phase", () => {
    const out = renderManagerStatus(
      [
        state({
          slug: "a",
          phase: "gated",
          updatedAt: "2026-11-07T23:59:00.000Z",
          phaseLog: [
            { phase: "gated", at: "2026-11-01T00:00:00.000Z" },
            { phase: "ci", at: "2026-11-02T00:00:00.000Z" },
            { phase: "gated", at: "2026-11-06T00:00:00.000Z" },
          ],
        }),
      ],
      NOW,
      extra,
    );
    expect(out).toContain("| 2d |");
  });

  it("orders owner-needed rows oldest first and omits finished pipelines", () => {
    const out = renderManagerStatus(
      [
        state({
          slug: "new",
          phase: "gated",
          updatedAt: "2026-11-07T00:00:00.000Z",
        }),
        state({
          slug: "old",
          phase: "needs-human",
          updatedAt: "2026-11-01T00:00:00.000Z",
        }),
        state({ slug: "done", phase: "merged" }),
      ],
      NOW,
      extra,
    );
    expect(out.indexOf("| old |")).toBeLessThan(out.indexOf("| new |"));
    expect(out).not.toContain("| done |");
  });

  it("says so when nothing is unfinished", () => {
    expect(
      renderManagerStatus([state({ phase: "merged" })], NOW, extra),
    ).toContain("No unfinished pipelines.");
  });
});

describe("renderManagerStatus view", () => {
  const states = [
    state({ slug: "mine", phase: "implementing", repo: "/r/flow" }),
    state({ slug: "theirs", phase: "gated", repo: "/r/other" }),
    state({ slug: "theirs-busy", phase: "implementing", repo: "/r/other" }),
  ];
  const inScope = (s: PipelineState) => s.repo === "/r/flow";

  it("lists only in-scope rows and no notices when notices are off", () => {
    const out = renderManagerStatus(states, NOW, extra, { inScope });
    expect(out).toContain("| mine |");
    expect(out).not.toContain("theirs");
    expect(out).not.toContain("## Not in scope");
  });

  it("names an out-of-scope owner-needed pipeline only under Not in scope when notices are on", () => {
    const out = renderManagerStatus(states, NOW, extra, {
      inScope,
      notices: true,
    });
    const [table, notices] = out.split("## Not in scope");
    expect(table).not.toContain("theirs");
    expect(notices).toContain(
      "- theirs (repo other) is PR is gated — validate its open Test Steps, then merge — answer in window theirs",
    );
    expect(notices).not.toContain("theirs-busy");
  });

  it("prints the #N handle beside a needs-you row", () => {
    const out = renderManagerStatus(states, NOW, extra, {
      handleFor: (s) => (s.slug === "theirs" ? 3 : undefined),
    });
    expect(out).toContain("| #3 PR is gated");
  });

  it("is unchanged from the plain table with no view", () => {
    expect(renderManagerStatus(states, NOW, extra)).toBe(
      renderManagerStatus(states, NOW, extra, {}),
    );
  });
});

describe("writeManagerStatus", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mstatus-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  const record: ManagerRecord = {
    version: 1,
    window: "manager",
    startedAt: "2026-11-08T00:00:00.000Z",
    model: "opus",
    effort: "medium",
    heartbeatSec: 900,
    stopWhenIdle: false,
    notices: false,
  };
  const scope = () =>
    updateScope(
      () => ({
        version: 1,
        scopes: ["repo:flow"],
        updatedAt: NOW.toISOString(),
        source: "cli",
      }),
      home,
    );
  const states = [
    state({ slug: "mine", repo: "/r/flow" }),
    state({ slug: "theirs", phase: "gated", repo: "/r/other" }),
  ];
  const read = () => fs.readFileSync(path.join(home, "status.md"), "utf8");

  it("renders the full table with no scope.json", () => {
    writeManagerStatus(states, NOW, extra, home);
    expect(read()).toBe(
      renderManagerStatus(states, NOW, extra, {
        handleFor: () => 1,
      }),
    );
    expect(read()).toContain("| theirs |");
  });

  it("filters to the scope while a manager record exists", () => {
    scope();
    writeManagerRecord(record, home);
    writeManagerStatus(states, NOW, extra, home);
    expect(read()).toContain("| mine |");
    expect(read()).not.toContain("theirs");
  });

  it("adds the Not in scope section when the record has notices on", () => {
    scope();
    writeManagerRecord({ ...record, notices: true }, home);
    writeManagerStatus(states, NOW, extra, home);
    expect(read()).toContain("## Not in scope");
    expect(read().split("## Not in scope")[0]).not.toContain("theirs");
  });

  it("renders the full table when scope.json exists but no manager record does", () => {
    scope();
    writeManagerStatus(states, NOW, extra, home);
    expect(read()).toContain("| mine |");
    expect(read()).toContain("| theirs |");
    expect(read()).not.toContain("## Not in scope");
  });

  it("agrees with stateInScope for a finished in-scope pipeline", () => {
    expect(stateInScope(state({ phase: "merged" }), scope())).toBe(true);
  });

  it("assigns stable handles and reuses them across writes", () => {
    const first = [
      state({ slug: "a", phase: "gated" }),
      state({ slug: "b", phase: "needs-human" }),
    ];
    writeManagerStatus(first, NOW, extra, home);
    expect(read()).toMatch(/\| a \|.*#1 PR is gated/);
    expect(read()).toMatch(/\| b \|.*#2 needs a human/);
    const reordered = [
      state({ slug: "c", phase: "gated" }),
      first[1]!,
      first[0]!,
    ];
    writeManagerStatus(reordered, NOW, extra, home);
    expect(read()).toMatch(/\| a \|.*#1 /);
    expect(read()).toMatch(/\| b \|.*#2 /);
    expect(read()).toMatch(/\| c \|.*#3 /);
  });

  it("reports changed only when the content differs apart from the timestamp", () => {
    expect(writeManagerStatus(states, NOW, extra, home).changed).toBe(true);
    const later = new Date(NOW.getTime() + 60_000);
    expect(writeManagerStatus(states, later, extra, home).changed).toBe(false);
    expect(
      writeManagerStatus(states, later, { ...extra, liveNotes: 9 }, home)
        .changed,
    ).toBe(true);
  });
});
