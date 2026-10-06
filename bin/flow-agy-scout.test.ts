import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SCOUT_SECTIONS,
  extractTaskBreakdown,
  parseArgs,
  run,
  validateScoutReport,
  type Deps,
} from "./flow-agy-scout";

const SKILL_DIR = path.join(
  import.meta.dirname,
  "../skills/pipeline/flow-new-feature",
);
const VARIANT = "Claude Opus 5.5 (High)";

const section = (name: string, body = "- item") => `## ${name}\n\n${body}\n`;
const report = (omit: string[] = [], emptyOf: string[] = []) =>
  `# Scout report\n\n${SCOUT_SECTIONS.filter((s) => !omit.includes(s))
    .map((s) => section(s, emptyOf.includes(s) ? "" : `- ${s} content`))
    .join("\n")}\n## summary\n\nPositive: x. Negative: y.\n`;
const envelopeOf = (text: string) => JSON.stringify({ response: text });

let dir: string;
let worktree: string;
let out: string;
let lines: string[];
let delegateArgv: string[][];
let prompts: string[];
let armed: string[][];

const base = (over: Partial<Deps> = {}): Partial<Deps> => ({
  readConfig: () => ({ delegate: { models: { scout: VARIANT } } }),
  readCooldown: () => ({ live: false }),
  armCooldown: (c) => void armed.push(c),
  writeOut: (l) => void lines.push(l),
  runDelegate: (argv) => {
    delegateArgv.push(argv);
    prompts.push(
      fs.readFileSync(argv[argv.indexOf("--prompt-file") + 1]!, "utf8"),
    );
    const rawPath = argv[argv.indexOf("--out") + 1]!;
    fs.writeFileSync(rawPath, envelopeOf(report()));
    return { ran: true, artifactPath: rawPath };
  },
  ...over,
});

const args = (extra: string[] = []) => [
  "--worktree",
  worktree,
  "--skill-dir",
  SKILL_DIR,
  "--description-file",
  path.join(dir, "desc.md"),
  "--out",
  out,
  ...extra,
];
const envelope = () => JSON.parse(lines[lines.length - 1]!);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-scout-"));
  worktree = path.join(dir, "wt");
  fs.mkdirSync(path.join(worktree, ".flow-tmp"), { recursive: true });
  out = path.join(worktree, ".flow-tmp", "scout.md");
  fs.writeFileSync(
    path.join(dir, "desc.md"),
    "Add a frobnicator to the widget.",
  );
  lines = [];
  delegateArgv = [];
  prompts = [];
  armed = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("validateScoutReport", () => {
  it("accepts a complete report and strips the summary into its own field", () => {
    const v = validateScoutReport(report());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.report.startsWith("# Scout report\n")).toBe(true);
      expect(v.report).not.toContain("## summary");
      expect(v.summary).toBe("Positive: x. Negative: y.");
    }
  });

  it("accepts a report wrapped in a markdown fence", () => {
    expect(validateScoutReport("```markdown\n" + report() + "\n```").ok).toBe(
      true,
    );
  });

  it.each(SCOUT_SECTIONS)("rejects a report missing %s", (name) => {
    const v = validateScoutReport(report([name]));
    expect(v).toEqual({ ok: false, missing: [name] });
  });

  it.each(SCOUT_SECTIONS)("rejects a report whose %s body is empty", (name) => {
    expect(validateScoutReport(report([], [name]))).toEqual({
      ok: false,
      missing: [name],
    });
  });

  it("has a null summary when none is given", () => {
    const v = validateScoutReport(report().split("## summary")[0]!);
    expect(v.ok && v.summary).toBeNull();
  });
});

describe("extractTaskBreakdown", () => {
  it("returns the Task breakdown section only, through the next same-level heading", () => {
    const md =
      "# PRD\n\nprose\n\n# Task breakdown\n\n### Task 1\n\ncontract\n\n# PR description draft\n\nnope\n";
    const got = extractTaskBreakdown(md);
    expect(got).toContain("### Task 1");
    expect(got).not.toContain("prose");
    expect(got).not.toContain("nope");
  });

  it("is null when the plan has no such heading", () => {
    expect(extractTaskBreakdown("# PRD\n\nonly prose\n")).toBeNull();
  });
});

describe("parseArgs", () => {
  it("requires the four mandatory flags and defaults --plan to absent", () => {
    expect(parseArgs([])).toHaveProperty("error");
    const ok = parseArgs(args());
    expect(ok).toMatchObject({ plan: "absent" });
  });
});

describe("flow-agy-scout run", () => {
  it("writes scout.md and reports ran:true with the summary when all six sections arrive (Story 4)", () => {
    expect(run(args(), base())).toBe(0);
    expect(envelope()).toEqual({
      ran: true,
      scoutPath: out,
      summary: "Positive: x. Negative: y.",
    });
    const written = fs.readFileSync(out, "utf8");
    for (const s of SCOUT_SECTIONS) expect(written).toContain(`## ${s}`);
    expect(written).not.toContain("## summary");
    expect(fs.existsSync(`${out}.agy-raw`)).toBe(false);
    expect(fs.existsSync(`${out}.prompt`)).toBe(false);
  });

  it("passes the scout model, add-dir, json output and the 8m budget to flow-delegate", () => {
    run(args(), base());
    const argv = delegateArgv[0]!;
    expect(argv[argv.indexOf("--model") + 1]).toBe(VARIANT);
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(worktree);
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("8m");
    expect(argv).toContain("json");
    expect(argv).not.toContain("--skip-permissions");
  });

  it.each(SCOUT_SECTIONS)("writes no scout.md when %s is missing", (name) => {
    run(
      args(),
      base({
        runDelegate: (argv) => {
          const raw = argv[argv.indexOf("--out") + 1]!;
          fs.writeFileSync(raw, envelopeOf(report([name])));
          return { ran: true, artifactPath: raw };
        },
      }),
    );
    expect(envelope()).toMatchObject({
      ran: false,
      skipReason: "scout-report-incomplete",
      missing: [name],
    });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("removes a stale scout.md before running and leaves none on failure", () => {
    fs.writeFileSync(out, "STALE");
    run(
      args(),
      base({ runDelegate: () => ({ ran: false, skipReason: "agy-timeout" }) }),
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it("null slot: scout-delegation-off and no agy call", () => {
    run(args(), base({ readConfig: () => ({}) }));
    expect(envelope()).toMatchObject({
      ran: false,
      skipReason: "scout-delegation-off",
      skipClass: "environment",
    });
    expect(delegateArgv).toHaveLength(0);
  });

  it("live cooldown: agy-cooldown and no agy call", () => {
    run(args(), base({ readCooldown: () => ({ live: true }) }));
    expect(envelope()).toMatchObject({
      ran: false,
      skipReason: "agy-cooldown",
    });
    expect(delegateArgv).toHaveLength(0);
  });

  it("names an empty body and a denied shell attempt distinctly", () => {
    run(
      args(),
      base({
        runDelegate: (argv) => {
          const raw = argv[argv.indexOf("--out") + 1]!;
          fs.writeFileSync(raw, envelopeOf(""));
          return { ran: true, artifactPath: raw };
        },
      }),
    );
    expect(envelope().skipReason).toBe("scout-output-empty");
    run(
      args(),
      base({
        runDelegate: (argv) => {
          const raw = argv[argv.indexOf("--out") + 1]!;
          fs.writeFileSync(raw, envelopeOf(""));
          return {
            ran: true,
            artifactPath: raw,
            deniedActions: ["RunCommand"],
          };
        },
      }),
    );
    expect(envelope().skipReason).toBe("scout-tools-denied");
    expect(armed).toEqual([]);
  });

  it("arms the cooldown on an explicit quota failure but not on a timeout", () => {
    run(
      args(),
      base({
        runDelegate: () => ({
          ran: false,
          skipReason: "agy-error",
          stderrTail: "quota exceeded",
        }),
      }),
    );
    expect(armed).toEqual([["quota-exhausted"]]);
    armed = [];
    run(
      args(),
      base({ runDelegate: () => ({ ran: false, skipReason: "agy-timeout" }) }),
    );
    expect(armed).toEqual([]);
  });

  it("does not arm on an environment skip such as agy-not-found", () => {
    run(
      args(),
      base({
        runDelegate: () => ({ ran: false, skipReason: "agy-not-found" }),
      }),
    );
    expect(armed).toEqual([]);
    expect(envelope()).toMatchObject({
      skipReason: "agy-not-found",
      skipClass: "environment",
    });
  });
});

describe("scout prompt", () => {
  it("is built from flow-scout-instructions and forbids shell and .flow-tmp reads", () => {
    run(args(), base());
    const p = prompts[0]!;
    expect(p).toContain("# Scout instructions");
    expect(p).toContain("Add a frobnicator to the widget.");
    expect(p).toContain("Do NOT run shell commands of any kind");
    expect(p).toContain("Never read anything under `.flow-tmp/`");
    expect(p).toContain(
      "Read AT MOST 40 files — this is the primary run, not a sample",
    );
    expect(p).not.toContain("Bash is in the allowlist");
    expect(p).not.toContain("flow-instructions-sentinel");
    expect(p.startsWith("---")).toBe(false);
    expect(p.startsWith("# Headless run rules")).toBe(true);
  });

  it("inlines only the plan's Task breakdown, never its PRD prose", () => {
    const plan = path.join(dir, "plan.md");
    fs.writeFileSync(
      plan,
      "# PRD\n\nPRD-PROSE-MARKER\n\n# Task breakdown\n\n### Task 1\n\nCONTRACT-MARKER\n",
    );
    run(args(["--plan", plan]), base());
    expect(prompts[0]).toContain("CONTRACT-MARKER");
    expect(prompts[0]).not.toContain("PRD-PROSE-MARKER");
  });

  it("inlines excluded paths when given", () => {
    const ex = path.join(dir, "excluded.json");
    fs.writeFileSync(ex, '{"excluded":[{"id":"EXCLUDED-MARKER"}]}');
    run(args(["--excluded-paths", ex]), base());
    expect(prompts[0]).toContain("EXCLUDED-MARKER");
    expect(prompts[0]).toContain("CLOSED");
  });

  it("inlines the saved memory index when the dir exists and omits it otherwise", () => {
    const mem = path.join(dir, "mem");
    fs.mkdirSync(mem);
    fs.writeFileSync(path.join(mem, "MEMORY.md"), "- MEMORY-MARKER note");
    run(args(["--memory-dir", mem]), base());
    expect(prompts[0]).toContain("MEMORY-MARKER");
    expect(prompts[0]).toContain("read-only");
    run(args(["--memory-dir", path.join(dir, "absent")]), base());
    expect(prompts[1]).not.toContain("Saved scout notes");
  });
});
