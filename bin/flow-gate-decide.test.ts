import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decide,
  fetchPrInputs,
  findTrappedTestSteps,
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

function seedState(slug: string, autoMerge?: boolean, pr?: number): void {
  const state: Record<string, unknown> = {
    slug,
    phase: "gating",
    repo: "/tmp/repo",
    updatedAt: "2026-04-30T12:00:00Z",
  };
  if (autoMerge !== undefined) state.autoMerge = autoMerge;
  // Matching the PR under test keeps `advancePhase`'s `expectPr` guard from
  // spuriously firing its `pr-mismatch` NOTICE on every pre-existing test
  // here — a real pipeline already has `state.pr` set by Step 5.
  if (pr !== undefined) state.pr = pr;
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

  it("excludes a `- [ ]` line trapped inside an unterminated <details> block", () => {
    // GitHub renders this span as raw HTML (no closing blank line ever
    // arrives) — the checkbox never rendered, so a reviewer can't tick
    // it. It must not count as a genuine unchecked item.
    const body =
      "## Test Steps\n\n- [ ] visible item\n<details>\n- [ ] trapped item\n";
    const r = parseTestStepsSection(body);
    expect(r.kind).toBe("has-unchecked");
    if (r.kind === "has-unchecked") {
      expect(r.uncheckedItems).toEqual(["visible item"]);
    }
  });

  it("returns no-unchecked when the only `- [ ]` item is trapped", () => {
    const body = "## Test Steps\n\n<details>\n- [ ] trapped item\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });

  it("still counts a `- [ ]` item inside a <details> block that IS closed by a blank line", () => {
    const body =
      "## Test Steps\n\n<details>\n- [ ] not trapped\n\n</details>\n";
    const r = parseTestStepsSection(body);
    expect(r.kind).toBe("has-unchecked");
    if (r.kind === "has-unchecked") {
      expect(r.uncheckedItems).toEqual(["not trapped"]);
    }
  });
});

describe("parseTestStepsSection — fenced content", () => {
  const unchecked = (body: string): string[] => {
    const r = parseTestStepsSection(body);
    return r.kind === "has-unchecked" ? r.uncheckedItems : [];
  };

  it("counts an unchecked item after an evidence block with a fenced unclosed '<!--'", () => {
    const body = [
      "## Test Steps",
      "",
      "- [x] Run `npm test`",
      "<!-- flow:evidence -->",
      "<details><summary>evidence</summary>",
      "",
      "```",
      "output <!-- never closed",
      "```",
      "",
      "</details>",
      "",
      "- [ ] SUBJECTIVE: looks right",
      "",
    ].join("\n");
    expect(unchecked(body)).toEqual(["SUBJECTIVE: looks right"]);
  });

  it("does not count a fenced '- [ ] fake' item", () => {
    const body = "## Test Steps\n\n```\n- [ ] fake\n```\n\n- [x] real\n";
    expect(parseTestStepsSection(body)).toEqual({ kind: "no-unchecked" });
  });

  it("still counts items after an unclosed fence opener", () => {
    const body = "## Test Steps\n\n```\n- [ ] after opener\n";
    expect(unchecked(body)).toEqual(["after opener"]);
  });

  it("does not end the section at a fenced '## Other' line", () => {
    const body = "## Test Steps\n\n```\n## Other\n```\n\n- [ ] still inside\n";
    expect(unchecked(body)).toEqual(["still inside"]);
  });

  it("does not take a fenced '## Test Steps' earlier in the body as the heading", () => {
    const body =
      "## Why\n\n```\n## Test Steps\n- [ ] fake\n```\n\n## Test Steps\n\n- [ ] real\n";
    expect(unchecked(body)).toEqual(["real"]);
  });
});

describe(findTrappedTestSteps, () => {
  it("names the trapped items excluded from parseTestStepsSection", () => {
    const body =
      "## Test Steps\n\n- [ ] visible item\n<details>\n- [ ] trapped item\n";
    expect(findTrappedTestSteps(body)).toEqual(["trapped item"]);
  });

  it("returns [] when the heading is missing or nothing is trapped", () => {
    expect(findTrappedTestSteps("## Why\nbecause\n")).toEqual([]);
    expect(findTrappedTestSteps("## Test Steps\n\n- [ ] plain item\n")).toEqual(
      [],
    );
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

  it("gates rather than auto-merges when every surviving item is trapped (fail-closed)", () => {
    // Was "auto-merge" pre-fix: the trapped-checkbox exclusion ran before
    // the emptiness test, so a body where EVERY item is trapped read as
    // "no-unchecked" and un-gated. A trapped item is unreadable, not
    // verified — this must never resolve to auto-merge.
    const r = decide({
      body: "## Test Steps\n\n<details>\n- [ ] trapped item\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("gated");
    expect(r.reason).toContain("trapped item");
    expect(r.reason).toMatch(/excluded 1 item/);
  });

  it("names a trapped item's exclusion in the reason alongside a visible unchecked item (gated)", () => {
    const r = decide({
      body: "## Test Steps\n\n- [ ] visible item\n<details>\n- [ ] trapped item\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.decision).toBe("gated");
    expect(r.validationItems).toEqual(["visible item"]);
    expect(r.reason).toContain("visible item");
    expect(r.reason).toContain("trapped item");
  });

  it("leaves the reason unchanged (no trapped suffix) for a well-formed body", () => {
    const r = decide({
      body: "## Test Steps\n\n- [ ] step one\n",
      state: "OPEN",
      url: "https://x/y/pull/1",
      autoMerge: true,
    });
    expect(r.reason).toBe("step one");
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
    // relies on this form: the slug auto-resolves from $FLOW_SLUG.
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

// --- browser-retry ---------------------------------------------------------

describe("decide() — browser-retry", () => {
  const WT = "/wt";
  const HEAD = "abc123";
  const DRIVER = "/wt/.flow-tmp/ui-driver-result.json";
  const PREFLIGHT = "/wt/.flow-tmp/ui-preflight.json";
  const ticked = (n: number) =>
    Array.from({ length: n }, (_, i) => `- [x] Run \`cmd ${i + 1}\` — ok`);
  const body = (...lines: string[]) => `## Test Steps\n\n${lines.join("\n")}\n`;
  const BROWSER = [
    '- [ ] Browser: on /a, click A — expect "A"',
    '- [ ] Browser: on /b, click B — expect "B"',
    '- [ ] Browser: on /c, click C — expect "C"',
  ];
  const files = (map: Record<string, unknown>) => ({
    readFile: (p: string): string | null =>
      p in map
        ? typeof map[p] === "string"
          ? (map[p] as string)
          : JSON.stringify(map[p])
        : null,
  });
  const MARKER = "/wt/.flow-tmp/browser-auto-redrive";
  const gate = (
    b: string,
    map: Record<string, unknown> = {},
    over: Record<string, unknown> = {},
  ) =>
    decide(
      {
        body: b,
        state: "OPEN",
        url: "https://x/y/pull/950",
        autoMerge: true,
        worktree: WT,
        headSha: HEAD,
        ...over,
      },
      files(map),
    );
  const driver = (item_results: unknown[]) => ({
    [DRIVER]: {
      headSha: HEAD,
      caller: "review-8c",
      ran: true,
      ok: false,
      item_results,
    },
  });
  const verdict = (index: number, v: string) => ({
    index,
    item: "x",
    kind: "behavior",
    verdict: v,
    screenshots: [],
  });

  it("PR #950 replay: 9 ticked command items + 3 open Browser items, no driver file => browser-retry (items 10-12 not-attempted)", () => {
    const r = gate(body(...ticked(9), ...BROWSER));
    expect(r.decision).toBe("browser-retry");
    expect(r.browserItems?.map((b) => [b.index, b.status])).toEqual([
      [10, "not-attempted"],
      [11, "not-attempted"],
      [12, "not-attempted"],
    ]);
    expect(r.validationItems).toHaveLength(3);
    // Without worktree evidence plumbing the same body is today's gated.
    expect(
      gate(body(...ticked(9), ...BROWSER), {}, { worktree: undefined })
        .decision,
    ).toBe("gated");
  });

  it("stays gated when a driver verdict is fail", () => {
    const r = gate(
      body(...ticked(9), ...BROWSER),
      driver([verdict(11, "fail")]),
    );
    expect(r.decision).toBe("gated");
  });

  it("stays gated when a driver verdict is not-drivable", () => {
    const r = gate(
      body(...ticked(9), ...BROWSER),
      driver([verdict(12, "not-drivable")]),
    );
    expect(r.decision).toBe("gated");
  });

  it("counts a passed-but-unticked item as re-drivable", () => {
    const r = gate(
      body(...ticked(1), BROWSER[0]),
      driver([verdict(2, "pass")]),
    );
    expect(r.decision).toBe("browser-retry");
    expect(r.browserItems?.[0].status).toBe("passed-unticked");
  });

  it("returns browser-retry with SUBJECTIVE items still listed in validationItems", () => {
    const r = gate(
      body(...ticked(2), "- [ ] SUBJECTIVE: it feels calm", ...BROWSER),
      { [PREFLIGHT]: { headSha: HEAD, ready: false } },
    );
    expect(r.decision).toBe("browser-retry");
    expect(r.validationItems).toContain("SUBJECTIVE: it feels calm");
    expect(r.browserItems?.every((b) => b.status === "env-blocked")).toBe(true);
  });

  it("stays gated when an open command or prose item sits next to a Browser item", () => {
    expect(
      gate(body("- [ ] Run `npm test` — passes", BROWSER[0])).decision,
    ).toBe("gated");
    expect(
      gate(body("- [ ] Check the thing by eye", BROWSER[0])).decision,
    ).toBe("gated");
  });

  it("stays gated when only SUBJECTIVE/DECISION items are open (nothing to re-drive)", () => {
    expect(
      gate(
        body(
          ...ticked(2),
          "- [ ] SUBJECTIVE: it feels calm",
          "- [ ] DECISION: accept X",
        ),
      ).decision,
    ).toBe("gated");
    expect(
      gate(body("- [x] " + BROWSER[0].slice(6), "- [ ] SUBJECTIVE: ok"))
        .decision,
    ).toBe("gated");
  });

  it("stays gated when an item is trapped in an unterminated <details>", () => {
    expect(
      gate(body(BROWSER[0], "<details>", "- [ ] Run `x` — ok")).decision,
    ).toBe("gated");
  });

  it("reports autoRedriven false until the marker carries the current head", () => {
    const b = body(...ticked(1), BROWSER[0]);
    expect(gate(b).autoRedriven).toBe(false);
    expect(gate(b, { [MARKER]: "old999\n" }).autoRedriven).toBe(false);
    expect(
      gate(b, {
        [MARKER]: `${HEAD}\n`,
        [PREFLIGHT]: { headSha: HEAD, ready: false },
      }).autoRedriven,
    ).toBe(true);
  });

  it("after the automatic re-drive, pauses only while an item is env-blocked", () => {
    const b = body(...ticked(1), BROWSER[0]);
    const redriven = { [MARKER]: HEAD };
    const blocked = gate(b, {
      ...redriven,
      [PREFLIGHT]: { headSha: HEAD, ready: false },
    });
    expect(blocked.decision).toBe("browser-retry");
    expect(blocked.autoRedriven).toBe(true);
    // The driver ran but returned nothing for the item: retrying cannot help.
    expect(gate(b, { ...redriven, ...driver([]) }).decision).toBe("gated");
    expect(
      gate(b, { ...redriven, ...driver([verdict(2, "pass")]) }).decision,
    ).toBe("gated");
  });

  it("a fix commit re-arms the automatic re-drive (marker names an older head)", () => {
    const r = gate(body(...ticked(1), BROWSER[0]), { [MARKER]: "old999" });
    expect(r.decision).toBe("browser-retry");
    expect(r.autoRedriven).toBe(false);
  });

  it("still returns browser-retry with autoMerge false (it re-runs, then gates)", () => {
    expect(gate(body(BROWSER[0]), {}, { autoMerge: false }).decision).toBe(
      "browser-retry",
    );
  });

  it("falls back to gated without a head sha, ignores stale evidence, and never fires for non-OPEN PRs", () => {
    expect(gate(body(BROWSER[0]), {}, { headSha: null }).decision).toBe(
      "gated",
    );
    const stale = gate(body(BROWSER[0]), {
      [DRIVER]: {
        headSha: "old",
        caller: "review-8c",
        ran: true,
        item_results: [verdict(1, "fail")],
      },
    });
    expect(stale.decision).toBe("browser-retry");
    expect(gate(body(BROWSER[0]), {}, { state: "MERGED" }).decision).toBe(
      "merged-externally",
    );
  });

  it("run() feeds state.worktree and the local head into the gate", () => {
    seedState("browser", true, 950);
    const sp = path.join(stateDir, "browser.json");
    const st = JSON.parse(fs.readFileSync(sp, "utf8"));
    fs.writeFileSync(sp, JSON.stringify({ ...st, worktree: WT }) + "\n");
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        body: body(...ticked(1), BROWSER[0]),
        state: "OPEN",
        url: "https://x/y/pull/950",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const localHead = vi.fn(() => HEAD);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      writes.push(c.toString());
      return true;
    });
    const exit = run(["950", "--slug", "browser"], {
      gh,
      stateDir,
      localHead,
      readFile: () => null,
    });
    spy.mockRestore();
    expect(exit).toBe(0);
    expect(localHead).toHaveBeenCalledWith(WT);
    expect((JSON.parse(writes.join("")) as DecisionResult).decision).toBe(
      "browser-retry",
    );
  });
});

// --- run() integration -----------------------------------------------------

describe("run() integration", () => {
  it("emits a decision JSON on success", () => {
    seedState("alpha", true, 100);
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
    seedState("beta", false, 1);
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
    seedState("gamma", true, 999);
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

  it("auto-resolves --slug from $FLOW_SLUG when omitted", () => {
    seedState("delta", false, 2);
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
    seedState("epsilon", true, 3);
    seedState("other-pipeline", false, 3);
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
    expect(errSpy.mock.calls.flat().join("\n")).toContain("FLOW_SLUG");
    errSpy.mockRestore();
  });
});

describe("run() — phase advance", () => {
  function readWritten(slug: string): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(stateDir, `${slug}.json`), "utf8"),
    );
  }

  function seedReviewing(slug: string, pr: number): void {
    fs.writeFileSync(
      path.join(stateDir, `${slug}.json`),
      JSON.stringify({
        slug,
        phase: "reviewing",
        repo: "/tmp/repo",
        pr,
        updatedAt: "2026-04-30T12:00:00Z",
      }) + "\n",
    );
  }

  const gh = vi.fn(() => ({
    stdout: JSON.stringify({
      body: "## Test Steps\n\n<!-- empty -->\n",
      state: "OPEN",
      url: "https://x/y/pull/10",
    }),
    stderr: "",
    exitCode: 0,
  }));

  it("advances once on a forward call", () => {
    seedReviewing("zeta", 10);
    const exit = run(["10", "--slug", "zeta"], { gh, stateDir });
    expect(exit).toBe(0);
    const written = readWritten("zeta");
    expect(written.phase).toBe("gating");
    expect((written.phaseLog as unknown[]) ?? []).toHaveLength(1);
  });

  it("no-ops on repeat (already at gating)", () => {
    seedState("eta-gate", true, 10);
    const exit = run(["10", "--slug", "eta-gate"], { gh, stateDir });
    expect(exit).toBe(0);
    const written = readWritten("eta-gate");
    expect(written.phase).toBe("gating");
    expect((written.phaseLog as unknown[]) ?? []).toHaveLength(0);
  });

  it("is a no-op with a stderr NOTICE when state.pr does not match the PR under review (FLOW_SLUG leak)", () => {
    seedReviewing("theta", 999);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["10", "--slug", "theta"], { gh, stateDir });
    expect(exit).toBe(0);
    const written = readWritten("theta");
    expect(written.phase).toBe("reviewing");
    // Assert on `.mock.calls` BEFORE `mockRestore()` — restore also clears
    // recorded call history (it does everything `mockReset()` does).
    expect(errSpy.mock.calls.flat().join("\n")).toContain(
      "NOTICE — phase-advance",
    );
    errSpy.mockRestore();
  });
});
