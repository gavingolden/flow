import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest as buildGatherManifest } from "../../../bin/flow-research-run";
import {
  AGENT_FINDINGS_JSON_SCHEMA,
  buildPrompt as buildLensPrompt,
} from "../../../bin/flow-gemini-lens";
import {
  buildPrompt as buildIntentPrompt,
  changedFileList,
} from "../../../bin/flow-gemini-intent-guess";
import {
  buildBatteryPrompt,
  extractGoalLine,
} from "../../../bin/lib/plan-review-prompt";
import { buildSurveyPrompt } from "../../../bin/lib/blind-survey-prompt";
import { readFileSync } from "node:fs";
import {
  answerBytes,
  buildProbeManifest,
  DEFAULT_REPEATS,
  GATHER_CAP_SENTENCE,
  parseArgs,
  type ProbeRecord,
  recordsDocument,
  runProbe,
  sizeLimit,
  sizeLimits,
  toProbeRecord,
} from "./run";

const INPUTS = join(__dirname, "inputs");
const WORKTREE = "/wt";
const HIGH = "Gemini 4 Argon (High)";
const MED = "Gemini 4 Argon (Medium)";
const read = (name: string) => readFileSync(join(INPUTS, name), "utf8");

function manifest(
  overrides: Partial<Parameters<typeof buildProbeManifest>[0]> = {},
) {
  const written = new Map<string, string>();
  const entries = buildProbeManifest({
    models: [HIGH, MED],
    repeats: {
      "research-gather": 1,
      "plan-review": 1,
      "blind-survey": 1,
      "intent-guess": 1,
      "review-lens": 1,
    },
    worktree: WORKTREE,
    inputsDir: INPUTS,
    timeout: "20m",
    outDir: "/out",
    io: {
      readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, d) => void written.set(p, d),
    },
    ...overrides,
  });
  const prompt = (e: { promptFile?: string }) => written.get(e.promptFile!)!;
  const first = (surface: string) =>
    entries.find((e) => e.task.startsWith(`${surface}__`))!;
  return { entries, written, prompt, first };
}

describe("buildProbeManifest — production builders and posture", () => {
  it("research gather: production gather prompt, skipPermissions, no addDirs", () => {
    const { first, prompt } = manifest();
    const e = first("research-gather");
    const prod = buildGatherManifest(read("research-question.md").trim(), {
      gatherModel: HIGH,
      refuteModel: HIGH,
      timeout: "20m",
    })[0]!;
    expect(prompt(e)).toBe(prod.prompt);
    expect(e.skipPermissions).toBe(true);
    expect(e.addDirs).toBeUndefined();
    expect(e.outputFormat).toBe("json");
  });

  it("plan review: buildBatteryPrompt output with addDirs [worktree]", () => {
    const { first, prompt } = manifest();
    const e = first("plan-review");
    const plan = read("plan.md");
    expect(prompt(e)).toBe(
      buildBatteryPrompt({
        planText: plan,
        goalLine: extractGoalLine(plan),
        worktreePath: WORKTREE,
      }),
    );
    expect(e.addDirs).toEqual([WORKTREE]);
    expect(e.skipPermissions).toBeUndefined();
  });

  it("blind survey: buildSurveyPrompt output with addDirs [worktree]", () => {
    const { first, prompt } = manifest();
    const e = first("blind-survey");
    expect(prompt(e)).toBe(
      buildSurveyPrompt({
        brief: read("survey-brief.md"),
        worktreePath: WORKTREE,
      }),
    );
    expect(e.addDirs).toEqual([WORKTREE]);
  });

  it("intent guess and lens: each helper's exported buildPrompt, json output with a wire schema", () => {
    const { first, prompt, written } = manifest();
    const diff = read("pr-941.diff");
    const intent = first("intent-guess");
    expect(prompt(intent)).toBe(
      buildIntentPrompt(diff, changedFileList(diff), WORKTREE),
    );
    const lens = first("review-lens");
    expect(prompt(lens)).toBe(buildLensPrompt(diff, WORKTREE));
    for (const e of [intent, lens]) {
      expect(e.addDirs).toEqual([WORKTREE]);
      expect(e.outputFormat).toBe("json");
      expect(written.has(e.jsonSchema!)).toBe(true);
    }
    expect(JSON.parse(written.get(lens.jsonSchema!)!)).toEqual(
      AGENT_FINDINGS_JSON_SCHEMA,
    );
  });

  it("dispatches every entry at the probe cap with a unique task per (surface, repeat, model)", () => {
    const { entries } = manifest();
    expect(entries.every((e) => e.timeout === "20m")).toBe(true);
    expect(new Set(entries.map((e) => e.task)).size).toBe(entries.length);
    expect(entries).toHaveLength(10);
  });

  it("honours repeats and pairs the models within each repeat", () => {
    const { entries } = manifest({
      repeats: {
        ...DEFAULT_REPEATS,
        "intent-guess": 2,
        "review-lens": 0,
        "research-gather": 0,
        "plan-review": 0,
        "blind-survey": 0,
      },
    });
    expect(entries.map((e) => `${e.task.split("__")[1]}:${e.model}`)).toEqual([
      `r1:${HIGH}`,
      `r1:${MED}`,
      `r2:${HIGH}`,
      `r2:${MED}`,
    ]);
  });

  it("--capped-gather adds High-only research-gather-capped entries carrying the cap sentence", () => {
    const { entries, prompt } = manifest({ cappedGather: true });
    const capped = entries.filter((e) =>
      e.task.startsWith("research-gather-capped__"),
    );
    expect(capped).toHaveLength(3);
    expect(capped.every((e) => e.model === HIGH)).toBe(true);
    const plain = prompt(
      entries.find((e) => e.task.startsWith("research-gather__"))!,
    );
    expect(prompt(capped[0]!)).toBe(`${plain}${GATHER_CAP_SENTENCE}`);
    expect(prompt(capped[0]!)).toContain(
      "at most 3 searches and read at most 8 pages",
    );
    expect(capped[0]!.skipPermissions).toBe(true);
  });
});

const rec = (over: Partial<ProbeRecord>): ProbeRecord => ({
  surface: "plan-review",
  model: HIGH,
  repeat: 1,
  wallSec: 100,
  ran: true,
  empty: false,
  timedOut: false,
  outputBytes: 10,
  deniedActions: [],
  ...over,
});

describe("sizeLimit", () => {
  it("floors at 10m when 3x the median is below it", () => {
    expect(
      sizeLimit(
        [rec({ wallSec: 100 }), rec({ wallSec: 150 }), rec({ wallSec: 200 })],
        HIGH,
      ),
    ).toEqual({
      limit: "10m",
      verdict: "fits",
      medianSec: 150,
    });
  });

  it("uses ceil(3 x median / 60) minutes above the floor", () => {
    const r = sizeLimit(
      [rec({ wallSec: 250 }), rec({ wallSec: 300 }), rec({ wallSec: 310 })],
      HIGH,
    );
    expect(r.limit).toBe("15m");
    expect(r.verdict).toBe("fits");
    expect(sizeLimit([rec({ wallSec: 301 })], HIGH).limit).toBe("16m");
  });

  it("caps at 20m and reports limit-mismatch above it", () => {
    expect(
      sizeLimit([rec({ wallSec: 500 }), rec({ wallSec: 500 })], HIGH),
    ).toEqual({
      limit: "20m",
      verdict: "limit-mismatch",
      medianSec: 500,
    });
    expect(sizeLimit([rec({ wallSec: 400 })], HIGH).verdict).toBe("fits");
  });

  it("stalls when at least 2/3 of the model's calls are empty", () => {
    const stalled = [
      rec({ empty: true, timedOut: true, ran: false }),
      rec({ empty: true }),
      rec({ wallSec: 90 }),
    ];
    expect(sizeLimit(stalled, HIGH).verdict).toBe("stalls");
    expect(
      sizeLimit([rec({ empty: true }), rec({}), rec({})], HIGH).verdict,
    ).toBe("fits");
  });

  it("only reads the named model's records", () => {
    expect(
      sizeLimit(
        [rec({ wallSec: 100 }), rec({ model: MED, wallSec: 500 })],
        HIGH,
      ).medianSec,
    ).toBe(100);
    expect(() => sizeLimit([rec({})], MED)).toThrow(/no measured probe/);
  });

  it("leaves never-attempted calls (agy not authenticated) out of the median and the empty share", () => {
    const unauthenticated = rec({ ran: false, wallSec: 0.05 });
    expect(
      sizeLimit([unauthenticated, rec({ wallSec: 500 })], HIGH).medianSec,
    ).toBe(500);
    expect(
      sizeLimit(
        [unauthenticated, unauthenticated, rec({ empty: true }), rec({})],
        HIGH,
      ).verdict,
    ).toBe("fits");
  });

  it("rejects sizing when no record was a measured attempt", () => {
    expect(() => sizeLimit([rec({ ran: false, wallSec: 0.05 })], HIGH)).toThrow(
      /no measured probe/,
    );
  });

  it("keeps real timeouts and empty answers as measured failures", () => {
    expect(
      sizeLimit(
        [
          rec({ ran: false, timedOut: true, empty: true }),
          rec({ empty: true }),
        ],
        HIGH,
      ).verdict,
    ).toBe("stalls");
  });
});

describe("sizeLimits", () => {
  it("sizes each surface per model — a step can stall on High and fit on Medium", () => {
    const records = [
      rec({
        surface: "research-gather",
        model: HIGH,
        empty: true,
        ran: false,
        timedOut: true,
        wallSec: 1200,
      }),
      rec({
        surface: "research-gather",
        model: HIGH,
        empty: true,
        ran: false,
        timedOut: true,
        wallSec: 1200,
      }),
      rec({ surface: "research-gather", model: HIGH, wallSec: 200 }),
      rec({ surface: "research-gather", model: MED, wallSec: 120 }),
      rec({ surface: "research-gather", model: MED, wallSec: 140 }),
      rec({ surface: "research-gather", model: MED, wallSec: 160 }),
      rec({ surface: "research-gather-capped", model: HIGH, wallSec: 90 }),
    ];
    const limits = sizeLimits(records);
    expect(limits["research-gather"][HIGH]!.verdict).toBe("stalls");
    expect(limits["research-gather"][MED]).toEqual({
      limit: "10m",
      verdict: "fits",
      medianSec: 140,
    });
    expect(limits["research-gather-capped"]![HIGH]!.verdict).toBe("fits");
    expect(limits["plan-review"]).toEqual({});
  });
});

describe("toProbeRecord", () => {
  const entry = { task: "plan-review__r2__gemini-4-argon-high", model: HIGH };

  it("maps the pool's durationMs to wallSec and the task to surface/repeat", () => {
    expect(
      toProbeRecord(
        entry,
        { task: entry.task, model: HIGH, ran: true, durationMs: 123456 },
        42,
      ),
    ).toEqual({
      surface: "plan-review",
      model: HIGH,
      repeat: 2,
      wallSec: 123.456,
      ran: true,
      empty: false,
      timedOut: false,
      outputBytes: 42,
      deniedActions: [],
    });
  });

  it("marks a ran call with a zero-byte answer empty", () => {
    expect(
      toProbeRecord(
        entry,
        { task: entry.task, model: HIGH, ran: true, durationMs: 1000 },
        0,
      ).empty,
    ).toBe(true);
  });

  it("marks agy-timeout as timedOut and empty, and keeps denied actions", () => {
    const r = toProbeRecord(entry, {
      task: entry.task,
      model: HIGH,
      ran: false,
      skipReason: "agy-timeout",
      durationMs: 1200000,
      deniedActions: ["browser"],
    });
    expect(r).toMatchObject({
      ran: false,
      timedOut: true,
      empty: true,
      wallSec: 1200,
      deniedActions: ["browser"],
    });
  });

  it("does not call another skip (auth) empty", () => {
    expect(
      toProbeRecord(entry, {
        task: entry.task,
        model: HIGH,
        ran: false,
        skipReason: "agy-not-authenticated",
        durationMs: 50,
      }).empty,
    ).toBe(false);
  });

  it("rejects a task that is not a probe task name", () => {
    expect(() =>
      toProbeRecord(
        { task: "other" },
        { task: "other", model: null, ran: true },
      ),
    ).toThrow();
  });
});

describe("answerBytes", () => {
  it("measures structured_output, then response, then raw text", () => {
    expect(answerBytes(JSON.stringify({ structured_output: { a: 1 } }))).toBe(
      7,
    );
    expect(answerBytes(JSON.stringify({ response: "  hello " }))).toBe(5);
    expect(answerBytes(JSON.stringify({ response: "" }))).toBe(0);
    expect(answerBytes("plain text\n")).toBe(10);
  });
});

describe("parseArgs", () => {
  it("requires --worktree and --out and applies the production repeat defaults", () => {
    expect(parseArgs([])).toEqual({
      error: "--worktree and --out are required",
    });
    const a = parseArgs(["--worktree", "/w", "--out", "/o"]);
    expect(a).toMatchObject({
      models: [HIGH, MED],
      timeout: "20m",
      repeats: DEFAULT_REPEATS,
      cappedGather: false,
    });
  });

  it("parses --repeats, --surfaces and --capped-gather", () => {
    const a = parseArgs([
      "--worktree",
      "/w",
      "--out",
      "/o",
      "--repeats",
      "plan-review=1",
      "--surfaces",
      "plan-review,blind-survey",
      "--capped-gather",
    ]);
    expect(a).toMatchObject({
      cappedGather: true,
      repeats: {
        "plan-review": 1,
        "blind-survey": 3,
        "research-gather": 0,
        "intent-guess": 0,
        "review-lens": 0,
      },
    });
    expect(
      parseArgs(["--worktree", "/w", "--out", "/o", "--surfaces", "bogus"]),
    ).toEqual({ error: "unknown surface: bogus" });
  });
});

describe("runProbe", () => {
  const args = () => {
    const a = parseArgs([
      "--worktree",
      "/wt",
      "--out",
      "/out",
      "--surfaces",
      "intent-guess",
      "--repeats",
      "intent-guess=2",
    ]);
    if ("error" in a) throw new Error(a.error);
    return a;
  };
  const io = (written: Map<string, string>) => ({
    readFile: (p: string) => readFileSync(p, "utf8"),
    writeFile: (p: string, d: string) => void written.set(p, d),
  });

  it("stops at the first quota refusal (exit 3) and keeps the earlier records", async () => {
    const dispatched: string[] = [];
    const writes = new Map<string, string>();
    const out: string[] = [];
    const code = await runProbe(args(), {
      writeOut: (l) => void out.push(l),
      io: io(new Map()),
      writeRecords: (p, d) => void writes.set(p, d),
      progress: () => {},
      now: () => new Date("2026-10-19T00:00:00Z"),
      dispatch: async (e) => {
        dispatched.push(e.task);
        return dispatched.length === 3
          ? {
              task: e.task,
              model: e.model ?? null,
              ran: false,
              skipReason: "agy-error",
              failureClass: "quota-exhausted",
            }
          : {
              task: e.task,
              model: e.model ?? null,
              ran: false,
              skipReason: "agy-timeout",
              durationMs: 1000,
            };
      },
    });
    expect(code).toBe(3);
    expect(dispatched).toHaveLength(3);
    const doc = JSON.parse(writes.get("/out/records.json")!);
    expect(doc.records).toHaveLength(2);
    expect(JSON.parse(out[0]!)).toEqual({ code: 3, recorded: 2, planned: 4 });
    expect(doc.records.every((r: ProbeRecord) => r.timedOut)).toBe(true);
  });

  it("merges into the earlier records: re-measured surfaces are replaced, others kept", async () => {
    const writes = new Map<string, string>();
    const prior = [
      rec({ surface: "plan-review", wallSec: 111 }),
      rec({ surface: "intent-guess", wallSec: 999 }),
    ];
    const out: string[] = [];
    await runProbe(args(), {
      writeOut: (l) => void out.push(l),
      io: io(new Map()),
      readPrior: () => prior,
      writeRecords: (p, d) => void writes.set(p, d),
      progress: () => {},
      now: () => new Date("2026-10-19T00:00:00Z"),
      dispatch: async (e) => ({
        task: e.task,
        model: e.model ?? null,
        ran: false,
        skipReason: "agy-timeout",
        durationMs: 1000,
      }),
    });
    const doc = JSON.parse(writes.get("/out/records.json")!);
    expect(doc.records).toHaveLength(5);
    expect(
      doc.records.filter((r: ProbeRecord) => r.surface === "plan-review"),
    ).toHaveLength(1);
    expect(
      doc.records.filter((r: ProbeRecord) => r.surface === "intent-guess"),
    ).toHaveLength(4);
    expect(doc.records.every((r: ProbeRecord) => r.wallSec !== 999)).toBe(true);
    expect(JSON.parse(out[0]!)).toEqual({ code: 0, recorded: 4, planned: 4 });
  });

  it("recordsDocument carries measuredAt, records and per-surface limits", () => {
    const doc = JSON.parse(recordsDocument([rec({})], "2026-10-19T00:00:00Z"));
    expect(Object.keys(doc)).toEqual(["measuredAt", "records", "limits"]);
    expect(doc.limits["plan-review"][HIGH].verdict).toBe("fits");
  });
});
