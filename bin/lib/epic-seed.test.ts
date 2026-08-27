import { describe, expect, it } from "vitest";
import {
  epicCreateSeed,
  epicResumeSeed,
  epicRunSeed,
  productPlanningSkillDir,
} from "./epic-seed";
import { resolveFlowSource } from "./paths";
import * as path from "node:path";

describe("epicCreateSeed", () => {
  it("is byte-exact: a short, prompt-free leading line, then the prompt on the remainder (Task 5 reshape)", () => {
    // The leading line must stay bounded/prompt-free — it's capture-verified
    // against a visible-pane-only `capture-pane -p`, so an unbounded prompt on
    // line 1 could never match once it exceeds the pane height. The prompt now
    // rides the remainder instead (paced + integrity-checked).
    expect(
      epicCreateSeed(
        "Add dark mode",
        ".flow/epics/add-dark-mode",
        "/flow/skills/flow-product-planning",
      ),
    ).toBe(
      "Use the /flow-epic-create skill for the prompt below.\nAdd dark mode\n\nEPIC_DIR: .flow/epics/add-dark-mode\n\nSKILL_DIR: /flow/skills/flow-product-planning",
    );
  });
});

describe("epicResumeSeed", () => {
  it("is byte-exact (Task-2 behavior-preserving regression anchor)", () => {
    expect(
      epicResumeSeed(
        "crashed-epic",
        ".flow/epics/crashed-epic",
        "/flow/skills/flow-product-planning",
      ),
    ).toBe(
      "Use the /flow-epic-create skill in --resume mode for: crashed-epic\n\nEPIC_DIR: .flow/epics/crashed-epic\n\nSKILL_DIR: /flow/skills/flow-product-planning",
    );
  });
});

describe("epicRunSeed", () => {
  it("is byte-exact (Task-2 behavior-preserving regression anchor)", () => {
    expect(epicRunSeed("my-epic", ".flow/epics/my-epic")).toBe(
      "Use the /flow-epic-run skill for: my-epic\n\nEPIC_DIR: .flow/epics/my-epic",
    );
  });
});

describe("productPlanningSkillDir", () => {
  it("resolves flow source + skills/pipeline/flow-product-planning", () => {
    expect(productPlanningSkillDir()).toBe(
      path.join(
        resolveFlowSource(),
        "skills",
        "pipeline",
        "flow-product-planning",
      ),
    );
  });
});
