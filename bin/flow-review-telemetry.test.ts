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

  it("honours --lens-tokens as the primary source", async () => {
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
    expect(telemetry.lenses["bug-detection"].tokens).toEqual({ total: 999 });
    expect(telemetry.lenses["bug-detection"].tokens_source).toBe(
      "task-notification",
    );
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
      version: 1,
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
      lenses: {
        "bug-detection": {
          ran: true,
          skip_reason: null,
          model: null,
          tokens: { total: 100 },
          tokens_source: "task-notification",
          findings_emitted: 1,
          findings_survived: 1,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
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
          model: null,
          tokens: null,
          tokens_source: "unavailable",
          findings_emitted: 0,
          findings_survived: 0,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
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
          model: null,
          tokens: null,
          tokens_source: "unavailable",
          findings_emitted: 0,
          findings_survived: 0,
          findings_dropped: 0,
          findings_acted: 0,
          findings_deferred: 0,
        },
      },
    });
    expect(renderTable(t)).toContain("| bug-detection | no | n/a |");
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
