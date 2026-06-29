import { describe, expect, it, vi } from "vitest";
import {
  boundFindings,
  buildManifest,
  type Deps,
  type FanoutAggregate,
  interpretFanout,
  parseArgs,
  resolveModels,
  run,
} from "./flow-research-run";

describe("parseArgs", () => {
  it("requires --task, --out, --status-file", () => {
    expect(parseArgs([])).toEqual({ error: "--task is required" });
    expect(parseArgs(["--task", "x"])).toEqual({ error: "--out is required" });
    expect(parseArgs(["--task", "x", "--out", "f.md"])).toEqual({
      error: "--status-file is required",
    });
  });

  it("rejects a value-flag with no value", () => {
    expect(parseArgs(["--task"])).toEqual({
      error: "--task requires a value",
    });
  });

  it("parses a full arg set and defaults --config", () => {
    const args = parseArgs([
      "--task",
      "add CSV export",
      "--out",
      "/wt/.flow-tmp/research-findings.md",
      "--status-file",
      "/wt/.flow-tmp/research-status.json",
    ]);
    expect(args).toMatchObject({
      task: "add CSV export",
      out: "/wt/.flow-tmp/research-findings.md",
      statusFile: "/wt/.flow-tmp/research-status.json",
    });
    expect((args as { config: string }).config).toMatch(
      /\.flow\/config\.json$/,
    );
  });
});

describe("buildManifest", () => {
  it("produces exactly 2 entries (gather + refute) carrying model and resolved timeout", () => {
    const m = buildManifest("add CSV export", {
      gatherModel: "Gemini 3.1 Pro (High)",
      refuteModel: "Claude Opus 4.6 (Thinking)",
      timeout: "3m",
    });
    expect(m).toHaveLength(2);
    for (const entry of m) {
      expect(typeof entry.model).toBe("string");
      expect(entry.model.length).toBeGreaterThan(0);
      expect(entry.timeout).toBe("3m");
      expect(entry.prompt).toContain("add CSV export");
    }
    expect(m[0]!.model).toBe("Gemini 3.1 Pro (High)");
    expect(m[1]!.model).toBe("Claude Opus 4.6 (Thinking)");
  });

  it("frames the gather prompt around web search + cited URLs + confidence", () => {
    const [gather] = buildManifest("X", {
      gatherModel: "Gemini 3.1 Pro (High)",
      refuteModel: "Claude Opus 4.6 (Thinking)",
      timeout: "3m",
    });
    expect(gather!.prompt).toMatch(/web search/i);
    expect(gather!.prompt).toMatch(/cited source URLs/i);
    expect(gather!.prompt).toMatch(/confidence/i);
  });

  it("frames the refute prompt adversarially (refute / critically assess)", () => {
    const [, refute] = buildManifest("X", {
      gatherModel: "Gemini 3.1 Pro (High)",
      refuteModel: "Claude Opus 4.6 (Thinking)",
      timeout: "3m",
    });
    expect(refute!.prompt).toMatch(/refute/i);
    expect(refute!.prompt).toMatch(/critically assess/i);
  });
});

describe("resolveModels (cross-model diversity guard)", () => {
  it("applies the frozen defaults when config is empty/garbage", () => {
    expect(resolveModels({})).toEqual({
      gatherModel: "Gemini 3.1 Pro (High)",
      refuteModel: "Claude Opus 4.6 (Thinking)",
    });
    expect(resolveModels(null)).toEqual({
      gatherModel: "Gemini 3.1 Pro (High)",
      refuteModel: "Claude Opus 4.6 (Thinking)",
    });
  });

  it("honours explicit overrides when they differ", () => {
    expect(
      resolveModels({
        research: {
          model: "GPT-OSS 120B (Medium)",
          refuteModel: "Claude Opus 4.6 (Thinking)",
        },
      }),
    ).toEqual({
      gatherModel: "GPT-OSS 120B (Medium)",
      refuteModel: "Claude Opus 4.6 (Thinking)",
    });
  });

  it("falls back to GPT-OSS when both resolve to Opus (gather is Opus)", () => {
    const r = resolveModels({
      research: {
        model: "Claude Opus 4.6 (Thinking)",
        refuteModel: "Claude Opus 4.6 (Thinking)",
      },
    });
    expect(r.gatherModel).toBe("Claude Opus 4.6 (Thinking)");
    expect(r.refuteModel).toBe("GPT-OSS 120B (Medium)");
    expect(r.refuteModel).not.toBe(r.gatherModel);
  });

  it("falls back to Opus on a collision where gather is not Opus", () => {
    const r = resolveModels({
      research: {
        model: "GPT-OSS 120B (Medium)",
        refuteModel: "GPT-OSS 120B (Medium)",
      },
    });
    expect(r.refuteModel).toBe("Claude Opus 4.6 (Thinking)");
    expect(r.refuteModel).not.toBe(r.gatherModel);
  });
});

describe("interpretFanout", () => {
  it("returns agy-unavailable on an allSkipped aggregate", () => {
    expect(interpretFanout({ allSkipped: true, anyRan: false })).toEqual({
      ran: false,
      reason: "agy-unavailable",
    });
  });

  it("returns ran on a normal aggregate", () => {
    expect(interpretFanout({ allSkipped: false, anyRan: true })).toEqual({
      ran: true,
      reason: "ran",
    });
  });

  it("treats a malformed/empty aggregate as agy-unavailable", () => {
    expect(interpretFanout({}).ran).toBe(false);
  });

  it("returns agy-unavailable when the fanout explicitly reports nothing ran (anyRan:false)", () => {
    // Isolates the `anyRan !== false` tightening: `allSkipped:false` alone would
    // read as ran without that clause, and the `{}` case short-circuits on the
    // first clause without exercising it. Deleting `&& aggregate.anyRan !== false`
    // from interpretFanout must turn THIS case red.
    expect(interpretFanout({ allSkipped: false, anyRan: false })).toEqual({
      ran: false,
      reason: "agy-unavailable",
    });
  });

  it("keeps the lenient side: allSkipped:false with anyRan absent still ran", () => {
    expect(interpretFanout({ allSkipped: false })).toEqual({
      ran: true,
      reason: "ran",
    });
  });
});

describe("boundFindings", () => {
  it("includes the heading and a refute caveat", () => {
    const out = boundFindings(
      "some grounded claim [high]",
      "this is uncertain",
    );
    expect(out).toContain("## Research findings (web-grounded, forced)");
    expect(out).toContain("some grounded claim");
    expect(out).toMatch(/Adversarial cross-check.*caveat/i);
    expect(out).toContain("this is uncertain");
  });

  it("caps long gather text with a truncation marker", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const out = boundFindings(long, "");
    expect(out).toContain("_[research findings truncated for brevity]_");
    expect(out).not.toContain("line 150");
  });

  it("handles empty gather text gracefully", () => {
    const out = boundFindings("", "");
    expect(out).toContain("## Research findings (web-grounded, forced)");
    expect(out).toContain("No web-grounded findings were returned");
  });
});

type Recorder = Deps & {
  files: Map<string, string>;
  out: string[];
  err: string[];
};

function makeDeps(
  runFanout: Deps["runFanout"],
  overrides: Partial<Deps> = {},
): Recorder {
  const files = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const base: Deps = {
    readConfig: () => "{}",
    runFanout,
    readFile: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    writeFile: (p, c) => {
      files.set(p, c);
    },
    removeFile: (p) => {
      files.delete(p);
    },
    mkdirp: () => {},
    writeOut: (line) => out.push(line),
    writeErr: (line) => err.push(line),
  };
  return Object.assign(base, overrides, { files, out, err });
}

const ARGV = [
  "--task",
  "add CSV export",
  "--out",
  "/wt/.flow-tmp/research-findings.md",
  "--status-file",
  "/wt/.flow-tmp/research-status.json",
];
const OUT = "/wt/.flow-tmp/research-findings.md";
const STATUS = "/wt/.flow-tmp/research-status.json";

describe("run — injected fanout stub", () => {
  it("writes status {ran:false,reason:agy-unavailable} and exits 0 when agy is down", () => {
    const deps = makeDeps(() => ({ allSkipped: true, anyRan: false }));
    expect(run(ARGV, deps)).toBe(0);
    expect(JSON.parse(deps.files.get(STATUS)!)).toEqual({
      active: true,
      ran: false,
      reason: "agy-unavailable",
    });
    // No findings file written on the skip path.
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("writes findings + status {ran:true} and exits 0 on a successful aggregate", () => {
    const aggregate: FanoutAggregate = {
      allSkipped: false,
      anyRan: true,
      entries: [
        {
          task: "research-gather",
          ran: true,
          artifactPath: "/wt/.flow-tmp/g.md",
        },
        {
          task: "research-refute",
          ran: true,
          artifactPath: "/wt/.flow-tmp/r.md",
        },
      ],
    };
    const deps = makeDeps(() => aggregate);
    deps.files.set("/wt/.flow-tmp/g.md", "RFC 4180 requires quoting [high]");
    deps.files.set(
      "/wt/.flow-tmp/r.md",
      "but line terminators vary by importer",
    );
    expect(run(ARGV, deps)).toBe(0);
    expect(JSON.parse(deps.files.get(STATUS)!)).toEqual({
      active: true,
      ran: true,
      reason: "ran",
    });
    const findings = deps.files.get(OUT)!;
    expect(findings).toContain("## Research findings (web-grounded, forced)");
    expect(findings).toContain("RFC 4180 requires quoting");
    expect(findings).toContain("line terminators vary");
  });

  it("degrades to a graceful skip (exit 0) when the fanout runner throws", () => {
    const deps = makeDeps(() => {
      throw new Error("spawn failed");
    });
    expect(run(ARGV, deps)).toBe(0);
    expect(JSON.parse(deps.files.get(STATUS)!)).toEqual({
      active: true,
      ran: false,
      reason: "agy-unavailable",
    });
  });

  it("returns 2 on a missing required flag", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run(["--task", "x"])).toBe(2);
    errSpy.mockRestore();
  });
});
