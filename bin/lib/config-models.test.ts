import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigModelsCli } from "./config-models";
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
      "review-lens:intent-guess",
      "fix-applier",
      "ui-driver",
      "consolidator",
      "merge-resolver",
    ]) {
      expect(table).toContain(phase);
    }
    // built-in model fallback is visible; effort is never pinned — every
    // sub-agent row follows the (resolved) session effort.
    expect(table).toContain("built-in (sonnet)");
    expect(table).toMatch(
      /fix-applier\s+sonnet\s+built-in \(sonnet\)\s+= session/,
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

  it("every sub-agent EFFORT cell reads `= session` regardless of the resolved value", () => {
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
      "fix-applier",
      "ui-driver",
      "consolidator",
      "merge-resolver",
    ]) {
      const line = out.find((l) => l.trimStart().startsWith(phase + " "));
      expect(line, `no row for ${phase}`).toBeDefined();
      expect(line).toMatch(/=\s*session\s*$/);
    }
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

  it("the footer names the launch-time timing and the no-per-spawn-effort-argument reason", () => {
    const code = runConfigModelsCli([], { read: reader(undefined) });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toContain(
      "effort is fixed when the pipeline launches; MODEL resolves at each spawn",
    );
    expect(table).toContain(
      "the Task tool has no per-spawn effort argument, so every sub-agent follows the session",
    );
  });

  // Story 1b — review-lens rows: default inherited, an explicit
  // config.models.reviewLenses.<lens> override, and the fable-session cap.
  it("renders the seven review-lens rows with their resolved model + source", () => {
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
    // an unconfigured lens with no session state falls through to "inherited"
    expect(table).toMatch(/review-lens:security\s+inherited\s+inherited/);
  });

  it("a capped review-lens row's SOURCE names the cap", () => {
    const code = runConfigModelsCli(["--slug", "feat"], {
      read: reader(undefined),
      loadState: () => st({ model: "fable" }),
    });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toMatch(/review-lens:bug-detection\s+opus\s+capped/);
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
    // 8 original spawn sites + 7 review-lens rows (bug-detection, security,
    // pattern-consistency, performance, supply-chain, test-coverage,
    // intent-guess) + the config-only `ui-driver` row
    expect(parsed.length).toBe(16);
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
      effort: "= session",
      effortSource: "follows session",
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
