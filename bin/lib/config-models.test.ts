import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatEffortCell, runConfigModelsCli } from "./config-models";
import type { ResolvedRow } from "./model-routing-table";
import type { ReadConfigFile } from "./models-config";
import type { PipelineState } from "./state";

// Config-read seam (mirrors models-config.test.ts): feed a fixture models table
// so the real ~/.flow/config.json is never touched.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

const st = (partial: Partial<PipelineState>): PipelineState =>
  ({
    slug: "s",
    phase: "planning",
    repo: "/r",
    updatedAt: "",
    ...partial,
  }) as PipelineState;

describe("runConfigModelsCli", () => {
  let logSpy!: ReturnType<typeof vi.spyOn>;
  let errSpy!: ReturnType<typeof vi.spyOn>;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    // Hermetic: the host's real Claude Code build / effort env must not leak.
    for (const name of [
      "CLAUDE_CODE_EFFORT_LEVEL",
      "AI_AGENT",
      "CLAUDE_CODE_EXECPATH",
    ]) {
      vi.stubEnv(name, "");
    }
    out = [];
    err = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m ?? ""));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
      err.push(String(m ?? ""));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  // Story 1 — a row per site, default model/source for a fixture config.
  it("prints one row per spawn site with MODEL/SOURCE/EFFORT columns", () => {
    const code = runConfigModelsCli([], {
      read: reader({ models: { review: "opus" } }),
    });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toMatch(/PHASE\s+MODEL\s+SOURCE\s+EFFORT/);
    for (const phase of [
      "session",
      "planning",
      "scout",
      "coder",
      "review",
      "review-lens:bug-detection",
      "review-lens:security",
      "review-lens:pattern-consistency",
      "review-lens:performance",
      "review-lens:supply-chain",
      "review-lens:test-coverage",
      "review-lens:product",
      "review-lens:intent-guess",
      "fix-applier",
      "ui-driver",
      "consolidator",
      "merge-resolver",
    ]) {
      expect(table).toContain(phase);
    }
    // built-in model fallback is visible; with no session effort known the
    // fix-applier's capped built-in reads `≤ medium`.
    expect(table).toContain("built-in (sonnet)");
    expect(table).toMatch(
      /fix-applier\s+sonnet\s+built-in \(sonnet\)\s+≤ medium · built-in/,
    );
    // the fixture config value resolves
    expect(table).toMatch(/review\s+opus\s+config \(models\.review\)/);
  });

  it("prints the resolved session effort with its source on a line above the table", () => {
    const code = runConfigModelsCli([], {
      read: reader({ launch: { effort: "high" } }),
    });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toMatch(/^effort: high — config \(launch\.effort\)/m);
    for (const line of out) {
      if (/^effort:/.test(line)) continue;
      expect(line).not.toMatch(/PHASE\s+MODEL\s+SOURCE\s+EFFORT/);
      break;
    }
  });

  it("every sub-agent EFFORT cell without a built-in or configured effort reads `= session`", () => {
    const code = runConfigModelsCli([], {
      read: reader({ launch: { effort: "high" } }),
    });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toMatch(/session\s+.*\s+high$/m);
    for (const phase of [
      "planning",
      "scout",
      "coder",
      "review",
      "consolidator",
      "merge-resolver",
    ]) {
      const line = out.find((l) => l.trimStart().startsWith(phase + " "));
      expect(line, `no row for ${phase}`).toBeDefined();
      expect(line).toMatch(/=\s*session\s*$/);
    }
    // The cheap-model fan-outs and the product reviewer carry a medium
    // built-in, capped at the session for the first two.
    for (const phase of ["fix-applier", "ui-driver"]) {
      const line = out.find((l) => l.trimStart().startsWith(phase + " "));
      expect(line).toMatch(/medium · built-in\s*$/);
    }
  });

  it("renders configured efforts with a `· config` cell and lens config on its own row", () => {
    const code = runConfigModelsCli([], {
      read: reader({
        launch: { effort: "high" },
        efforts: { coder: "xhigh", reviewLenses: { product: "max" } },
      }),
    });
    expect(code).toBe(0);
    const coder = out.find((l) => l.trimStart().startsWith("coder "));
    expect(coder).toMatch(/xhigh · config\s*$/);
    const product = out.find((l) =>
      l.trimStart().startsWith("review-lens:product "),
    );
    expect(product).toMatch(/max · config\s*$/);
  });

  it("formatEffortCell: capped built-in reads `≤ level` only while the session effort is unknown", () => {
    const capped = {
      phase: "fix-applier",
      effort: "medium",
      effortSource: "built-in (fix-applier, ≤ session)",
    } as ResolvedRow;
    expect(formatEffortCell(capped, false)).toBe("≤ medium · built-in");
    expect(formatEffortCell(capped, true)).toBe("medium · built-in");
    const uncapped = {
      phase: "review-lens:product",
      effort: "medium",
      effortSource: "built-in (review-lens:product)",
    } as ResolvedRow;
    expect(formatEffortCell(uncapped, false)).toBe("medium · built-in");
  });

  it("CLAUDE_CODE_EFFORT_LEVEL overrides every row and prints a banner", () => {
    const code = runConfigModelsCli(["--json"], {
      read: reader({ efforts: { coder: "low" } }),
      env: { CLAUDE_CODE_EFFORT_LEVEL: "max" },
    });
    expect(code).toBe(0);
    for (const r of JSON.parse(out[0])) {
      expect(r.effort).toBe("max");
      expect(r.effortSource).toBe("env (CLAUDE_CODE_EFFORT_LEVEL)");
    }
    out.length = 0;
    runConfigModelsCli([], {
      read: reader(undefined),
      env: { CLAUDE_CODE_EFFORT_LEVEL: "max" },
    });
    const text = out.join("\n");
    expect(text).toContain(
      "CLAUDE_CODE_EFFORT_LEVEL=max overrides the effort of every sub-agent",
    );
    expect(text).toMatch(
      /fix-applier\s+sonnet\s+built-in \(sonnet\)\s+max · env/,
    );
  });

  it("prints a banner when the running build predates per-spawn effort, and none otherwise", () => {
    runConfigModelsCli([], {
      read: reader(undefined),
      env: { AI_AGENT: "claude-code_2-1-291_agent" },
    });
    expect(out.join("\n")).toContain("predates per-spawn sub-agent effort");
    out.length = 0;
    runConfigModelsCli([], {
      read: reader(undefined),
      env: { AI_AGENT: "claude-code_2-1-303_agent" },
    });
    expect(out.join("\n")).not.toContain("predates per-spawn");
    out.length = 0;
    runConfigModelsCli([], { read: reader(undefined), env: {} });
    expect(out.join("\n")).not.toContain("predates per-spawn");
  });

  it("--slug renders the frozen run effort with source `this run (fixed at launch)`, ignoring a differing launch.effort in config", () => {
    const code = runConfigModelsCli(["--slug", "feat"], {
      // A live launch.effort of "low" must never leak in once a state
      // resolved this pipeline's effort to "high" — config is out of the
      // chain the moment --slug resolves a state (config-launch.ts's rule).
      read: reader({ launch: { effort: "low" } }),
      loadState: () => st({ effort: "high" }),
    });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toMatch(/^effort: high — this run \(fixed at launch\)/m);
  });

  it("with no state and no launch.effort configured, the session effort renders `(none)` / built-in", () => {
    const code = runConfigModelsCli([], { read: reader(undefined) });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toMatch(
      /^effort: \(none\) — built-in \(no --effort passed\)/m,
    );
  });

  it("the table still has exactly four columns", () => {
    const code = runConfigModelsCli([], { read: reader(undefined) });
    expect(code).toBe(0);
    const headerLine = out.find((l) =>
      /PHASE\s+MODEL\s+SOURCE\s+EFFORT/.test(l),
    );
    expect(headerLine).toBeDefined();
    const cols = headerLine!.trim().split(/\s{2,}/);
    expect(cols).toEqual(["PHASE", "MODEL", "SOURCE", "EFFORT"]);
  });

  it("the footer explains per-spawn effort and no longer claims the Task tool lacks the argument", () => {
    const code = runConfigModelsCli([], { read: reader(undefined) });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toContain(
      "MODEL and EFFORT both resolve at each spawn; set a row's effort with efforts.<key> (same key as models.*) — needs Claude Code 2.1.292+",
    );
    expect(table).not.toContain("no per-spawn effort argument");
  });

  // Story 1b — review-lens rows: default inherited, an explicit
  // config.models.reviewLenses.<lens> override, and the fable-session cap.
  it("renders the eight review-lens rows with their resolved model + source", () => {
    const code = runConfigModelsCli([], {
      read: reader({
        models: { reviewLenses: { "bug-detection": "haiku" } },
      }),
    });
    expect(code).toBe(0);
    const table = out.join("\n");
    // an explicit models.reviewLenses.<lens> value names that layer as source
    expect(table).toMatch(
      /review-lens:bug-detection\s+haiku\s+config \(models\.reviewLenses\.bug-detection\)/,
    );
    // An unconfigured lens with no session state falls through to the session
    // model. MODEL deliberately reads `inherited`, NOT the EFFORT column's
    // `= session`: a model is resolved per spawn and can be overridden per
    // row, while effort is fixed at launch and no row can vary it. Keeping
    // the two words distinct is what preserves that spawn-time/launch-time
    // distinction in the table itself.
    expect(table).toMatch(/review-lens:security\s+inherited\s+inherited/);
  });

  it("a capped review-lens row's SOURCE names the cap", () => {
    const code = runConfigModelsCli(["--slug", "feat"], {
      read: reader(undefined),
      loadState: () => st({ model: "fable" }),
    });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toMatch(/review-lens:security\s+opus\s+capped/);
    expect(table).toMatch(/review-lens:bug-detection\s+inherited\s+inherited/);
  });

  // Story 2 — a per-pipeline override landed.
  it("--slug overlays a per-phase state override with its state (--model-planning) source", () => {
    const code = runConfigModelsCli(["--slug", "feat"], {
      read: reader(undefined),
      loadState: () => st({ modelPlanning: "fable" }),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(
      /planning\s+fable\s+state \(--model-planning\)/,
    );
  });

  // Story 4 — machine-readable output.
  it("--json emits a parseable array of {phase,model,source,effort,effortSource}", () => {
    const code = runConfigModelsCli(["--json"], { read: reader(undefined) });
    expect(code).toBe(0);
    // exactly one stdout line, no footer/color/session-effort line
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]);
    expect(Array.isArray(parsed)).toBe(true);
    // 8 original spawn sites + 8 review-lens rows (bug-detection, security,
    // pattern-consistency, performance, supply-chain, test-coverage,
    // product, intent-guess) + the config-only `ui-driver` row
    expect(parsed.length).toBe(17);
    for (const r of parsed) {
      expect(r).toHaveProperty("phase");
      expect(r).toHaveProperty("model");
      expect(r).toHaveProperty("source");
      expect(r).toHaveProperty("effort");
      expect(r).toHaveProperty("effortSource");
    }
    const fixApplier = parsed.find(
      (r: { phase: string }) => r.phase === "fix-applier",
    );
    expect(fixApplier).toMatchObject({
      model: "sonnet",
      source: "built-in (sonnet)",
      effort: "medium",
      effortSource: "built-in (fix-applier, ≤ session)",
    });
    const product = parsed.find(
      (r: { phase: string }) => r.phase === "review-lens:product",
    );
    expect(product).toMatchObject({
      model: "opus",
      source: "pinned (opus)",
      effort: "medium",
      effortSource: "built-in (review-lens:product)",
    });
    const session = parsed.find(
      (r: { phase: string }) => r.phase === "session",
    );
    expect(session).toMatchObject({
      effort: "(none)",
      effortSource: "built-in (no --effort passed)",
    });
  });

  // Story 6 — discoverability.
  it("--help prints the config help and exits 0 without reading state/config", () => {
    const code = runConfigModelsCli(["--help"], {
      read: () => {
        throw new Error("must not read config on --help");
      },
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/flow config/);
  });

  // Story 7 — an explicit bad --slug fails loudly.
  it("--slug for a missing pipeline exits non-zero, names the slug, prints no table", () => {
    const code = runConfigModelsCli(["--slug", "ghost"], {
      read: reader(undefined),
      loadState: () => null,
    });
    expect(code).not.toBe(0);
    expect(err.join("\n")).toContain("no feature pipeline 'ghost'");
    expect(out).toEqual([]);
  });

  it("rejects an unknown option with exit 2", () => {
    const code = runConfigModelsCli(["--bogus"], { read: reader(undefined) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("unknown option '--bogus'");
  });

  it("rejects --slug without a value with exit 2", () => {
    const code = runConfigModelsCli(["--slug"], { read: reader(undefined) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--slug requires a value");
  });
});
