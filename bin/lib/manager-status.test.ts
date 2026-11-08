import { describe, expect, it } from "vitest";
import { renderManagerStatus } from "./manager-status";
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
