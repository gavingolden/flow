import { describe, expect, it } from "vitest";
import type { CritiqueFinding } from "./ui-critique";
import type { LoopLog } from "./ui-critique";
import {
  collectSubjectiveEvidence,
  requiredViews,
  summarizeUiReview,
} from "./ui-signoff-evidence";

const body = (...lines: string[]): string =>
  ["## Test Steps", "", ...lines].join("\n");

function finding(over: Partial<CritiqueFinding>): CritiqueFinding {
  return {
    id: "f",
    severity: "defect",
    route: "/",
    section: "hero",
    viewport: "390",
    shot: "s.png",
    observation: "o",
    rule: "r",
    fix: "x",
    introduced: true,
    ...over,
  };
}

function log(over: Partial<LoopLog> = {}): LoopLog {
  return {
    mode: "fix",
    round: null,
    outcome: "clean",
    residual: [],
    persistent: [],
    omittedSections: 0,
    costUsd: 0,
    completed: true,
    critiqueCalls: [],
    required: true,
    headSha: "abcdef1234567",
    ...over,
  };
}

const OK_GATE = { required: true, satisfied: true, reason: null };

describe("requiredViews", () => {
  it("defaults to phone + desktop and adds no views for false-alarm phrases", () => {
    for (const t of [
      "the 404 empty state",
      "16px gap",
      "PR #1012",
      "dark border on the light card",
      "at 600",
    ]) {
      expect(requiredViews(`SUBJECTIVE: check ${t}`)).toEqual([
        "phone",
        "desktop",
      ]);
    }
  });

  it("reads widths, words and dark mode in stable order", () => {
    expect(requiredViews("at 390 and 1280, dark mode")).toEqual([
      "phone",
      "desktop",
      "phone-dark",
      "desktop-dark",
    ]);
    expect(requiredViews("on a tablet")).toEqual(["tablet"]);
    expect(requiredViews("1280x800 and 375px")).toEqual(["phone", "desktop"]);
  });
});

describe("collectSubjectiveEvidence", () => {
  it("computes missing views from labelled shots", () => {
    const [e] = collectSubjectiveEvidence(
      body(
        "- [ ] SUBJECTIVE: looks right at 390 and 1280, dark mode",
        "  ![a (phone)](a.png)",
        "  ![b (desktop)](b.png)",
        "  ![c (phone-dark)](c.png)",
      ),
    );
    expect(e.missing).toEqual(["desktop-dark"]);
    expect(e.unlabelled).toBe(0);
  });

  it("reports unlabelled shots and no missing", () => {
    const [e] = collectSubjectiveEvidence(
      body(
        "- [ ] SUBJECTIVE: looks right",
        "  ![shot](https://github.com/user-attachments/assets/abc)",
      ),
    );
    expect(e.unlabelled).toBe(1);
    expect(e.missing).toEqual([]);
  });

  it("classifies by alt suffix even when the item text names desktop", () => {
    const [e] = collectSubjectiveEvidence(
      body("- [ ] SUBJECTIVE: desktop header ![desktop header (phone)](x.png)"),
    );
    expect(e.shots[0].view).toBe("phone");
  });

  it("falls back to filename tokens", () => {
    const [e] = collectSubjectiveEvidence(
      body("- [ ] SUBJECTIVE: ok ![s](shots/home-desktop-dark.png)"),
    );
    expect(e.shots[0].view).toBe("desktop-dark");
  });

  it("captures partial: and no screenshot: without adding views", () => {
    const [p, n] = collectSubjectiveEvidence(
      body(
        "- [ ] SUBJECTIVE: ok ![a (phone)](a.png)",
        "  partial: tablet needs login",
        "- [ ] SUBJECTIVE: haptics",
        "  no screenshot: real device only",
      ),
    );
    expect(p.partial).toBe("tablet needs login");
    expect(p.required).toEqual(["phone", "desktop"]);
    expect(n.noScreenshot).toBe("real device only");
    expect(n.missing).toEqual([]);
  });

  it("keys a wrapped item by its first line and excludes ticked / other kinds", () => {
    const items = collectSubjectiveEvidence(
      body(
        "- [ ] SUBJECTIVE: first line",
        "  continues here",
        "- [x] SUBJECTIVE: ticked",
        "- [ ] DECISION: other",
      ),
    );
    expect(items.map((i) => i.item)).toEqual(["SUBJECTIVE: first line"]);
    expect(items[0].missing).toEqual(["phone", "desktop"]);
  });

  it("resolves local refs only", () => {
    const [e] = collectSubjectiveEvidence(
      body(
        "- [ ] SUBJECTIVE: ok ![a (phone)](a.png) ![b (desktop)](https://x.test/b.png)",
      ),
      (r) => `/wt/${r}`,
    );
    expect(e.shots.map((s) => s.ref)).toEqual([
      "/wt/a.png",
      "https://x.test/b.png",
    ]);
  });
});

describe("summarizeUiReview", () => {
  it("passes only for required + satisfied + reason null + completed log", () => {
    expect(summarizeUiReview(log(), OK_GATE).passed).toBe(true);
    expect(summarizeUiReview(log(), undefined).passed).toBe(false);
    expect(
      summarizeUiReview(log(), { ...OK_GATE, reason: "stale" }).passed,
    ).toBe(false);
    expect(
      summarizeUiReview(log(), { ...OK_GATE, satisfied: false }).passed,
    ).toBe(false);
    expect(
      summarizeUiReview(
        log({ outcome: "skipped", skip: "no browser" }),
        OK_GATE,
      ).passed,
    ).toBe(false);
    expect(summarizeUiReview(log({ outcome: null }), OK_GATE).passed).toBe(
      false,
    );
    expect(summarizeUiReview(null, OK_GATE).passed).toBe(false);
  });

  it("counts gating residual + persistent and ignores advisory signoff findings", () => {
    const s = summarizeUiReview(
      log({
        residual: [
          finding({ severity: "defect" }),
          finding({ severity: "major" }),
          finding({ severity: "defect", introduced: false }),
        ],
        persistent: ["p1"],
        signoff: {
          findings: [finding({ severity: "defect" })],
          judgedSha: "abc",
        },
      }),
      OK_GATE,
    );
    expect(s).toMatchObject({
      outcome: "clean",
      judgedSha: "abcdef1234567",
      gatingMajor: 1,
      gatingDefect: 2,
    });
  });
});
