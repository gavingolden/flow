import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideCandidateIssues,
  extractTicked,
  parseArgs,
  run,
  splitCandidate,
  tickCandidates,
} from "./flow-candidate-issues";

const HEADING = "# Candidate follow-up issues";

// --- decideCandidateIssues -------------------------------------------------

describe(decideCandidateIssues, () => {
  it("returns no-op when the heading is absent", () => {
    const r = decideCandidateIssues("# PRD\n\nsome text\n");
    expect(r).toEqual({
      action: "no-op",
      candidates: [],
      untickedCount: 0,
      tickedCount: 0,
    });
  });

  it("returns no-op when the heading is present but has zero item lines", () => {
    const r = decideCandidateIssues(
      `## Why\n\nbecause.\n\n${HEADING}\n\nprose only, no checkboxes.\n`,
    );
    expect(r.action).toBe("no-op");
    expect(r.untickedCount).toBe(0);
    expect(r.tickedCount).toBe(0);
    expect(r.candidates).toEqual([]);
  });

  it("returns prompt with one candidate, splitting on the first ` — `", () => {
    const r = decideCandidateIssues(
      `${HEADING}\n\n- [ ] OAuth refresh path leaks tokens — separate concern; needs a session.\n`,
    );
    expect(r.action).toBe("prompt");
    expect(r.untickedCount).toBe(1);
    expect(r.tickedCount).toBe(0);
    expect(r.candidates).toEqual([
      {
        title: "OAuth refresh path leaks tokens",
        body: "separate concern; needs a session.",
      },
    ]);
  });

  it("splits only on the FIRST ` — ` (body may contain another em-dash)", () => {
    const r = decideCandidateIssues(
      `${HEADING}\n\n- [ ] Title here — body part one — body part two\n`,
    );
    expect(r.candidates).toEqual([
      { title: "Title here", body: "body part one — body part two" },
    ]);
  });

  it("returns prompt for 4 unticked items", () => {
    const r = decideCandidateIssues(
      `${HEADING}\n\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n`,
    );
    expect(r.action).toBe("prompt");
    expect(r.untickedCount).toBe(4);
    expect(r.candidates).toHaveLength(4);
  });

  it("returns skip-already-ticked when 1 ticked + 2 unticked", () => {
    const r = decideCandidateIssues(
      `${HEADING}\n\n- [x] already filed — done\n- [ ] a\n- [ ] b\n`,
    );
    expect(r.action).toBe("skip-already-ticked");
    expect(r.untickedCount).toBe(2);
    expect(r.tickedCount).toBe(1);
  });

  it("returns skip-already-ticked when every item is already ticked", () => {
    const r = decideCandidateIssues(`${HEADING}\n\n- [x] one\n- [X] two\n`);
    expect(r.action).toBe("skip-already-ticked");
    expect(r.untickedCount).toBe(0);
    expect(r.tickedCount).toBe(2);
  });

  it("returns overflow for 5 unticked items", () => {
    const body =
      `${HEADING}\n\n` +
      ["a", "b", "c", "d", "e"].map((t) => `- [ ] ${t}`).join("\n") +
      "\n";
    const r = decideCandidateIssues(body);
    expect(r.action).toBe("overflow");
    expect(r.untickedCount).toBe(5);
  });

  it("returns overflow for 6 unticked items", () => {
    const body =
      `${HEADING}\n\n` +
      ["a", "b", "c", "d", "e", "f"].map((t) => `- [ ] ${t}`).join("\n") +
      "\n";
    const r = decideCandidateIssues(body);
    expect(r.action).toBe("overflow");
    expect(r.untickedCount).toBe(6);
  });

  it("yields body === '' when a candidate line has no ` — `", () => {
    const r = decideCandidateIssues(`${HEADING}\n\n- [ ] Just a title\n`);
    expect(r.candidates).toEqual([{ title: "Just a title", body: "" }]);
  });

  it("stops parsing at the next top-level `# ` heading", () => {
    // An item-looking line under a following `# Task breakdown` heading is
    // NOT counted — the section is bounded by the next H1.
    const body = `${HEADING}\n\n- [ ] real candidate\n\n# Task breakdown\n\n- [ ] not a candidate\n- [ ] also not\n`;
    const r = decideCandidateIssues(body);
    expect(r.action).toBe("prompt");
    expect(r.untickedCount).toBe(1);
    expect(r.candidates).toEqual([{ title: "real candidate", body: "" }]);
  });
});

// --- splitCandidate --------------------------------------------------------

describe(splitCandidate, () => {
  it("returns empty body when there is no delimiter", () => {
    expect(splitCandidate("only a title")).toEqual({
      title: "only a title",
      body: "",
    });
  });
});

// --- tickCandidates (pure) -------------------------------------------------

describe(tickCandidates, () => {
  const SECTION = `${HEADING}\n\n- [ ] first\n- [ ] second\n- [ ] third\n`;

  it("flips only the selected 1-based unticked indices, leaving others byte-identical", () => {
    const { text, result } = tickCandidates(SECTION, [1, 3]);
    expect(text).toContain("- [x] first");
    expect(text).toContain("- [ ] second");
    expect(text).toContain("- [x] third");
    expect(result.tickedIndices).toEqual([1, 3]);
    expect(result.tickedCount).toBe(2);
    // The heading line and the untouched item are unchanged verbatim.
    expect(text.split("\n")[0]).toBe(HEADING);
  });

  it("throws on an out-of-range index", () => {
    expect(() => tickCandidates(SECTION, [4])).toThrow(/out of range/);
    expect(() => tickCandidates(SECTION, [0])).toThrow(/out of range/);
  });

  it("is idempotent: re-deciding after a flip reflects the new ticked state", () => {
    const { text } = tickCandidates(SECTION, [1]);
    const r = decideCandidateIssues(text);
    expect(r.action).toBe("skip-already-ticked");
    expect(r.tickedCount).toBe(1);
    expect(r.untickedCount).toBe(2);
  });
});

// --- extractTicked ---------------------------------------------------------

describe(extractTicked, () => {
  it("returns an empty array when the section is absent", () => {
    expect(extractTicked("# PRD\n\ntext\n")).toEqual([]);
  });

  it("returns an empty array when the section has zero ticked items", () => {
    expect(extractTicked(`${HEADING}\n\n- [ ] a\n- [ ] b\n`)).toEqual([]);
  });

  it("returns only the ticked items as { title, body } pairs", () => {
    const body = `${HEADING}\n\n- [x] Filed one — body one\n- [ ] not ticked\n- [X] Filed two — body two\n`;
    expect(extractTicked(body)).toEqual([
      { title: "Filed one", body: "body one" },
      { title: "Filed two", body: "body two" },
    ]);
  });
});

// --- parseArgs -------------------------------------------------------------

describe(parseArgs, () => {
  it("requires --plan-md-file", () => {
    expect(parseArgs(["--json"])).toEqual({
      error: "--plan-md-file is required",
    });
  });

  it("defaults to json mode", () => {
    expect(parseArgs(["--plan-md-file", "p.md"])).toEqual({
      planMdFile: "p.md",
      mode: "json",
      tickIndices: undefined,
    });
  });

  it("parses --tick into integer indices", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--tick", "1,3"])).toEqual({
      planMdFile: "p.md",
      mode: "tick",
      tickIndices: [1, 3],
    });
  });

  it("rejects a non-integer --tick index", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--tick", "1,x"])).toEqual({
      error: "--tick index must be an integer, got 'x'",
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });
});

// --- run() / CLI (file-touching modes) -------------------------------------

describe("run() integration", () => {
  let dir!: string;
  let planFile!: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-candidate-issues-"));
    planFile = path.join(dir, "plan.md");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePlan(body: string): void {
    fs.writeFileSync(planFile, body);
  }

  function captureStdout(fn: () => number): { exit: number; out: string } {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const exit = fn();
    spy.mockRestore();
    return { exit, out: writes.join("") };
  }

  it("emits the decision shape { action, candidates, untickedCount, tickedCount }", () => {
    writePlan(`${HEADING}\n\n- [ ] alpha — first\n- [ ] beta\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--json"]),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      action: "prompt",
      candidates: [
        { title: "alpha", body: "first" },
        { title: "beta", body: "" },
      ],
      untickedCount: 2,
      tickedCount: 0,
    });
  });

  it("--tick flips the selected items in the file and leaves others unchanged", () => {
    writePlan(`${HEADING}\n\n- [ ] one\n- [ ] two\n- [ ] three\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--tick", "1,3"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({ tickedIndices: [1, 3], tickedCount: 2 });
    const after = fs.readFileSync(planFile, "utf8");
    expect(after).toContain("- [x] one");
    expect(after).toContain("- [ ] two");
    expect(after).toContain("- [x] three");
  });

  it("--tick rejects an out-of-range index with exit 2 and no file mutation", () => {
    writePlan(`${HEADING}\n\n- [ ] one\n`);
    const before = fs.readFileSync(planFile, "utf8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--plan-md-file", planFile, "--tick", "5"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(fs.readFileSync(planFile, "utf8")).toBe(before);
  });

  it("--ticked emits the now-ticked pairs after a --tick", () => {
    writePlan(`${HEADING}\n\n- [ ] alpha — first\n- [ ] beta — second\n`);
    captureStdout(() => run(["--plan-md-file", planFile, "--tick", "2"]));
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--ticked"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({
      ticked: [{ title: "beta", body: "second" }],
    });
  });

  it("--ticked returns an empty array on an all-unticked section", () => {
    writePlan(`${HEADING}\n\n- [ ] a\n- [ ] b\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--ticked"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({ ticked: [] });
  });

  it("returns 2 when --plan-md-file points at a missing file", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--plan-md-file", path.join(dir, "nope.md"), "--json"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("returns 2 on bad args", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--json"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});
