import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  appendEntry,
  buildExcerpt,
  buildPrBodySection,
  computeId,
  formatVerdict,
  parseAddArgs,
  parseRunArgs,
  parseUpsertArgs,
  readEntries,
  runAdd,
  runEntries,
  runRun,
  runUpsert,
  upsertPrBodySection,
  type Entry,
  type Spawner,
} from "./flow-followups";

let tmpRoot!: string;
let jsonlPath!: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-followups-test-"));
  jsonlPath = path.join(tmpRoot, "log.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// --- ALLOWLIST shape ---

describe("ALLOWLIST", () => {
  it("seeds with flow setup variants only", () => {
    expect([...ALLOWLIST].sort()).toEqual(["flow setup", "flow setup --upgrade"]);
  });
});

// --- computeId ---

describe("computeId", () => {
  it("is deterministic across calls", () => {
    expect(computeId("flow setup", "x")).toBe(computeId("flow setup", "x"));
  });

  it("changes when command changes", () => {
    expect(computeId("flow setup", "x")).not.toBe(computeId("flow setup --upgrade", "x"));
  });

  it("changes when reason changes", () => {
    expect(computeId("flow setup", "x")).not.toBe(computeId("flow setup", "y"));
  });

  it("returns a 12-char hex string", () => {
    expect(computeId("a", "b")).toMatch(/^[0-9a-f]{12}$/);
  });
});

// --- parseAddArgs ---

describe("parseAddArgs", () => {
  it("requires --command", () => {
    expect(parseAddArgs(["--reason", "x"])).toEqual({ error: "--command is required" });
  });

  it("requires --reason", () => {
    expect(parseAddArgs(["--command", "flow setup"])).toEqual({ error: "--reason is required" });
  });

  it("rejects unknown flags", () => {
    expect(parseAddArgs(["--bogus", "x"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("rejects a flag without a value", () => {
    expect(parseAddArgs(["--command"])).toEqual({ error: "--command requires a value" });
  });

  it("parses a full set", () => {
    expect(
      parseAddArgs([
        "--command",
        "flow setup --upgrade",
        "--reason",
        "new helper added",
        "--auto",
        "--id",
        "abc123",
        "--registered-by",
        "step-5.5",
      ]),
    ).toEqual({
      command: "flow setup --upgrade",
      reason: "new helper added",
      auto: true,
      id: "abc123",
      registeredBy: "step-5.5",
    });
  });

  it("defaults auto to false", () => {
    expect(parseAddArgs(["--command", "x", "--reason", "y"])).toMatchObject({ auto: false });
  });
});

// --- parseRunArgs ---

describe("parseRunArgs", () => {
  it("defaults note-only and json to false", () => {
    expect(parseRunArgs([])).toEqual({ noteOnly: false, json: false });
  });

  it("parses note-only and json flags", () => {
    expect(parseRunArgs(["--note-only", "--json"])).toEqual({ noteOnly: true, json: true });
  });

  it("parses --jsonl override", () => {
    expect(parseRunArgs(["--jsonl", "/tmp/x.jsonl"])).toMatchObject({
      jsonlOverride: "/tmp/x.jsonl",
    });
  });

  it("rejects unknown flags", () => {
    expect(parseRunArgs(["--bogus"])).toEqual({ error: "--bogus requires a value" });
  });
});

// --- parseUpsertArgs ---

describe("parseUpsertArgs", () => {
  it("requires PR number", () => {
    expect(parseUpsertArgs([])).toEqual({ error: "PR number is required" });
  });

  it("rejects non-positive integer", () => {
    expect(parseUpsertArgs(["abc"])).toMatchObject({ error: expect.stringContaining("PR must") });
    expect(parseUpsertArgs(["0"])).toMatchObject({ error: expect.stringContaining("PR must") });
    expect(parseUpsertArgs(["-1"])).toMatchObject({ error: expect.stringContaining("PR must") });
  });

  it("parses PR and --jsonl override", () => {
    expect(parseUpsertArgs(["42", "--jsonl", "/tmp/x.jsonl"])).toEqual({
      pr: 42,
      jsonlOverride: "/tmp/x.jsonl",
    });
  });
});

// --- readEntries / appendEntry ---

describe("readEntries", () => {
  it("returns empty for missing log", () => {
    expect(readEntries(jsonlPath)).toEqual([]);
  });

  it("parses JSONL and dedupes by id", () => {
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify({ id: "a", command: "x", reason: "r1", auto: true, registeredAt: "t" }),
        JSON.stringify({ id: "b", command: "y", reason: "r2", auto: false, registeredAt: "t" }),
        JSON.stringify({ id: "a", command: "x", reason: "DUP", auto: true, registeredAt: "t" }),
        "",
      ].join("\n"),
    );
    const entries = readEntries(jsonlPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "a", reason: "r1" });
    expect(entries[1]).toMatchObject({ id: "b", reason: "r2" });
  });

  it("skips malformed lines without throwing", () => {
    fs.writeFileSync(
      jsonlPath,
      [
        "not json",
        JSON.stringify({ id: "a", command: "x", reason: "r", auto: false, registeredAt: "t" }),
        '{"missing":"required-fields"}',
      ].join("\n"),
    );
    const entries = readEntries(jsonlPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("a");
  });
});

describe("appendEntry", () => {
  it("creates the parent directory lazily", () => {
    const nested = path.join(tmpRoot, "deep", "nested", "log.jsonl");
    appendEntry(nested, {
      id: "x",
      command: "c",
      reason: "r",
      auto: false,
      registeredAt: "t",
    });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("appends one line per call", () => {
    appendEntry(jsonlPath, { id: "a", command: "x", reason: "r1", auto: false, registeredAt: "t" });
    appendEntry(jsonlPath, { id: "b", command: "y", reason: "r2", auto: false, registeredAt: "t" });
    const text = fs.readFileSync(jsonlPath, "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

// --- buildExcerpt ---

describe("buildExcerpt", () => {
  it("returns full output when under cap", () => {
    const out = "line1\nline2\nline3";
    const e = buildExcerpt(out);
    expect(e.headExcerpt).toBe(out);
    expect(e.tailExcerpt).toBe("");
    expect(e.totalLines).toBe(3);
  });

  it("strips ANSI escapes", () => {
    expect(buildExcerpt("\x1b[31merror\x1b[0m").headExcerpt).toBe("error");
  });

  it("splits head and tail when over cap", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n");
    const e = buildExcerpt(lines);
    expect(e.totalLines).toBe(200);
    expect(e.headExcerpt.split("\n")).toHaveLength(50);
    expect(e.tailExcerpt.split("\n")).toHaveLength(50);
    expect(e.headExcerpt.split("\n")[0]).toBe("line1");
    expect(e.tailExcerpt.split("\n").at(-1)).toBe("line200");
  });
});

// --- runEntries decision logic ---

const okSpawn: Spawner = () => ({ stdout: "ok\n", stderr: "", exitCode: 0 });
const failSpawn: Spawner = () => ({ stdout: "", stderr: "boom\n", exitCode: 1 });

const allowedAuto: Entry = {
  id: "a",
  command: "flow setup --upgrade",
  reason: "new helper",
  auto: true,
  registeredAt: "t",
};
const blockedAuto: Entry = {
  id: "b",
  command: "rm -rf /",
  reason: "cleanup",
  auto: true,
  registeredAt: "t",
};
const manual: Entry = {
  id: "c",
  command: "manual step",
  reason: "rotate creds",
  auto: false,
  registeredAt: "t",
};

describe("runEntries", () => {
  it("note-only mode notes every entry without spawning", () => {
    const calls: string[][] = [];
    const recordingSpawn: Spawner = (argv) => {
      calls.push(argv);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const v = runEntries([allowedAuto, blockedAuto, manual], {
      noteOnly: true,
      spawn: recordingSpawn,
    });
    expect(calls).toEqual([]);
    expect(v.summary).toEqual({ total: 3, ran: 0, noted: 3, failed: 0 });
    expect(v.noted.find((n) => n.id === "a")?.autoDeniedBecause).toBe("note-only-mode");
  });

  it("executes auto-allowlisted entries", () => {
    const v = runEntries([allowedAuto], { spawn: okSpawn, homeDir: "/tmp" });
    expect(v.summary).toEqual({ total: 1, ran: 1, noted: 0, failed: 0 });
    expect(v.ran[0].command).toBe("flow setup --upgrade");
    expect(v.ran[0].exitCode).toBe(0);
  });

  it("notes auto entries not in allowlist with autoDeniedBecause", () => {
    const v = runEntries([blockedAuto], { spawn: okSpawn });
    expect(v.summary).toEqual({ total: 1, ran: 0, noted: 1, failed: 0 });
    expect(v.noted[0].autoDeniedBecause).toBe("not-in-allowlist");
  });

  it("notes non-auto entries", () => {
    const v = runEntries([manual], { spawn: okSpawn });
    expect(v.summary).toEqual({ total: 1, ran: 0, noted: 1, failed: 0 });
    expect(v.noted[0].auto).toBe(false);
    expect(v.noted[0].autoDeniedBecause).toBeUndefined();
  });

  it("partitions failed runs out of ran", () => {
    const v = runEntries([allowedAuto], { spawn: failSpawn });
    expect(v.summary).toEqual({ total: 1, ran: 0, noted: 0, failed: 1 });
    expect(v.failed[0].exitCode).toBe(1);
  });

  it("passes home dir as spawn cwd", () => {
    let observedCwd: string | undefined;
    const spy: Spawner = (_argv, opts) => {
      observedCwd = opts.cwd;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    runEntries([allowedAuto], { spawn: spy, homeDir: "/Users/test" });
    expect(observedCwd).toBe("/Users/test");
  });
});

// --- formatVerdict ---

describe("formatVerdict", () => {
  it("returns empty string for an empty log", () => {
    expect(formatVerdict({ summary: { total: 0, ran: 0, noted: 0, failed: 0 }, ran: [], failed: [], noted: [] }, false)).toBe("");
  });

  it("uses normal header for the merged path", () => {
    const v = runEntries([allowedAuto], { spawn: okSpawn });
    const out = formatVerdict(v, false);
    expect(out).toContain("LOCAL FOLLOW-UPS:");
    expect(out).not.toContain("deferred");
    expect(out).toContain("RAN");
  });

  it("uses deferred header for note-only mode", () => {
    const v = runEntries([allowedAuto], { noteOnly: true });
    const out = formatVerdict(v, true);
    expect(out).toContain("LOCAL FOLLOW-UPS (deferred — PR not yet merged)");
    expect(out).toContain("(auto)");
  });

  it("annotates allowlist-denied entries", () => {
    const v = runEntries([blockedAuto]);
    const out = formatVerdict(v, false);
    expect(out).toContain("auto-run denied: not in allowlist");
  });

  it("includes failure tail excerpt", () => {
    const v = runEntries([allowedAuto], {
      spawn: () => ({ stdout: "", stderr: "boom: it broke\n", exitCode: 2 }),
    });
    const out = formatVerdict(v, false);
    expect(out).toContain("FAIL");
    expect(out).toContain("boom: it broke");
  });
});

// --- buildPrBodySection / upsertPrBodySection ---

describe("buildPrBodySection", () => {
  it("renders heading and entries", () => {
    const md = buildPrBodySection([allowedAuto, manual]);
    expect(md).toContain("## Local Follow-ups");
    expect(md).toContain("- [ ] flow setup --upgrade  # new helper (auto)");
    expect(md).toContain("- [ ] manual step  # rotate creds");
    // Manual entry is not auto, so no (auto) tag.
    expect(md.split("\n").find((l) => l.startsWith("- [ ] manual step"))).not.toContain("(auto)");
  });
});

describe("upsertPrBodySection", () => {
  it("appends to a body without the heading", () => {
    const out = upsertPrBodySection("## Why\nbecause\n", "## Local Follow-ups\n\n- [ ] x  # r");
    expect(out).toBe("## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] x  # r\n");
  });

  it("renders into an empty body", () => {
    const out = upsertPrBodySection("", "## Local Follow-ups\n\n- [ ] x  # r");
    expect(out).toBe("## Local Follow-ups\n\n- [ ] x  # r\n");
  });

  it("replaces an existing section in place when followed by another heading", () => {
    const before =
      "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] old  # old\n\n## Test Steps\n\n- [ ] verify\n";
    const out = upsertPrBodySection(before, "## Local Follow-ups\n\n- [ ] new  # new");
    expect(out).toBe(
      "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] new  # new\n\n## Test Steps\n\n- [ ] verify\n",
    );
  });

  it("replaces an existing section at end of body", () => {
    const before = "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] old  # old\n";
    const out = upsertPrBodySection(before, "## Local Follow-ups\n\n- [ ] new  # new");
    expect(out).toBe("## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] new  # new\n");
  });

  it("is idempotent — second run with same input returns same output", () => {
    const before = "## Why\nbecause\n";
    const section = "## Local Follow-ups\n\n- [ ] x  # r";
    const once = upsertPrBodySection(before, section);
    const twice = upsertPrBodySection(once, section);
    expect(twice).toBe(once);
  });
});

// --- runAdd ---

describe("runAdd", () => {
  it("returns 2 on missing required flag", () => {
    expect(runAdd(["--command", "x"])).toBe(2);
  });

  it("appends an entry and exits 0", () => {
    const code = runAdd(
      ["--command", "flow setup", "--reason", "test", "--auto", "--jsonl", jsonlPath],
      { now: () => "2026-05-05T00:00:00.000Z" },
    );
    expect(code).toBe(0);
    const entries = readEntries(jsonlPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      command: "flow setup",
      reason: "test",
      auto: true,
      registeredAt: "2026-05-05T00:00:00.000Z",
    });
  });

  it("dedupes by id on a second add with same command+reason", () => {
    runAdd(["--command", "flow setup", "--reason", "x", "--jsonl", jsonlPath]);
    runAdd(["--command", "flow setup", "--reason", "x", "--jsonl", jsonlPath]);
    expect(readEntries(jsonlPath)).toHaveLength(1);
  });

  it("respects an explicit --id for dedup", () => {
    runAdd(["--command", "a", "--reason", "b", "--id", "fixed", "--jsonl", jsonlPath]);
    runAdd(["--command", "different", "--reason", "different", "--id", "fixed", "--jsonl", jsonlPath]);
    expect(readEntries(jsonlPath)).toHaveLength(1);
  });
});

// --- runRun ---

describe("runRun", () => {
  it("emits empty output when log is missing", () => {
    let captured = "";
    const code = runRun(["--jsonl", jsonlPath], { out: (s) => (captured += s) });
    expect(code).toBe(0);
    expect(captured).toBe("");
  });

  it("emits human-readable text on the merged path", () => {
    runAdd(["--command", "flow setup --upgrade", "--reason", "new helper", "--auto", "--jsonl", jsonlPath]);
    let captured = "";
    runRun(["--jsonl", jsonlPath], {
      out: (s) => (captured += s),
      spawn: okSpawn,
      homeDir: "/tmp",
    });
    expect(captured).toContain("LOCAL FOLLOW-UPS:");
    expect(captured).toContain("RAN");
  });

  it("emits JSON verdict on --json", () => {
    runAdd(["--command", "flow setup", "--reason", "r", "--auto", "--jsonl", jsonlPath]);
    let captured = "";
    runRun(["--jsonl", jsonlPath, "--json"], {
      out: (s) => (captured += s),
      spawn: okSpawn,
      homeDir: "/tmp",
    });
    const parsed = JSON.parse(captured);
    expect(parsed.summary.total).toBe(1);
    expect(parsed.ran).toHaveLength(1);
  });

  it("does not spawn under --note-only", () => {
    runAdd(["--command", "flow setup --upgrade", "--reason", "r", "--auto", "--jsonl", jsonlPath]);
    const calls: string[][] = [];
    const recordingSpawn: Spawner = (argv) => {
      calls.push(argv);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    runRun(["--jsonl", jsonlPath, "--note-only"], {
      out: () => {},
      spawn: recordingSpawn,
      homeDir: "/tmp",
    });
    expect(calls).toEqual([]);
  });

  it("emits a stderr warning when an auto entry is denied by allowlist", () => {
    runAdd(["--command", "rm -rf /", "--reason", "blocked", "--auto", "--jsonl", jsonlPath]);
    let captured = "";
    runRun(["--jsonl", jsonlPath], {
      out: () => {},
      err: (s) => (captured += s),
    });
    expect(captured).toContain("not in the allowlist");
    expect(captured).toContain("rm -rf /");
  });
});

// --- runUpsert ---

describe("runUpsert", () => {
  function makeGh(captured: { argv: string[]; bodyFileContent?: string }[]) {
    let bodyForView = "";
    return {
      gh: (argv: string[]) => {
        const entry: { argv: string[]; bodyFileContent?: string } = { argv: [...argv] };
        if (argv[0] === "pr" && argv[1] === "edit") {
          const i = argv.indexOf("--body-file");
          if (i !== -1 && argv[i + 1]) {
            entry.bodyFileContent = fs.readFileSync(argv[i + 1], "utf8");
          }
        }
        captured.push(entry);
        if (argv[0] === "pr" && argv[1] === "view") {
          return { stdout: bodyForView, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      setBody: (s: string) => {
        bodyForView = s;
      },
    };
  }

  it("returns 0 with no gh calls when log is missing", () => {
    const captured: { argv: string[]; bodyFileContent?: string }[] = [];
    const { gh } = makeGh(captured);
    const code = runUpsert(["42", "--jsonl", jsonlPath], { gh });
    expect(code).toBe(0);
    expect(captured).toEqual([]);
  });

  it("appends a new section when body lacks the heading", () => {
    runAdd(["--command", "flow setup", "--reason", "test", "--auto", "--jsonl", jsonlPath]);
    const captured: { argv: string[]; bodyFileContent?: string }[] = [];
    const { gh, setBody } = makeGh(captured);
    setBody("## Why\nbecause\n");
    const code = runUpsert(["99", "--jsonl", jsonlPath], { gh });
    expect(code).toBe(0);
    const editCall = captured.find((c) => c.argv[1] === "edit");
    expect(editCall?.bodyFileContent).toBeDefined();
    expect(editCall!.bodyFileContent!).toContain("## Local Follow-ups");
    expect(editCall!.bodyFileContent!).toContain("- [ ] flow setup  # test (auto)");
  });

  it("replaces an existing section idempotently", () => {
    runAdd(["--command", "flow setup", "--reason", "test", "--auto", "--jsonl", jsonlPath]);
    const captured: { argv: string[]; bodyFileContent?: string }[] = [];
    const { gh, setBody } = makeGh(captured);
    setBody("## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] flow setup  # test (auto)\n");
    runUpsert(["99", "--jsonl", jsonlPath], { gh });
    // Second invocation: body is already correct → no edit call should fire.
    const editCalls = captured.filter((c) => c.argv[1] === "edit");
    expect(editCalls).toHaveLength(0);
  });

  it("returns 1 on gh pr view failure", () => {
    runAdd(["--command", "flow setup", "--reason", "test", "--auto", "--jsonl", jsonlPath]);
    const code = runUpsert(["99", "--jsonl", jsonlPath], {
      gh: () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
    });
    expect(code).toBe(1);
  });
});
