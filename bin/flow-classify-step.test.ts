import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  render,
  run,
  SLUG_TO_HUMAN,
  type RenderInputs,
} from "./flow-classify-step";

const CANONICAL =
  "Automation-precedence audit: ran 3/5 items (1 prose-promoted, 2 left manual: subjective UX, production-only)";

function inputs(overrides: Partial<RenderInputs> = {}): RenderInputs {
  return {
    ran: 3,
    total: 5,
    prosePromoted: 1,
    reasons: ["subjective-UX", "production-only"],
    ...overrides,
  };
}

describe(render, () => {
  it("renders the canonical general case", () => {
    expect(render(inputs())).toBe(CANONICAL);
  });

  it("omits the colon+reason list when Y=0 (ran === total)", () => {
    const line = render({ ran: 5, total: 5, prosePromoted: 0, reasons: [] });
    expect(line).toBe(
      "Automation-precedence audit: ran 5/5 items (0 prose-promoted, 0 left manual)",
    );
    expect(line).not.toContain("left manual:");
  });

  it("renders the M=0 branch with a fixed parenthetical", () => {
    expect(render({ ran: 0, total: 0, prosePromoted: 0, reasons: [] })).toBe(
      "Automation-precedence audit: ran 0/0 items (no Test Steps to verify)",
    );
  });

  it("renders a single reason", () => {
    expect(
      render({
        ran: 1,
        total: 2,
        prosePromoted: 0,
        reasons: ["cross-browser"],
      }),
    ).toBe(
      "Automation-precedence audit: ran 1/2 items (0 prose-promoted, 1 left manual: cross-browser)",
    );
  });

  it("preserves reason insertion order across multiple reasons", () => {
    expect(
      render({
        ran: 2,
        total: 5,
        prosePromoted: 1,
        reasons: [
          "cost-prohibitive-infra",
          "subjective-UX",
          "performance-under-realistic-load",
        ],
      }),
    ).toBe(
      "Automation-precedence audit: ran 2/5 items (1 prose-promoted, 3 left manual: cost-prohibitive infra, subjective UX, performance under realistic load)",
    );
  });

  it("renders 'unspecified' when Y>0 but reasons is empty (non-fatal classification gap)", () => {
    expect(render({ ran: 3, total: 5, prosePromoted: 1, reasons: [] })).toBe(
      "Automation-precedence audit: ran 3/5 items (1 prose-promoted, 2 left manual: unspecified)",
    );
  });

  it("M=0 branch wins over reasons (reasons ignored when total is 0)", () => {
    expect(
      render({
        ran: 0,
        total: 0,
        prosePromoted: 0,
        reasons: ["subjective-UX"],
      }),
    ).toBe(
      "Automation-precedence audit: ran 0/0 items (no Test Steps to verify)",
    );
  });
});

describe("SLUG_TO_HUMAN", () => {
  it.each([
    ["subjective-UX", "subjective UX"],
    ["production-only", "production-only"],
    ["cross-browser", "cross-browser"],
    ["performance-under-realistic-load", "performance under realistic load"],
    ["cost-prohibitive-infra", "cost-prohibitive infra"],
  ])("maps %s → %s", (slug, human) => {
    expect(SLUG_TO_HUMAN[slug]).toBe(human);
  });
});

describe(parseArgs, () => {
  it("returns missing required flag: --ran when --ran is omitted", () => {
    const r = parseArgs(["--total", "5", "--prose-promoted", "1"]);
    expect("error" in r && r.error).toContain("missing required flag: --ran");
  });

  it("returns missing required flag: --total when --total is omitted", () => {
    const r = parseArgs(["--ran", "3", "--prose-promoted", "1"]);
    expect("error" in r && r.error).toContain("missing required flag: --total");
  });

  it("returns missing required flag: --prose-promoted when omitted", () => {
    const r = parseArgs(["--ran", "3", "--total", "5"]);
    expect("error" in r && r.error).toContain(
      "missing required flag: --prose-promoted",
    );
  });

  it("rejects non-integer counts", () => {
    const r = parseArgs([
      "--ran",
      "abc",
      "--total",
      "5",
      "--prose-promoted",
      "1",
    ]);
    expect("error" in r && r.error).toContain("must be a non-negative integer");
  });

  it("rejects negative counts", () => {
    const r = parseArgs([
      "--ran",
      "-1",
      "--total",
      "5",
      "--prose-promoted",
      "1",
    ]);
    expect("error" in r && r.error).toContain("must be a non-negative integer");
  });

  it("rejects --ran > --total", () => {
    const r = parseArgs([
      "--ran",
      "6",
      "--total",
      "5",
      "--prose-promoted",
      "0",
    ]);
    expect("error" in r && r.error).toContain(
      "--ran (6) cannot exceed --total (5)",
    );
  });

  it("rejects --prose-promoted > --ran", () => {
    const r = parseArgs([
      "--ran",
      "3",
      "--total",
      "5",
      "--prose-promoted",
      "4",
    ]);
    expect("error" in r && r.error).toContain(
      "--prose-promoted (4) cannot exceed --ran (3)",
    );
  });

  it("rejects --reason without a value", () => {
    const r = parseArgs([
      "--ran",
      "3",
      "--total",
      "5",
      "--prose-promoted",
      "1",
      "--reason",
    ]);
    expect("error" in r && r.error).toBe("--reason requires a value");
  });

  it("rejects --reason when followed by another flag (next-arg-is-flag)", () => {
    const r = parseArgs([
      "--ran",
      "3",
      "--total",
      "5",
      "--prose-promoted",
      "1",
      "--reason",
      "--total",
    ]);
    expect("error" in r && r.error).toBe("--reason requires a value");
  });

  it("rejects --ran when given as a trailing flag with no value", () => {
    const r = parseArgs(["--ran"]);
    expect("error" in r && r.error).toBe("--ran requires a value");
  });

  it("rejects an unknown --reason slug, listing allowed slugs", () => {
    const r = parseArgs([
      "--ran",
      "3",
      "--total",
      "5",
      "--prose-promoted",
      "1",
      "--reason",
      "bogus",
    ]);
    expect("error" in r && r.error).toContain("unknown --reason 'bogus'");
    expect("error" in r && r.error).toContain("allowed:");
  });

  it("rejects unknown flags", () => {
    const r = parseArgs([
      "--bogus",
      "--ran",
      "3",
      "--total",
      "5",
      "--prose-promoted",
      "1",
    ]);
    expect("error" in r && r.error).toBe("unknown flag: --bogus");
  });

  it("parses a valid invocation with one reason", () => {
    expect(
      parseArgs([
        "--ran",
        "3",
        "--total",
        "5",
        "--prose-promoted",
        "1",
        "--reason",
        "subjective-UX",
      ]),
    ).toEqual({
      ran: 3,
      total: 5,
      prosePromoted: 1,
      reasons: ["subjective-UX"],
    });
  });

  it("accepts --reason flags before the count flags (order-independent)", () => {
    expect(
      parseArgs([
        "--reason",
        "subjective-UX",
        "--ran",
        "3",
        "--total",
        "5",
        "--prose-promoted",
        "1",
      ]),
    ).toEqual({
      ran: 3,
      total: 5,
      prosePromoted: 1,
      reasons: ["subjective-UX"],
    });
  });
});

describe(run, () => {
  it("writes the rendered line to stdout and returns 0 on success", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const code = run([
      "--ran",
      "3",
      "--total",
      "5",
      "--prose-promoted",
      "1",
      "--reason",
      "subjective-UX",
      "--reason",
      "production-only",
    ]);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(writes.join("")).toBe(CANONICAL + "\n");
  });

  it("writes the parse error + usage line to stderr and returns 2", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const code = run(["--bogus"]);
    spy.mockRestore();
    expect(code).toBe(2);
    const stderr = writes.join("");
    expect(stderr).toContain("unknown flag: --bogus");
    expect(stderr).toContain(
      "usage: flow-classify-step --ran <n> --total <m> --prose-promoted <x> [--reason <slug>]...",
    );
  });
});

describe("subprocess smoke", () => {
  it("renders the canonical line end-to-end via bun + the shebang entry gate", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..");
    const r = spawnSync(
      "bun",
      [
        "bin/flow-classify-step.ts",
        "--ran",
        "3",
        "--total",
        "5",
        "--prose-promoted",
        "1",
        "--reason",
        "subjective-UX",
        "--reason",
        "production-only",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(CANONICAL);
  });
});
