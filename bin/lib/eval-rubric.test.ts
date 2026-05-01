import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRubric, runHardChecks, type Rubric } from "./eval-rubric";

let scratch!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-rubric-"));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function writeRubric(yaml: string): string {
  const p = path.join(scratch, "rubric.yml");
  fs.writeFileSync(p, yaml);
  return p;
}

describe("parseRubric", () => {
  it("parses a full rubric with both sections", () => {
    const p = writeRubric(`
hard:
  must_pass:
    - "npm test"
  must_create:
    - "bin/cli.ts"
  must_not_modify:
    - "package.json"
soft:
  - "Tests cover the new flag."
`);
    const r = parseRubric(p);
    expect(r.hard.mustPass).toEqual(["npm test"]);
    expect(r.hard.mustCreate).toEqual(["bin/cli.ts"]);
    expect(r.hard.mustNotModify).toEqual(["package.json"]);
    expect(r.soft).toEqual(["Tests cover the new flag."]);
  });

  it("treats missing sections as empty arrays", () => {
    const p = writeRubric(`
soft:
  - "x"
`);
    const r = parseRubric(p);
    expect(r.hard.mustPass).toEqual([]);
    expect(r.hard.mustCreate).toEqual([]);
    expect(r.hard.mustNotModify).toEqual([]);
    expect(r.soft).toEqual(["x"]);
  });

  it("throws when no checks at all are defined", () => {
    const p = writeRubric(`hard: {}\n`);
    expect(() => parseRubric(p)).toThrow(/at least one check/);
  });

  it("throws on non-string list entries", () => {
    const p = writeRubric(`
soft:
  - 42
`);
    expect(() => parseRubric(p)).toThrow(/expected string/);
  });
});

describe("runHardChecks", () => {
  function rubric(overrides: Partial<Rubric["hard"]>): Rubric {
    return {
      hard: { mustPass: [], mustCreate: [], mustNotModify: [], ...overrides },
      soft: [],
    };
  }

  it("passes when no hard checks are defined", () => {
    const r = runHardChecks(rubric({}), scratch, []);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("flags must_pass commands that exit non-zero", () => {
    const r = runHardChecks(rubric({ mustPass: ["false"] }), scratch, []);
    expect(r.pass).toBe(false);
    expect(r.failures[0].check).toBe("must_pass");
    expect(r.failures[0].detail).toBe("false");
  });

  it("passes must_pass commands that exit zero", () => {
    const r = runHardChecks(rubric({ mustPass: ["true"] }), scratch, []);
    expect(r.pass).toBe(true);
  });

  it("flags missing must_create files", () => {
    const r = runHardChecks(rubric({ mustCreate: ["bin/cli.ts"] }), scratch, []);
    expect(r.pass).toBe(false);
    expect(r.failures[0].check).toBe("must_create");
  });

  it("matches must_create globs", () => {
    fs.mkdirSync(path.join(scratch, "src"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "src", "thing.ts"), "");
    const r = runHardChecks(rubric({ mustCreate: ["src/*.ts"] }), scratch, []);
    expect(r.pass).toBe(true);
  });

  it("flags must_not_modify hits in changedPaths", () => {
    const r = runHardChecks(
      rubric({ mustNotModify: ["package.json"] }),
      scratch,
      ["package.json", "bin/cli.ts"],
    );
    expect(r.pass).toBe(false);
    expect(r.failures[0].check).toBe("must_not_modify");
    expect(r.failures[0].detail).toBe("package.json");
  });

  it("ignores must_not_modify globs that don't match changedPaths", () => {
    const r = runHardChecks(
      rubric({ mustNotModify: ["package.json"] }),
      scratch,
      ["bin/cli.ts"],
    );
    expect(r.pass).toBe(true);
  });

  it("supports ** glob in must_not_modify", () => {
    const r = runHardChecks(
      rubric({ mustNotModify: ["src/**"] }),
      scratch,
      ["src/deep/nested/file.ts"],
    );
    expect(r.pass).toBe(false);
  });

  it("collects multiple failures across check kinds", () => {
    const r = runHardChecks(
      rubric({
        mustPass: ["false"],
        mustCreate: ["nope.ts"],
        mustNotModify: ["touched.ts"],
      }),
      scratch,
      ["touched.ts"],
    );
    expect(r.pass).toBe(false);
    expect(r.failures.map((f) => f.check).sort()).toEqual([
      "must_create",
      "must_not_modify",
      "must_pass",
    ]);
  });
});
