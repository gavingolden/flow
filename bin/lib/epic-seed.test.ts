import { describe, expect, it } from "vitest";
import {
  epicCreateSeed,
  epicResumeSeed,
  epicRunSeed,
  productPlanningSkillDir,
} from "./epic-seed";
import { resolveFlowSource } from "./paths";
import { splitSeed } from "./seed-delivery";
import * as path from "node:path";

describe("epicCreateSeed", () => {
  it("is byte-exact: a single control-char-free line carrying REQUEST_FILE, EPIC_DIR, and SKILL_DIR — the prompt no longer rides the seed", () => {
    // The leading line must stay bounded/prompt-free — it's capture-verified
    // against a visible-pane-only `capture-pane -p`, so an unbounded prompt on
    // line 1 could never match once it exceeds the pane height. The prompt
    // no longer rides the seed at all: the caller writes it to a request
    // file first and passes the resolved path in as `requestFile`.
    expect(
      epicCreateSeed(
        "Add dark mode",
        ".flow/epics/add-dark-mode",
        "/flow/skills/flow-product-planning",
        "/Users/test/.flow/state/add-dark-mode.request.md",
      ),
    ).toBe(
      "Use the /flow-epic-create skill. REQUEST_FILE: /Users/test/.flow/state/add-dark-mode.request.md EPIC_DIR: .flow/epics/add-dark-mode SKILL_DIR: /flow/skills/flow-product-planning",
    );
  });

  it("splitSeed's remainder is empty for the returned seed", () => {
    const seed = epicCreateSeed(
      "Add dark mode",
      ".flow/epics/add-dark-mode",
      "/flow/skills/flow-product-planning",
      "/Users/test/.flow/state/add-dark-mode.request.md",
    );
    expect(splitSeed(seed).remainder).toBe("");
  });
});

describe("epicResumeSeed", () => {
  it("is byte-exact (single control-char-free line, no REQUEST_FILE)", () => {
    expect(
      epicResumeSeed(
        "crashed-epic",
        ".flow/epics/crashed-epic",
        "/flow/skills/flow-product-planning",
      ),
    ).toBe(
      "Use the /flow-epic-create skill in --resume mode for: crashed-epic EPIC_DIR: .flow/epics/crashed-epic SKILL_DIR: /flow/skills/flow-product-planning",
    );
  });
});

describe("epicRunSeed", () => {
  it("is byte-exact (single control-char-free line)", () => {
    expect(epicRunSeed("my-epic", ".flow/epics/my-epic")).toBe(
      "Use the /flow-epic-run skill for: my-epic EPIC_DIR: .flow/epics/my-epic",
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
