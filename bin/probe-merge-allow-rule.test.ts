import { describe, expect, it } from "vitest";
import { classify, ROWS } from "../scripts/probe-merge-allow-rule";

const [merge, recordOverride, autoMerge] = ROWS;
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
});
