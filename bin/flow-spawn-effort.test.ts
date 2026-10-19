import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  detectClaudeBuild,
  MIN_SUBAGENT_EFFORT_VERSION,
  run,
  type FlowSpawnEffortDeps,
} from "./flow-spawn-effort";
import type { ReadConfigFile } from "./lib/models-config";
import type { PipelineState } from "./lib/state";

const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

const NEW_BUILD = { AI_AGENT: "claude-code_2-1-303_agent" };

const st = (partial: Partial<PipelineState>): PipelineState =>
  ({
    slug: "s",
    phase: "planning",
    repo: "/r",
    updatedAt: "",
    ...partial,
  }) as PipelineState;

function runWith(
  argv: string[],
  opts: {
    config?: unknown;
    env?: NodeJS.ProcessEnv;
    state?: PipelineState | null;
    resolveSlug?: () => string | null;
  } = {},
): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: FlowSpawnEffortDeps = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    read: reader(opts.config ?? {}),
    env: opts.env ?? { ...NEW_BUILD, CLAUDE_EFFORT: "high" },
    loadState: () => opts.state ?? null,
    resolveSlug: opts.resolveSlug ?? (() => null),
  };
  return { code: run(argv, deps), out, err };
}

describe("flow-spawn-effort", () => {
  it("caps mechanical roles at medium on a high session", () => {
    for (const phase of ["fix-applier", "ui-driver"]) {
      const { code, out } = runWith([phase]);
      expect(code).toBe(0);
      expect(out).toEqual(["medium"]);
    }
  });

  it("keeps a low session low for the capped roles", () => {
    const { out } = runWith(["fix-applier"], {
      env: { ...NEW_BUILD, CLAUDE_EFFORT: "low" },
    });
    expect(out).toEqual(["low"]);
  });

  it("runs the product lens at medium even on a low session", () => {
    const { out } = runWith(["review-lens:product"], {
      env: { ...NEW_BUILD, CLAUDE_EFFORT: "low" },
    });
    expect(out).toEqual(["medium"]);
  });

  it("prints nothing for judgment roles that follow the session", () => {
    for (const phase of [
      "planning",
      "scout",
      "coder",
      "consolidator",
      "merge-resolver",
      "review-lens:security",
    ]) {
      const { code, out } = runWith([phase]);
      expect(code).toBe(0);
      expect(out).toEqual([]);
    }
  });

  it("config wins over the built-in, including nested lens values", () => {
    const config = {
      efforts: {
        fixApplier: "xhigh",
        coder: "low",
        reviewLenses: { product: "max", security: "low" },
      },
    };
    expect(runWith(["fix-applier"], { config }).out).toEqual(["xhigh"]);
    expect(runWith(["coder"], { config }).out).toEqual(["low"]);
    expect(runWith(["review-lens:product"], { config }).out).toEqual(["max"]);
    expect(runWith(["review-lens:security"], { config }).out).toEqual(["low"]);
  });

  it("falls back to the built-in for an invalid configured value", () => {
    const { out } = runWith(["fix-applier"], {
      config: { efforts: { fixApplier: "hgh" } },
    });
    expect(out).toEqual(["medium"]);
  });

  it("does not read the group keys efforts.review / efforts.implement", () => {
    const config = { efforts: { review: "low", implement: "low" } };
    expect(runWith(["review-lens:security"], { config }).out).toEqual([]);
    expect(runWith(["scout"], { config }).out).toEqual([]);
  });

  it("prints nothing on a build older than 2.1.292, even when configured", () => {
    const config = { efforts: { fixApplier: "high" } };
    const old = { AI_AGENT: "claude-code_2-1-291_agent" };
    expect(runWith(["fix-applier"], { config, env: old }).out).toEqual([]);
    expect(
      runWith(["fix-applier"], { config, env: { CLAUDE_EFFORT: "high" } }).out,
    ).toEqual([]);
  });

  it("detects the build from CLAUDE_CODE_EXECPATH when AI_AGENT is absent", () => {
    const env = {
      CLAUDE_CODE_EXECPATH: "/x/claude/versions/2.1.300",
      CLAUDE_EFFORT: "high",
    };
    expect(runWith(["fix-applier"], { env }).out).toEqual(["medium"]);
    expect(detectClaudeBuild(env)).toBe("2.1.300");
    expect(MIN_SUBAGENT_EFFORT_VERSION).toBe("2.1.292");
  });

  it("rejects session, bare review, unknown phases and bad args with exit 2", () => {
    expect(runWith(["session"]).code).toBe(2);
    const review = runWith(["review"]);
    expect(review.code).toBe(2);
    expect(review.err.join("\n")).toContain("review-lens:<lens>");
    expect(runWith(["nope"]).code).toBe(2);
    expect(runWith([]).code).toBe(2);
    expect(runWith(["fix-applier", "--bogus"]).code).toBe(2);
    expect(runWith(["fix-applier", "--slug"]).code).toBe(2);
  });

  it("validates arguments before the build gate", () => {
    expect(runWith(["nope"], { env: {} }).code).toBe(2);
  });

  it("--json carries phase, effort, source and build", () => {
    const { out } = runWith(["fix-applier", "--json"]);
    expect(JSON.parse(out[0]!)).toEqual({
      phase: "fix-applier",
      effort: "medium",
      source: "built-in (fix-applier, ≤ session)",
      build: "2.1.303",
    });
    const omitted = runWith(["scout", "--json"]);
    expect(JSON.parse(omitted.out[0]!)).toMatchObject({
      effort: "",
      source: "follows session",
    });
  });

  it("uses state.effort via the ambient slug when CLAUDE_EFFORT is unset", () => {
    const { out } = runWith(["fix-applier"], {
      env: { ...NEW_BUILD },
      state: st({ effort: "low" }),
      resolveSlug: () => "s",
    });
    expect(out).toEqual(["low"]);
  });

  it("CLAUDE_EFFORT wins over state.effort", () => {
    const { out } = runWith(["fix-applier"], {
      env: { ...NEW_BUILD, CLAUDE_EFFORT: "max" },
      state: st({ effort: "low" }),
      resolveSlug: () => "s",
    });
    expect(out).toEqual(["medium"]);
  });

  it("rejects an extra positional argument with exit 2", () => {
    const { code, err, out } = runWith(["fix-applier", "extra"]);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("unexpected extra argument 'extra'");
  });

  describe("real --config / --state / --slug file paths (no injected readers)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-spawn-effort-"));
    const cfg = path.join(tmp, "config.json");
    const emptyCfg = path.join(tmp, "empty-config.json");
    const stateFile = path.join(tmp, "state.json");
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.writeFileSync(cfg, JSON.stringify({ efforts: { fixApplier: "high" } }));
    fs.writeFileSync(emptyCfg, "{}");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        slug: "s",
        phase: "planning",
        repo: "/r",
        effort: "low",
      }),
    );

    const runReal = (argv: string[], deps: FlowSpawnEffortDeps = {}) => {
      const out: string[] = [];
      const code = run(argv, {
        stdout: (s) => out.push(s),
        stderr: () => {},
        env: { ...NEW_BUILD },
        ...deps,
      });
      return { code, out };
    };

    it("--config reads the file: configured effort wins", () => {
      const { code, out } = runReal([
        "fix-applier",
        "--config",
        cfg,
        "--state",
        stateFile,
      ]);
      expect(code).toBe(0);
      expect(out).toEqual(["high"]);
    });

    it("--state reads the file: the state effort caps the built-in default", () => {
      const { out } = runReal([
        "fix-applier",
        "--config",
        emptyCfg,
        "--state",
        stateFile,
      ]);
      expect(out).toEqual(["low"]);
    });

    it("an explicit --slug looks that slug up and skips ambient resolution", () => {
      const loadState = vi.fn(() => st({ effort: "low" }));
      const resolveSlug = vi.fn(() => "ambient");
      const { out } = runReal(
        ["fix-applier", "--config", emptyCfg, "--slug", "explicit"],
        { loadState, resolveSlug },
      );
      expect(out).toEqual(["low"]);
      expect(loadState).toHaveBeenCalledWith("explicit");
      expect(resolveSlug).not.toHaveBeenCalled();
    });
  });

  it("only ever prints an effort enum value", () => {
    for (const phase of ["fix-applier", "ui-driver", "review-lens:product"]) {
      const { out } = runWith([phase]);
      expect(["low", "medium", "high", "xhigh", "max"]).toContain(out[0]);
    }
  });
});
