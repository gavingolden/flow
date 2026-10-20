import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureLaunchSettings } from "./lib/feature";
import {
  FLOW_MERGE_ALLOW_RULE,
  FLOW_OVERRIDE_ALLOW_RULES,
} from "./lib/merge-allow-rule";
import {
  FLOW_NARROW_ALLOW_RULES,
  FLOW_ROUTINE_ALLOW_RULES,
} from "./lib/pipeline-allow-rules";
import {
  classify,
  markerSatisfied,
  overallExit,
  allowedToolsFor,
  ROWS,
  rulesFromLaunchSettings,
  stubsFor,
  type RowVerdict,
} from "../scripts/probe-merge-allow-rule";

const [
  merge,
  recordOverride,
  noRuleControl,
  autoControl,
  autoMerge,
  overrideBare,
  overrideSlug,
  overrideOnlyMerge,
  autoOverrideControl,
  chained,
  pipeTail,
  pipeJq,
  cdPrefix,
  autoCdPrefix,
  killControl,
  ciWaiter,
  planReviewWaiter,
  launderControl,
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

describe("probe-merge-allow-rule classify (override-rule rows)", () => {
  it("has eighteen rows, with the override rows decisive dontAsk rows and the auto override control informational", () => {
    expect(ROWS).toHaveLength(18);
    for (const row of [overrideBare, overrideSlug, overrideOnlyMerge]) {
      expect(row.overrideRules).toBe(true);
      expect(row.mode).toBe("dontAsk");
      expect(row.informational).toBeUndefined();
    }
    expect(overrideSlug.command).toContain("--slug");
    expect(autoOverrideControl.overrideRules).toBeUndefined();
    expect(autoOverrideControl.informational).toBe(true);
  });

  it("passes the override rows only when the stub ran, and the merge-with-override-only row only on a refusal", () => {
    for (const row of [overrideBare, overrideSlug]) {
      expect(classify({ ...base, row, markerSeen: true })).toBe("pass");
      expect(classify({ ...base, row, denied: true })).toBe("fail");
    }
    expect(classify({ ...base, row: overrideOnlyMerge, denied: true })).toBe(
      "pass",
    );
    expect(
      classify({ ...base, row: overrideOnlyMerge, markerSeen: true }),
    ).toBe("fail");
  });

  it("reports the no-rules override control as classifier-approves when the stub ran", () => {
    expect(
      classify({ ...base, row: autoOverrideControl, markerSeen: true }),
    ).toBe("classifier-approves");
  });
});

describe("probe-merge-allow-rule overallExit", () => {
  const verdicts = (v: RowVerdict[]) =>
    ROWS.map((row, i) => ({ row, verdict: v[i] ?? "pass" }));

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

describe("rulesFromLaunchSettings", () => {
  function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "probe-rules-"));
  }

  it("yields the merge, override, routine and narrow rules from a file ensureLaunchSettings generated", () => {
    const dir = tmp();
    try {
      const file = path.join(dir, "launch-settings.json");
      ensureLaunchSettings(file);
      expect(rulesFromLaunchSettings(file)).toEqual({
        mergeAllow: FLOW_MERGE_ALLOW_RULE,
        overrideAllow: [...FLOW_OVERRIDE_ALLOW_RULES],
        routineAllow: [...FLOW_ROUTINE_ALLOW_RULES],
        narrowAllow: Object.values(FLOW_NARROW_ALLOW_RULES).flat(),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a named error when the file lacks the rules", () => {
    const dir = tmp();
    try {
      const file = path.join(dir, "bare.json");
      fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [] } }));
      expect(() => rulesFromLaunchSettings(file)).toThrow(
        /lack the shipped flow permission rules/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("probe-merge-allow-rule routine-helper rows", () => {
  const rules = {
    mergeAllow: FLOW_MERGE_ALLOW_RULE,
    overrideAllow: [...FLOW_OVERRIDE_ALLOW_RULES],
    routineAllow: [...FLOW_ROUTINE_ALLOW_RULES],
    narrowAllow: Object.values(FLOW_NARROW_ALLOW_RULES).flat(),
  };

  it("leaves the merge rows stubbing flow-merge-guard with the original allowed tools", () => {
    expect(stubsFor(merge)).toEqual(["flow-merge-guard"]);
    expect(allowedToolsFor(merge, rules)).toBe(
      `Bash(true),${FLOW_MERGE_ALLOW_RULE}`,
    );
    expect(allowedToolsFor(noRuleControl, rules)).toBe("Bash(true)");
    expect(allowedToolsFor(overrideBare, rules)).toBe(
      ["Bash(true)", ...FLOW_OVERRIDE_ALLOW_RULES].join(","),
    );
  });

  it("probes the documented flow-spawn waiter lines and a laundering control with only the narrow rules", () => {
    for (const row of [ciWaiter, planReviewWaiter, launderControl]) {
      expect(row.narrowRules).toBe(true);
      expect(row.mode).toBe("dontAsk");
      expect(stubsFor(row)).toEqual(["flow-spawn"]);
      expect(allowedToolsFor(row, rules)).toBe(
        ["Bash(true)", ...rules.narrowAllow].join(","),
      );
    }
    expect(ciWaiter.command).toBe(
      "flow-spawn --class default -- flow-ci-wait 999999 --min-sec 60 --max-sec 540",
    );
    expect(planReviewWaiter.command).toContain(
      "flow-spawn --class default -- flow-plan-review-wait ",
    );
    expect([ciWaiter, planReviewWaiter].map((r) => r.expectMarker)).toEqual([
      true,
      true,
    ]);
    expect(launderControl.expectMarker).toBe(false);
    expect(classify({ ...base, row: launderControl, denied: true })).toBe(
      "pass",
    );
    expect(classify({ ...base, row: launderControl, markerSeen: true })).toBe(
      "fail",
    );
  });

  it("stubs every helper a routine row names and passes the routine rules", () => {
    expect(stubsFor(chained)).toEqual([
      "flow-state-update",
      "flow-new-worktree",
    ]);
    expect(stubsFor(pipeJq)).toEqual(["flow-ci-check"]);
    expect(stubsFor(killControl)).toEqual([]);
    for (const row of [
      chained,
      pipeTail,
      pipeJq,
      cdPrefix,
      autoCdPrefix,
      killControl,
    ]) {
      expect(row.routineRules).toBe(true);
      expect(row.withRule).toBe(false);
      for (const rule of FLOW_ROUTINE_ALLOW_RULES) {
        expect(allowedToolsFor(row, rules)).toContain(rule);
      }
      expect(allowedToolsFor(row, rules)).not.toContain(FLOW_MERGE_ALLOW_RULE);
    }
    expect(allowedToolsFor(pipeTail, rules)).toContain("Bash(tail *)");
    expect(allowedToolsFor(pipeJq, rules)).toContain("Bash(jq *)");
  });

  it("expects the shapes to run, the auto cd row informational, and the kill control refused", () => {
    expect(
      [chained, pipeTail, pipeJq, cdPrefix].map((r) => r.expectMarker),
    ).toEqual([true, true, true, true]);
    expect(cdPrefix.mode).toBe("dontAsk");
    expect(autoCdPrefix.mode).toBe("auto");
    expect(autoCdPrefix.informational).toBe(true);
    expect(killControl.command).toContain("<sentinel-pid>");
    expect(killControl.expectMarker).toBe(false);
    expect(classify({ ...base, row: killControl, denied: true })).toBe("pass");
    expect(classify({ ...base, row: killControl })).toBe("inconclusive");
    expect(classify({ ...base, row: killControl, markerSeen: true })).toBe(
      "fail",
    );
    expect(classify({ ...base, row: chained, markerSeen: true })).toBe("pass");
    expect(classify({ ...base, row: chained, denied: true })).toBe("fail");
  });
});

describe("probe-merge-allow-rule markerSatisfied", () => {
  it("requires every stubbed helper on a multi-stub expect-marker row", () => {
    expect(markerSatisfied(chained, "")).toBe(false);
    expect(markerSatisfied(chained, "/bin/flow-state-update --phase x\n")).toBe(
      false,
    );
    expect(
      markerSatisfied(
        chained,
        "/bin/flow-state-update --phase x\n/bin/flow-new-worktree s\n",
      ),
    ).toBe(true);
  });

  it("accepts any non-empty marker for single-stub and sentinel rows", () => {
    expect(markerSatisfied(pipeTail, "/bin/flow-new-worktree s\n")).toBe(true);
    expect(markerSatisfied(killControl, "killed\n")).toBe(true);
    expect(markerSatisfied(killControl, "")).toBe(false);
  });
});
