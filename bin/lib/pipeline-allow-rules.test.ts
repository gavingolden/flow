import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLOW_EXEC_REVIEW_ALLOW_RULES,
  FLOW_NARROW_ALLOW_RULES,
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

describe("FLOW_NARROW_ALLOW_RULES", () => {
  it("is keyed only by never-allow helpers", () => {
    for (const h of Object.keys(FLOW_NARROW_ALLOW_RULES))
      expect(FLOW_NEVER_ALLOW_HELPERS).toContain(h);
  });

  it("pins every flow-spawn rule to a literal prefix ending in a routine helper", () => {
    for (const rule of FLOW_NARROW_ALLOW_RULES["flow-spawn"]) {
      expect(rule.endsWith(" *)")).toBe(true);
      const literal = rule.slice("Bash(".length, -" *)".length);
      expect(literal).not.toContain("*");
      const wrapped = literal.split(" -- ")[1].split(" ").pop() as string;
      expect(FLOW_ROUTINE_HELPERS).toContain(wrapped);
    }
  });

  it("never grants a blanket Bash(<helper> *)", () => {
    for (const [h, rules] of Object.entries(FLOW_NARROW_ALLOW_RULES)) {
      expect(rules).not.toContain(`Bash(${h} *)`);
      expect(rules).not.toContain(`Bash(${h})`);
    }
  });
});

describe("FLOW_EXEC_REVIEW_ALLOW_RULES", () => {
  it("is one literal-subcommand rule each, never a bare wildcard", () => {
    expect(FLOW_EXEC_REVIEW_ALLOW_RULES).not.toContain(
      "Bash(flow-exec-review *)",
    );
    expect(FLOW_EXEC_REVIEW_ALLOW_RULES).not.toContain(
      "Bash(flow-exec-review)",
    );
    for (const rule of FLOW_EXEC_REVIEW_ALLOW_RULES) {
      expect(rule).toMatch(/^Bash\(flow-exec-review [a-z-]+ \*\)$/);
    }
  });

  it("pre-approves status/review/order/outcome/stamp-check and never charter", () => {
    expect(FLOW_EXEC_REVIEW_ALLOW_RULES).toEqual([
      "Bash(flow-exec-review status *)",
      "Bash(flow-exec-review review *)",
      "Bash(flow-exec-review order *)",
      "Bash(flow-exec-review outcome *)",
      "Bash(flow-exec-review stamp-check *)",
    ]);
    expect(FLOW_EXEC_REVIEW_ALLOW_RULES.join(" ")).not.toContain("charter");
  });

  it("is not part of the routine bare-plus-wildcard helper list", () => {
    expect(FLOW_ROUTINE_HELPERS).not.toContain("flow-exec-review");
  });
});

describe("step 7 waiter doc pin", () => {
  it("launches the CI waiter as one standalone line with no $( substitution", () => {
    const doc = fs.readFileSync(
      path.resolve(
        BIN_DIR,
        "..",
        "skills/pipeline/flow-pipeline/references/phases/step-07-ci-wait.md",
      ),
      "utf8",
    );
    const lines = doc
      .split("\n")
      .filter((l) => l.includes("flow-spawn --class default -- flow-ci-wait"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain("$(");
    expect(doc).toContain(
      'flow-spawn --class default -- flow-ci-wait "$PR" --min-sec 60 --max-sec 540',
    );
  });
});

describe("plan-review waiter doc pin", () => {
  const rule = FLOW_NARROW_ALLOW_RULES["flow-spawn"].find((r) =>
    r.includes("flow-plan-review-wait"),
  );
  const prefix = (rule ?? "").replace(/^Bash\(/, "").replace(/\*\)$/, "");

  it("derives the literal prefix from the narrow rule", () => {
    expect(prefix).toBe("flow-spawn --class default -- flow-plan-review-wait ");
  });

  it.each([
    "skills/pipeline/flow-pipeline/references/phases/step-03-plan.md",
    "skills/pipeline/flow-epic-create/SKILL.md",
  ])(
    "%s launches the waiter with the rule's prefix and no $( substitution",
    (rel) => {
      const doc = fs
        .readFileSync(path.resolve(BIN_DIR, "..", rel), "utf8")
        .replace(/\s+/g, " ");
      const at = doc.indexOf(prefix);
      expect(
        at,
        `${rel} no longer contains "${prefix}"`,
      ).toBeGreaterThanOrEqual(0);
      const invocation = doc.slice(at, doc.indexOf("--max-sec 540", at));
      expect(invocation).not.toContain("$(");
    },
  );
});
