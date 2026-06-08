import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decide,
  fetchPrInputs,
  parseArgs,
  parseTestStepsSection,
  run,
  type DecisionResult,
} from "./flow-gate-decide";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-gate-decide-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function seedState(slug: string, autoMerge?: boolean): void {
  const state: Record<string, unknown> = {
    slug,
    phase: "gating",
    repo: "/tmp/repo",
    updatedAt: "2026-04-30T12:00:00Z",
  };
  if (autoMerge !== undefined) state.autoMerge = autoMerge;
  fs.writeFileSync(
    path.join(stateDir, `${slug}.json`),
    JSON.stringify(state) + "\n",
  );
}

// --- parseTestStepsSection -------------------------------------------------

describe(parseTestStepsSection, () => {
  it("returns missing when the heading is absent", () => {
    expect(parseTestStepsSection("## Why\n\nbecause.\n")).toEqual({
      kind: "missing",
    });
  });

  it("returns missing for a similar-but-wrong heading", () => {
    // `## Manual validation` was the legacy heading; the new rubric only
    // matches `## Test Steps`. A leftover hand-edited PR with the old
    // heading must escalate, not silently auto-merge.
    expect(
      parseTestStepsSection("## Manual validation\n\n- [ ] foo\n"),
    ).toEqual({
      kind: "missing",
    });
  });

  it("returns no-unchecked when only an HTML comment placeholder is present", () => {
    const body =
      "## Why\n\nbecause.\n\n## Test Steps\n\n<!-- No human verification needed. -->\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });

  it("returns no-unchecked when the section is bounded by the next H2 heading and has no items", () => {
    const body =
      "## Test Steps\n\n<!-- placeholder -->\n\n## Deployment follow-up\n\n- [ ] not-this-section\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });

  it("returns no-unchecked when only blank lines and HTML comments fill the section", () => {
    const body = "## Test Steps\n\n\n<!-- a -->\n\n<!-- b -->\n\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });

  it("returns has-unchecked with the unchecked items extracted", () => {
    const body =
      "## Test Steps\n\n" +
      "- [ ] Run `npm run test` — all specs pass.\n" +
      "- [ ] Visit /foo with valid input.\n" +
      "\n## Other\n";
    const r = parseTestStepsSection(body);
    expect(r.kind).toBe("has-unchecked");
    if (r.kind === "has-unchecked") {
      expect(r.uncheckedItems).toEqual([
        "Run `npm run test` — all specs pass.",
        "Visit /foo with valid input.",
      ]);
    }
  });

  it("returns no-unchecked when every item is ticked (- [x])", () => {
    // pr-review ticks runnable items in place; this is the canonical
    // "all done, ship it" state.
    const body = "## Test Steps\n\n- [x] one\n- [x] two\n- [X] three\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });

  it("returns has-unchecked listing only the unchecked items when mixed with - [x]", () => {
    const body =
      "## Test Steps\n\n- [x] done\n- [ ] still-todo\n- [x] also-done\n";
    const r = parseTestStepsSection(body);
    expect(r.kind).toBe("has-unchecked");
    if (r.kind === "has-unchecked") {
      expect(r.uncheckedItems).toEqual(["still-todo"]);
    }
  });

  it("returns no-unchecked when only ticked items + a <details> evidence block are present", () => {
    // pr-review-completed shape: ticks runnable items and injects evidence
    // under each. The evidence has no `- [ ]` markers, so the count is 0.
    const body =
      "## Test Steps\n\n" +
      "- [x] `npm run verify` — pass\n" +
      "  <details><summary>Output</summary>\n\n" +
      "  PASS bin/foo.test.ts\n" +
      "  ✓ does the thing (4 ms)\n\n" +
      "  </details>\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });

  it("only matches the heading at column 0 (not indented)", () => {
    const body = "Random text\n  ## Test Steps\n\n- [ ] x\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "missing" });
  });

  it("ignores trailing whitespace on the heading line", () => {
    const body = "## Test Steps   \n\n<!-- empty -->\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });

  it("does not silently treat a missing heading as no-unchecked", () => {
    // The load-bearing rubric case: missing heading must escalate, NOT
    // route to auto-merge. The unchecked-count alone returns 0 in both
    // cases, which is why the heading-presence check exists.
    expect(parseTestStepsSection("")).toEqual({ kind: "missing" });
    expect(parseTestStepsSection("\n\n\n")).toEqual({ kind: "missing" });
  });

  it("ignores the literal `- [ ]` token when it appears inside an HTML comment", () => {
    // The comment is stripped before counting; the `- [ ]` inside should
    // not count toward the gate.
    const body =
      "## Test Steps\n\n<!-- example: - [ ] do thing -->\n- [x] ran tests\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });
});

// --- decide() --------------------------------------------------------------

describe(decide, () => {
  it("returns auto-merge when section has no unchecked items + autoMerge true", () => {
    const r = decide({
      body: "## Test Steps\n\n<!-- empty -->\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("auto-merge");
    expect(r.prState).toBe("OPEN");
  });

  it("returns auto-merge when only ticked items remain + autoMerge true", () => {
    const r = decide({
      body: "## Test Steps\n\n- [x] one\n- [x] two\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("auto-merge");
  });

  it("returns gated when section has no unchecked items + autoMerge false", () => {
    const r = decide({
      body: "## Test Steps\n\n<!-- empty -->\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: false,
    });
    expect(r.decision).toBe("gated");
    expect(r.validationItems).toEqual([]);
    expect(r.reason).toMatch(/opted out/);
  });

  it("returns gated with the unchecked items listed when section has - [ ] items", () => {
    const r = decide({
      body: "## Test Steps\n\n- [ ] step one\n- [ ] step two\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("gated");
    expect(r.validationItems).toEqual(["step one", "step two"]);
  });

  it("returns gated listing only unchecked items when ticked + unchecked are mixed", () => {
    const r = decide({
      body: "## Test Steps\n\n- [x] verified\n- [ ] still-todo\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("gated");
    expect(r.validationItems).toEqual(["still-todo"]);
  });

  it("returns escalate-heading-missing with reason 'test-steps-section-missing' for OPEN PRs without the heading", () => {
    const r = decide({
      body: "## Why\n\nbecause.\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("escalate-heading-missing");
    expect(r.reason).toBe("test-steps-section-missing");
  });

  it("returns merged-externally for MERGED PRs (any body)", () => {
    const r = decide({
      body: "## Why\nbecause\n", // heading missing, but state takes precedence
      state: "MERGED",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("merged-externally");
  });

  it("returns closed-no-merge for CLOSED PRs", () => {
    const r = decide({
      body: "## Test Steps\n\n- [ ] x\n",
      state: "CLOSED",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("closed-no-merge");
  });

  it("MERGED takes precedence over a missing heading (heading check is OPEN-only)", () => {
    const r = decide({
      body: "no heading at all",
      state: "MERGED",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("merged-externally");
  });
});

// --- fetchPrInputs ---------------------------------------------------------

describe(fetchPrInputs, () => {
  it("parses a successful gh pr view response", () => {
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        body: "## Test Steps\n\n",
        state: "OPEN",
        url: "https://x/y/pull/1",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const r = fetchPrInputs(1, gh);
    expect(r).toEqual({
      kind: "ok",
      body: "## Test Steps\n\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
    });
  });

  it("returns error on gh non-zero", () => {
    const gh = vi.fn(() => ({
      stdout: "",
      stderr: "auth required",
      exitCode: 4,
    }));
    const r = fetchPrInputs(1, gh);
    expect(r).toEqual({ kind: "error", message: "auth required" });
  });

  it("returns error on non-JSON stdout", () => {
    const gh = vi.fn(() => ({ stdout: "not-json", stderr: "", exitCode: 0 }));
    const r = fetchPrInputs(1, gh) as { kind: "error"; message: string };
    expect(r.kind).toBe("error");
    expect(r.message).toMatch(/non-JSON/);
  });

  it("returns error on unexpected state value", () => {
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({ body: "x", state: "DRAFT", url: "u" }),
      stderr: "",
      exitCode: 0,
    }));
    const r = fetchPrInputs(1, gh) as { kind: "error"; message: string };
    expect(r.kind).toBe("error");
    expect(r.message).toMatch(/unexpected JSON/);
  });
});

// --- parseArgs -------------------------------------------------------------

describe(parseArgs, () => {
  it("requires a PR number", () => {
    expect(parseArgs([])).toEqual({ error: "PR number is required" });
  });

  it("rejects a non-positive PR", () => {
    expect(parseArgs(["0", "--slug", "x"])).toEqual({
      error: "PR must be a positive integer, got '0'",
    });
  });

  it("treats --slug as optional (auto-resolve path) — parses PR-only", () => {
    // Previously rejected with '--slug is required'. The supervisor now
    // relies on this form: the slug auto-resolves from $TMUX_PANE.
    expect(parseArgs(["100"])).toEqual({ pr: 100 });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["100", "--bogus", "x"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("parses a valid invocation with explicit slug (back-compat)", () => {
    expect(parseArgs(["142", "--slug", "csv-export"])).toEqual({
      pr: 142,
      slug: "csv-export",
    });
  });
});

// --- run() integration -----------------------------------------------------

describe("run() integration", () => {
  it("emits a decision JSON on success", () => {
    seedState("alpha", true);
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        body: "## Test Steps\n\n<!-- empty -->\n",
        state: "OPEN",
        url: "https://x/y/pull/100",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((s) => {
        writes.push(s.toString());
        return true;
      });
    const exit = run(["100", "--slug", "alpha"], { gh, stateDir });
    writeSpy.mockRestore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.decision).toBe("auto-merge");
    expect(result.autoMerge).toBe(true);
  });

  it("respects autoMerge: false from state.json", () => {
    seedState("beta", false);
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        body: "## Test Steps\n\n<!-- empty -->\n",
        state: "OPEN",
        url: "https://x/y/pull/1",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const exit = run(["1", "--slug", "beta"], { gh, stateDir });
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.decision).toBe("gated");
    expect(result.autoMerge).toBe(false);
  });

  it("emits escalate-gh-error on gh failure, still exits 0 (caller branches on decision)", () => {
    seedState("gamma", true);
    const gh = vi.fn(() => ({ stdout: "", stderr: "no such PR", exitCode: 1 }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const exit = run(["999", "--slug", "gamma"], { gh, stateDir });
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.decision).toBe("escalate-gh-error");
    expect(result.reason).toContain("no such PR");
  });

  it("falls back to autoMerge=true when no state.json is found", () => {
    // No seedState — readState returns null.
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        body: "## Test Steps\n\n<!-- empty -->\n",
        state: "OPEN",
        url: "https://x/y/pull/1",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const exit = run(["1", "--slug", "missing"], { gh, stateDir });
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.decision).toBe("auto-merge");
    expect(result.autoMerge).toBe(true);
  });

  it("returns 2 with a clear error on bad args", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run([], { gh: vi.fn(), stateDir });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("auto-resolves --slug from $TMUX_PANE when omitted", () => {
    seedState("delta", false);
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        body: "## Test Steps\n\n<!-- empty -->\n",
        state: "OPEN",
        url: "https://x/y/pull/2",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((s) => {
        writes.push(s.toString());
        return true;
      });
    const exit = run(["2"], { gh, stateDir, resolveSlug: () => "delta" });
    writeSpy.mockRestore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    // delta is seeded with autoMerge: false → gated. Confirms the
    // pane-resolved slug actually fed readState() and surfaced the
    // recorded autoMerge value.
    expect(result.decision).toBe("gated");
    expect(result.autoMerge).toBe(false);
  });

  it("prefers an explicit --slug over the pane resolver (back-compat)", () => {
    seedState("epsilon", true);
    seedState("other-pipeline", false);
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        body: "## Test Steps\n\n<!-- empty -->\n",
        state: "OPEN",
        url: "https://x/y/pull/3",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((s) => {
        writes.push(s.toString());
        return true;
      });
    const exit = run(["3", "--slug", "epsilon"], {
      gh,
      stateDir,
      // Resolver disagrees — explicit must win, surfacing autoMerge: true.
      resolveSlug: () => "other-pipeline",
    });
    writeSpy.mockRestore();
    expect(exit).toBe(0);
    const result = JSON.parse(writes.join("")) as DecisionResult;
    expect(result.autoMerge).toBe(true);
  });

  it("returns 2 when no --slug given and pane has none either", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["4"], {
      gh: vi.fn(),
      stateDir,
      resolveSlug: () => null,
    });
    expect(exit).toBe(2);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("@flow-slug");
    errSpy.mockRestore();
  });
});
