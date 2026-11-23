import { describe, expect, it, vi } from "vitest";
import { formatVerdict, type Verdict } from "../flow-followups";
import {
  appendRecorded,
  applyMergeSeeds,
  mergeSeedEntries,
  recordTurnEndItems,
} from "./untracked-merge-seed";
import type { PipelineState } from "./state";

const base: PipelineState = {
  slug: "s",
  phase: "merging",
  repo: "/r",
  updatedAt: "t",
};

describe("FAIL_LINE", () => {
  it("seeds a follow-up that failed to spawn (exit -1)", () => {
    const seeds = mergeSeedEntries({
      afterMerge: [],
      followupEntries: [],
      followupsBlock: "  FAIL    brew install shellcheck  (exit -1)\n",
    });
    expect(seeds.map((s) => s.source)).toEqual(["followup"]);
  });
});

describe("appendRecorded / recordTurnEndItems", () => {
  const w = (title: string, kind: "work" | "manual" = "work") => ({
    title,
    kind,
  });
  it("dedups against dropped items and within a batch by normalised title", () => {
    const s = {
      ...base,
      untracked: [
        {
          id: 3,
          title: "serialize parallel suites",
          source: "x",
          at: "t",
          droppedAt: "t",
        },
      ],
    };
    const r = appendRecorded(
      s,
      [
        w("  Serialize   parallel suites "),
        w("new idea", "manual"),
        w("NEW IDEA"),
      ],
      () => "t2",
    );
    expect(r.added).toEqual([4]);
    expect(r.state.untracked!.at(-1)).toMatchObject({
      id: 4,
      source: "turn-end",
      kind: "manual",
    });
  });

  it("writes only when something was added, and throws on a missing state", () => {
    const s = {
      ...base,
      untracked: [{ id: 1, title: "a idea", source: "x", at: "t" }],
    };
    const write = vi.fn();
    const read = vi.fn(() => s);
    recordTurnEndItems("s", [w("A  Idea")], { read, write });
    expect(write).not.toHaveBeenCalled();
    recordTurnEndItems("s", [w("other")], { read, write });
    expect(write).toHaveBeenCalledTimes(1);
    expect(() =>
      recordTurnEndItems("s", [w("x")], { read: () => null, write }),
    ).toThrow(/no state/);
  });
});

describe("mergeSeedEntries", () => {
  it("turns one after-merge item and one non-allowlisted follow-up into two manual items", () => {
    const seeds = mergeSeedEntries({
      afterMerge: ["run flow ls and eyeball the CLOSE? column"],
      followupEntries: [
        { command: "rm -rf build", reason: "clean stale output", auto: true },
        { command: "flow install", reason: "refresh", auto: true },
      ],
      followupsBlock: "",
    });
    expect(seeds).toEqual([
      {
        title: "after merge: run flow ls and eyeball the CLOSE? column",
        kind: "manual",
        source: "after-merge",
      },
      {
        title: "failed follow-up: rm -rf build — clean stale output",
        kind: "manual",
        source: "followup",
      },
    ]);
  });

  it("treats an allowlisted entry without auto as not run", () => {
    const seeds = mergeSeedEntries({
      afterMerge: [],
      followupEntries: [{ command: "flow install", reason: "r" }],
      followupsBlock: "",
    });
    expect(seeds).toHaveLength(1);
  });

  it("parses FAIL lines from the real formatVerdict shape and ignores the tail", () => {
    const verdict: Verdict = {
      summary: { total: 1, ran: 0, noted: 0, failed: 1 },
      ran: [],
      failed: [
        {
          id: "a",
          command: "flow install --upgrade",
          exitCode: 2,
          headExcerpt: "boom",
          tailExcerpt: "FAIL something (exit 9)\nboom",
          totalLines: 2,
        },
      ],
      noted: [],
    };
    const block = formatVerdict(verdict, false);
    const seeds = mergeSeedEntries({
      afterMerge: [],
      followupEntries: [],
      followupsBlock: block,
    });
    expect(seeds.map((s) => s.title)).toEqual([
      "failed follow-up: flow install --upgrade",
    ]);
  });

  it("strips a leading 'After merge:' and skips empty input", () => {
    const seeds = mergeSeedEntries({
      afterMerge: ["After merge: do x", "  "],
      followupEntries: [],
      followupsBlock: "",
    });
    expect(seeds.map((s) => s.title)).toEqual(["after merge: do x"]);
  });
});

describe("applyMergeSeeds", () => {
  const seeds = mergeSeedEntries({
    afterMerge: ["check a"],
    followupEntries: [{ command: "x", reason: "y" }],
    followupsBlock: "",
  });

  it("adds manual items and re-runs add nothing, even after a drop", () => {
    const first = applyMergeSeeds(base, seeds, () => "t1");
    expect(first.added).toEqual([1, 2]);
    expect(first.state.untracked?.every((i) => i.kind === "manual")).toBe(true);

    const dropped: PipelineState = {
      ...first.state,
      untracked: first.state.untracked!.map((i, n) =>
        n === 0 ? { ...i, droppedAt: "t2" } : { ...i, doneAt: "t2" },
      ),
    };
    const again = applyMergeSeeds(dropped, seeds, () => "t3");
    expect(again.added).toEqual([]);
    expect(again.state.untracked).toHaveLength(2);
  });

  it("continues ids after existing items", () => {
    const withOne: PipelineState = {
      ...base,
      untracked: [{ id: 7, title: "other", source: "pr-review", at: "t" }],
    };
    expect(applyMergeSeeds(withOne, seeds).added).toEqual([8, 9]);
  });
});
