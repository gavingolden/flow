import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildManifest,
  toFanoutEntries,
  blind,
  classifyPreflight,
  DEFAULT_MODELS,
  dispatchWithRetries,
  parseArgs,
  runBench,
  type Deps,
} from "./flow-model-bench";
import type { BenchCase, BenchResult } from "./lib/model-bench-schema";
import {
  ADD_DIR_TOKEN,
  isTransportSkip,
  loadCases,
  shouldRetry,
} from "./lib/model-bench-manifest";
import type { EntryResult, FanoutResult } from "./flow-delegate-fanout";
import { BLIND_FRAMING } from "./lib/blind-survey-prompt";
import { JUDGE_A_TIMEOUT } from "./flow-blind-survey";
import { REVIEWER_1_TIMEOUT } from "./flow-plan-review";
import {
  buildManifest as buildGatherManifest,
  DEFAULT_TIMEOUT as RESEARCH_TIMEOUT,
} from "./flow-research-run";
import { DELEGATED_SCOUT_TIMEOUT } from "./lib/delegate-models";
import { DELEGATE_TIMEOUT_DEFAULTS } from "./lib/delegate-timeouts";

// No test in this file ever spawns a real process or calls the real agy
// binary — every Deps hook (preflight, runFanout) is stubbed.

function baseCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return {
    id: "c-base",
    surface: "scout",
    kind: "multi-file",
    promptFile: "prompt.md",
    inputFiles: ["a.ts"],
    authoredAtCommit: "abc1234",
    routable: true,
    ...overrides,
  };
}

describe("buildManifest", () => {
  it("yields one entry per (case, arm, model, repeat) plus one flagged warm-up per slot group", () => {
    const c = baseCase({ repeats: 2 });
    const entries = buildManifest([c], ["model-a"]);
    expect(entries).toHaveLength(3); // 1 warm-up + 2 repeats
    const warmups = entries.filter((e) => e.warmup);
    expect(warmups).toHaveLength(1);
    expect(
      entries
        .filter((e) => !e.warmup)
        .map((e) => e.repeat)
        .sort(),
    ).toEqual([0, 1]);
    for (const e of entries) {
      expect(e.caseId).toBe("c-base");
      expect(e.model).toBe("model-a");
    }
  });

  it("yields a single 'n/a' arm for schemaAb:false and both arms for schemaAb:true", () => {
    const plain = baseCase({ repeats: 1 });
    const ab = baseCase({
      id: "c-ab",
      repeats: 1,
      schemaAb: true,
      jsonSchemaFile: "schema.json",
    });
    const plainEntries = buildManifest([plain], ["m"]);
    expect(new Set(plainEntries.map((e) => e.arm))).toEqual(new Set(["n/a"]));

    const abEntries = buildManifest([ab], ["m"]);
    expect(new Set(abEntries.map((e) => e.arm))).toEqual(
      new Set(["schema", "free-form"]),
    );
    // 2 arms x (1 repeat + 1 warm-up) = 4
    expect(abEntries).toHaveLength(4);
  });

  it("yields one slot per size for a case carrying `sizes`", () => {
    const c = baseCase({ repeats: 1, sizes: [10, 20, 30] });
    const entries = buildManifest([c], ["m"]);
    // 3 sizes x (1 repeat + 1 warm-up) = 6
    expect(entries).toHaveLength(6);
    expect(new Set(entries.map((e) => e.size))).toEqual(new Set([10, 20, 30]));
  });

  it("honours --repeats as an override of every case's own tier, and each case's own tier when omitted", () => {
    const c = baseCase({ repeats: 5 });
    const overridden = buildManifest([c], ["m"], 2);
    expect(overridden.filter((e) => !e.warmup)).toHaveLength(2);

    const defaulted = buildManifest([c], ["m"]);
    expect(defaulted.filter((e) => !e.warmup)).toHaveLength(5);
  });
});

function fakeFs(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  return {
    store,
    readFile: (p: string) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p: string, data: string) => {
      store.set(p, data);
    },
    mkdirp: () => {},
  };
}

describe("toFanoutEntries", () => {
  it("sets jsonSchema on the schema arm and structuredFallback on the free-form arm, both pointing at the same schema file", () => {
    const c = baseCase({
      id: "c-ab",
      repeats: 1,
      schemaAb: true,
      jsonSchemaFile: "schema.json",
    });
    const fixturesDir = "fixtures";
    const fs = fakeFs({
      "fixtures/c-ab/prompt.md": "prompt text",
      "fixtures/c-ab/a.ts": "input text",
    });
    const manifest = buildManifest([c], ["m"]).filter((e) => !e.warmup);
    const fanoutEntries = toFanoutEntries(
      manifest,
      [c],
      fixturesDir,
      "out",
      fs,
    );
    const schemaEntry = fanoutEntries.find(
      (e, i) => manifest[i]!.arm === "schema",
    )!;
    const freeFormEntry = fanoutEntries.find(
      (e, i) => manifest[i]!.arm === "free-form",
    )!;
    expect(schemaEntry.jsonSchema).toBe("fixtures/c-ab/schema.json");
    expect(schemaEntry.structuredFallback).toBeUndefined();
    expect(freeFormEntry.structuredFallback).toBe("fixtures/c-ab/schema.json");
    expect(freeFormEntry.jsonSchema).toBeUndefined();
  });

  it("head-truncates the composed prompt's input material to each case's declared size", () => {
    const longInput = "x".repeat(1000);
    const c = baseCase({ id: "c-sizes", repeats: 1, sizes: [10, 500] });
    const fixturesDir = "fixtures";
    const fs = fakeFs({
      "fixtures/c-sizes/prompt.md": "PROMPT-HEADER",
      "fixtures/c-sizes/a.ts": longInput,
    });
    const manifest = buildManifest([c], ["m"]).filter((e) => !e.warmup);
    toFanoutEntries(manifest, [c], fixturesDir, "out", fs);
    const smallWritten = [...fs.store.entries()].find(([p]) =>
      p.includes("s10"),
    )![1];
    const bigWritten = [...fs.store.entries()].find(([p]) =>
      p.includes("s500"),
    )![1];
    const combinedInput = `\n\n### a.ts\n\n${longInput}`;
    expect(smallWritten).toBe(`PROMPT-HEADER${combinedInput.slice(0, 10)}`);
    expect(bigWritten).toBe(`PROMPT-HEADER${combinedInput.slice(0, 500)}`);
    expect(smallWritten.length).toBeLessThan(bigWritten.length);
  });

  it("memoizes the composed prompt per (caseId, size) — repeats/models never re-read the input files", () => {
    const c = baseCase({ id: "c-repeat", repeats: 3 });
    const fixturesDir = "fixtures";
    const fs = fakeFs({
      "fixtures/c-repeat/prompt.md": "PROMPT",
      "fixtures/c-repeat/a.ts": "input text",
    });
    const readFileSpy = vi.fn(fs.readFile);
    const manifest = buildManifest([c], ["model-a", "model-b"]).filter(
      (e) => !e.warmup,
    );
    // 3 repeats x 2 models = 6 slots sharing one (caseId, size) key.
    expect(manifest.length).toBe(6);
    const entries = toFanoutEntries(manifest, [c], fixturesDir, "out", {
      ...fs,
      readFile: readFileSpy,
    });
    expect(entries).toHaveLength(6);
    // Only the FIRST slot actually reads the fixture files (prompt.md +
    // a.ts); every subsequent slot hits the memoized composed prompt.
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });

  // Regression: entryId sanitizes arm/model but historically passed caseId
  // through raw. A caseId containing "/" would smuggle a path separator
  // into the slot id used for the prompt/raw filenames — the same
  // nonexistent-directory bug commit 46c0eb6 fixed for the "n/a" arm.
  it("sanitizes a slash in caseId out of the entry's task/prompt-file slot id", () => {
    const c = baseCase({ id: "c/nested", repeats: 1 });
    const fixturesDir = "fixtures";
    const fs = fakeFs({
      "fixtures/c/nested/prompt.md": "PROMPT",
      "fixtures/c/nested/a.ts": "input text",
    });
    const manifest = buildManifest([c], ["m"]).filter((e) => !e.warmup);
    const fanoutEntries = toFanoutEntries(
      manifest,
      [c],
      fixturesDir,
      "out",
      fs,
    );
    for (const e of fanoutEntries) {
      expect(e.task).not.toContain("/");
      expect(e.promptFile!.split("/").pop()).not.toContain("nested/");
      expect(e.out!.split("/").pop()).not.toContain("nested/");
    }
  });
});

describe("blind", () => {
  it("produces a packet with NO model string anywhere in it, while the key maps every id back to its model", () => {
    const results: BenchResult[] = [
      {
        caseId: "c1",
        arm: "n/a",
        model: "gemini-3.6-flash-high",
        repeat: 0,
        warmup: false,
        ran: true,
        response: "hello",
      },
      {
        caseId: "c1",
        arm: "n/a",
        model: "claude-sonnet-4-6",
        repeat: 1,
        warmup: false,
        ran: true,
        response: "world",
      },
    ];
    const { packet, key } = blind(results);
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain("gemini-3.6-flash-high");
    expect(serialized).not.toContain("claude-sonnet-4-6");
    expect(key[packet[0]!.id]).toBe("gemini-3.6-flash-high");
    expect(key[packet[1]!.id]).toBe("claude-sonnet-4-6");
  });
});

describe("classifyPreflight", () => {
  it("passes when the resolved binary names --output-format in a usage error (exit 2)", () => {
    const result = classifyPreflight(
      2,
      '--output-format must be "text" or "json"',
      "/path/to/flow-delegate.ts",
    );
    expect(result.ok).toBe(true);
  });

  it("fails loudly, naming the resolved binary path, when the resolved binary rejects the flag as unknown", () => {
    const result = classifyPreflight(
      2,
      "unknown flag: --output-format",
      "/path/to/stale/flow-delegate.ts",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("/path/to/stale/flow-delegate.ts");
    expect(result.message).toMatch(/unknown flag/i);
  });

  it("fails when the binary exits 0 or doesn't mention the flag at all", () => {
    expect(classifyPreflight(0, "", "/bin/x").ok).toBe(false);
    expect(classifyPreflight(2, "some unrelated error", "/bin/x").ok).toBe(
      false,
    );
  });
});

function makeEntryResult(overrides: Partial<EntryResult>): EntryResult {
  return { task: "t", model: "m", ran: false, ...overrides };
}

describe("dispatchWithRetries", () => {
  it("retries a transport-class skipReason up to twice, and never retries a non-transport skip", async () => {
    const manifest = [
      { task: "transport", model: "m", promptFile: "p" },
      { task: "refusal", model: "m", promptFile: "p" },
    ];
    let callCount = 0;
    const runFanout = vi.fn(async (m): Promise<FanoutResult> => {
      callCount++;
      if (callCount === 1) {
        return {
          entries: [
            makeEntryResult({
              task: "transport",
              ran: false,
              skipReason: "timeout",
            }),
            makeEntryResult({
              task: "refusal",
              ran: false,
              skipReason: "malformed-output",
            }),
          ],
          anyRan: false,
          allSkipped: true,
          calls: { attempted: 2, ran: 0, skipped: 2, budget: 2 },
        };
      }
      // Retry call: only the transport-class entry should be re-dispatched.
      expect(m).toHaveLength(1);
      expect(m[0]!.task).toBe("transport");
      return {
        entries: [makeEntryResult({ task: "transport", ran: true })],
        anyRan: true,
        allSkipped: false,
        calls: { attempted: 1, ran: 1, skipped: 0, budget: 1 },
      };
    });
    const deps = { runFanout, progress: vi.fn() } as unknown as Deps;
    const results = await dispatchWithRetries(deps, manifest, {
      concurrency: 1,
      maxCalls: 2,
      outDir: "out",
      delegateBin: "/bin/x",
    });
    expect(callCount).toBe(2);
    expect(results.find((r) => r.task === "transport")!.ran).toBe(true);
    expect(results.find((r) => r.task === "refusal")!.ran).toBe(false);
  });

  it("stops retrying a persistently-failing transport entry after the retry cap and records ran:false", async () => {
    const manifest = [{ task: "transport", model: "m", promptFile: "p" }];
    const skip = (): FanoutResult => ({
      entries: [
        makeEntryResult({
          task: "transport",
          ran: false,
          skipReason: "timeout",
        }),
      ],
      anyRan: false,
      allSkipped: true,
      calls: { attempted: 1, ran: 0, skipped: 1, budget: 1 },
    });
    const runFanout = vi.fn(async (): Promise<FanoutResult> => skip());
    const deps = { runFanout, progress: vi.fn() } as unknown as Deps;
    const results = await dispatchWithRetries(deps, manifest, {
      concurrency: 1,
      maxCalls: 1,
      outDir: "out",
      delegateBin: "/bin/x",
    });
    // One initial dispatch + exactly two retries, then it gives up.
    expect(runFanout).toHaveBeenCalledTimes(3);
    expect(results.find((r) => r.task === "transport")!.ran).toBe(false);
  });
});

// Table test over isTransportSkip's documented policy boundaries: which
// skipReason strings are treated as transient (worth retrying) vs permanent
// (never retry, to avoid double-spending live agy quota on a failure a
// retry can never fix).
describe("isTransportSkip", () => {
  it.each([
    ["timeout waiting for response", true],
    ["HTTP 503", true],
    ["rate limit exceeded", true],
    ["rate-limit exceeded", true],
    ["agy-not-authenticated", true],
    ["agy-error", false],
    ["agy-not-found", false],
    [undefined, false],
  ])("isTransportSkip(%o) === %s", (reason, expected) => {
    expect(isTransportSkip(reason as string | undefined)).toBe(expected);
  });
});

describe("runBench max-calls", () => {
  function inMemoryDeps(overrides: Partial<Deps> = {}): Deps {
    const files = new Map<string, string>([
      [
        "fixtures/c1/case.json",
        JSON.stringify({
          id: "c1",
          surface: "scout",
          kind: "multi-file",
          promptFile: "prompt.md",
          inputFiles: ["a.ts"],
          repeats: 1,
          authoredAtCommit: "abc1234",
          routable: true,
        }),
      ],
      ["fixtures/c1/prompt.md", "prompt"],
      ["fixtures/c1/a.ts", "input"],
    ]);
    return {
      readFile: (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFile: (p, data) => {
        files.set(p, data);
      },
      fileExists: (p) => files.has(p),
      mkdirp: () => {},
      readdir: () => ["c1"],
      progress: vi.fn(),
      preflight: () => ({ ok: true, message: "" }),
      gitHead: () => "deadbeef",
      agyVersion: () => "1.0.0",
      fileMtime: () => new Date("2026-01-01T00:00:00Z"),
      runFanout: vi.fn(
        async (): Promise<FanoutResult> => ({
          entries: [
            makeEntryResult({
              task: "w",
              ran: true,
              artifactPath: "out/raw/w.md",
            }),
            makeEntryResult({
              task: "r0",
              ran: true,
              artifactPath: "out/raw/r0.md",
            }),
          ],
          anyRan: true,
          allSkipped: false,
          calls: { attempted: 2, ran: 2, skipped: 0, budget: 2 },
        }),
      ),
      ...overrides,
    };
  }

  it("passes the fanout a --max-calls at least as large as the built manifest's length by default", async () => {
    const deps = inMemoryDeps();
    const code = await runBench(
      [
        "--fixtures",
        "fixtures",
        "--models",
        "m",
        "--delegate-bin",
        "/bin/flow-delegate.ts",
        "--out",
        "out",
      ],
      deps,
    );
    expect(code).toBe(0);
    const call = (deps.runFanout as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const manifestArg = call[0] as unknown[];
    const opts = call[1] as { maxCalls: number };
    expect(opts.maxCalls).toBeGreaterThanOrEqual(manifestArg.length);
    expect(opts.maxCalls).toBe(manifestArg.length); // 1 repeat + 1 warm-up = 2
  });

  it("excludes warmup entries from the blinded judge packet", async () => {
    const files = new Map<string, string>([
      [
        "fixtures/c1/case.json",
        JSON.stringify({
          id: "c1",
          surface: "scout",
          kind: "multi-file",
          promptFile: "prompt.md",
          inputFiles: ["a.ts"],
          repeats: 1,
          authoredAtCommit: "abc1234",
          routable: true,
        }),
      ],
      ["fixtures/c1/prompt.md", "prompt"],
      ["fixtures/c1/a.ts", "input"],
    ]);
    const deps = inMemoryDeps({
      readFile: (p) => {
        // The runner reads each entry's raw artifact by its OWN computed
        // out path (fanoutEntries[i].out), not by the mocked runFanout
        // response below — match on the slot-id suffix baked into that
        // path rather than hardcoding it.
        if (p.includes("warmup")) return "warmup response text";
        if (p.includes("--r0")) return "real response text";
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFile: (p, data) => {
        files.set(p, data);
      },
      fileExists: (p) => files.has(p),
      runFanout: vi.fn(
        async (m: unknown[]): Promise<FanoutResult> => ({
          entries: [
            makeEntryResult({
              task: (m[0] as { task: string }).task,
              ran: true,
              artifactPath: (m[0] as { out: string }).out,
            }),
            makeEntryResult({
              task: (m[1] as { task: string }).task,
              ran: true,
              artifactPath: (m[1] as { out: string }).out,
            }),
          ],
          anyRan: true,
          allSkipped: false,
          calls: { attempted: 2, ran: 2, skipped: 0, budget: 2 },
        }),
      ),
    });
    // buildManifest produces one warm-up + one real slot for repeats:1.
    const code = await runBench(
      [
        "--fixtures",
        "fixtures",
        "--models",
        "m",
        "--delegate-bin",
        "/bin/flow-delegate.ts",
        "--out",
        "out",
      ],
      deps,
    );
    expect(code).toBe(0);
    const results = JSON.parse(files.get("out/results.json")!);
    expect(results.some((r: { warmup: boolean }) => r.warmup)).toBe(true);
    const packet = JSON.parse(files.get("out/judge-packet.json")!);
    const packetTexts = packet.map((p: { text: string }) => p.text);
    expect(packetTexts).not.toContain("warmup response text");
    expect(packet.length).toBe(1);
    expect(packetTexts[0]).toBe("real response text");
  });

  it("honours an explicit --max-calls below the manifest length, but warns loudly on stderr", async () => {
    const deps = inMemoryDeps();
    const code = await runBench(
      [
        "--fixtures",
        "fixtures",
        "--models",
        "m",
        "--max-calls",
        "1",
        "--delegate-bin",
        "/bin/flow-delegate.ts",
        "--out",
        "out",
      ],
      deps,
    );
    expect(code).toBe(0);
    const call = (deps.runFanout as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const opts = call[1] as { maxCalls: number };
    expect(opts.maxCalls).toBe(1);
    const progressCalls = (deps.progress as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("");
    expect(progressCalls).toMatch(/truncates the 2-entry manifest/);
  });

  it("exits non-zero, naming the resolved delegate-bin, when the preflight fails", async () => {
    const deps = inMemoryDeps({
      preflight: () => ({
        ok: false,
        message: "resolved delegate-bin /stale/path is stale",
      }),
    });
    const code = await runBench(
      [
        "--fixtures",
        "fixtures",
        "--models",
        "m",
        "--delegate-bin",
        "/bin/flow-delegate.ts",
        "--out",
        "out",
      ],
      deps,
    );
    expect(code).toBe(1);
    expect(deps.runFanout).not.toHaveBeenCalled();
    const progressCalls = (deps.progress as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("");
    expect(progressCalls).toContain("/stale/path");
  });

  // Regression: in JSON mode the raw artifact is the AGY ENVELOPE, not model
  // prose. The first live smoke run parsed the envelope AS the model output,
  // so structuredOutput was null on every arm. Pin the unwrap.
  it("unwraps the agy envelope from the raw artifact — response is the model text and structured_output is lifted", async () => {
    const envelope = JSON.stringify({
      conversation_id: "x",
      status: "SUCCESS",
      response: '{"reasoning":"because","verdict":"skip"}',
      structured_output: { reasoning: "because", verdict: "skip" },
      duration_seconds: 1.5,
      usage: { input_tokens: 10 },
    });
    const deps = inMemoryDeps();
    const innerRead = deps.readFile;
    deps.readFile = (p) => (p.startsWith("out/raw/") ? envelope : innerRead(p));
    const code = await runBench(
      [
        "--fixtures",
        "fixtures",
        "--models",
        "m",
        "--delegate-bin",
        "/bin/flow-delegate.ts",
        "--out",
        "out",
      ],
      deps,
    );
    expect(code).toBe(0);
    const results = JSON.parse(deps.readFile("out/results.json"));
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.response).toBe('{"reasoning":"because","verdict":"skip"}');
      expect(r.structuredOutput).toEqual({
        reasoning: "because",
        verdict: "skip",
      });
    }
  });
});

describe("runBench --report", () => {
  const INCUMBENT = "claude-sonnet-4-6";
  const CANDIDATE = "candidate-model";

  function reportDeps(overrides: Record<string, string> = {}): Deps {
    const files = new Map<string, string>([
      [
        "fixtures/c1/case.json",
        JSON.stringify({
          id: "c1",
          surface: "scout",
          kind: "multi-file",
          promptFile: "prompt.md",
          inputFiles: ["a.ts"],
          repeats: 1,
          authoredAtCommit: "abc1234",
          routable: true,
        }),
      ],
      [
        "fixtures/c1/truth.json",
        JSON.stringify({ caseId: "c1", required: ["alpha", "beta"] }),
      ],
      [
        "out/results.json",
        JSON.stringify([
          {
            caseId: "c1",
            arm: "n/a",
            model: INCUMBENT,
            repeat: 0,
            warmup: false,
            ran: true,
            response: "alpha only",
            durationSeconds: 10,
          },
          {
            caseId: "c1",
            arm: "n/a",
            model: CANDIDATE,
            repeat: 0,
            warmup: false,
            ran: true,
            response: "alpha beta",
            durationSeconds: 1,
          },
        ]),
      ],
      ...Object.entries(overrides),
    ]);
    return {
      readFile: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFile: (p: string, data: string) => {
        files.set(p, data);
      },
      fileExists: (p: string) => files.has(p),
      mkdirp: () => {},
      readdir: () => ["c1"],
      progress: vi.fn(),
      preflight: vi.fn(() => ({ ok: true, message: "" })),
      gitHead: () => "deadbeef",
      agyVersion: () => "1.0.0",
      fileMtime: () => new Date("2026-01-01T00:00:00Z"),
      runFanout: vi.fn(async (): Promise<FanoutResult> => {
        throw new Error("report mode must never dispatch a model call");
      }),
      __files: files,
    } as unknown as Deps & { __files: Map<string, string> };
  }

  it("joins a completed run against the fixture truths and writes report.md + verdicts.json", async () => {
    const deps = reportDeps();
    const code = await runBench(
      ["--report", "--out", "out", "--fixtures", "fixtures"],
      deps,
    );
    expect(code).toBe(0);
    const report = deps.readFile("out/report.md");
    for (const heading of [
      "## Per-surface verdicts",
      "## Where each candidate was worse",
      "## Surfaces no candidate should take",
      "## Case discrimination",
      "## Schema tax",
      "## Run provenance",
      "## Limitations",
    ]) {
      expect(report).toContain(heading);
    }
    const verdicts = JSON.parse(deps.readFile("out/verdicts.json"));
    expect(verdicts.matrix.scout[CANDIDATE].status).toBe("clear");
    expect(verdicts.recommendation.scout.candidate).toBe(CANDIDATE);
  });

  it("downgrades a clear verdict to inconclusive when the judged file scores the candidate worse", async () => {
    const deps = reportDeps({
      "out/judge-key.json": JSON.stringify({ r1: CANDIDATE }),
      "out/judge-packet.json": JSON.stringify([
        { id: "r1", caseId: "c1", arm: "n/a", text: "alpha beta" },
      ]),
      "judged.json": JSON.stringify({ r1: "worse" }),
    });
    const code = await runBench(
      [
        "--report",
        "--out",
        "out",
        "--fixtures",
        "fixtures",
        "--judged",
        "judged.json",
      ],
      deps,
    );
    expect(code).toBe(0);
    const verdicts = JSON.parse(deps.readFile("out/verdicts.json"));
    expect(verdicts.matrix.scout[CANDIDATE].status).toBe("inconclusive");
    expect(verdicts.matrix.scout[CANDIDATE].reason).toMatch(/blind judge/);
  });

  it("keeps a 'worse' veto even when a later attempt on the same pair judges 'parity' (worst-wins, not last-wins)", async () => {
    const deps = reportDeps({
      "out/judge-key.json": JSON.stringify({
        r1: CANDIDATE,
        r2: CANDIDATE,
      }),
      "out/judge-packet.json": JSON.stringify([
        { id: "r1", caseId: "c1", arm: "n/a", text: "alpha beta" },
        { id: "r2", caseId: "c1", arm: "n/a", text: "gamma delta" },
      ]),
      // Object key order pins iteration order: "worse" comes FIRST here, so
      // a last-wins bug would let the later "parity" silently overwrite it.
      "judged.json": JSON.stringify({ r1: "worse", r2: "parity" }),
    });
    const code = await runBench(
      [
        "--report",
        "--out",
        "out",
        "--fixtures",
        "fixtures",
        "--judged",
        "judged.json",
      ],
      deps,
    );
    expect(code).toBe(0);
    const verdicts = JSON.parse(deps.readFile("out/verdicts.json"));
    expect(verdicts.matrix.scout[CANDIDATE].status).toBe("inconclusive");
    expect(verdicts.matrix.scout[CANDIDATE].reason).toMatch(/blind judge/);
  });

  it("exits 2 and writes nothing when results.json is missing", async () => {
    const deps = reportDeps();
    const filesMap = (deps as unknown as { __files: Map<string, string> })
      .__files;
    filesMap.delete("out/results.json");
    const code = await runBench(
      ["--report", "--out", "out", "--fixtures", "fixtures"],
      deps,
    );
    expect(code).toBe(2);
    expect(filesMap.has("out/report.md")).toBe(false);
    expect(filesMap.has("out/verdicts.json")).toBe(false);
  });

  it("exits 2 and writes nothing when results.json is invalid", async () => {
    const deps = reportDeps({ "out/results.json": "not json" });
    const filesMap = (deps as unknown as { __files: Map<string, string> })
      .__files;
    const code = await runBench(
      ["--report", "--out", "out", "--fixtures", "fixtures"],
      deps,
    );
    expect(code).toBe(2);
    expect(filesMap.has("out/report.md")).toBe(false);
    expect(filesMap.has("out/verdicts.json")).toBe(false);
  });

  it("never calls runFanout or preflight in report mode", async () => {
    const deps = reportDeps();
    const code = await runBench(
      ["--report", "--out", "out", "--fixtures", "fixtures"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.runFanout).not.toHaveBeenCalled();
  });

  const baselineRows = (model: string) =>
    JSON.stringify([
      {
        caseId: "c1",
        arm: "n/a",
        model,
        repeat: 0,
        warmup: false,
        ran: true,
        response: "alpha beta",
        durationSeconds: 10,
      },
    ]);
  // results.json holds only the candidate; the incumbent's rows come from a
  // committed baseline file merged at report time.
  const candidateOnly = JSON.stringify([
    {
      caseId: "c1",
      arm: "n/a",
      model: CANDIDATE,
      repeat: 0,
      warmup: false,
      ran: true,
      response: "alpha beta",
      durationSeconds: 1,
    },
  ]);

  it("--baseline-results merges the incumbent's committed rows so a candidate-only run can be scored", async () => {
    const deps = reportDeps({
      "out/results.json": candidateOnly,
      "base.json": baselineRows(INCUMBENT),
    });
    const code = await runBench(
      [
        "--report",
        "--out",
        "out",
        "--fixtures",
        "fixtures",
        "--baseline-results",
        "base.json",
      ],
      deps,
    );
    expect(code).toBe(0);
    const verdicts = JSON.parse(deps.readFile("out/verdicts.json"));
    expect(verdicts.matrix.scout[CANDIDATE]).toBeDefined();
    expect(verdicts.matrix.scout[INCUMBENT]).toBeUndefined(); // baseline is not a candidate
  });

  it("fails with a named error when the incumbent has no rows anywhere, instead of clearing on ground truth", async () => {
    const deps = reportDeps({ "out/results.json": candidateOnly });
    const code = await runBench(
      [
        "--report",
        "--out",
        "out",
        "--fixtures",
        "fixtures",
        "--ground-truth-floor",
        "0.8",
      ],
      deps,
    );
    expect(code).toBe(2);
    const said = (deps.progress as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(said).toMatch(/incumbent "claude-sonnet-4-6" has no rows/);
    expect(() => deps.readFile("out/report.md")).toThrow();
  });

  it("without a ground-truth floor, a case the baseline has no rows for is inconclusive, never clear", async () => {
    const newCase = JSON.stringify({
      id: "c2",
      surface: "scout",
      kind: "free-text",
      promptFile: "prompt.md",
      inputFiles: [],
      repeats: 1,
      authoredAtCommit: "abc1234",
      routable: true,
    });
    const row = (caseId: string, model: string) => ({
      caseId,
      arm: "n/a",
      model,
      repeat: 0,
      warmup: false,
      ran: true,
      response: "alpha beta",
      durationSeconds: 1,
    });
    // The baseline measured the incumbent on c1 only; c2 is a new case.
    const deps = {
      ...reportDeps({
        "out/results.json": JSON.stringify([
          row("c1", CANDIDATE),
          row("c2", CANDIDATE),
        ]),
        "base.json": JSON.stringify([row("c1", INCUMBENT)]),
        "fixtures/c2/case.json": newCase,
        "fixtures/c2/truth.json": JSON.stringify({
          caseId: "c2",
          required: ["alpha"],
        }),
      }),
      readdir: () => ["c1", "c2"],
    } as Deps;
    const argv = [
      "--report",
      "--out",
      "out",
      "--fixtures",
      "fixtures",
      "--baseline-results",
      "base.json",
    ];
    await runBench(argv, deps);
    const cell = JSON.parse(deps.readFile("out/verdicts.json")).matrix.scout[
      CANDIDATE
    ];
    expect(cell.status).toBe("inconclusive");
    expect(cell.reason).toMatch(/no baseline rows for claude-sonnet-4-6 on c2/);

    // With a floor, c2 is judged on ground truth instead ("ground truth only").
    await runBench([...argv, "--ground-truth-floor", "0.8"], deps);
    const gated = JSON.parse(deps.readFile("out/verdicts.json")).matrix.scout[
      CANDIDATE
    ];
    expect(gated.reason).toContain("c2 (ground truth only)");
  });

  it("exits 2 when --baseline-results names a missing file", async () => {
    const deps = reportDeps();
    const code = await runBench(
      [
        "--report",
        "--out",
        "out",
        "--fixtures",
        "fixtures",
        "--baseline-results",
        "nope.json",
      ],
      deps,
    );
    expect(code).toBe(2);
  });

  it("renders the production timeout fit section when a case carries a productionTimeout", async () => {
    const caseJson = JSON.stringify({
      id: "c1",
      surface: "scout",
      kind: "multi-file",
      promptFile: "prompt.md",
      inputFiles: ["a.ts"],
      repeats: 1,
      productionTimeout: "8m",
      authoredAtCommit: "abc1234",
      routable: true,
    });
    const deps = reportDeps({ "fixtures/c1/case.json": caseJson });
    expect(
      await runBench(
        ["--report", "--out", "out", "--fixtures", "fixtures"],
        deps,
      ),
    ).toBe(0);
    const report = deps.readFile("out/report.md");
    expect(report).toContain("## Production timeout fit");
    expect(report).toContain(
      "**scout** / candidate-model: 0/1 timed out at the 8m production limit",
    );
  });
});

// ---------------------------------------------------------------------------
// Roster, quota halt, resume, production posture and drift (Tasks 9-14)
// ---------------------------------------------------------------------------

describe("default roster", () => {
  it("benches today's agy roster, Argon High and Medium, when --models is omitted", () => {
    const parsed = parseArgs(["--out", "out"]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.models).toEqual([
      "gemini-4-argon-high",
      "gemini-4-argon-medium",
    ]);
    expect(DEFAULT_MODELS).toEqual(parsed.models);
    expect(parsed.incumbent).toBe("claude-sonnet-4-6");
  });

  it("parses the resume, chunking, warm-up and report-gate flags", () => {
    const parsed = parseArgs([
      "--out",
      "out",
      "--resume",
      "--no-warmup",
      "--chunk-size",
      "4",
      "--no-latency-gate",
      "--ground-truth-floor",
      "0.8",
      "--baseline-results",
      "base.json",
    ]);
    expect(parsed).toMatchObject({
      resume: true,
      noWarmup: true,
      chunkSize: 4,
      noLatencyGate: true,
      groundTruthFloor: 0.8,
      baselineResults: "base.json",
    });
    expect(parseArgs(["--out", "o"])).toMatchObject({
      resume: false,
      chunkSize: 16,
      noWarmup: false,
      noLatencyGate: false,
    });
    expect(parseArgs(["--out", "o", "--ground-truth-floor", "2"])).toEqual({
      error: "--ground-truth-floor must be a number in 0..1",
    });
  });
});

describe("buildManifest — model-major order and --no-warmup", () => {
  it("orders every case for the first model before the second model", () => {
    const entries = buildManifest(
      [
        baseCase({ id: "c-a", repeats: 1 }),
        baseCase({ id: "c-b", repeats: 1 }),
      ],
      ["m1", "m2"],
      undefined,
      { warmup: false },
    );
    expect(entries.map((e) => `${e.model}:${e.caseId}`)).toEqual([
      "m1:c-a",
      "m1:c-b",
      "m2:c-a",
      "m2:c-b",
    ]);
  });

  it("--no-warmup yields no warm-up slots", () => {
    const entries = buildManifest(
      [baseCase({ repeats: 2 })],
      ["m"],
      undefined,
      {
        warmup: false,
      },
    );
    expect(entries.some((e) => e.warmup)).toBe(false);
    expect(entries).toHaveLength(2);
  });
});

describe("shouldRetry — no re-fire of slots that stand as outcomes", () => {
  const entry = { task: "t", model: "m", promptFile: "p" };
  it("retries a plain transport skip", () => {
    expect(
      shouldRetry(
        makeEntryResult({ skipReason: "agy-not-authenticated" }),
        entry,
      ),
    ).toBe(true);
    expect(
      shouldRetry(makeEntryResult({ skipReason: "agy-timeout" }), entry),
    ).toBe(true);
  });

  it("never retries a quota refusal, even when its skip reason looks transport-class", () => {
    expect(
      shouldRetry(
        makeEntryResult({
          skipReason: "rate limit",
          failureClass: "quota-exhausted",
        }),
        entry,
      ),
    ).toBe(false);
  });

  it("never retries an agy-timeout on a case with a productionTimeout", () => {
    expect(
      shouldRetry(makeEntryResult({ skipReason: "agy-timeout" }), {
        ...entry,
        productionTimeout: "10m",
      }),
    ).toBe(false);
    // ...but other transport skips on that case still retry.
    expect(
      shouldRetry(makeEntryResult({ skipReason: "agy-not-authenticated" }), {
        ...entry,
        productionTimeout: "10m",
      }),
    ).toBe(true);
  });
});

describe("dispatchWithRetries — production-limit and quota slots are not re-fired", () => {
  const dispatchOpts = {
    concurrency: 1,
    maxCalls: 1,
    outDir: "out",
    delegateBin: "/b",
  };
  const countingFanout = (entry: EntryResult) => {
    const runFanout = vi.fn(
      async (): Promise<FanoutResult> => ({
        entries: [entry],
        anyRan: false,
        allSkipped: true,
        calls: { attempted: 1, ran: 0, skipped: 1, budget: 1 },
      }),
    );
    return {
      runFanout,
      deps: { runFanout, progress: vi.fn() } as unknown as Deps,
    };
  };

  it("dispatches an agy-timeout on a productionTimeout case exactly once", async () => {
    const { runFanout, deps } = countingFanout(
      makeEntryResult({ task: "t", skipReason: "agy-timeout" }),
    );
    const out = await dispatchWithRetries(
      deps,
      [{ task: "t", model: "m", promptFile: "p", productionTimeout: "10m" }],
      dispatchOpts,
    );
    expect(runFanout).toHaveBeenCalledTimes(1);
    expect(out[0]!.skipReason).toBe("agy-timeout");
  });

  it("dispatches a quota-refused slot exactly once and classifies it from its error text", async () => {
    const { runFanout, deps } = countingFanout(
      makeEntryResult({
        task: "t",
        skipReason: "agy-error",
        agyError: "Individual quota reached. Resets in 4h10m",
      }),
    );
    const out = await dispatchWithRetries(
      deps,
      [{ task: "t", model: "m", promptFile: "p" }],
      dispatchOpts,
    );
    expect(runFanout).toHaveBeenCalledTimes(1);
    expect(out[0]!.failureClass).toBe("quota-exhausted");
  });
});

describe("runBench — chunked, resumable dispatch with a quota halt", () => {
  const CASE = {
    id: "c1",
    surface: "scout",
    kind: "multi-file",
    promptFile: "prompt.md",
    inputFiles: ["a.ts"],
    repeats: 4,
    authoredAtCommit: "abc1234",
    routable: true,
  };

  function benchDeps(
    files: Map<string, string>,
    runFanout: Deps["runFanout"],
  ): Deps & { progress: ReturnType<typeof vi.fn> } {
    files.set("fixtures/c1/case.json", JSON.stringify(CASE));
    files.set("fixtures/c1/prompt.md", "prompt");
    files.set("fixtures/c1/a.ts", "input");
    return {
      readFile: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFile: (p: string, data: string) => void files.set(p, data),
      fileExists: (p: string) => files.has(p),
      mkdirp: () => {},
      readdir: () => ["c1"],
      progress: vi.fn(),
      preflight: () => ({ ok: true, message: "" }),
      gitHead: () => "deadbeef",
      agyVersion: () => "1.0.0",
      fileMtime: () => new Date("2026-01-01T00:00:00Z"),
      runFanout,
    } as Deps & { progress: ReturnType<typeof vi.fn> };
  }

  const ARGV = [
    "--fixtures",
    "fixtures",
    "--models",
    "m",
    "--no-warmup",
    "--delegate-bin",
    "/bin/flow-delegate.ts",
    "--out",
    "out",
  ];

  const okFanout =
    (log: string[][]): Deps["runFanout"] =>
    async (manifest): Promise<FanoutResult> => {
      log.push(manifest.map((m) => m.task));
      return {
        entries: manifest.map((m) =>
          makeEntryResult({ task: m.task, ran: true, artifactPath: m.out }),
        ),
        anyRan: true,
        allSkipped: false,
        calls: {
          attempted: manifest.length,
          ran: manifest.length,
          skipped: 0,
          budget: manifest.length,
        },
      };
    };

  it("stops after the first quota refusal, stores its class and reset, and exits 3", async () => {
    const files = new Map<string, string>();
    let chunks = 0;
    const deps = benchDeps(files, async (manifest): Promise<FanoutResult> => {
      chunks++;
      return {
        entries: manifest.map((m) =>
          chunks === 1
            ? makeEntryResult({
                task: m.task,
                ran: false,
                skipReason: "agy-error",
                agyError: "Individual quota reached. Resets in 92h31m22s",
              })
            : makeEntryResult({ task: m.task, ran: true }),
        ),
        anyRan: false,
        allSkipped: true,
        calls: {
          attempted: manifest.length,
          ran: 0,
          skipped: manifest.length,
          budget: manifest.length,
        },
      };
    });
    const code = await runBench([...ARGV, "--chunk-size", "2"], deps);
    expect(code).toBe(3);
    expect(chunks).toBe(1); // no further chunk after the refusal
    const rows = JSON.parse(files.get("out/results.json")!);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ran: false,
      failureClass: "quota-exhausted",
      resetsIn: "92h31m22s",
    });
    const said = deps.progress.mock.calls.map((c) => String(c[0])).join("");
    // 2 refused slots (no successful row) + 2 never dispatched.
    expect(said).toMatch(/4 slot\(s\) remain/);
    expect(said).toContain("92h31m22s");
  });

  it("writes results.json after every chunk so a crash loses at most one chunk", async () => {
    const files = new Map<string, string>();
    const writes: number[] = [];
    const deps = benchDeps(files, okFanout([]));
    const baseWrite = deps.writeFile;
    deps.writeFile = (p, data) => {
      if (p === "out/results.json") writes.push(JSON.parse(data).length);
      baseWrite(p, data);
    };
    expect(await runBench([...ARGV, "--chunk-size", "3"], deps)).toBe(0);
    expect(writes).toEqual([3, 4]);
  });

  it("--resume selects pending slots before --max-calls, so a second tranche dispatches new slots", async () => {
    const files = new Map<string, string>();
    const log1: string[][] = [];
    const first = benchDeps(files, okFanout(log1));
    expect(await runBench([...ARGV, "--max-calls", "2"], first)).toBe(0);
    expect(log1.flat()).toHaveLength(2);

    const log2: string[][] = [];
    const second = benchDeps(files, okFanout(log2));
    expect(
      await runBench([...ARGV, "--max-calls", "2", "--resume"], second),
    ).toBe(0);
    const firstTasks = new Set(log1.flat());
    expect(log2.flat()).toHaveLength(2);
    expect(log2.flat().some((t) => firstTasks.has(t))).toBe(false);
    expect(JSON.parse(files.get("out/results.json")!)).toHaveLength(4);
  });

  it("a missing results file reads as no prior rows under --resume", async () => {
    const files = new Map<string, string>();
    const log: string[][] = [];
    const deps = benchDeps(files, okFanout(log));
    expect(await runBench([...ARGV, "--resume"], deps)).toBe(0);
    expect(log.flat()).toHaveLength(4);
  });

  it("a resume keeps every earlier row's blinded id and rebuilds the packet from the merged file", async () => {
    const files = new Map<string, string>();
    const withText = (n: number): Deps => {
      const deps = benchDeps(files, okFanout([]));
      const read = deps.readFile;
      deps.readFile = (p) =>
        p.includes("/raw/") ? `answer ${p.split("--").pop()} #${n}` : read(p);
      return deps;
    };
    await runBench([...ARGV, "--max-calls", "2"], withText(1));
    const packet1 = JSON.parse(files.get("out/judge-packet.json")!);
    await runBench([...ARGV, "--max-calls", "2", "--resume"], withText(2));
    const packet2 = JSON.parse(files.get("out/judge-packet.json")!);
    expect(packet2).toHaveLength(4);
    expect(packet2.slice(0, 2)).toEqual(packet1);
  });

  it("a failed slot is re-dispatched on resume and its fresh success replaces it", async () => {
    const files = new Map<string, string>();
    let first = true;
    const flaky: Deps["runFanout"] = async (manifest) => ({
      entries: manifest.map((m, i) =>
        first && i === 0
          ? makeEntryResult({
              task: m.task,
              ran: false,
              skipReason: "agy-error",
            })
          : makeEntryResult({ task: m.task, ran: true }),
      ),
      anyRan: true,
      allSkipped: false,
      calls: {
        attempted: manifest.length,
        ran: manifest.length,
        skipped: 0,
        budget: manifest.length,
      },
    });
    await runBench(ARGV, benchDeps(files, flaky));
    first = false;
    const log: string[][] = [];
    await runBench([...ARGV, "--resume"], benchDeps(files, okFanout(log)));
    expect(log.flat()).toHaveLength(1);
    const rows = JSON.parse(files.get("out/results.json")!);
    expect(rows).toHaveLength(4);
    expect(rows.every((r: BenchResult) => r.ran)).toBe(true);
  });
});

describe("toFanoutEntries — production posture and limit", () => {
  const files = (c: BenchCase) =>
    fakeFs({
      [`fixtures/${c.id}/prompt.md`]: `read ${ADD_DIR_TOKEN} now`,
    });
  const entriesFor = (c: BenchCase, timeout?: string) => {
    const manifest = buildManifest([c], ["m"], 1, { warmup: false });
    return toFanoutEntries(manifest, [c], "fixtures", "out", files(c), timeout);
  };

  it("dispatches a case at exactly its productionTimeout, ahead of --timeout", () => {
    const c = baseCase({ id: "c-p", inputFiles: [], productionTimeout: "7m" });
    const [e] = entriesFor(c, "3m");
    expect(e!.timeout).toBe("7m");
    expect(e!.productionTimeout).toBe("7m");
  });

  it("falls back to --timeout, then to 15m, for a case with no productionTimeout", () => {
    const c = baseCase({ id: "c-p", inputFiles: [] });
    expect(entriesFor(c, "3m")[0]!.timeout).toBe("3m");
    expect(entriesFor(c)[0]!.timeout).toBe("15m");
    expect(entriesFor(c)[0]!.productionTimeout).toBeUndefined();
  });

  it("passes skipPermissions through and never adds addDirs to a skipPermissions entry", () => {
    const c = baseCase({ id: "c-p", inputFiles: [], skipPermissions: true });
    const [e] = entriesFor(c);
    expect(e!.skipPermissions).toBe(true);
    expect(e!.addDirs).toBeUndefined();
  });

  it("grants read access to the fixture-relative addDir and resolves the prompt placeholder to it", () => {
    const c = baseCase({ id: "c-p", inputFiles: [], addDir: "context" });
    const fs = files(c);
    const manifest = buildManifest([c], ["m"], 1, { warmup: false });
    const [e] = toFanoutEntries(manifest, [c], "fixtures", "out", fs);
    const abs = path.resolve("fixtures", "c-p", "context");
    expect(e!.addDirs).toEqual([abs]);
    expect(e!.skipPermissions).toBeUndefined();
    expect(fs.store.get(e!.promptFile!)).toBe(`read ${abs} now`);
  });
});

describe("committed fixtures — production limit and prompt drift", () => {
  const FIXTURES = path.resolve(__dirname, "fixtures", "model-bench");
  const loaded = loadCases(FIXTURES, {
    readdir: (d) => readdirSync(d),
    readFile: (p) => readFileSync(p, "utf8"),
    fileExists: (p) => existsSync(p),
  });
  if ("error" in loaded) throw new Error(loaded.error);
  const byId = new Map(loaded.map((c) => [c.id, c]));
  const caseOf = (id: string): BenchCase => {
    const c = byId.get(id);
    if (!c) throw new Error(`missing fixture ${id}`);
    return c;
  };
  const text = (id: string, file: string) =>
    readFileSync(path.join(FIXTURES, id, file), "utf8");

  it.each([
    ["c1-multifile-contract", DELEGATED_SCOUT_TIMEOUT],
    ["c2-planted-defects", DELEGATED_SCOUT_TIMEOUT],
    ["c2b-real-defect", DELEGATED_SCOUT_TIMEOUT],
    ["c4-intent-json", DELEGATE_TIMEOUT_DEFAULTS.intentGuess],
    ["c6-plan-review", REVIEWER_1_TIMEOUT],
    ["c7-review-lens", DELEGATE_TIMEOUT_DEFAULTS.reviewLens],
    ["c8-research-refute", RESEARCH_TIMEOUT],
    ["c11-research-gather", RESEARCH_TIMEOUT],
    ["c12-blind-survey", JUDGE_A_TIMEOUT],
  ])("%s carries its step's production limit", (id, limit) => {
    expect(caseOf(id).productionTimeout).toBe(limit);
  });

  it("carries the production web-search posture on c8 and c11, and read access on c12", () => {
    for (const id of ["c8-research-refute", "c11-research-gather"]) {
      expect(caseOf(id).skipPermissions).toBe(true);
      expect(caseOf(id).addDir).toBeUndefined();
    }
    expect(caseOf("c12-blind-survey").addDir).toBe("context");
    expect(caseOf("c12-blind-survey").skipPermissions).toBeUndefined();
    expect(existsSync(path.join(FIXTURES, "c12-blind-survey", "context"))).toBe(
      true,
    );
  });

  it("c11's prompt.md contains the gather prompt flow-research-run builds for the fixture task", () => {
    const task =
      "add CSV export that follows RFC 4180 for field quoting, quote escaping and line terminators";
    const [gather] = buildGatherManifest(task, {
      gatherModel: "g",
      refuteModel: "r",
      timeout: RESEARCH_TIMEOUT,
    });
    expect(text("c11-research-gather", "prompt.md")).toContain(gather!.prompt);
  });

  it("c12's prompt.md contains BLIND_FRAMING and each output heading of the survey prompt", () => {
    const prompt = text("c12-blind-survey", "prompt.md");
    expect(prompt).toContain(BLIND_FRAMING);
    const source = readFileSync(
      path.resolve(__dirname, "lib", "blind-survey-prompt.ts"),
      "utf8",
    );
    const headings = [...source.matchAll(/^### \d\. .+$/gm)].map((m) => m[0]);
    expect(headings).toHaveLength(4);
    for (const h of headings) expect(prompt).toContain(h);
    expect(prompt).toContain(ADD_DIR_TOKEN);
  });
});
