import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseArgs,
  renderTable,
  run,
  type Deps,
} from "./flow-review-telemetry";
import type { ReviewTelemetry } from "./lib/review-telemetry";

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-review-telemetry-"));
  fs.mkdirSync(path.join(dir, ".flow-tmp"), { recursive: true });
  scratchDirs.push(dir);
  return dir;
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    appendFile: (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, content);
    },
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    git: () => ({ stdout: "deadbeef1234\n", exitCode: 0 }),
    env: {},
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    homeDir: fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-review-telemetry-home-"),
    ),
    stdout: () => {},
    ...overrides,
  };
}

describe("collect", () => {
  it("writes review-telemetry.json with one entry per lens from fixture artifacts in a temp worktree", async () => {
    const dir = makeWorktree();
    fs.writeFileSync(
      path.join(dir, ".flow-tmp", "agent-output-bug-detection.json"),
      JSON.stringify({ findings: [{}] }),
    );
    const deps = makeDeps();
    const code = await run(["collect", "--worktree", dir, "--pr", "10"], deps);
    expect(code).toBe(0);
    const telemetry: ReviewTelemetry = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".flow-tmp", "review-telemetry.json"),
        "utf8",
      ),
    );
    expect(telemetry.lenses["bug-detection"].findings_emitted).toBe(1);
    expect(Object.keys(telemetry.lenses).length).toBeGreaterThanOrEqual(6);
  });

  it("records --lens-tokens as context_tokens, never as the token total", async () => {
    const dir = makeWorktree();
    const deps = makeDeps();
    const code = await run(
      [
        "collect",
        "--worktree",
        dir,
        "--pr",
        "10",
        "--lens-tokens",
        "bug-detection=999",
      ],
      deps,
    );
    expect(code).toBe(0);
    const telemetry: ReviewTelemetry = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".flow-tmp", "review-telemetry.json"),
        "utf8",
      ),
    );
    expect(telemetry.version).toBe(5);
    expect(telemetry.lenses["bug-detection"].context_tokens).toBe(999);
    expect(telemetry.lenses["bug-detection"].tokens).toBeNull();
    expect(telemetry.lenses["bug-detection"].tokens_source).toBe("unavailable");
  });

  it("records the model from a single --lens-model flag", async () => {
    const dir = makeWorktree();
    const deps = makeDeps();
    const code = await run(
      [
        "collect",
        "--worktree",
        dir,
        "--pr",
        "10",
        "--lens-tokens",
        "bug-detection=999",
        "--lens-model",
        "bug-detection=opus",
      ],
      deps,
    );
    expect(code).toBe(0);
    const telemetry: ReviewTelemetry = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".flow-tmp", "review-telemetry.json"),
        "utf8",
      ),
    );
    expect(telemetry.lenses["bug-detection"].model).toBe("opus");
  });

  it("records a model per lens for repeated --lens-model flags", async () => {
    const dir = makeWorktree();
    const deps = makeDeps();
    const code = await run(
      [
        "collect",
        "--worktree",
        dir,
        "--pr",
        "10",
        "--lens-tokens",
        "bug-detection=999",
        "--lens-tokens",
        "security=100",
        "--lens-model",
        "bug-detection=opus",
        "--lens-model",
        "security=sonnet",
      ],
      deps,
    );
    expect(code).toBe(0);
    const telemetry: ReviewTelemetry = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".flow-tmp", "review-telemetry.json"),
        "utf8",
      ),
    );
    expect(telemetry.lenses["bug-detection"].model).toBe("opus");
    expect(telemetry.lenses.security.model).toBe("sonnet");
  });

  describe("delegated-lens engine (Story 5)", () => {
    const writeRecord = (dir: string, startedAt: string) =>
      fs.writeFileSync(
        path.join(dir, ".flow-tmp", "agy-lenses-result.json"),
        JSON.stringify({
          review_started_at: startedAt,
          model: "Claude Opus 5.5 (High)",
          routes: [
            { lens: "bug-detection", route: "agy" },
            { lens: "security", route: "agy" },
          ],
          delegated: [
            {
              lens: "bug-detection",
              findingCount: 1,
              decodedVia: "structured-output",
              durationSec: 60,
            },
          ],
          fallback: [{ lens: "security", reason: "agy-output-unparseable" }],
          cooldownArmed: false,
        }),
      );
    const collectLenses = async (dir: string) => {
      const out = path.join(dir, "telemetry.json");
      const code = await run(
        ["collect", "--pr", "7", "--worktree", dir, "--out", out],
        makeDeps(),
      );
      expect(code).toBe(0);
      return (JSON.parse(fs.readFileSync(out, "utf8")) as ReviewTelemetry)
        .lenses;
    };
    const writeScope = (dir: string, startedAt: string) =>
      fs.writeFileSync(
        path.join(dir, ".flow-tmp", "review-scope.json"),
        JSON.stringify({
          scope: "full",
          base_sha: null,
          head_sha: "def",
          delta_files: [],
          delta_ratio: null,
          started_at: startedAt,
        }),
      );

    it("records engine task + the fallback reason for a fallen-back lens, engine agy + model for a delegated one", async () => {
      const dir = makeWorktree();
      writeScope(dir, "2026-10-06T10:00:00Z");
      writeRecord(dir, "2026-10-06T10:00:00Z");
      const lenses = await collectLenses(dir);
      expect(lenses["bug-detection"]).toMatchObject({
        engine: "agy",
        agy_model: "Claude Opus 5.5 (High)",
        rerouted_from: null,
        model: "Claude Opus 5.5 (High)",
        fallback_reason: null,
      });
      expect(lenses.security).toMatchObject({
        engine: "task",
        fallback_reason: "agy-output-unparseable",
      });
      expect(lenses.performance).toMatchObject({
        engine: "task",
        agy_model: null,
        rerouted_from: null,
        fallback_reason: null,
      });
    });

    it("ignores a record left over from an earlier review window", async () => {
      const dir = makeWorktree();
      writeScope(dir, "2026-10-07T10:00:00Z");
      writeRecord(dir, "2026-10-06T10:00:00Z");
      const lenses = await collectLenses(dir);
      expect(lenses["bug-detection"].engine).toBe("task");
    });

    it("defaults every lens to engine task when no record exists", async () => {
      const dir = makeWorktree();
      const lenses = await collectLenses(dir);
      expect(
        Object.values(lenses).every(
          (l) =>
            l.engine === "task" &&
            l.agy_model === null &&
            l.fallback_reason === null,
        ),
      ).toBe(true);
    });
  });

  it("rejects a malformed --lens-model value with exit 2", async () => {
    const dir = makeWorktree();
    const deps = makeDeps();
    const code = await run(
      [
        "collect",
        "--worktree",
        dir,
        "--pr",
        "10",
        "--lens-model",
        "no-equals-sign",
      ],
      deps,
    );
    expect(code).toBe(2);
  });

  it("rejects --lens-model with an empty value after '=' (e.g. security=) with exit 2, not a silent drop", async () => {
    const dir = makeWorktree();
    const deps = makeDeps();
    const code = await run(
      ["collect", "--worktree", dir, "--pr", "10", "--lens-model", "security="],
      deps,
    );
    expect(code).toBe(2);
  });

  it("appends exactly one JSONL line with --append and does not duplicate it on a second run with the same run_id", async () => {
    const dir = makeWorktree();
    const jsonlPath = path.join(dir, "rt.jsonl");
    const deps = makeDeps();
    await run(
      [
        "collect",
        "--worktree",
        dir,
        "--pr",
        "10",
        "--append",
        "--jsonl",
        jsonlPath,
      ],
      deps,
    );
    await run(
      [
        "collect",
        "--worktree",
        dir,
        "--pr",
        "10",
        "--append",
        "--jsonl",
        jsonlPath,
      ],
      deps,
    );
    const lines = fs
      .readFileSync(jsonlPath, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it("exits 0 with zero counts when consolidator/fix-applier artifacts are absent", async () => {
    const dir = makeWorktree();
    const deps = makeDeps();
    const code = await run(["collect", "--worktree", dir, "--pr", "10"], deps);
    expect(code).toBe(0);
    const telemetry: ReviewTelemetry = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".flow-tmp", "review-telemetry.json"),
        "utf8",
      ),
    );
    expect(telemetry.lenses["bug-detection"].findings_survived).toBe(0);
  });

  it("appends exactly one JSONL line on the production run_id path (derived from review-scope.json's started_at) across two collect --append runs with different injected `now` values", async () => {
    const dir = makeWorktree();
    fs.writeFileSync(
      path.join(dir, ".flow-tmp", "review-scope.json"),
      JSON.stringify({
        scope: "full",
        base_sha: null,
        head_sha: "deadbeef1234",
        delta_files: [],
        delta_ratio: null,
        started_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    const jsonlPath = path.join(dir, "rt-prod.jsonl");
    const deps1 = makeDeps({ now: () => new Date("2026-01-01T00:00:01.000Z") });
    await run(
      [
        "collect",
        "--worktree",
        dir,
        "--pr",
        "10",
        "--append",
        "--jsonl",
        jsonlPath,
      ],
      deps1,
    );
    const deps2 = makeDeps({ now: () => new Date("2026-01-01T01:00:00.000Z") });
    await run(
      [
        "collect",
        "--worktree",
        dir,
        "--pr",
        "10",
        "--append",
        "--jsonl",
        jsonlPath,
      ],
      deps2,
    );
    const lines = fs
      .readFileSync(jsonlPath, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.run_id.endsWith("2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("exits 2 without --pr or --worktree", async () => {
    const deps = makeDeps();
    expect(await run(["collect", "--worktree", "/tmp/x"], deps)).toBe(2);
    expect(await run(["collect", "--pr", "10"], deps)).toBe(2);
  });
});

describe("print", () => {
  function fixtureTelemetry(
    overrides: Partial<ReviewTelemetry> = {},
  ): ReviewTelemetry {
    return {
      version: 5,
      run_id: "10:abc:2026",
      ts: "2026-01-01T00:00:00.000Z",
      repo: "flow",
      slug: null,
      pr: 10,
      session_id: null,
      scope: {
        kind: "delta",
        base_sha: "abc",
        head_sha: "def",
        delta_files: 1,
        delta_ratio: 0.1,
      },
      widened: { value: false, reason: null },
      intent_guess: null,
      lenses: {
        "bug-detection": {
          ran: true,
          skip_reason: null,
          skip_class: null,
          model: null,
          effort: null,
          tokens: { total: 100 },
          tokens_source: "subagent-transcript",
          context_tokens: null,
          findings_emitted: 1,
          findings_survived: 1,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
          engine: "task",
          agy_model: null,
          rerouted_from: null,
          fallback_reason: null,
        },
      },
      ...overrides,
    };
  }

  it("should render the table with a scope line and a NOTICE — tokens-unavailable line when a ran lens has no token source", () => {
    const t = fixtureTelemetry({
      lenses: {
        "bug-detection": {
          ran: true,
          skip_reason: null,
          skip_class: null,
          model: null,
          effort: null,
          tokens: null,
          tokens_source: "unavailable",
          context_tokens: null,
          findings_emitted: 0,
          findings_survived: 0,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
          engine: "task",
          agy_model: null,
          rerouted_from: null,
          fallback_reason: null,
        },
      },
    });
    const table = renderTable(t);
    expect(table).toContain("scope: delta (1 files)");
    expect(table).toContain("NOTICE — tokens-unavailable: 1 lenses");
  });

  it("renders n/a for null tokens", () => {
    const t = fixtureTelemetry({
      lenses: {
        "bug-detection": {
          ran: false,
          skip_reason: "docs-only",
          skip_class: null,
          model: null,
          effort: null,
          tokens: null,
          tokens_source: "unavailable",
          context_tokens: null,
          findings_emitted: 0,
          findings_survived: 0,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
          engine: "task",
          agy_model: null,
          rerouted_from: null,
          fallback_reason: null,
        },
      },
    });
    expect(renderTable(t)).toContain("| bug-detection | no | - | n/a |");
  });

  it("renders the literal '-' placeholder for a lens with no recorded model, and the model when present", () => {
    const t = fixtureTelemetry({
      lenses: {
        "bug-detection": {
          ran: true,
          skip_reason: null,
          skip_class: null,
          model: "opus",
          effort: null,
          tokens: { total: 100 },
          tokens_source: "subagent-transcript",
          context_tokens: null,
          findings_emitted: 1,
          findings_survived: 1,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
          engine: "task",
          agy_model: null,
          rerouted_from: null,
          fallback_reason: null,
        },
        security: {
          ran: true,
          skip_reason: null,
          skip_class: null,
          model: null,
          effort: null,
          tokens: { total: 50 },
          tokens_source: "subagent-transcript",
          context_tokens: null,
          findings_emitted: 0,
          findings_survived: 0,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
          engine: "task",
          agy_model: null,
          rerouted_from: null,
          fallback_reason: null,
        },
      },
    });
    const table = renderTable(t);
    expect(table).toContain("| bug-detection | yes | opus | 100 |");
    expect(table).toContain("| security | yes | - | 50 |");
  });

  it("prints via the CLI", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-review-telemetry-print-"),
    );
    scratchDirs.push(dir);
    const inPath = path.join(dir, "rt.json");
    fs.writeFileSync(inPath, JSON.stringify(fixtureTelemetry()));
    let output = "";
    const deps = makeDeps({ stdout: (s) => (output += s) });
    const code = await run(["print", "--in", inPath], deps);
    expect(code).toBe(0);
    expect(output).toContain("scope: delta");
  });
});

describe("parseArgs", () => {
  it("errors when neither collect nor print is given", () => {
    expect(parseArgs([])).toEqual({
      error: "subcommand is required (collect | print)",
    });
  });
});

describe("executable bit", () => {
  it("is executable", () => {
    const p = path.join(import.meta.dirname ?? ".", "flow-review-telemetry.ts");
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  });
});

describe("background Gemini skip detail", () => {
  const helper = (status: string, outcome: string, extra = {}) => ({
    status,
    outcome,
    startedAtSec: 0,
    giveUpAtSec: null,
    envelope: "/e",
    out: "/o",
    log: "/l",
    ...extra,
  });
  const seed = (
    dir: string,
    opts: {
      head?: string;
      lensEnvelope?: string;
      guessEnvelope?: string;
      lens?: ReturnType<typeof helper>;
      guess?: ReturnType<typeof helper>;
      noState?: boolean;
      awaited?: boolean;
    },
  ) => {
    const tmp = path.join(dir, ".flow-tmp");
    fs.writeFileSync(
      path.join(tmp, "review-scope.json"),
      JSON.stringify({
        scope: "full",
        base_sha: null,
        head_sha: "H1",
        delta_files: [],
        delta_ratio: null,
        started_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    if (!opts.noState) {
      fs.writeFileSync(
        path.join(tmp, "review-bg.json"),
        JSON.stringify({
          version: 1,
          generation: "g",
          head_sha: opts.head ?? "H1",
          scope: "full",
          review_started_at: null,
          configPath: "/c",
          ...(opts.awaited === false ? {} : { awaitedAt: 1 }),
          watchdog: null,
          diffSnapshot: null,
          helpers: {
            "gemini-lens": opts.lens ?? helper("done", "complete"),
            "gemini-intent-guess": opts.guess ?? helper("done", "complete"),
          },
        }),
      );
    }
    if (opts.lensEnvelope !== undefined) {
      fs.writeFileSync(
        path.join(tmp, "gemini-lens-envelope.json"),
        opts.lensEnvelope,
      );
    }
    if (opts.guessEnvelope !== undefined) {
      fs.writeFileSync(
        path.join(tmp, "intent-guess-envelope.json"),
        opts.guessEnvelope,
      );
    }
  };
  const collect = async (dir: string): Promise<ReviewTelemetry> => {
    expect(
      await run(["collect", "--worktree", dir, "--pr", "10"], makeDeps()),
    ).toBe(0);
    return JSON.parse(
      fs.readFileSync(
        path.join(dir, ".flow-tmp", "review-telemetry.json"),
        "utf8",
      ),
    );
  };

  it("carries the envelope's real skip reason and class for a missing Gemini lens", async () => {
    const dir = makeWorktree();
    seed(dir, {
      lensEnvelope:
        '{"ran":false,"skipReason":"lens-timeout","skipClass":"ran-unusable"}\n',
      guessEnvelope: '{"ran":true}\n',
    });
    const t = await collect(dir);
    expect(t.lenses.gemini).toMatchObject({
      ran: false,
      skip_reason: "lens-timeout",
      skip_class: "ran-unusable",
    });
    expect(t.lenses["bug-detection"].skip_reason).toBe("no artifact");
    expect(t.lenses["bug-detection"].skip_class).toBeNull();
    expect(t.intent_guess).toEqual({
      ran: true,
      skip_reason: null,
      skip_class: null,
    });
  });

  it("names gemini-not-launched when no state exists for the head", async () => {
    const dir = makeWorktree();
    seed(dir, { noState: true });
    const t = await collect(dir);
    expect(t.lenses.gemini).toMatchObject({
      skip_reason: "gemini-not-launched",
      skip_class: "environment",
    });
    expect(t.intent_guess?.skip_reason).toBe("gemini-not-launched");
  });

  it("names gemini-not-awaited when the lens was still running with no envelope", async () => {
    const dir = makeWorktree();
    seed(dir, { lens: helper("running", "pending") });
    const t = await collect(dir);
    expect(t.lenses.gemini).toMatchObject({
      skip_reason: "gemini-not-awaited",
      skip_class: "ran-unusable",
    });
  });

  it("names gemini-not-awaited when the lens finished after nobody waited", async () => {
    const dir = makeWorktree();
    seed(dir, { awaited: false, lensEnvelope: '{"ran":true}\n' });
    fs.writeFileSync(
      path.join(dir, ".flow-tmp", "agent-output-gemini.json"),
      JSON.stringify({ findings: [{ file: "a", line: 1 }] }),
    );
    const t = await collect(dir);
    expect(t.lenses.gemini).toMatchObject({
      ran: false,
      skip_reason: "gemini-not-awaited",
      findings_emitted: 0,
    });
  });

  it("still matches a widened pass: the same head_sha keeps the state", async () => {
    const dir = makeWorktree();
    seed(dir, {
      guess: helper("skipped", "skipped", {
        skipReason: "gemini-intent-guess-delta-reentry",
        skipClass: "environment",
      }),
      lensEnvelope: '{"ran":true}\n',
    });
    const code = await run(
      ["collect", "--worktree", dir, "--pr", "10", "--widened", "stale delta"],
      makeDeps(),
    );
    expect(code).toBe(0);
    const t: ReviewTelemetry = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".flow-tmp", "review-telemetry.json"),
        "utf8",
      ),
    );
    expect(t.intent_guess).toEqual({
      ran: false,
      skip_reason: "gemini-intent-guess-delta-reentry",
      skip_class: "environment",
    });
  });

  it("prints the intent-guess line under the lens table", () => {
    const base = {
      ran: false,
      skip_reason: "agy-cooldown",
      skip_class: "environment",
    };
    const ran = renderTable({
      ...(JSON.parse("{}") as ReviewTelemetry),
      scope: { kind: "full", delta_files: 0 },
      widened: { value: false, reason: null },
      lenses: {},
      intent_guess: { ran: true, skip_reason: null, skip_class: null },
    } as unknown as ReviewTelemetry);
    expect(ran).toContain("intent guess (Gemini): ran");
    const skipped = renderTable({
      scope: { kind: "full", delta_files: 0 },
      widened: { value: false, reason: null },
      lenses: {},
      intent_guess: base,
    } as unknown as ReviewTelemetry);
    expect(skipped).toContain("intent guess (Gemini): skipped — agy-cooldown");
  });
});
