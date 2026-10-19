import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLOW_NEVER_ALLOW_HELPERS,
  FLOW_ROUTINE_ALLOW_RULES,
  FLOW_ROUTINE_HELPERS,
} from "./pipeline-allow-rules";

const BIN_DIR = path.resolve(__dirname, "..");

describe("FLOW_ROUTINE_HELPERS", () => {
  it("names only helpers that ship in bin/", () => {
    for (const h of FLOW_ROUTINE_HELPERS) {
      expect(
        fs.existsSync(path.join(BIN_DIR, `${h}.ts`)) ||
          fs.existsSync(path.join(BIN_DIR, h)),
        h,
      ).toBe(true);
    }
  });

  it("never overlaps the never-allow list or the flow-merge-guard family", () => {
    for (const h of FLOW_ROUTINE_HELPERS) {
      expect(FLOW_NEVER_ALLOW_HELPERS).not.toContain(h);
      expect(h.startsWith("flow-merge-guard")).toBe(false);
    }
  });

  it("uses plain helper names with no wildcard or shell metacharacter", () => {
    for (const h of FLOW_ROUTINE_HELPERS)
      expect(h).toMatch(/^flow-[a-z0-9-]+$/);
    expect(new Set(FLOW_ROUTINE_HELPERS).size).toBe(
      FLOW_ROUTINE_HELPERS.length,
    );
  });
});

describe("FLOW_ROUTINE_ALLOW_RULES", () => {
  it("is exactly a bare and an argument rule per helper", () => {
    expect(FLOW_ROUTINE_ALLOW_RULES).toEqual(
      FLOW_ROUTINE_HELPERS.flatMap((h) => [`Bash(${h})`, `Bash(${h} *)`]),
    );
    expect(FLOW_ROUTINE_ALLOW_RULES.length).toBe(
      FLOW_ROUTINE_HELPERS.length * 2,
    );
  });
});
