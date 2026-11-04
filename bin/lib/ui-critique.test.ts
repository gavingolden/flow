import { describe, expect, it } from "vitest";

import {
  acceptRound,
  emptyLoopLog,
  isGating,
  parseLoopLog,
  persistentDefects,
  validateFindings,
  type CritiqueFinding,
} from "./ui-critique";
import { GALLERY_MAX_SHOTS, selectGallery } from "./ui-critique-gallery";
import { decideGate, type GateInput } from "./ui-critique-gate";
import {
  PLAYWRIGHT_BROWSERS_HINT,
  PLAYWRIGHT_MISSING_HINT,
} from "./playwright-resolve";
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
  introduced: true,
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
  const ui = { ran: true, ok: true, skippedReason: null, sectionShots: 6 };
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    enabled: true,
    uiRequired: true,
    targetCount: 1,
    playwright: "ok",
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
      required: true,
    });
  });

  it("runs on a UI diff with no look-and-feel sign-off step", () => {
    // The gate no longer reads the PR body at all: the diff is the trigger.
    expect(decideGate(input({ ui: null })).run).toBe(true);
  });

  it("applies the precedence already-ran > no-ui-change > disabled > no-target > no-ui > no-shots", () => {
    const everything = input({
      uiRequired: false,
      enabled: false,
      targetCount: 0,
      ui: {
        ran: false,
        ok: false,
        skippedReason: "mcp-not-available",
        sectionShots: 0,
      },
      log: { ...emptyLoopLog(), completed: true },
    });
    expect(decideGate(everything).reason).toBe("already-ran");
    const fresh = { ...everything, log: emptyLoopLog() };
    expect(decideGate(fresh).reason).toBe("no-ui-change");
    const required = { ...fresh, uiRequired: true };
    expect(decideGate(required).reason).toBe("disabled-by-config");
    const enabled = { ...required, enabled: true };
    expect(decideGate(enabled).reason).toBe("no-review-target");
    const targeted = { ...enabled, targetCount: 2 };
    expect(decideGate(targeted).reason).toBe("no-ui-pass");
    expect(decideGate(input({ ui: { ...ui, sectionShots: 0 } })).reason).toBe(
      "no-section-shots",
    );
  });

  it("a diff that changes no rendered file never runs and is not required", () => {
    const d = decideGate(input({ uiRequired: false }));
    expect(d).toMatchObject({
      run: false,
      reason: "no-ui-change",
      required: false,
    });
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
  });

  it("captured section shots run the review even when the page checks failed", () => {
    expect(decideGate(input({ ui: { ...ui, ok: false } }))).toMatchObject({
      run: true,
      reason: "run",
    });
  });

  it("a capture artifact with zero section shots is no-section-shots", () => {
    expect(decideGate(input({ ui: { ...ui, sectionShots: 0 } }))).toMatchObject(
      { run: false, reason: "no-section-shots" },
    );
  });

  describe("pre-drive capture path", () => {
    it("chooses playwright when it resolves, with no warning", () => {
      expect(decideGate(input({ ui: null, playwright: "ok" }))).toMatchObject({
        run: true,
        capture: "playwright",
        loud: false,
        warning: null,
      });
    });

    it("falls back to the browser driver and warns loudly when Playwright is missing", () => {
      const d = decideGate(input({ ui: null, playwright: "missing" }));
      expect(d).toMatchObject({ run: true, capture: "mcp", loud: true });
      expect(d.warning).toBe(PLAYWRIGHT_MISSING_HINT);
      expect(d.warning).toContain(
        "npm i -D @playwright/test && npx playwright install chromium",
      );
    });

    it("names the browser install when only the browser is missing", () => {
      const d = decideGate(input({ ui: null, playwright: "browsers-missing" }));
      expect(d).toMatchObject({ capture: "mcp", loud: true });
      expect(d.warning).toBe(PLAYWRIGHT_BROWSERS_HINT);
    });

    it("does not warn when the review is off or the diff has no UI", () => {
      expect(
        decideGate(input({ ui: null, playwright: "missing", enabled: false })),
      ).toMatchObject({ loud: false, warning: null, capture: null });
      expect(
        decideGate(
          input({ ui: null, playwright: "missing", uiRequired: false }),
        ),
      ).toMatchObject({ loud: false, warning: null });
    });

    it("reports no capture path on the post-capture call", () => {
      expect(decideGate(input({ playwright: "missing" })).capture).toBeNull();
    });
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

describe("introduced findings", () => {
  const gallery = ["/wt/.flow-tmp/ui-evidence/a.png"];

  it("a reply without `introduced` parses as introduced, so it still gates", () => {
    const { introduced: _i, ...bare } = finding();
    const r = validateFindings({ findings: [bare] }, gallery);
    expect(r.ok && r.findings[0].introduced).toBe(true);
  });

  it("keeps an explicit introduced:false and rejects a non-boolean", () => {
    const r = validateFindings(
      { findings: [finding({ introduced: false })] },
      gallery,
    );
    expect(r.ok && r.findings[0].introduced).toBe(false);
    const bad = validateFindings(
      { findings: [{ ...finding(), introduced: "yes" }] },
      gallery,
    );
    expect(bad.ok).toBe(false);
  });

  it("gates on introduced defects and state-mismatch, not pre-existing ones", () => {
    expect(isGating(finding())).toBe(true);
    expect(isGating(finding({ introduced: false }))).toBe(false);
    expect(
      isGating(finding({ introduced: false, rule: "state-mismatch" })),
    ).toBe(true);
  });

  it("a pre-existing defect neither blocks nor counts as a regression in a fix round", () => {
    const targeted = [finding({ severity: "defect" })];
    const preExisting = finding({
      severity: "defect",
      section: "Footer",
      introduced: false,
    });
    const r = acceptRound({
      regressed: false,
      targeted,
      after: [finding({ severity: "minor" }), preExisting],
    });
    expect(r.decision).toBe("keep");
  });
});

describe("parseLoopLog keeps the review-gate fields", () => {
  it("round-trips required, headSha, targets and playwrightWarning", () => {
    const log = {
      ...emptyLoopLog(),
      required: true,
      headSha: "abc",
      targets: [{ route: "/a", state: "x", source: "plan" }],
      playwrightWarning: "install it",
    };
    expect(parseLoopLog(JSON.stringify(log))).toMatchObject({
      required: true,
      headSha: "abc",
      targets: [{ route: "/a", state: "x", source: "plan" }],
      playwrightWarning: "install it",
    });
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

describe("selectGallery across targets", () => {
  const shot = (route: string, section: string): SectionShot[] =>
    (["phone", "desktop"] as const).map((viewport) => ({
      route,
      section,
      viewport,
      part: "whole" as const,
      path: `/wt/${route.replace(/\W/g, "_")}-${section}-${viewport}.png`,
    }));

  it("gives every target a share of the cap instead of filling in input order", () => {
    const a = ["a1", "a2", "a3", "a4", "a5", "a6"].flatMap((n) =>
      shot("/a", n),
    );
    const b = ["b1", "b2", "b3"].flatMap((n) => shot("/b", n));
    const c = ["c1", "c2"].flatMap((n) => shot("/c", n));
    const r = selectGallery([...a, ...b, ...c], 12);
    const routes = new Set(r.shots.map((x) => x.route));
    expect(routes).toEqual(new Set(["/a", "/b", "/c"]));
    expect(r.shots.length).toBeLessThanOrEqual(12);
    expect(r.omittedSections).toBe(11 - r.shots.length / 2);
  });

  it("every target contributes within the 24-shot cap (3 targets x 6 sections)", () => {
    const all = ["/a", "/b", "/c"].flatMap((route) =>
      ["s1", "s2", "s3", "s4", "s5", "s6"].flatMap((n) => shot(route, n)),
    );
    const r = selectGallery(all);
    expect(r.shots.length).toBeLessThanOrEqual(GALLERY_MAX_SHOTS);
    for (const route of ["/a", "/b", "/c"]) {
      expect(r.shots.some((s) => s.route === route)).toBe(true);
    }
  });
});
