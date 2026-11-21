import { describe, expect, it } from "vitest";
import { formatVerdict, type Verdict } from "../flow-followups";
import { applyMergeSeeds, mergeSeedEntries } from "./untracked-merge-seed";
import type { PipelineState } from "./state";

const base: PipelineState = {
  slug: "s",
  phase: "merging",
  repo: "/r",
  updatedAt: "t",
};

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
