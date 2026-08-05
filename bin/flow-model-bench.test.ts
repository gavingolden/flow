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
});
