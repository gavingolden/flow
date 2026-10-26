import { describe, expect, it } from "vitest";

import {
  acceptRound,
  decideGate,
  emptyLoopLog,
  GALLERY_MAX_SHOTS,
  parseLoopLog,
  persistentDefects,
  selectGallery,
  validateFindings,
  type CritiqueFinding,
  type GateInput,
} from "./ui-critique";
import type { SectionShot } from "./ui-driver-schema";

const finding = (over: Partial<CritiqueFinding> = {}): CritiqueFinding => ({
  id: "f1",
  severity: "major",
  route: "/",
  section: "Pricing",
  viewport: "phone",
  shot: "/wt/.flow-tmp/ui-evidence/a.png",
  observation: "cramped",
  rule: "layout.md",
  fix: "stack the columns",
  ...over,
});

describe("validateFindings", () => {
  const gallery = ["/wt/.flow-tmp/ui-evidence/a.png"];

  it("accepts a well-formed reply", () => {
    const r = validateFindings({ findings: [finding()] }, gallery);
    expect(r).toEqual({ ok: true, findings: [finding()], dropped: 0 });
  });

  it("drops and counts a finding whose shot is not in the gallery", () => {
    const r = validateFindings(
      { findings: [finding(), finding({ id: "f2", shot: "/etc/other.png" })] },
      gallery,
    );
    expect(r).toMatchObject({ ok: true, dropped: 1 });
    expect(r.ok && r.findings).toHaveLength(1);
  });

  it.each([
    ["a non-object", "text"],
    ["an array", []],
    ["a missing findings array", {}],
    [
      "too many findings",
      { findings: Array.from({ length: 21 }, () => finding()) },
    ],
    ["a non-object finding", { findings: ["x"] }],
    ["an empty field", { findings: [finding({ fix: "" })] }],
    [
      "an over-long field",
      { findings: [finding({ observation: "x".repeat(301) })] },
    ],
    [
      "an unknown severity",
      { findings: [{ ...finding(), severity: "blocker" }] },
    ],
  ])("rejects %s", (_name, raw) => {
    expect(validateFindings(raw, gallery).ok).toBe(false);
  });
});

describe("decideGate", () => {
  const body = "## Test Steps\n\n- [ ] SUBJECTIVE: the page feels calm\n";
  const ui = { ran: true, ok: true, skippedReason: null, sectionShots: 6 };
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    body,
    enabled: true,
    ui,
    log: emptyLoopLog(),
    demotion: { demoted: false, reason: "" },
    ...over,
  });

  it("runs when every condition holds", () => {
    expect(decideGate(input())).toMatchObject({
      run: true,
      mode: "fix",
      reason: "run",
      openRound: null,
    });
  });

  it("the pre-drive call (ui: null) runs without a UI result", () => {
    expect(decideGate(input({ ui: null })).run).toBe(true);
  });

  it("applies the precedence already-ran > no-subjective > disabled > no-ui > no-shots", () => {
    const none = { body: "## Test Steps\n\n- [ ] `npm test` — pass\n" };
    const everything = input({
      ...none,
      enabled: false,
      ui: {
        ran: false,
        ok: false,
        skippedReason: "mcp-not-available",
        sectionShots: 0,
      },
      log: { ...emptyLoopLog(), completed: true },
    });
    expect(decideGate(everything).reason).toBe("already-ran");
    expect(decideGate({ ...everything, log: emptyLoopLog() }).reason).toBe(
      "no-subjective-item",
    );
    const fresh = { ...everything, log: emptyLoopLog(), body };
    expect(decideGate(fresh).reason).toBe("disabled-by-config");
    expect(decideGate({ ...fresh, enabled: true }).reason).toBe("no-ui-pass");
    expect(decideGate(input({ ui: { ...ui, sectionShots: 0 } })).reason).toBe(
      "no-section-shots",
    );
  });

  it("names why the browser checks did not count", () => {
    const skipped = decideGate(
      input({
        ui: {
          ran: false,
          ok: false,
          skippedReason: "mcp-not-available",
          sectionShots: 0,
        },
      }),
    );
    expect(skipped.detail).toBe(
      "browser checks did not run (mcp-not-available)",
    );
    const failed = decideGate(input({ ui: { ...ui, ok: false } }));
    expect(failed.reason).toBe("no-ui-pass");
    expect(failed.detail).toBe("browser checks reported failures");
  });

  it("is list-only when demoted, and reports an open round whatever the decision", () => {
    const d = decideGate(
      input({
        demotion: { demoted: true, reason: "3 reverts" },
        log: {
          ...emptyLoopLog(),
          round: { kind: "critique", preSha: "abc", open: true },
        },
        enabled: false,
      }),
    );
    expect(d.mode).toBe("list-only");
    expect(d.run).toBe(false);
    expect(d.openRound).toEqual({ kind: "critique", preSha: "abc" });
  });
});

describe("selectGallery", () => {
  const shot = (
    section: string,
    viewport: SectionShot["viewport"],
    part: SectionShot["part"] = "whole",
  ): SectionShot => ({
    route: "/",
    section,
    viewport,
    part,
    path: `/wt/.flow-tmp/ui-evidence/${section}-${viewport}-${part}.png`,
  });
  const section = (name: string, parts = 1) => [
    ...(["phone", "desktop", "desktop-dark"] as const).flatMap((v) =>
      parts === 1
        ? [shot(name, v)]
        : [shot(name, v, "start"), shot(name, v, "end")],
    ),
  ];

  it("keeps everything under the cap", () => {
    const shots = [...section("a"), ...section("b")];
    expect(selectGallery(shots)).toEqual({ shots, omittedSections: 0 });
  });

  it("drops whole sections from the end so dark shots are never starved", () => {
    const shots = ["a", "b", "c", "d", "e"].flatMap((n) => section(n, 2));
    const r = selectGallery(shots);
    expect(r.shots.length).toBeLessThanOrEqual(GALLERY_MAX_SHOTS);
    expect(r.omittedSections).toBe(1);
    const sections = new Set(r.shots.map((s) => s.section));
    for (const name of sections) {
      expect(
        r.shots.filter(
          (s) => s.section === name && s.viewport === "desktop-dark",
        ),
      ).toHaveLength(2);
    }
    expect([...sections]).toEqual(["a", "b", "c", "d"]);
  });

  it("honours a custom max", () => {
    const shots = [...section("a"), ...section("b")];
    expect(selectGallery(shots, 3)).toMatchObject({ omittedSections: 1 });
  });
});

describe("acceptRound", () => {
  const targeted = [finding({ severity: "defect" })];

  it("keeps when the targeted location improved with no regression", () => {
    expect(
      acceptRound({
        regressed: false,
        targeted,
        after: [finding({ severity: "minor" })],
      }).decision,
    ).toBe("keep");
    expect(
      acceptRound({ regressed: false, targeted, after: [] }).decision,
    ).toBe("keep");
  });

  it("reverts on a regression regardless of the findings", () => {
    const r = acceptRound({ regressed: true, targeted, after: [] });
    expect(r.decision).toBe("revert");
    expect(r.reason).toContain("page checks got worse");
  });

  it("reverts when a targeted location did not get strictly better", () => {
    const r = acceptRound({
      regressed: false,
      targeted,
      after: [finding({ severity: "defect" })],
    });
    expect(r).toMatchObject({ decision: "revert" });
    expect(r.reason).toContain("did not improve");
  });

  it("reverts when a new defect or major appears on a location with none", () => {
    const r = acceptRound({
      regressed: false,
      targeted,
      after: [finding({ section: "Footer", severity: "major" })],
    });
    expect(r.decision).toBe("revert");
    expect(r.reason).toContain("Footer");
  });

  it("tolerates a new minor finding elsewhere", () => {
    expect(
      acceptRound({
        regressed: false,
        targeted,
        after: [finding({ section: "Footer", severity: "minor" })],
      }).decision,
    ).toBe("keep");
  });

  it("reverts a round that targeted nothing worth fixing", () => {
    expect(
      acceptRound({
        regressed: false,
        targeted: [finding({ severity: "minor" })],
        after: [],
      }).decision,
    ).toBe("revert");
  });
});

describe("persistentDefects", () => {
  const a = ["[xs] anchor: #x lands under chrome", "[xs] leak: token"];

  it("needs at least three attempts, no other failures, and every message in every attempt", () => {
    expect(persistentDefects([a, a, a], 0)).toEqual({
      allPersistent: true,
      persistent: a,
    });
    expect(persistentDefects([a, a], 0).allPersistent).toBe(false);
    expect(persistentDefects([a, a, a], 1).allPersistent).toBe(false);
    expect(persistentDefects([a, a, []], 0).allPersistent).toBe(false);
    expect(persistentDefects([[a[0]], a, a], 0).allPersistent).toBe(false);
  });

  it("a message new in the last attempt is not persistent", () => {
    const r = persistentDefects([[a[0]], [a[0]], a], 0);
    expect(r.allPersistent).toBe(false);
    expect(r.persistent).toEqual([a[0]]);
  });
});

describe("parseLoopLog", () => {
  it("reads null, junk and a non-object as an empty log", () => {
    for (const raw of [null, "{nope", "42", "null"]) {
      expect(parseLoopLog(raw)).toEqual(emptyLoopLog());
    }
  });

  it("round-trips a populated log and drops malformed parts", () => {
    const log = {
      mode: "list-only",
      round: { kind: "smell", preSha: "abc", open: true },
      outcome: "kept",
      residual: [finding()],
      persistent: ["x"],
      omittedSections: 2,
      costUsd: 0.5,
      completed: true,
      critiqueCalls: ["round-0"],
      skip: "why",
    };
    expect(parseLoopLog(JSON.stringify(log))).toEqual(log);
    const bad = parseLoopLog(
      JSON.stringify({
        round: { kind: "other" },
        outcome: "weird",
        persistent: [1, "y"],
      }),
    );
    expect(bad.round).toBeNull();
    expect(bad.outcome).toBeNull();
    expect(bad.persistent).toEqual(["y"]);
  });
});
