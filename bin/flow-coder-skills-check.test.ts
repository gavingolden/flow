import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkIssueBody } from "./lib/issue-body-rubric";
import { checkSkillsRead, DESIGN_GAP_TITLE } from "./flow-coder-skills-check";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-coder-skills-check-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SCRIPT = path.join(__dirname, "flow-coder-skills-check.ts");

const TESTING_DOCS = [
  "/skills/flow-testing/SKILL.md",
  "/skills/flow-testing-svelte/SKILL.md",
  "/skills/flow-svelte/SKILL.md",
];
const DESIGN = [
  "/skills/flow-ui-ux/SKILL.md",
  "/skills/flow-ui-ux/references/layout.md",
  "/skills/flow-ui-ux/references/visual-design.md",
  "/skills/flow-ui-ux/references/accessibility.md",
  "/skills/flow-tailwind-shadcn/SKILL.md",
];

const uiEditSet = [
  {
    file: "src/lib/components/BrushOverlay.svelte",
    intent: "i",
    expected_outcome: "o",
    skill_docs: TESTING_DOCS,
  },
];

describe("checkSkillsRead", () => {
  it("flags every design path missing in the run-1 fixture, with a consequence-worded title", () => {
    const artifact = { status: "complete", skills_read: TESTING_DOCS };
    const r = checkSkillsRead(artifact, uiEditSet, DESIGN);
    expect(r.missing).toEqual(DESIGN);
    expect(r.missingDesign).toEqual(DESIGN);
    expect(r.needsContinuation).toBe(true);
    expect(r.untrackedTitle).toBe(DESIGN_GAP_TITLE);
    expect(r.untrackedTitle).not.toContain("skill not applied");
    expect(r.untrackedTitle).not.toContain("flow-ui-ux");
    expect(r.untrackedBody).not.toBeNull();
    expect(checkIssueBody(r.untrackedBody as string).misses).toEqual([]);
    expect(r.untrackedBody).not.toContain("\n");
  });

  it("treats a path in both skills_read and skills_read_late as late, not missing", () => {
    const artifact = {
      skills_read: [...TESTING_DOCS, ...DESIGN],
      skills_read_late: [DESIGN[0]],
    };
    const r = checkSkillsRead(artifact, uiEditSet, DESIGN);
    expect(r.late).toEqual([DESIGN[0]]);
    expect(r.missing).toEqual([]);
    expect(r.needsContinuation).toBe(true);
    expect(r.untrackedTitle).toBeNull();
    expect(r.untrackedBody).toBeNull();
  });

  it("reports nothing when every required path was read in time", () => {
    const artifact = { skills_read: [...TESTING_DOCS, ...DESIGN] };
    const r = checkSkillsRead(artifact, uiEditSet, DESIGN);
    expect(r.missing).toEqual([]);
    expect(r.late).toEqual([]);
    expect(r.needsContinuation).toBe(false);
    expect(r.untrackedTitle).toBeNull();
    expect(r.untrackedBody).toBeNull();
  });

  it("is empty for an edit-set with no skill_docs and no design paths", () => {
    const r = checkSkillsRead({}, [{ file: "bin/x.ts" }], []);
    expect(r.required).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.needsContinuation).toBe(false);
    expect(r.untrackedTitle).toBeNull();
  });

  it("does not require design paths for a non-UI edit-set", () => {
    const r = checkSkillsRead(
      { skills_read: [] },
      [{ file: "bin/x.ts" }],
      DESIGN,
    );
    expect(r.required).toEqual([]);
    expect(r.missingDesign).toEqual([]);
    expect(r.untrackedTitle).toBeNull();
  });

  it("reports non-design misses without an owner-facing title", () => {
    const r = checkSkillsRead({ skills_read: [] }, uiEditSet, []);
    expect(r.missing).toEqual(TESTING_DOCS);
    expect(r.needsContinuation).toBe(true);
    expect(r.untrackedTitle).toBeNull();
  });

  it("dedupes required paths in first-seen order and tolerates malformed fields", () => {
    const editSet = [
      { file: "a.ts", skill_docs: ["/a/./b", "/c"] },
      { file: "b.ts", skill_docs: ["/a/b", 7, null] },
      "junk",
      { file: "c.ts", skill_docs: "nope" },
    ];
    const r = checkSkillsRead(
      { skills_read: "nope", skills_read_late: [1] },
      editSet,
      [],
    );
    expect(r.required).toEqual(["/a/./b", "/c"]);
    expect(r.read).toEqual([]);
    expect(r.late).toEqual([]);
  });

  it("matches paths that differ only by normalization", () => {
    const r = checkSkillsRead(
      { skills_read: ["/a/./b/../b/SKILL.md"] },
      [{ file: "a.ts", skill_docs: ["/a/b/SKILL.md"] }],
      [],
    );
    expect(r.missing).toEqual([]);
  });

  it("matches a symlinked path against its real path", () => {
    const real = path.join(tmp, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "SKILL.md"), "x");
    const link = path.join(tmp, "link");
    fs.symlinkSync(real, link);
    const r = checkSkillsRead(
      { skills_read: [path.join(link, "SKILL.md")] },
      [{ file: "a.ts", skill_docs: [path.join(real, "SKILL.md")] }],
      [],
    );
    expect(r.missing).toEqual([]);
  });
});

describe("flow-coder-skills-check CLI", () => {
  const artifactPath = path.join(tmp, "artifact.json");
  const editSetPath = path.join(tmp, "edit-set.json");
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ status: "complete", skills_read: TESTING_DOCS }),
  );
  fs.writeFileSync(editSetPath, JSON.stringify(uiEditSet));

  const cli = (args: string[]) =>
    spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });

  it("prints one JSON verdict from --edit-set-file", () => {
    const r = cli([
      "--artifact",
      artifactPath,
      "--edit-set-file",
      editSetPath,
      "--design",
      DESIGN[0],
    ]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.missingDesign).toEqual([DESIGN[0]]);
    expect(out.untrackedTitle).toBe(DESIGN_GAP_TITLE);
  });

  it("accepts the inline --edit-set form", () => {
    const r = cli([
      "--artifact",
      artifactPath,
      "--edit-set",
      JSON.stringify(uiEditSet),
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).needsContinuation).toBe(false);
  });

  it.each([
    ["missing --artifact", ["--edit-set-file", editSetPath]],
    ["missing edit-set", ["--artifact", artifactPath]],
    [
      "unreadable artifact",
      [
        "--artifact",
        path.join(tmp, "nope.json"),
        "--edit-set-file",
        editSetPath,
      ],
    ],
    ["unknown flag", ["--artifact", artifactPath, "--bogus", "x"]],
  ])("exits 2 on %s", (_label, args) => {
    const r = cli(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("flow-coder-skills-check");
  });

  it("exits 2 on an unparseable artifact", () => {
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{not json");
    const r = cli(["--artifact", bad, "--edit-set-file", editSetPath]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not valid JSON");
  });

  it("exits 2 when the edit-set is not a JSON array", () => {
    const r = cli(["--artifact", artifactPath, "--edit-set", "{}"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("JSON array");
  });
});
