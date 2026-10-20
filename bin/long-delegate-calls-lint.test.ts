import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readPipelineSkillDoc } from "./lib/pipeline-skill-corpus";

/**
 * Doc lint for the detach-and-wait recipe. Every agy-delegated call site whose
 * helper can outlast one tool call (the 600000 ms Bash cap) launches it with
 * `flow-spawn --detach` and waits with `flow-plan-review-wait --complete-line
 * --pid` — never as one blocking tool call. Table-driven so a new site is one
 * row.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDoc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

type Site = {
  name: string;
  read: () => string;
  helper: string;
  // The call-site recipe removes the watched file before launching, so a stale
  // file from an earlier pass never satisfies the waiter instantly. Pointer
  // paragraphs that defer to the recipe doc don't carry the rm themselves.
  carriesRecipe: boolean;
};

const SITES: Site[] = [
  {
    name: "blind survey recipe (blind-survey.md)",
    read: () => readPipelineSkillDoc("references/blind-survey.md"),
    helper: "flow-blind-survey",
    carriesRecipe: true,
  },
  {
    name: "blind survey pointer (step-03-plan.md)",
    read: () => readPipelineSkillDoc("references/phases/step-03-plan.md"),
    helper: "flow-blind-survey",
    carriesRecipe: false,
  },
  {
    name: "forced research recipe (step3-threading.md)",
    read: () => readPipelineSkillDoc("references/step3-threading.md"),
    helper: "flow-research-run",
    carriesRecipe: true,
  },
  {
    name: "forced research pointer (step-03-plan.md)",
    read: () => readPipelineSkillDoc("references/phases/step-03-plan.md"),
    helper: "flow-research-run",
    carriesRecipe: false,
  },
  {
    name: "Gemini review lens (gemini-lens-run.md)",
    read: () =>
      repoDoc("skills/pipeline/flow-pr-review/references/gemini-lens-run.md"),
    helper: "flow-gemini-lens",
    carriesRecipe: true,
  },
  {
    name: "intent guess (intent-mismatch-resolution.md)",
    read: () =>
      repoDoc(
        "skills/pipeline/flow-pr-review/references/intent-mismatch-resolution.md",
      ),
    helper: "flow-gemini-intent-guess",
    carriesRecipe: true,
  },
  {
    name: "discovery research (discovery-research.md)",
    read: () =>
      repoDoc(
        "skills/pipeline/flow-product-planning/references/discovery-research.md",
      ),
    helper: "flow-delegate-fanout",
    carriesRecipe: true,
  },
];

const NEAR = 700;

function near(text: string, a: string, b: string, window = NEAR): boolean {
  const idx = (needle: string) =>
    [
      ...text.matchAll(
        new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      ),
    ].map((m) => m.index!);
  const bs = idx(b);
  return idx(a).some((i) => bs.some((j) => Math.abs(i - j) <= window));
}

// The old shape: the helper run as ONE blocking tool call under a 600000 ms
// timeout, with the "sum to 9 minutes" / "9m ceiling" arithmetic that justified it.
const FORBIDDEN: Array<[string, RegExp]> = [
  [
    "a blocking `timeout: 600000` helper call",
    /as a Bash (tool )?call\s+with\s+`timeout: 600000`/,
  ],
  [
    "a mandatory explicit `timeout: 600000` on the helper call",
    /MUST pass an explicit `timeout: 600000`/,
  ],
  ['the "sum to 9 minutes" arithmetic', /sum to 9\s+minutes/],
  ["the 9m sync ceiling", /9m sync ceiling|ceiling 9m|ceiling is 9m/],
];

describe.each(SITES)("long delegate call site: $name", (site) => {
  const text = site.read();

  it("launches the helper with flow-spawn --detach", () => {
    expect(
      near(text, "flow-spawn --detach", site.helper),
      `${site.name} must put \`flow-spawn --detach\` next to \`${site.helper}\``,
    ).toBe(true);
  });

  it("waits with the complete-line waiter bound to the launched pid", () => {
    expect(text).toContain("flow-plan-review-wait");
    expect(text).toContain("--complete-line");
    expect(text).toContain("--pid");
    expect(near(text, "flow-plan-review-wait", "--pid", 200)).toBe(true);
  });

  it("is not one blocking tool call", () => {
    for (const [what, re] of FORBIDDEN) {
      expect(re.test(text), `${site.name} must not carry ${what}`).toBe(false);
    }
  });

  it.runIf(site.carriesRecipe)(
    "removes the watched file before launching",
    () => {
      const rm = text.search(/rm -f /);
      const spawn = text.indexOf("flow-spawn --detach");
      expect(rm).toBeGreaterThanOrEqual(0);
      expect(rm).toBeLessThan(spawn);
    },
  );

  it.runIf(site.carriesRecipe)(
    "names a give-up and kills the process group",
    () => {
      expect(text).toMatch(/give-up/);
      expect(text).toMatch(/kill -- -"\$\(cat [^\n]*\.pid"?\)"/);
    },
  );

  // Each Bash call is a fresh shell, so $PID set in the launch block is unset
  // by the wait and give-up calls; the recipe must persist it and read it back.
  it.runIf(site.carriesRecipe)(
    "persists the pid to a file and reads it back in the wait call",
    () => {
      expect(text).toMatch(/echo "\$PID" > [^\n]*\.pid/);
      expect(text).toMatch(/PID=\$\(cat [^\n]*\.pid"?\)/);
    },
  );
});

describe("flow-pr-review/SKILL.md", () => {
  const skill = repoDoc("skills/pipeline/flow-pr-review/SKILL.md");

  it("points the Gemini lens at its launch-and-wait recipe", () => {
    expect(skill).toContain("references/gemini-lens-run.md");
    expect(skill).toContain("flow-spawn --detach");
  });

  it("no longer clamps the lens to a 9m sync ceiling under one tool call", () => {
    for (const [what, re] of FORBIDDEN) {
      expect(re.test(skill), `SKILL.md must not carry ${what}`).toBe(false);
    }
  });
});
