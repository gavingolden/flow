import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JUDGE_A_TIMEOUT,
  JUDGE_B_TIMEOUT,
  parseArgs,
  run,
  type Deps,
  type FanoutAggregate,
} from "./flow-blind-survey";

const MODEL_A = "Gemini 3.1 Pro (High)";
const MODEL_B = "Claude Opus 4.6 (Thinking)";

const JUDGE_PROSE =
  '### 1. Goal as understood\n\nShip a way to validate the user\'s method.\n\n### 2. Recommended method\n\n"Add a supervisor-side blind survey before discovery drafts a plan." It runs two model-pinned judges over a goal-only brief.\n\n### 3. Alternatives considered and why not\n\nA Task-tool judge sub-agent — rejected, off-limits by policy.\n\n### 4. Risks and what would change your mind\n\nCosts one extra fan-out call per feature pipeline.';

const BRIEF =
  "Ship a way to validate the user's proposed method before building it, so the pipeline builds the right thing.";
const DESCRIPTION =
  "Add a Task subagent that reads the whole plan and vetoes it before implementation starts.\nPause the pipeline and ask before proceeding.";

const BRIEF_FILE = "/wt/.flow-tmp/blind-survey-brief.md";
const DESCRIPTION_FILE = "/wt/.flow-tmp/blind-survey-description.txt";
const OUT = "/wt/.flow-tmp/blind-survey.md";
const WORKTREE = "/wt";
const BASE_ARGV = [
  "--brief-file",
  BRIEF_FILE,
  "--description-file",
  DESCRIPTION_FILE,
  "--out",
  OUT,
  "--worktree",
  WORKTREE,
];

function makeDeps(overrides: Partial<Deps> = {}): Deps & {
  calls: {
    fanout: Array<{
      manifestPath: string;
      outPath: string;
      concurrency: number;
    }>;
    writes: Array<{ path: string; contents: string }>;
    removed: string[];
    out: string[];
  };
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const calls = {
    fanout: [] as Array<{
      manifestPath: string;
      outPath: string;
      concurrency: number;
    }>,
    writes: [] as Array<{ path: string; contents: string }>,
    removed: [] as string[],
    out: [] as string[],
  };
  const base: Deps = {
    runFanout: (input) => {
      calls.fanout.push(input);
      let manifest: Array<{ task: string; model: string; out?: string }> = [];
      try {
        manifest = JSON.parse(files.get(input.manifestPath) ?? "[]");
      } catch {
        manifest = [];
      }
      const entries = manifest.map((m, i) => {
        const artifactPath = m.out ?? `${input.outPath}.artifact.${i}.md`;
        files.set(artifactPath, JUDGE_PROSE);
        return { task: m.task, model: m.model, ran: true, artifactPath };
      });
      return {
        entries,
        anyRan: entries.length > 0,
        allSkipped: entries.length === 0,
      } as FanoutAggregate;
    },
    readFile: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    writeFile: (p, c) => {
      calls.writes.push({ path: p, contents: c });
      files.set(p, c);
    },
    removeFile: (p) => {
      calls.removed.push(p);
      files.delete(p);
    },
    mkdirp: () => {},
    writeOut: (line) => calls.out.push(line),
    dirExists: () => true,
  };
  files.set(BRIEF_FILE, BRIEF);
  files.set(DESCRIPTION_FILE, DESCRIPTION);
  return Object.assign(base, overrides, { calls, files });
}

const envelope = (deps: { calls: { out: string[] } }) =>
  JSON.parse(deps.calls.out[0] as string);

describe("parseArgs", () => {
  it("requires every flag", () => {
    expect(parseArgs([])).toEqual({ error: "--brief-file is required" });
    expect(parseArgs(["--brief-file", "/b.md"])).toEqual({
      error: "--description-file is required",
    });
    expect(
      parseArgs(["--brief-file", "/b.md", "--description-file", "/d.txt"]),
    ).toEqual({ error: "--out is required" });
  });

  it("--worktree is optional at parse time (checked at run() time instead)", () => {
    expect(
      parseArgs([
        "--brief-file",
        "/b.md",
        "--description-file",
        "/d.txt",
        "--out",
        "/o.md",
      ]),
    ).toMatchObject({
      briefFile: "/b.md",
      descriptionFile: "/d.txt",
      out: "/o.md",
      worktree: undefined,
    });
  });

  it("parses a full arg set", () => {
    expect(parseArgs(BASE_ARGV)).toEqual({
      briefFile: BRIEF_FILE,
      descriptionFile: DESCRIPTION_FILE,
      out: OUT,
      worktree: WORKTREE,
    });
  });

  it("rejects an unknown flag (e.g. --config, deliberately dropped)", () => {
    expect(parseArgs([...BASE_ARGV, "--config", "/c.json"])).toEqual({
      error: "unknown flag: --config",
    });
  });

  it("rejects a value-flag with no value", () => {
    expect(parseArgs(["--brief-file"])).toEqual({
      error: "--brief-file requires a value",
    });
  });
});

describe("run — brief-not-blind (mechanical blindness guard)", () => {
  it("fires on a verbatim 8-word run from the description, with no fanout call", () => {
    const deps = makeDeps({
      readFile: (p) => {
        if (p === BRIEF_FILE) {
          return "We should add a Task subagent that reads the whole plan and vetoes it.";
        }
        if (p === DESCRIPTION_FILE) return DESCRIPTION;
        throw new Error(`ENOENT: ${p}`);
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "brief-not-blind",
    });
    expect(deps.calls.fanout).toHaveLength(0);
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("fires on a run copied from a digest-answer line appended to the description", () => {
    const deps = makeDeps({
      readFile: (p) => {
        if (p === BRIEF_FILE) {
          return "The plan should pause the pipeline and ask before proceeding with implementation.";
        }
        if (p === DESCRIPTION_FILE) return DESCRIPTION;
        throw new Error(`ENOENT: ${p}`);
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "brief-not-blind",
    });
    expect(deps.calls.fanout).toHaveLength(0);
  });
});

describe("run — happy path", () => {
  it("builds a 2-entry manifest at concurrency 1 with the pinned models/timeouts/addDirs", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(deps.calls.fanout).toHaveLength(1);
    expect(deps.calls.fanout[0]!.concurrency).toBe(1);
    const manifestWrite = deps.calls.writes.find(
      (w) => w.path === deps.calls.fanout[0]!.manifestPath,
    )!;
    const manifest = JSON.parse(manifestWrite.contents);
    expect(manifest).toHaveLength(2);
    expect(manifest[0]).toMatchObject({
      model: MODEL_A,
      timeout: JUDGE_A_TIMEOUT,
      addDirs: [WORKTREE],
    });
    expect(manifest[1]).toMatchObject({
      model: MODEL_B,
      timeout: JUDGE_B_TIMEOUT,
      addDirs: [WORKTREE],
    });
  });

  it("writes a prompt file per judge containing the brief and BLIND_FRAMING, never the description text", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const promptWrites = deps.calls.writes.filter((w) =>
      w.path.includes(".prompt"),
    );
    expect(promptWrites.length).toBeGreaterThanOrEqual(1);
    for (const w of promptWrites) {
      expect(w.contents).toContain(BRIEF);
      expect(w.contents).toMatch(
        /you do not know what solution the requester has in mind/,
      );
      expect(w.contents).not.toContain(DESCRIPTION.split("\n")[0]);
    }
  });

  it("emits ran:true with the survey file starting with the v1 marker", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    const env = envelope(deps);
    expect(env.ran).toBe(true);
    expect(env.surveyPath).toBe(OUT);
    expect(env.skipReason).toBeNull();
    expect(
      deps.files.get(OUT)!.startsWith("<!-- flow-blind-survey v1 -->"),
    ).toBe(true);
  });

  it("cleans up scratch siblings on success", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    expect(deps.files.has(`${OUT}.judge-a.prompt`)).toBe(false);
    expect(deps.files.has(`${OUT}.judge-b.prompt`)).toBe(false);
    expect(deps.files.has(`${OUT}.fanout-manifest.json`)).toBe(false);
    expect(deps.files.has(OUT)).toBe(true);
  });
});

describe("run — worktree gate", () => {
  it("skips with worktree-not-provided when --worktree is omitted", () => {
    const deps = makeDeps();
    const argv = [
      "--brief-file",
      BRIEF_FILE,
      "--description-file",
      DESCRIPTION_FILE,
      "--out",
      OUT,
    ];
    expect(run(argv, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "worktree-not-provided",
    });
    expect(deps.calls.fanout).toHaveLength(0);
  });

  it("skips with worktree-not-found when --worktree does not exist", () => {
    const deps = makeDeps({ dirExists: () => false });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "worktree-not-found",
    });
    expect(deps.calls.fanout).toHaveLength(0);
  });
});

describe("run — input files", () => {
  it("skips with brief-unreadable when the brief file read throws", () => {
    const deps = makeDeps({
      readFile: (p) => {
        if (p === BRIEF_FILE) throw new Error("ENOENT");
        if (p === DESCRIPTION_FILE) return DESCRIPTION;
        throw new Error(`ENOENT: ${p}`);
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "brief-unreadable",
    });
  });

  it("skips with description-unreadable when the description file read throws", () => {
    const deps = makeDeps({
      readFile: (p) => {
        if (p === BRIEF_FILE) return BRIEF;
        throw new Error(`ENOENT: ${p}`);
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "description-unreadable",
    });
  });
});

describe("run — fanout skip propagation", () => {
  it("both judges agy-not-found ⇒ {ran:false, skipReason:'agy-not-found'} and no --out file", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        deps.calls.fanout.push(input);
        let manifest: Array<{ task: string }> = [];
        try {
          manifest = JSON.parse(deps.files.get(input.manifestPath) ?? "[]");
        } catch {
          manifest = [];
        }
        return {
          entries: manifest.map((m) => ({
            task: m.task,
            ran: false,
            skipReason: "agy-not-found",
          })),
          allSkipped: true,
        } as FanoutAggregate;
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({ ran: false, skipReason: "agy-not-found" });
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("judge B agy-timeout + judge A ok ⇒ ran:true, judges[1].skipReason judge-timeout, survey carries A's body", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        deps.calls.fanout.push(input);
        let manifest: Array<{ task: string; model: string; out?: string }> = [];
        try {
          manifest = JSON.parse(deps.files.get(input.manifestPath) ?? "[]");
        } catch {
          manifest = [];
        }
        const entries = manifest.map((m, i) => {
          if (m.task === "blind-survey-judge-b") {
            return { task: m.task, ran: false, skipReason: "agy-timeout" };
          }
          const artifactPath = m.out ?? `${input.outPath}.artifact.${i}.md`;
          deps.files.set(artifactPath, JUDGE_PROSE);
          return { task: m.task, model: m.model, ran: true, artifactPath };
        });
        return { entries, anyRan: true, allSkipped: false } as FanoutAggregate;
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    const env = envelope(deps);
    expect(env.ran).toBe(true);
    expect(env.judges[1].skipReason).toBe("judge-timeout");
    const survey = deps.files.get(OUT)!;
    expect(survey).toContain(JUDGE_PROSE);
    expect(survey).toContain("_Judge B skipped: judge-timeout_");
  });

  it("an artifact under 40 chars ⇒ judge-empty", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        deps.calls.fanout.push(input);
        let manifest: Array<{ task: string; model: string; out?: string }> = [];
        try {
          manifest = JSON.parse(deps.files.get(input.manifestPath) ?? "[]");
        } catch {
          manifest = [];
        }
        const entries = manifest.map((m, i) => {
          const artifactPath = m.out ?? `${input.outPath}.artifact.${i}.md`;
          deps.files.set(
            artifactPath,
            m.task === "blind-survey-judge-a" ? "too short" : JUDGE_PROSE,
          );
          return { task: m.task, model: m.model, ran: true, artifactPath };
        });
        return { entries, anyRan: true, allSkipped: false } as FanoutAggregate;
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    const env = envelope(deps);
    expect(env.judges[0].skipReason).toBe("judge-empty");
  });
});

describe("run — scratch cleanup on skip", () => {
  it("removes scratch siblings when a post-fanout skip fires", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        deps.calls.fanout.push(input);
        let manifest: Array<{ task: string }> = [];
        try {
          manifest = JSON.parse(deps.files.get(input.manifestPath) ?? "[]");
        } catch {
          manifest = [];
        }
        return {
          entries: manifest.map((m) => ({
            task: m.task,
            ran: false,
            skipReason: "agy-not-found",
          })),
          allSkipped: true,
        } as FanoutAggregate;
      },
    });
    run(BASE_ARGV, deps);
    expect(deps.files.has(`${OUT}.judge-a.prompt`)).toBe(false);
    expect(deps.files.has(`${OUT}.judge-b.prompt`)).toBe(false);
    expect(deps.files.has(`${OUT}.fanout-manifest.json`)).toBe(false);
    expect(deps.files.has(`${OUT}.fanout.json`)).toBe(false);
  });

  it("removes a pre-existing stale --out file even on an early skip", () => {
    const deps = makeDeps({
      readFile: (p) => {
        if (p === BRIEF_FILE) throw new Error("ENOENT");
        if (p === DESCRIPTION_FILE) return DESCRIPTION;
        throw new Error(`ENOENT: ${p}`);
      },
    });
    deps.files.set(OUT, "stale prior survey");
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(deps.files.has(OUT)).toBe(false);
    expect(deps.calls.removed).toContain(OUT);
  });
});

describe("run — diversity guard", () => {
  let originalHome: string | undefined;
  let tmp: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-blind-survey-home-"));
    process.env.HOME = tmp;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    errSpy.mockRestore();
  });

  it("falls back to the other pinned default and warns when blindSurveySecond equals blindSurvey", () => {
    fs.mkdirSync(path.join(tmp, ".flow"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".flow", "config.json"),
      JSON.stringify({ delegate: { models: { blindSurveySecond: MODEL_A } } }),
    );
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    const manifestWrite = deps.calls.writes.find(
      (w) => w.path === deps.calls.fanout[0]!.manifestPath,
    )!;
    const manifest = JSON.parse(manifestWrite.contents);
    expect(manifest[1].model).not.toBe(manifest[0].model);
    expect(manifest[1].model).toBe(MODEL_B);
    const warned = errSpy.mock.calls.some((c) =>
      String(c[0]).includes("blindSurveySecond resolved equal to blindSurvey"),
    );
    expect(warned).toBe(true);
  });
});
