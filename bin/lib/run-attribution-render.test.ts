import { describe, expect, it } from "vitest";
import { renderRanOn } from "./run-attribution-render";
import type {
  DelegatedCall,
  RunAttribution,
  SpawnAttribution,
  UnitAttribution,
} from "./run-attribution-types";
import { computeTotals } from "./run-attribution-unit";

function unit(
  id: string,
  runs: [string | null, string, number][],
  cost: number | null = 1,
): UnitAttribution {
  return {
    session_id: id,
    model: runs[0][0],
    runs,
    run_costs: runs.map((_, i) => (i === 0 || cost === null ? cost : 0)),
    turns: runs.reduce((n, r) => n + r[2], 0),
    tokens: { input: 0, cache_creation: 0, cache_read: 0, output: 0, total: 0 },
    cost_usd: cost,
  };
}

function build(
  sessions: UnitAttribution[],
  spawns: SpawnAttribution[] = [],
  delegated: DelegatedCall[] = [],
  skipped = 0,
): RunAttribution {
  return {
    version: 1,
    slug: "s",
    pr: null,
    repo: "/r",
    sessions,
    spawns,
    delegated,
    totals: computeTotals([...sessions, ...spawns], delegated, skipped),
  };
}

const coder: SpawnAttribution = {
  ...unit("agent-1", [["claude-sonnet-5-5", "medium", 12]], 2),
  role: "coder",
  agent_type: "flow-module-core:flow-coder",
  parent_session_id: "sess-1",
};

const attr = build(
  [
    unit(
      "sess-1abcdef",
      [
        ["claude-opus-5-5", "low", 327],
        ["claude-opus-5-5", "high", 39],
      ],
      20,
    ),
  ],
  [coder],
);

describe(renderRanOn, () => {
  it("names both models, both efforts in order and the list-price total in the pm lens", () => {
    const [line] = renderRanOn(attr, "pm");
    expect(line).toContain("Opus 5.5 at low (327 turns), then high (39)");
    expect(line).toContain("sub-agents: Sonnet 5.5 at medium ×1");
    expect(line).toContain("$22.00 at list price");
    expect(line.indexOf("low")).toBeLessThan(line.indexOf("high"));
  });

  it("renders one line per session and per role group in the dev lens", () => {
    const lines = renderRanOn(attr, "dev");
    expect(lines).toEqual([
      "session 1 (sess-1ab): Opus 5.5 at low (327 turns), then high (39) — $20.00",
      "coder: Sonnet 5.5 at medium (12 turns) — $2.00",
      "total: $22.00 at list price",
    ]);
  });

  it("names the new model on a mid-session model switch", () => {
    const a = build([
      unit("s", [
        ["claude-opus-5-5", "high", 5],
        ["claude-sonnet-5-5", "medium", 2],
      ]),
    ]);
    expect(renderRanOn(a, "pm")[0]).toContain(
      "Opus 5.5 at high (5 turns), then Sonnet 5.5 at medium (2)",
    );
  });

  it("says effort was not recorded instead of listing unknown runs", () => {
    const a = build([unit("s", [["claude-opus-5-5", "unknown", 4]])]);
    for (const lens of ["pm", "dev"] as const) {
      const text = renderRanOn(a, lens).join("\n");
      expect(text).toContain("effort not recorded in the session logs");
      expect(text).not.toContain("unknown");
    }
  });

  it("omits unknown effort per run when only some units recorded it", () => {
    const a = build(
      [unit("s", [["claude-opus-5-5", "high", 3]])],
      [
        {
          ...unit("agent-x", [["claude-sonnet-5-5", "unknown", 2]]),
          role: "coder",
          agent_type: null,
          parent_session_id: "s",
        },
      ],
    );
    for (const lens of ["pm", "dev"] as const) {
      const text = renderRanOn(a, lens).join("\n");
      expect(text).not.toContain("unknown");
    }
    expect(renderRanOn(a, "pm")[0]).toContain("sub-agents: Sonnet 5.5 ×1");
  });

  it("appends unpriced models and unreadable-log counts without hiding known spend", () => {
    const a = build(
      [
        unit("s", [["claude-haiku-5-5", "low", 1]], null),
        unit("t", [["claude-opus-5-5", "low", 1]], 4),
      ],
      [],
      [],
      2,
    );
    const [line] = renderRanOn(a, "pm");
    expect(line).toContain("$4.00 at list price");
    expect(line).toContain("(+ unpriced: claude-haiku-5-5)");
    expect(line).toContain(
      "(+ 2 transcripts not read: too large or unreadable)",
    );
  });

  it("lists delegated models and skips calls that did not run", () => {
    const call = (ran: boolean): DelegatedCall => ({
      event: "delegate.call",
      task: "default",
      model: "Gemini 4 Argon",
      effort: null,
      ran,
      skip_reason: null,
      ts: "2026-11-06T00:00:00Z",
      cost_usd: null,
    });
    const a = build(attr.sessions, [], [call(true), call(true), call(false)]);
    expect(renderRanOn(a, "pm")[0]).toContain("delegated: Gemini 4 Argon ×2");
  });

  it("renders none without an attribution or without any unit", () => {
    expect(renderRanOn(null, "pm")).toEqual(["none"]);
    expect(renderRanOn(build([]), "dev")).toEqual(["none"]);
  });
});
