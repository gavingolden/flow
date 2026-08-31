import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUpsertArgs, run, runUpsert } from "./flow-foreclosed-paths";

let tmpRoot!: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-foreclosed-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content);
  return p;
}

const fixApplier = JSON.stringify({
  commits: [],
  deferred: [],
  rejected_alternatives: [
    {
      finding_id: "F1",
      considered_approach: "memoize the parser",
      why_rejected: "added cache-invalidation complexity",
    },
  ],
  anti_patterns_found: [],
  summary: "s",
});

const consolidator = JSON.stringify({
  consolidated_findings: [],
  dropped_by_validation: [],
  rejected_alternatives: ["kept the two lenses separate"],
  anti_patterns_found: [],
  summary: "s",
});

type GhCall = { argv: string[]; bodyFileContent?: string };

function makeGh(captured: GhCall[]) {
  let bodyForView = "";
  return {
    gh: (argv: string[]) => {
      const entry: GhCall = { argv: [...argv] };
      if (argv[0] === "pr" && argv[1] === "edit") {
        const i = argv.indexOf("--body-file");
        if (i !== -1 && argv[i + 1]) {
          entry.bodyFileContent = fs.readFileSync(argv[i + 1], "utf8");
          // Mutating gh: subsequent `pr view` returns the edited body, so a
          // second run sees an already-upserted body (idempotency check).
          bodyForView = entry.bodyFileContent;
        }
      }
      captured.push(entry);
      if (argv[0] === "pr" && argv[1] === "view") {
        return { stdout: bodyForView, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    setBody: (s: string) => {
      bodyForView = s;
    },
  };
}

describe("parseUpsertArgs", () => {
  it("requires a PR number", () => {
    expect(parseUpsertArgs([])).toEqual({ error: "PR number is required" });
  });

  it("rejects a non-positive integer", () => {
    expect(parseUpsertArgs(["abc"])).toMatchObject({
      error: expect.stringContaining("PR must"),
    });
  });

  it("parses PR + artifact path overrides", () => {
    expect(
      parseUpsertArgs([
        "42",
        "--fix-applier-result",
        "/a.json",
        "--consolidator-result",
        "/b.json",
      ]),
    ).toEqual({
      pr: 42,
      fixApplierResult: "/a.json",
      consolidatorResult: "/b.json",
    });
  });
});

describe("runUpsert", () => {
  it("upserts the section once on the happy path", () => {
    const fa = write("fix-applier-result.json", fixApplier);
    const co = write("consolidator-result.json", consolidator);
    const captured: GhCall[] = [];
    const { gh, setBody } = makeGh(captured);
    setBody("## Why\nbecause\n");
    const code = runUpsert(
      ["99", "--fix-applier-result", fa, "--consolidator-result", co],
      { gh },
    );
    expect(code).toBe(0);
    const edit = captured.find((c) => c.argv[1] === "edit");
    expect(edit?.bodyFileContent).toBeDefined();
    expect(edit!.bodyFileContent!).toContain("## Foreclosed Paths");
    expect(edit!.bodyFileContent!).toContain("memoize the parser");
    expect(edit!.bodyFileContent!).toContain("kept the two lenses separate");
    // The section body is collapsed under a <details> wrapper (Task 7);
    // normalizeDetailsBlocks (routed through upsertPrBodySection) leaves
    // its blank-line-after-<summary>/</details> shape unchanged.
    expect(edit!.bodyFileContent!).toContain(
      "<details><summary>1 rejected alternatives, 0 anti-patterns, 1 reviewer notes</summary>",
    );
    expect(edit!.bodyFileContent!).toContain("</details>");
  });

  it("is idempotent — a second run produces no further edit", () => {
    const fa = write("fix-applier-result.json", fixApplier);
    const co = write("consolidator-result.json", consolidator);
    const captured: GhCall[] = [];
    const { gh, setBody } = makeGh(captured);
    setBody("## Why\nbecause\n");
    runUpsert(["99", "--fix-applier-result", fa, "--consolidator-result", co], {
      gh,
    });
    const afterFirst = captured.filter((c) => c.argv[1] === "edit").length;
    runUpsert(["99", "--fix-applier-result", fa, "--consolidator-result", co], {
      gh,
    });
    const afterSecond = captured.filter((c) => c.argv[1] === "edit").length;
    expect(afterFirst).toBe(1);
    // The second run's `pr view` returns the already-upserted body, so the
    // computed newBody === currentBody and no further edit fires.
    expect(afterSecond).toBe(1);
  });

  it("no-ops (exit 0, no gh pr edit) when both artifacts are absent", () => {
    const captured: GhCall[] = [];
    const { gh } = makeGh(captured);
    const code = runUpsert(
      [
        "99",
        "--fix-applier-result",
        path.join(tmpRoot, "nope-a.json"),
        "--consolidator-result",
        path.join(tmpRoot, "nope-b.json"),
      ],
      { gh },
    );
    expect(code).toBe(0);
    expect(captured).toEqual([]);
  });

  it("no-ops when artifacts are present but carry empty arrays", () => {
    const fa = write(
      "fix-applier-result.json",
      JSON.stringify({
        commits: [],
        deferred: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "s",
      }),
    );
    const captured: GhCall[] = [];
    const { gh } = makeGh(captured);
    const code = runUpsert(
      [
        "99",
        "--fix-applier-result",
        fa,
        "--consolidator-result",
        path.join(tmpRoot, "absent.json"),
      ],
      { gh },
    );
    expect(code).toBe(0);
    expect(captured).toEqual([]);
  });

  it("derives artifactDir from tmpDir on a bare invocation (no --consolidator-result), so the disk fallback still fires — regression for the #716 failure mode where the PR-body surface never got the rescue", () => {
    // Bare invocation: no --fix-applier-result / --consolidator-result flags,
    // mirroring SKILL.md's `flow-foreclosed-paths pr-body-upsert "$PR"`.
    // `resolveFlowTmpDir`'s cwd fallback appends `.flow-tmp`, so the fixture
    // files must live under `<cwd>/.flow-tmp`, not `<cwd>` directly.
    const cwdRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-foreclosed-bare-"),
    );
    const flowTmp = path.join(cwdRoot, ".flow-tmp");
    fs.mkdirSync(flowTmp);
    fs.writeFileSync(
      path.join(flowTmp, "consolidator-result.json"),
      JSON.stringify({
        consolidated_findings: [],
        dropped_by_validation: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "s",
      }),
    );
    fs.writeFileSync(
      path.join(flowTmp, "agent-output-security.json"),
      JSON.stringify({
        rejected_alternatives: [
          {
            considered_approach: "store the token in localStorage",
            why_rejected: "XSS-exposed; used an httpOnly cookie instead",
          },
        ],
        anti_patterns_found: [],
      }),
    );
    try {
      const captured: GhCall[] = [];
      const { gh, setBody } = makeGh(captured);
      setBody("## Why\nbecause\n");
      const code = runUpsert(["99"], {
        gh,
        resolve: { resolveSlug: () => null, cwd: () => cwdRoot },
      });
      expect(code).toBe(0);
      const edit = captured.find((c) => c.argv[1] === "edit");
      expect(edit?.bodyFileContent).toContain(
        "store the token in localStorage",
      );
    } finally {
      fs.rmSync(cwdRoot, { recursive: true, force: true });
    }
  });

  it("returns 1 on gh pr view failure", () => {
    const fa = write("fix-applier-result.json", fixApplier);
    const code = runUpsert(
      [
        "99",
        "--fix-applier-result",
        fa,
        "--consolidator-result",
        path.join(tmpRoot, "absent.json"),
      ],
      { gh: () => ({ stdout: "", stderr: "boom", exitCode: 1 }) },
    );
    expect(code).toBe(1);
  });
});

describe("run (dispatcher)", () => {
  it("returns 2 with no subcommand", () => {
    expect(run([])).toBe(2);
  });

  it("returns 2 on unknown subcommand", () => {
    expect(run(["bogus"])).toBe(2);
  });
});
