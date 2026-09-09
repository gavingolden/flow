import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run, type Deps } from "./lib/explain-judge";
import { defaultDeps } from "./flow-explain-judge";
import { recordEvent } from "./lib/telemetry";

function tmpLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explain-judge-cli-"));
  return path.join(dir, "events.jsonl");
}

function readEvents(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function baseDeps(logPath: string, overrides: Partial<Deps> = {}): Deps {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "explain-judge-cli-run-"));
  return {
    readFile: () => null,
    fileExists: () => false,
    readConfig: () => null,
    resolveBrief: () => ({ found: false }),
    runHeadless: async () => ({ exitCode: 1, stdout: "" }),
    mkdtemp: () => tmp,
    removeDir: () => {},
    env: {},
    writeOut: () => {},
    record: (attrs) => recordEvent("explain.judge", attrs, { logPath }),
    ...overrides,
  };
}

describe("defaultDeps", () => {
  it("wires a record function bound to the explain.judge event name", () => {
    const logPath = tmpLogPath();
    const deps = defaultDeps({ logPath, env: {}, stateDir: os.tmpdir() });
    deps.record?.({ site: "smoke", ran: false });
    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("explain.judge");
  });
});

describe("flow-explain-judge CLI end-to-end", () => {
  it("judged path: exactly one explain.judge event, verdict pass", async () => {
    const logPath = tmpLogPath();
    const artifactPath = "/tmp/cli-artifact-judged.json";
    const code = await run(
      ["--text-file", "/x", "--site", "pr-body", "--expect", "pass"],
      baseDeps(logPath, {
        fileExists: () => true,
        readFile: (p) => {
          if (p === "/x") return "## Why\nusers get faster checkout\n";
          if (p === artifactPath)
            return JSON.stringify({
              result: '{"verdict":"pass","reasons":["clear"]}',
            });
          return null;
        },
        runHeadless: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            ran: true,
            artifact: artifactPath,
            total_cost_usd: 0.01,
          }),
        }),
      }),
    );
    expect(code).toBe(0);
    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("explain.judge");
    expect((events[0].attrs as Record<string, unknown>).verdict).toBe("pass");
  });

  it("skipped path: exactly one explain.judge event, ran false", async () => {
    const logPath = tmpLogPath();
    const code = await run(
      ["--text-file", "/nope", "--site", "smoke"],
      baseDeps(logPath, { fileExists: () => false }),
    );
    expect(code).toBe(0);
    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect((events[0].attrs as Record<string, unknown>).skipReason).toBe(
      "text-empty",
    );
  });

  it("failed path: exactly one explain.judge event, child reports an error skipReason", async () => {
    const logPath = tmpLogPath();
    const code = await run(
      ["--text-file", "/x", "--site", "smoke"],
      baseDeps(logPath, {
        fileExists: () => true,
        readFile: () => "## Why\nbody\n",
        runHeadless: async () => ({
          exitCode: 2,
          stdout: JSON.stringify({ ran: false, skipReason: "claude-error" }),
        }),
      }),
    );
    expect(code).toBe(0);
    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect((events[0].attrs as Record<string, unknown>).skipReason).toBe(
      "claude-error",
    );
  });

  it("--expect exit mapping: 0 on match, 1 on mismatch, 3 when ran:false", async () => {
    const artifactPath = "/tmp/cli-artifact-expect.json";
    const passDeps = () =>
      baseDeps(tmpLogPath(), {
        fileExists: () => true,
        readFile: (p) => {
          if (p === "/x") return "## Why\nbody\n";
          if (p === artifactPath)
            return JSON.stringify({
              result: '{"verdict":"pass","reasons":[]}',
            });
          return null;
        },
        runHeadless: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ ran: true, artifact: artifactPath }),
        }),
      });

    expect(
      await run(
        ["--text-file", "/x", "--site", "s", "--expect", "pass"],
        passDeps(),
      ),
    ).toBe(0);
    expect(
      await run(
        ["--text-file", "/x", "--site", "s", "--expect", "rewrite"],
        passDeps(),
      ),
    ).toBe(1);
    expect(
      await run(
        ["--text-file", "/nope", "--site", "s", "--expect", "pass"],
        baseDeps(tmpLogPath(), { fileExists: () => false }),
      ),
    ).toBe(3);
  });

  it("FLOW_HEADLESS_DEPTH pre-check spawns nothing", async () => {
    let spawned = false;
    const code = await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps(tmpLogPath(), {
        env: { FLOW_HEADLESS_DEPTH: "1" },
        fileExists: () => true,
        readFile: () => "## Why\nbody\n",
        runHeadless: async () => {
          spawned = true;
          return { exitCode: 0, stdout: "" };
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(code).toBe(0);
  });

  it("product.judge:false opts out without spawning", async () => {
    let spawned = false;
    const code = await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps(tmpLogPath(), {
        readConfig: () => JSON.stringify({ product: { judge: false } }),
        fileExists: () => true,
        readFile: () => "## Why\nbody\n",
        runHeadless: async () => {
          spawned = true;
          return { exitCode: 0, stdout: "" };
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(code).toBe(0);
  });

  it("one-shot bad-args tools-fallback retry: spawns exactly twice and succeeds", async () => {
    const artifactPath = "/tmp/cli-artifact-fallback.json";
    let calls = 0;
    const logPath = tmpLogPath();
    const code = await run(
      ["--text-file", "/x", "--site", "s"],
      baseDeps(logPath, {
        fileExists: () => true,
        readFile: (p) => {
          if (p === "/x") return "## Why\nbody\n";
          if (p === artifactPath)
            return JSON.stringify({
              result: '{"verdict":"pass","reasons":[]}',
            });
          return null;
        },
        runHeadless: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              exitCode: 2,
              stdout: JSON.stringify({ ran: false, skipReason: "bad-args" }),
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ ran: true, artifact: artifactPath }),
          };
        },
      }),
    );
    expect(calls).toBe(2);
    expect(code).toBe(0);
    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect((events[0].attrs as Record<string, unknown>).tools_fallback).toBe(
      true,
    );
  });
});
