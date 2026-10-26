import { describe, expect, it } from "vitest";

import {
  appendLedger,
  decideDemotion,
  LEDGER_MAX_LINES,
  ledgerPath,
  readLedger,
  type LedgerLine,
  type LedgerOutcome,
} from "./ui-critique-ledger";

const line = (
  outcome: LedgerOutcome,
  over: Partial<LedgerLine> = {},
): LedgerLine => ({
  at: "2026-10-25T00:00:00.000Z",
  repo: "r",
  slug: "s",
  outcome,
  costUsd: 0.1,
  ...over,
});

describe("ledgerPath", () => {
  it("lives under ~/.flow/logs", () => {
    expect(ledgerPath("/home/u")).toBe("/home/u/.flow/logs/ui-critique.jsonl");
  });
});

describe("readLedger", () => {
  it("skips malformed, foreign and torn lines", () => {
    const raw = [
      JSON.stringify(line("kept")),
      "{torn",
      JSON.stringify({ at: "x" }),
      JSON.stringify(line("bogus" as LedgerOutcome)),
      "",
      JSON.stringify(line("reverted")),
    ].join("\n");
    expect(readLedger(raw).map((l) => l.outcome)).toEqual(["kept", "reverted"]);
    expect(readLedger(null)).toEqual([]);
  });
});

describe("appendLedger", () => {
  function memory(initial: string | null) {
    const store = { content: initial };
    return {
      store,
      deps: {
        path: "/led/ui-critique.jsonl",
        readFile: () => store.content,
        writeFile: (_p: string, c: string) => {
          store.content = c;
        },
        mkdirp: () => {},
      },
    };
  }

  it("appends one JSON line and creates the file", () => {
    const m = memory(null);
    appendLedger(line("kept"), m.deps);
    expect(m.store.content).toBe(JSON.stringify(line("kept")) + "\n");
  });

  it("keeps only the last 200 lines", () => {
    const seed = Array.from({ length: LEDGER_MAX_LINES }, (_, i) =>
      JSON.stringify(line("clean", { slug: `s${i}` })),
    ).join("\n");
    const m = memory(seed);
    appendLedger(line("kept", { slug: "new" }), m.deps);
    const lines = readLedger(m.store.content);
    expect(lines).toHaveLength(LEDGER_MAX_LINES);
    expect(lines[0].slug).toBe("s1");
    expect(lines[lines.length - 1].slug).toBe("new");
  });

  it("never throws when the filesystem fails", () => {
    expect(() =>
      appendLedger(line("kept"), {
        path: "/x",
        readFile: () => {
          throw new Error("EIO");
        },
      }),
    ).not.toThrow();
  });
});

describe("decideDemotion", () => {
  const seq = (...o: LedgerOutcome[]) => o.map((x) => line(x));

  it("is not demoted with fewer than three decided rounds or any kept among them", () => {
    expect(decideDemotion(seq("reverted", "reverted")).demoted).toBe(false);
    expect(decideDemotion(seq("reverted", "kept", "reverted")).demoted).toBe(
      false,
    );
    expect(
      decideDemotion(seq("reverted", "reverted", "reverted", "kept")).demoted,
    ).toBe(false);
    expect(decideDemotion([]).demoted).toBe(false);
  });

  it("is demoted after three consecutive reverts, ignoring non-decided outcomes between", () => {
    const d = decideDemotion(
      seq("reverted", "clean", "reverted", "skipped", "reverted"),
    );
    expect(d.demoted).toBe(true);
    expect(d.reason).toContain("reverted");
  });

  it("counts a kept as resetting the streak", () => {
    expect(
      decideDemotion(
        seq("reverted", "reverted", "kept", "reverted", "reverted"),
      ).demoted,
    ).toBe(false);
  });

  it("ends probation after five list-only outcomes", () => {
    const base: LedgerOutcome[] = ["reverted", "reverted", "reverted"];
    expect(
      decideDemotion(
        seq(...base, "list-only", "list-only", "list-only", "list-only"),
      ).demoted,
    ).toBe(true);
    expect(
      decideDemotion(
        seq(
          ...base,
          "list-only",
          "list-only",
          "list-only",
          "list-only",
          "list-only",
        ),
      ).demoted,
    ).toBe(false);
  });

  it("is global across repos", () => {
    const lines = [
      line("reverted", { repo: "a" }),
      line("reverted", { repo: "b" }),
      line("reverted", { repo: "c" }),
    ];
    expect(decideDemotion(lines).demoted).toBe(true);
  });
});
