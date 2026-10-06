import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run, type Deps } from "./flow-agy-lenses";
import type { FanoutResult, ManifestEntry } from "./flow-delegate-fanout";

const SKILL_DIR = path.join(
  import.meta.dirname,
  "../skills/pipeline/flow-pr-review",
);
const VARIANT = "Claude Opus 5.5 (High)";
const FINDING = {
  file: "src/a.ts",
  line: 3,
  label: "issue",
  decoration: "blocking",
  confidence: 90,
  subject: "s",
  body: "b",
};
const GOOD = JSON.stringify({
  response: JSON.stringify({
    findings: [FINDING],
    rejected_alternatives: [],
    anti_patterns_found: [],
  }),
});

let worktree: string;
let lines: string[];
let fanoutCalls: ManifestEntry[][];
let prompts: Record<string, string>;
let armed: string[][];
let armedReset: Array<number | null>;
let reads: string[];

const cfg =
  (over: Record<string, unknown> = {}) =>
  () => ({
    delegate: {
      models: { claudeLenses: VARIANT },
      lenses: ["pattern-consistency", "bug-detection"],
      ...over,
    },
  });

type EntryBehaviour = (
  lens: string,
  entry: ManifestEntry,
) => Partial<FanoutResult["entries"][number]> & { raw?: string };

const fanoutWith =
  (behave: EntryBehaviour): Deps["runFanout"] =>
  async (manifest) => {
    fanoutCalls.push(manifest);
    return {
      entries: manifest.map((entry) => {
        const lens = entry.task.replace("agy-lens-", "");
        prompts[lens] = fs.readFileSync(entry.promptFile!, "utf8");
        const b = behave(lens, entry);
        if (b.raw !== undefined) fs.writeFileSync(entry.out!, b.raw);
        const { raw: _raw, ...rest } = b;
        return {
          task: entry.task,
          model: entry.model ?? null,
          ran: true,
          artifactPath: entry.out,
          durationMs: 4000,
          ...rest,
        };
      }),
      anyRan: true,
      allSkipped: false,
      calls: {
        attempted: manifest.length,
        ran: manifest.length,
        skipped: 0,
        budget: 9,
      },
    };
  };

const deps = (over: Partial<Deps> = {}): Partial<Deps> => ({
  readConfig: cfg(),
  resolveSlug: () => null,
  loadState: () => null,
  ghPrView: () => ({
    number: 7,
    title: "Add the thing",
    body: "PR body",
    baseRefName: "main",
  }),
  gitShow: () => null,
  readCooldown: () => ({ live: false }),
  armCooldown: (classes, resetMs) => {
    armed.push(classes);
    armedReset.push(resetMs);
  },
  writeOut: (l) => void lines.push(l),
  readFile: (p) => {
    reads.push(p);
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  runFanout: fanoutWith(() => ({ raw: GOOD })),
  ...over,
});

const argv = (lenses: string, extra: string[] = []) => [
  "--worktree",
  worktree,
  "--skill-dir",
  SKILL_DIR,
  "--lenses",
  lenses,
  ...extra,
];

const envelope = () => JSON.parse(lines[lines.length - 1]!);
const tmpFile = (name: string) => path.join(worktree, ".flow-tmp", name);

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lenses-"));
  const t = path.join(worktree, ".flow-tmp");
  fs.mkdirSync(t, { recursive: true });
  const p = (n: string) => path.join(t, n);
  fs.writeFileSync(
    p("diff.txt"),
    "diff --git a/src/a.ts b/src/a.ts\n+const x = 1;\n",
  );
  fs.writeFileSync(p("pr-commits.md"), "abc1234 feat: add the thing\n");
  fs.writeFileSync(p("intent-comments.md"), "(none)\n");
  fs.writeFileSync(
    p("pr-review-fetch.md"),
    "## Inline Comments\nREVIEWER-COMMENT-SENTINEL\n",
  );
  fs.writeFileSync(
    p("static-analysis.json"),
    JSON.stringify({
      types: [],
      security: [],
      lint: [],
      dependencies: [],
      meta: {},
    }),
  );
  fs.writeFileSync(
    p("review-scope.json"),
    JSON.stringify({
      started_at: "2026-10-06T10:00:00Z",
      scope: "full",
      pr_files: ["src/a.ts"],
      product_brief: { found: false },
    }),
  );
  fs.writeFileSync(
    p("review-prep.json"),
    JSON.stringify({
      pr: 7,
      prompt_interpretation_tension: false,
      paths: {
        fetch: p("pr-review-fetch.md"),
        commits: p("pr-commits.md"),
        static_analysis: p("static-analysis.json"),
        review_scope: p("review-scope.json"),
        diff: p("diff.txt"),
        intent_comments: p("intent-comments.md"),
      },
    }),
  );
  lines = [];
  fanoutCalls = [];
  prompts = {};
  armed = [];
  armedReset = [];
  reads = [];
});

afterEach(() => fs.rmSync(worktree, { recursive: true, force: true }));

describe("parseArgs", () => {
  it("rejects intent-guess and unknown lenses as usage errors", () => {
    expect(parseArgs(argv("intent-guess"))).toHaveProperty("error");
    expect(parseArgs(argv("security,nope"))).toHaveProperty("error");
  });

  it("requires --worktree, --skill-dir and --lenses", () => {
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["--worktree", "w"])).toHaveProperty("error");
  });

  it("exits 2 on a usage error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(argv("intent-guess"), deps())).toBe(2);
    err.mockRestore();
  });
});

describe("delegated + fallback cover exactly the agy-routed lenses (Story 1)", () => {
  it("delegates a decodable lens and keeps the others on task", async () => {
    expect(await run(argv("pattern-consistency,security"), deps())).toBe(0);
    const e = envelope();
    expect(e.model).toBe(VARIANT);
    expect(e.routes.map((r: { lens: string }) => r.lens)).toEqual([
      "pattern-consistency",
      "security",
    ]);
    expect(e.delegated.map((d: { lens: string }) => d.lens)).toEqual([
      "pattern-consistency",
    ]);
    expect(e.fallback).toEqual([]);
    expect(e.routes[1]).toEqual({
      lens: "security",
      route: "task",
      reason: "not-in-delegated-set",
    });
    const out = JSON.parse(
      fs.readFileSync(tmpFile("agent-output-pattern-consistency.json"), "utf8"),
    );
    expect(Object.keys(out).sort()).toEqual([
      "anti_patterns_found",
      "findings",
      "rejected_alternatives",
    ]);
    expect(fs.existsSync(tmpFile("agent-output-security.json"))).toBe(false);
  });

  it("falls back on ran:true with an empty body and writes no agent-output file", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        runFanout: fanoutWith((lens) => ({
          raw:
            lens === "bug-detection" ? JSON.stringify({ response: "" }) : GOOD,
        })),
      }),
    );
    const e = envelope();
    expect(e.delegated.map((d: { lens: string }) => d.lens)).toEqual([
      "pattern-consistency",
    ]);
    expect(e.fallback).toEqual([
      {
        lens: "bug-detection",
        reason: "agy-output-unparseable",
        skipClass: "ran-unusable",
      },
    ]);
    expect(fs.existsSync(tmpFile("agent-output-bug-detection.json"))).toBe(
      false,
    );
    expect(armed).toEqual([]);
  });

  it("falls back on a schema-invalid payload", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          raw: JSON.stringify({
            response: JSON.stringify({ findings: [{ file: "x" }] }),
          }),
        })),
      }),
    );
    expect(envelope().fallback[0].reason).toBe("agy-output-unparseable");
    expect(
      fs.existsSync(tmpFile("agent-output-pattern-consistency.json")),
    ).toBe(false);
  });

  it("pre-cleans a stale agent-output for an agy-routed lens", async () => {
    fs.writeFileSync(tmpFile("agent-output-pattern-consistency.json"), "STALE");
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          raw: JSON.stringify({ response: "" }),
        })),
      }),
    );
    expect(
      fs.existsSync(tmpFile("agent-output-pattern-consistency.json")),
    ).toBe(false);
  });

  it("reports a not-ran lens with its skip reason and class", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          ran: false,
          skipReason: "agy-timeout",
        })),
      }),
    );
    expect(envelope().fallback).toEqual([
      {
        lens: "pattern-consistency",
        reason: "agy-timeout",
        skipClass: "ran-unusable",
      },
    ]);
  });

  it("falls back for every agy-routed lens when the review-prep inputs are missing", async () => {
    fs.rmSync(tmpFile("review-prep.json"));
    await run(argv("pattern-consistency,bug-detection"), deps());
    const e = envelope();
    expect(fanoutCalls).toHaveLength(0);
    expect(e.delegated).toEqual([]);
    expect(e.fallback.map((f: { reason: string }) => f.reason)).toEqual([
      "agy-prep-failed",
      "agy-prep-failed",
    ]);
    expect(armed).toEqual([]);
  });

  it("falls back when the fanout itself throws", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(envelope().fallback[0].reason).toBe("agy-fanout-failed");
    expect(armed).toEqual([]);
  });
});

describe("routing without an agy call", () => {
  it("claudeLenses null: every lens is task/delegation-off and no agy call is made", async () => {
    await run(
      argv("pattern-consistency,security"),
      deps({ readConfig: () => ({ delegate: { lenses: ["security"] } }) }),
    );
    const e = envelope();
    expect(fanoutCalls).toHaveLength(0);
    expect(e.model).toBeNull();
    expect(
      e.routes.every(
        (r: { route: string; reason: string }) =>
          r.route === "task" && r.reason === "delegation-off",
      ),
    ).toBe(true);
  });

  it("--plan-only makes no agy call, covers --lenses exactly and writes no record", async () => {
    await run(argv("security,pattern-consistency", ["--plan-only"]), deps());
    expect(fanoutCalls).toHaveLength(0);
    const e = envelope();
    expect(Object.keys(e)).toEqual(["routes"]);
    expect(e.routes.map((r: { lens: string }) => r.lens)).toEqual([
      "security",
      "pattern-consistency",
    ]);
    expect(fs.existsSync(tmpFile("agy-lenses-result.json"))).toBe(false);
  });

  it("a live cooldown routes everything to task/agy-cooldown with no agy call", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({ readCooldown: () => ({ live: true, until: "later" }) }),
    );
    expect(fanoutCalls).toHaveLength(0);
    expect(envelope().routes.map((r: { reason: string }) => r.reason)).toEqual([
      "agy-cooldown",
      "agy-cooldown",
    ]);
  });

  it("a Fable session keeps bug-detection on task", async () => {
    await run(
      argv("pattern-consistency,bug-detection", ["--slug", "s"]),
      deps({ loadState: () => ({ model: "fable" }) as never }),
    );
    const e = envelope();
    expect(
      e.routes.find((r: { lens: string }) => r.lens === "bug-detection"),
    ).toEqual({
      lens: "bug-detection",
      route: "task",
      reason: "fable-session-keeps-task",
    });
    expect(e.delegated.map((d: { lens: string }) => d.lens)).toEqual([
      "pattern-consistency",
    ]);
  });
});

describe("cooldown arming (Story 2b)", () => {
  it("arms when every agy-routed lens fails on a quota class", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        runFanout: fanoutWith(() => ({
          ran: false,
          skipReason: "agy-error",
          stderrTail: "Error: quota reached, upgrade your subscription",
        })),
      }),
    );
    expect(armed).toEqual([["quota-exhausted", "quota-exhausted"]]);
    expect(armedReset).toEqual([null]);
    expect(envelope().cooldownArmed).toBe(true);
  });

  it("holds the cooldown until the reset agy names in its quota error", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        runFanout: fanoutWith(() => ({
          ran: false,
          skipReason: "agy-error",
          agyError:
            "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h44m12s.",
        })),
      }),
    );
    expect(armedReset).toEqual([(4 * 3600 + 44 * 60 + 12) * 1000]);
  });

  it("does not arm when the failure is an environment skip (agy-not-found)", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        runFanout: fanoutWith(() => ({
          ran: false,
          skipReason: "agy-not-found",
        })),
      }),
    );
    expect(armed).toEqual([]);
    expect(envelope().cooldownArmed).toBe(false);
  });

  it("does not arm when only some lenses failed", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        runFanout: fanoutWith((lens) =>
          lens === "bug-detection"
            ? { ran: false, skipReason: "agy-timeout" }
            : { raw: GOOD },
        ),
      }),
    );
    expect(armed).toEqual([]);
  });

  it("arms when every lens returns an unusable body", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          raw: JSON.stringify({ response: "" }),
        })),
      }),
    );
    expect(armed).toEqual([["empty-artifact"]]);
  });
});

describe("prompt inputs", () => {
  it("never reads the fetch.md reviewer-comment dump into a prompt", async () => {
    await run(argv("pattern-consistency"), deps());
    expect(reads.some((r) => r.endsWith("pr-review-fetch.md"))).toBe(false);
    expect(prompts["pattern-consistency"]).not.toContain(
      "REVIEWER-COMMENT-SENTINEL",
    );
    expect(prompts["pattern-consistency"]).toContain("PR #7: Add the thing");
    expect(prompts["pattern-consistency"]).toContain("UNTRUSTED_DIFF_BEGIN");
  });

  it("inlines the base-branch repo checklist from git show origin/<base>", async () => {
    const specs: string[] = [];
    await run(
      argv("pattern-consistency"),
      deps({
        gitShow: (spec) => {
          specs.push(spec);
          return "BASE-BRANCH-CHECKLIST-ENTRY";
        },
      }),
    );
    expect(specs).toEqual(["origin/main:.flow/review-checklist.md"]);
    expect(prompts["pattern-consistency"]).toContain(
      "BASE-BRANCH-CHECKLIST-ENTRY",
    );
  });

  it("runs ONE wave with the per-lens timeout, schema, add-dir and no skip-permissions", async () => {
    await run(argv("pattern-consistency,bug-detection"), deps());
    expect(fanoutCalls).toHaveLength(1);
    const wave = fanoutCalls[0]!;
    expect(wave).toHaveLength(2);
    for (const entry of wave) {
      expect(entry.model).toBe(VARIANT);
      expect(entry.timeout).toBe("8m");
      expect(entry.outputFormat).toBe("json");
      expect(entry.addDirs).toEqual([worktree]);
      expect(entry.jsonSchema).toBeDefined();
      expect(entry.skipPermissions).toBeUndefined();
    }
  });

  it("removes its scratch files", async () => {
    await run(argv("pattern-consistency"), deps());
    expect(
      fs
        .readdirSync(path.join(worktree, ".flow-tmp"))
        .filter(
          (f) => f.startsWith("agy-lens") && f !== "agy-lenses-result.json",
        ),
    ).toEqual([]);
  });
});

describe("result record", () => {
  it("merges a widen re-fan wave into the first wave's record", async () => {
    await run(argv("pattern-consistency"), deps());
    await run(argv("bug-detection"), deps());
    const rec = JSON.parse(
      fs.readFileSync(tmpFile("agy-lenses-result.json"), "utf8"),
    );
    expect(rec.delegated.map((d: { lens: string }) => d.lens).sort()).toEqual([
      "bug-detection",
      "pattern-consistency",
    ]);
    expect(rec.routes).toHaveLength(2);
  });

  it("overwrites the record when the review window differs", async () => {
    await run(argv("pattern-consistency"), deps());
    const scopePath = tmpFile("review-scope.json");
    const scope = JSON.parse(fs.readFileSync(scopePath, "utf8"));
    scope.started_at = "2026-10-06T18:00:00Z";
    fs.writeFileSync(scopePath, JSON.stringify(scope));
    await run(argv("bug-detection"), deps());
    const rec = JSON.parse(
      fs.readFileSync(tmpFile("agy-lenses-result.json"), "utf8"),
    );
    expect(rec.delegated.map((d: { lens: string }) => d.lens)).toEqual([
      "bug-detection",
    ]);
  });
});
