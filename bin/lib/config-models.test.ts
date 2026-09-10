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
      "consolidator",
      "merge-resolver",
    ]) {
      expect(table).toContain(phase);
    }
    // built-in + pinned fallbacks are visible
    expect(table).toContain("built-in (sonnet)");
    expect(table).toContain("pinned");
    // the fixture config value resolves
    expect(table).toMatch(/review\s+opus\s+config \(models\.review\)/);
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
  it("--json emits a parseable array of {phase,model,source,effort}", () => {
    const code = runConfigModelsCli(["--json"], { read: reader(undefined) });
    expect(code).toBe(0);
    // exactly one stdout line, no footer/color
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]);
    expect(Array.isArray(parsed)).toBe(true);
    // 8 original spawn sites + 7 review-lens rows (bug-detection, security,
    // pattern-consistency, performance, supply-chain, test-coverage, intent-guess)
    expect(parsed.length).toBe(15);
    for (const r of parsed) {
      expect(r).toHaveProperty("phase");
      expect(r).toHaveProperty("model");
      expect(r).toHaveProperty("source");
      expect(r).toHaveProperty("effort");
    }
    const fixApplier = parsed.find(
      (r: { phase: string }) => r.phase === "fix-applier",
    );
    expect(fixApplier).toMatchObject({
      model: "sonnet",
      source: "built-in (sonnet)",
      effort: "low (pinned)",
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
