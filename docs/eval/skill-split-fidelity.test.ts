import { describe, expect, it } from "vitest";
import { ledgerLines, unaccounted } from "./skill-split-fidelity";

const FENCE = "````";

describe("unaccounted", () => {
  it("accepts a line present in the corpus, ignoring blockquote marks and spacing", () => {
    expect(
      unaccounted("> **Rule.**  keep\n\nplain", "**Rule.** keep\nplain"),
    ).toEqual([]);
  });

  it("flags a line in neither the corpus nor the ledger", () => {
    expect(unaccounted("kept\ndropped line", "kept")).toEqual(["dropped line"]);
  });

  it("accepts a line cut in two across files", () => {
    const corpus =
      "> **You never bypass the helper scripts.**\n> Always call `flow-new-worktree`";
    expect(
      unaccounted(
        "> **You never bypass the helper scripts.** Always call `flow-new-worktree`",
        corpus,
      ),
    ).toEqual([]);
  });

  it("does not accept a line whose halves exist but not as a head and tail", () => {
    expect(unaccounted("alpha beta gamma", "alpha\nbeta\ngamma")).toEqual([
      "alpha beta gamma",
    ]);
  });

  it("accepts a ledgered line", () => {
    const ledger = `${FENCE}\nremoved line\nowner: bin/x.test.ts\n${FENCE}\n`;
    expect(unaccounted("removed line", "", ledger)).toEqual([]);
  });
});

describe("ledgerLines", () => {
  it("reads every line of a fenced entry up to its owner line", () => {
    const ledger = [
      "prose",
      FENCE,
      "first",
      "second",
      "owner: a.test.ts",
      FENCE,
      FENCE,
      "third",
      "owner: b.test.ts",
      FENCE,
    ].join("\n");
    expect([...ledgerLines(ledger)].sort()).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
