import { describe, expect, it, vi } from "vitest";
import {
  buildManifest,
  toFanoutEntries,
  blind,
  classifyPreflight,
  dispatchWithRetries,
  runBench,
  type Deps,
} from "./flow-model-bench";
import type { BenchCase, BenchResult } from "./lib/model-bench-schema";
import { isTransportSkip } from "./lib/model-bench-manifest";
import type { EntryResult, FanoutResult } from "./flow-delegate-fanout";

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
});
