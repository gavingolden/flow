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
// Keyed `<rung>:<lens>` ("primary" | "reroute"), captured at fan-out time.
let schemas: Record<string, string>;
let rerouteSawEvidence: Record<string, boolean>;
let armed: string[][];
let armedReset: Array<number | null>;
let reads: string[];
let cacheDir: string;

const REFUSAL =
  "Your previous response was blocked by content safety filters\nPlease provide a response that complies with content policies, or briefly explain to the user why you cannot help with this request\nRetries remaining: 3";

const cfg =
  (over: Record<string, unknown> = {}) =>
  () => ({
    delegate: {
      models: { claudeLenses: VARIANT },
      lenses: ["pattern-consistency", "bug-detection"],
      ...over,
    },
  });

type Rung = "primary" | "reroute";

type EntryBehaviour = (
  lens: string,
  entry: ManifestEntry,
  rung: Rung,
) => Partial<FanoutResult["entries"][number]> & { raw?: string };

const fanoutWith =
  (behave: EntryBehaviour): Deps["runFanout"] =>
  async (manifest) => {
    fanoutCalls.push(manifest);
    return {
      entries: manifest.map((entry) => {
        const rung: Rung = entry.task.startsWith("agy-reroute-")
          ? "reroute"
          : "primary";
        const lens = entry.task.replace(/^agy-(lens|reroute)-/, "");
        const prompt = fs.readFileSync(entry.promptFile!, "utf8");
        schemas[`${rung}:${lens}`] = fs.readFileSync(entry.jsonSchema!, "utf8");
        if (rung === "primary") prompts[lens] = prompt;
        else {
          prompts[`reroute:${lens}`] = prompt;
          rerouteSawEvidence[lens] =
            fs.existsSync(cacheDir) &&
            fs.readdirSync(cacheDir).some((n) => n.endsWith(`-${lens}.prompt`));
        }
        const b = behave(lens, entry, rung);
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
  refusalCacheDir: cacheDir,
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
  schemas = {};
  rerouteSawEvidence = {};
  armed = [];
  armedReset = [];
  reads = [];
  cacheDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "agy-refusals-")),
    "agy-refusals",
  );
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
  fs.rmSync(path.dirname(cacheDir), { recursive: true, force: true });
});

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

describe("delegated + fallback cover exactly the requested lenses (Story 1)", () => {
  it("delegates a decodable lens and reports a requested non-agy lens as a fallback with its route reason", async () => {
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
    expect(e.fallback).toEqual([
      {
        lens: "security",
        reason: "not-in-delegated-set",
        skipClass: "environment",
      },
    ]);
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

  it("--plan-only makes no agy call, covers --lenses exactly and records only the routes", async () => {
    await run(argv("security,pattern-consistency", ["--plan-only"]), deps());
    expect(fanoutCalls).toHaveLength(0);
    const e = envelope();
    expect(Object.keys(e)).toEqual(["routes"]);
    expect(e.routes.map((r: { lens: string }) => r.lens)).toEqual([
      "security",
      "pattern-consistency",
    ]);
    const rec = JSON.parse(
      fs.readFileSync(tmpFile("agy-lenses-result.json"), "utf8"),
    );
    expect(rec.routes.map((r: { lens: string }) => r.lens)).toEqual([
      "security",
      "pattern-consistency",
    ]);
    expect(rec.delegated).toEqual([]);
    expect(rec.fallback).toEqual([]);
  });

  it("--plan-only records a live cooldown even though no lens routes to agy", async () => {
    await run(
      argv("pattern-consistency", ["--plan-only"]),
      deps({ readCooldown: () => ({ live: true, until: "later" }) }),
    );
    const rec = JSON.parse(
      fs.readFileSync(tmpFile("agy-lenses-result.json"), "utf8"),
    );
    expect(rec.routes).toEqual([
      { lens: "pattern-consistency", route: "task", reason: "agy-cooldown" },
    ]);
  });

  it("a lens planned for agy that the full run re-routes to task is a fallback, never dropped", async () => {
    await run(argv("pattern-consistency", ["--plan-only"]), deps());
    expect(envelope().routes[0].route).toBe("agy");
    // another pipeline armed the cooldown between the plan and the full run
    await run(
      argv("pattern-consistency"),
      deps({ readCooldown: () => ({ live: true, until: "later" }) }),
    );
    const e = envelope();
    expect(fanoutCalls).toHaveLength(0);
    expect(e.delegated).toEqual([]);
    expect(e.fallback).toEqual([
      {
        lens: "pattern-consistency",
        reason: "agy-cooldown",
        skipClass: "environment",
      },
    ]);
    const rec = JSON.parse(
      fs.readFileSync(tmpFile("agy-lenses-result.json"), "utf8"),
    );
    expect(rec.routes).toHaveLength(1);
    expect(rec.fallback).toHaveLength(1);
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
    expect(
      envelope().fallback.map((f: { reason: string }) => f.reason),
    ).toEqual(["agy-quota-exhausted", "agy-quota-exhausted"]);
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
          failureClass: "unknown",
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

  it("reports agy-tools-denied for a shell denial; a wave of them arms the cooldown like any unusable body", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          raw: JSON.stringify({ response: "" }),
          deniedActions: ["RunCommand"],
        })),
      }),
    );
    expect(envelope().fallback).toEqual([
      {
        lens: "pattern-consistency",
        reason: "agy-tools-denied",
        skipClass: "ran-unusable",
      },
    ]);
    expect(armed).toEqual([["empty-artifact"]]);
  });

  it("reports agy-token-exhausted when thinking consumed the output budget", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          raw: JSON.stringify({ response: "" }),
          usage: { thinking_tokens: 950, output_tokens: 1000 },
        })),
      }),
    );
    expect(envelope().fallback[0]).toMatchObject({
      reason: "agy-token-exhausted",
      skipClass: "ran-unusable",
    });
  });

  it("a lens whose finalize write fails is ran-unusable (agy already spent quota)", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        writeFile: (p, c) => {
          if (p.endsWith("agent-output-pattern-consistency.json")) {
            throw new Error("disk full");
          }
          fs.writeFileSync(p, c);
        },
      }),
    );
    expect(envelope().fallback).toEqual([
      {
        lens: "pattern-consistency",
        reason: "agy-finalize-failed",
        skipClass: "ran-unusable",
      },
    ]);
  });
});

const REFUSED = {
  ran: false,
  skipReason: "agy-error",
  failureClass: "content-filtered",
  agyError: REFUSAL,
} as const;

describe("content-filter refusals", () => {
  const refused = REFUSED;

  it("trusts the delegate's failureClass when the entry carries no matching text", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        runFanout: fanoutWith(() => ({
          ran: false,
          skipReason: "agy-error",
          failureClass: "content-filtered",
        })),
      }),
    );
    expect(
      envelope().fallback.map((f: { reason: string }) => f.reason),
    ).toEqual(["agy-content-filtered", "agy-content-filtered"]);
    expect(armed).toEqual([]);
  });

  it("reports an all-refused wave as agy-content-filtered and never arms the cooldown", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({ runFanout: fanoutWith(() => ({ ...refused })) }),
    );
    expect(armed).toEqual([]);
    expect(envelope().cooldownArmed).toBe(false);
    expect(envelope().fallback).toEqual([
      {
        lens: "pattern-consistency",
        reason: "agy-content-filtered",
        skipClass: "ran-unusable",
        rerouteOutcome: "agy-content-filtered",
      },
      {
        lens: "bug-detection",
        reason: "agy-content-filtered",
        skipClass: "ran-unusable",
        rerouteOutcome: "agy-content-filtered",
      },
    ]);
  });

  it("arms when a refusal sits next to a quota-exhausted sibling", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        runFanout: fanoutWith((lens) =>
          lens === "bug-detection"
            ? { ...refused }
            : {
                ran: false,
                skipReason: "agy-error",
                failureClass: "quota-exhausted",
                agyError: "Individual quota reached.",
              },
        ),
      }),
    );
    expect(armed).toEqual([["quota-exhausted", "content-filtered"]]);
  });

  it("does not arm when a refusal sits next to a timeout", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        runFanout: fanoutWith((lens) =>
          lens === "bug-detection"
            ? { ...refused }
            : {
                ran: false,
                skipReason: "agy-timeout",
                failureClass: "timeout",
              },
        ),
      }),
    );
    expect(armed).toEqual([]);
  });

  it("copies the refused lens's prompt and raw output into the refusal cache", async () => {
    await run(
      argv("bug-detection"),
      deps({
        runFanout: fanoutWith(() => ({ ...refused, raw: "partial output" })),
      }),
    );
    const names = fs.readdirSync(cacheDir);
    const prompt = names.find((n) => n.endsWith("-bug-detection.prompt"));
    const raw = names.find((n) => n.endsWith("-bug-detection.raw"));
    expect(prompt).toBeDefined();
    expect(raw).toBeDefined();
    expect(fs.readFileSync(path.join(cacheDir, prompt!), "utf8")).toBe(
      prompts["bug-detection"],
    );
    expect(fs.readFileSync(path.join(cacheDir, raw!), "utf8")).toBe(
      "partial output",
    );
    expect(fs.existsSync(tmpFile("agy-lens-bug-detection.prompt"))).toBe(false);
    expect(fs.statSync(path.join(cacheDir, prompt!)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
  });

  it("keeps nothing in the cache when no lens was refused", async () => {
    await run(argv("bug-detection"), deps());
    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("classifies a refusal from the entry's diagnostics when the delegate stamped no failureClass", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          ran: false,
          skipReason: "agy-error",
          stderrTail: REFUSAL,
        })),
      }),
    );
    expect(envelope().fallback[0]).toMatchObject({
      reason: "agy-content-filtered",
      skipClass: "ran-unusable",
    });
    expect(armed).toEqual([]);
  });

  it("maps an in-reply refusal on a ran:true lens to agy-content-filtered", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          raw: JSON.stringify({ response: REFUSAL }),
        })),
      }),
    );
    expect(envelope().fallback[0]).toMatchObject({
      reason: "agy-content-filtered",
      skipClass: "ran-unusable",
    });
    expect(armed).toEqual([]);
    expect(fs.readdirSync(cacheDir).length).toBeGreaterThan(0);
  });

  it("lets tools-denied win over refusal text on a ran:true lens", async () => {
    await run(
      argv("pattern-consistency"),
      deps({
        runFanout: fanoutWith(() => ({
          raw: JSON.stringify({ response: REFUSAL }),
          deniedActions: ["RunCommand"],
        })),
      }),
    );
    expect(envelope().fallback[0]).toMatchObject({
      reason: "agy-tools-denied",
    });
  });
});

describe("Gemini re-run of a refused lens", () => {
  const GEMINI = "Gemini 4 Argon (Medium)";
  const refusePrimaryOnly: EntryBehaviour = (_l, _e, rung) =>
    rung === "primary" ? { ...REFUSED } : { raw: GOOD };

  it("reports a recovered lens as delegated on Gemini with reroutedFrom, writes its agent-output and keeps it out of fallback", async () => {
    await run(
      argv("bug-detection"),
      deps({ runFanout: fanoutWith(refusePrimaryOnly), now: () => 1000 }),
    );
    const e = envelope();
    expect(e.delegated).toEqual([
      expect.objectContaining({
        lens: "bug-detection",
        model: GEMINI,
        reroutedFrom: "agy-content-filtered",
        findingCount: 1,
      }),
    ]);
    expect(e.fallback).toEqual([]);
    expect(e.cooldownArmed).toBe(false);
    expect(fs.existsSync(tmpFile("agent-output-bug-detection.json"))).toBe(
      true,
    );
    const rerun = fanoutCalls
      .map((c) => c[0]!)
      .find((c) => c.task.startsWith("agy-reroute-"))!;
    expect(rerun.task).toBe("agy-reroute-bug-detection");
    expect(rerun.model).toBe(GEMINI);
    expect(rerun.timeout).toBe("480s");
    expect(rerun.addDirs).toEqual([worktree]);
    expect(rerun.outputFormat).toBe("json");
  });

  it("records the primary model on a lens that needed no re-run", async () => {
    await run(argv("bug-detection"), deps());
    expect(envelope().delegated[0]).toMatchObject({ model: VARIANT });
    expect(envelope().delegated[0].reroutedFrom).toBeUndefined();
  });

  it("keeps the refusal evidence before the re-run starts", async () => {
    await run(
      argv("bug-detection"),
      deps({ runFanout: fanoutWith(refusePrimaryOnly), now: () => 1000 }),
    );
    expect(rerouteSawEvidence["bug-detection"]).toBe(true);
  });

  it("gives the primary a reasoning-free schema and the re-run the full one", async () => {
    await run(
      argv("bug-detection"),
      deps({ runFanout: fanoutWith(refusePrimaryOnly), now: () => 1000 }),
    );
    expect(schemas["primary:bug-detection"]).not.toContain("reasoning");
    expect(schemas["reroute:bug-detection"]).toContain("reasoning");
    expect(prompts["bug-detection"]).not.toContain("scratchpad");
    expect(prompts["reroute:bug-detection"]).toContain("scratchpad");
  });

  it("falls back with the re-run's reason when the Gemini run refuses too", async () => {
    await run(
      argv("bug-detection"),
      deps({ runFanout: fanoutWith(() => ({ ...REFUSED })), now: () => 1000 }),
    );
    expect(envelope().fallback).toEqual([
      {
        lens: "bug-detection",
        reason: "agy-content-filtered",
        skipClass: "ran-unusable",
        rerouteOutcome: "agy-content-filtered",
      },
    ]);
    expect(envelope().delegated).toEqual([]);
  });

  it("skips the re-run when too little of the helper budget is left", async () => {
    let t = 0;
    await run(
      argv("bug-detection"),
      deps({
        runFanout: fanoutWith(refusePrimaryOnly),
        now: () => {
          const v = t;
          t = 600_000;
          return v;
        },
      }),
    );
    expect(fanoutCalls).toHaveLength(1);
    expect(envelope().fallback).toEqual([
      expect.objectContaining({
        lens: "bug-detection",
        reason: "agy-content-filtered",
        rerouteOutcome: "skipped-no-time",
      }),
    ]);
  });

  it("never arms the cooldown on a Gemini re-run quota failure", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        now: () => 1000,
        runFanout: fanoutWith((_l, _e, rung) =>
          rung === "primary"
            ? { ...REFUSED }
            : {
                ran: false,
                skipReason: "agy-error",
                failureClass: "quota-exhausted",
                agyError: "Individual quota reached.",
              },
        ),
      }),
    );
    expect(armed).toEqual([]);
    expect(envelope().cooldownArmed).toBe(false);
    expect(envelope().fallback[0]).toMatchObject({
      rerouteOutcome: "agy-quota-exhausted",
    });
  });

  it("still arms when a refused-and-recovered lens sits next to a quota-exhausted sibling", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        now: () => 1000,
        runFanout: fanoutWith((lens, _e, rung) =>
          lens === "bug-detection"
            ? rung === "primary"
              ? { ...REFUSED }
              : { raw: GOOD }
            : {
                ran: false,
                skipReason: "agy-error",
                failureClass: "quota-exhausted",
                agyError: "Individual quota reached.",
              },
        ),
      }),
    );
    expect(armed).toEqual([["quota-exhausted", "content-filtered"]]);
    expect(envelope().cooldownArmed).toBe(true);
  });

  it("does not re-run a refusal on a Gemini primary", async () => {
    await run(
      argv("bug-detection"),
      deps({
        readConfig: cfg({ models: { claudeLenses: "Gemini 4 Argon (High)" } }),
        runFanout: fanoutWith(() => ({ ...REFUSED })),
      }),
    );
    expect(fanoutCalls).toHaveLength(1);
    expect(envelope().fallback[0].rerouteOutcome).toBeUndefined();
  });
});

describe("prompt inputs", () => {
  const rewriteScope = (patch: Record<string, unknown>) => {
    const scopePath = tmpFile("review-scope.json");
    const scope = JSON.parse(fs.readFileSync(scopePath, "utf8"));
    fs.writeFileSync(scopePath, JSON.stringify({ ...scope, ...patch }));
  };

  it("carries a delta re-review scope into the prompt", async () => {
    rewriteScope({
      scope: "delta",
      base_sha: "aaaaaaaa1",
      head_sha: "bbbbbbbb2",
      delta_files: ["src/a.ts"],
    });
    await run(argv("pattern-consistency"), deps());
    expect(prompts["pattern-consistency"]).toContain(
      "Delta re-entry: the diff below covers only aaaaaaa..bbbbbbb (1 files)",
    );
  });

  it("inlines the product brief named by review-scope.json", async () => {
    const briefPath = tmpFile("brief.md");
    fs.writeFileSync(briefPath, "BRIEF-MARKER");
    rewriteScope({ product_brief: { found: true, path: briefPath } });
    await run(
      argv("product"),
      deps({ readConfig: cfg({ lenses: ["product"] }) }),
    );
    expect(prompts.product).toContain("BRIEF-MARKER");
  });

  it("one lens failing prep leaves the other lens's result attributed to it", async () => {
    await run(
      argv("pattern-consistency,bug-detection"),
      deps({
        readFile: (p) =>
          p.endsWith(path.join("checklists", "bug-detection.md"))
            ? null
            : (() => {
                try {
                  return fs.readFileSync(p, "utf8");
                } catch {
                  return null;
                }
              })(),
        runFanout: fanoutWith((lens) =>
          lens === "pattern-consistency" ? { raw: GOOD } : { raw: "" },
        ),
      }),
    );
    const e = envelope();
    expect(fanoutCalls[0]).toHaveLength(1);
    expect(e.delegated.map((d: { lens: string }) => d.lens)).toEqual([
      "pattern-consistency",
    ]);
    expect(e.fallback).toEqual([
      {
        lens: "bug-detection",
        reason: "agy-prep-failed",
        skipClass: "environment",
      },
    ]);
    expect(armed).toEqual([]);
  });

  it("never reads the fetch.md reviewer-comment dump into a prompt", async () => {
    await run(argv("pattern-consistency"), deps());
    expect(reads.some((r) => r.endsWith("pr-review-fetch.md"))).toBe(false);
    expect(prompts["pattern-consistency"]).not.toContain(
      "REVIEWER-COMMENT-SENTINEL",
    );
    expect(prompts["pattern-consistency"]).toContain("Add the thing");
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

  it("runs one one-entry fan-out per lens with the per-lens timeout, schema, add-dir and no skip-permissions", async () => {
    await run(argv("pattern-consistency,bug-detection"), deps());
    expect(fanoutCalls).toHaveLength(2);
    expect(fanoutCalls.every((c) => c.length === 1)).toBe(true);
    expect(fanoutCalls.map((c) => c[0]!.task).sort()).toEqual([
      "agy-lens-bug-detection",
      "agy-lens-pattern-consistency",
    ]);
    for (const [entry] of fanoutCalls) {
      expect(entry!.model).toBe(VARIANT);
      expect(entry!.timeout).toBe("8m");
      expect(entry!.outputFormat).toBe("json");
      expect(entry!.addDirs).toEqual([worktree]);
      expect(entry!.jsonSchema).toBeDefined();
      expect(entry!.skipPermissions).toBeUndefined();
    }
    const manifests = fanoutCalls.map((c) => c[0]!.promptFile);
    expect(new Set(manifests).size).toBe(2);
  });

  it("removes its scratch files, including the re-run rung's", async () => {
    const leftovers = () =>
      fs
        .readdirSync(path.join(worktree, ".flow-tmp"))
        .filter((f) => f.startsWith("agy-") && f !== "agy-lenses-result.json");
    await run(argv("pattern-consistency"), deps());
    expect(leftovers()).toEqual([]);
    await run(
      argv("bug-detection"),
      deps({
        runFanout: fanoutWith((_l, _e, rung) =>
          rung === "primary" ? { ...REFUSED } : { raw: GOOD },
        ),
      }),
    );
    expect(fanoutCalls.some((c) => c[0]!.task.startsWith("agy-reroute-"))).toBe(
      true,
    );
    expect(leftovers()).toEqual([]);
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
