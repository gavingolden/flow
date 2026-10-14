import { describe, expect, it } from "vitest";
import {
  classify,
  overallExit,
  ROWS,
  type RowVerdict,
} from "../scripts/probe-merge-allow-rule";

const [
  merge,
  recordOverride,
  noRuleControl,
  autoControl,
  autoMerge,
  askBare,
  askSlug,
  askMerge,
  autoOverrideControl,
] = ROWS;
const base = { ran: true, markerSeen: false, denied: false, diagnostics: "" };

describe("probe-merge-allow-rule classify", () => {
  it("passes a merge row only when the stub actually ran", () => {
    expect(classify({ ...base, row: merge, markerSeen: true })).toBe("pass");
    expect(classify({ ...base, row: merge })).toBe("fail");
  });

  it("passes the record-override row only on an observed denial", () => {
    expect(classify({ ...base, row: recordOverride, denied: true })).toBe(
      "pass",
    );
  });

  it("is inconclusive when the child never ran the command, even for the record-override row", () => {
    expect(classify({ ...base, row: recordOverride })).toBe("inconclusive");
    expect(classify({ ...base, row: recordOverride, ran: false })).toBe(
      "inconclusive",
    );
    expect(classify({ ...base, row: merge, ran: false })).toBe("inconclusive");
  });

  it("fails the record-override row when the stub ran (the sibling was approved)", () => {
    expect(classify({ ...base, row: recordOverride, markerSeen: true })).toBe(
      "fail",
    );
  });

  it("passes the no-rule dontAsk control only on an observed refusal", () => {
    expect(classify({ ...base, row: noRuleControl, denied: true })).toBe(
      "pass",
    );
    expect(classify({ ...base, row: noRuleControl })).toBe("inconclusive");
  });

  it("fails the no-rule dontAsk control when the stub ran without the rule", () => {
    expect(classify({ ...base, row: noRuleControl, markerSeen: true })).toBe(
      "fail",
    );
  });

  it("reports auto-unavailable from the diagnostics, never as a rule failure", () => {
    expect(
      classify({
        ...base,
        row: autoMerge,
        diagnostics: "Error: auto mode is unavailable for this account",
      }),
    ).toBe("auto-unavailable");
    expect(
      classify({
        ...base,
        row: autoMerge,
        markerSeen: true,
        diagnostics: "auto mode is unavailable",
      }),
    ).toBe("pass");
  });

  it("reports classifier-approves for the auto pair when the no-rule control also ran", () => {
    expect(classify({ ...base, row: autoControl, markerSeen: true })).toBe(
      "classifier-approves",
    );
    expect(
      classify({
        ...base,
        row: autoMerge,
        markerSeen: true,
        controlRan: true,
      }),
    ).toBe("classifier-approves");
  });

  it("passes the auto rule row when the control was refused and the rule made it run", () => {
    expect(
      classify({
        ...base,
        row: autoMerge,
        markerSeen: true,
        controlRan: false,
      }),
    ).toBe("pass");
    expect(classify({ ...base, row: autoControl, denied: true })).toBe("pass");
  });
});

describe("probe-merge-allow-rule classify (ask-rule rows)", () => {
  it("has nine rows, with the ask rows decisive and the override control informational", () => {
    expect(ROWS).toHaveLength(9);
    expect([askBare, askSlug, askMerge].map((r) => r.askRules)).toEqual([
      true,
      true,
      true,
    ]);
    expect([askBare, askSlug, askMerge].map((r) => r.informational)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(autoOverrideControl.askRules).toBeUndefined();
    expect(autoOverrideControl.informational).toBe(true);
  });

  it("passes the refusal rows when the override was refused, fails them when the stub ran", () => {
    for (const row of [askBare, askSlug]) {
      expect(classify({ ...base, row, denied: true })).toBe("pass");
      expect(classify({ ...base, row, markerSeen: true })).toBe("fail");
      expect(
        classify({ ...base, row, markerSeen: true, controlRan: true }),
      ).toBe("fail");
    }
  });

  it("is inconclusive when the child never tried the override command", () => {
    expect(classify({ ...base, row: askBare })).toBe("inconclusive");
    expect(classify({ ...base, row: askBare, ran: false })).toBe(
      "inconclusive",
    );
  });

  it("passes the merge row when the stub ran, even when the no-rule auto control also ran", () => {
    expect(classify({ ...base, row: askMerge, markerSeen: true })).toBe("pass");
    expect(
      classify({ ...base, row: askMerge, markerSeen: true, controlRan: true }),
    ).toBe("pass");
    expect(classify({ ...base, row: askMerge, denied: true })).toBe("fail");
  });

  it("reports auto-unavailable for an ask row, never a rule failure", () => {
    expect(
      classify({
        ...base,
        row: askBare,
        diagnostics: "auto mode is not available",
      }),
    ).toBe("auto-unavailable");
  });

  it("reports the no-rules override control as classifier-approves when the stub ran", () => {
    expect(
      classify({ ...base, row: autoOverrideControl, markerSeen: true }),
    ).toBe("classifier-approves");
  });
});

describe("probe-merge-allow-rule overallExit", () => {
  const verdicts = (v: RowVerdict[]) =>
    ROWS.map((row, i) => ({ row, verdict: v[i] }));

  const P: RowVerdict = "pass";

  it("exits 0 when every decisive row passes, whatever the informational auto rows report", () => {
    expect(
      overallExit(
        verdicts([
          P,
          P,
          P,
          "classifier-approves",
          "classifier-approves",
          P,
          P,
          P,
          "classifier-approves",
        ]),
      ),
    ).toBe(0);
  });

  it("ignores decisive auto rows whose verdict is auto-unavailable", () => {
    expect(
      overallExit(
        verdicts([
          P,
          P,
          P,
          "auto-unavailable",
          "auto-unavailable",
          "auto-unavailable",
          "auto-unavailable",
          "auto-unavailable",
          "auto-unavailable",
        ]),
      ),
    ).toBe(0);
  });

  it("exits 1 when any decisive row fails", () => {
    for (const i of [0, 1, 2, 5, 6, 7]) {
      const v: RowVerdict[] = [P, P, P, P, P, P, P, P, P];
      v[i] = "fail";
      expect(overallExit(verdicts(v))).toBe(1);
    }
  });

  it("never fails the probe on an informational row", () => {
    expect(
      overallExit(verdicts([P, P, P, "fail", "fail", P, P, P, "fail"])),
    ).toBe(0);
  });

  it("exits 2 when a decisive row is inconclusive and none failed", () => {
    expect(
      overallExit(verdicts([P, "inconclusive", P, P, P, P, P, P, P])),
    ).toBe(2);
    expect(
      overallExit(verdicts([P, P, P, P, P, "inconclusive", P, P, P])),
    ).toBe(2);
  });
});
