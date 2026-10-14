import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  analyzeSession,
  renderSessions,
  staticSizes,
  summarizeSessions,
} from "./supervisor-skill-payload";

const T = "2026-10-01T00:00:00Z";
const usage = (ctx: number) => ({
  input_tokens: 1,
  cache_read_input_tokens: ctx,
});
const asst = (id: string, block: object, ctx: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: T,
    message: {
      id,
      model: "claude-opus-5",
      usage: usage(ctx),
      content: [block],
    },
  });
const use = (name: string, input: object) => ({
  type: "tool_use",
  name,
  input,
});
const DOCS =
  "/h/.flow/claude-home/.claude/skills/flow-module-core/skills/flow-pipeline";

const fixture = [
  asst("a", use("Bash", { command: "ls" }), 10_000),
  asst("b", use("Skill", { skill: "flow-module-core:flow-pipeline" }), 10_500),
  JSON.stringify({
    type: "user",
    message: { content: "Base directory for this skill: x" },
  }),
  asst(
    "c",
    use("Bash", { command: "flow-state-update --phase triaged" }),
    100_500,
  ),
  asst(
    "d",
    use("Read", { file_path: `${DOCS}/references/phases/step-01-triage.md` }),
    101_000,
  ),
  asst(
    "e",
    use("Read", { file_path: `${DOCS}/references/step3-threading.md` }),
    101_500,
  ),
  asst(
    "f",
    use("Bash", { command: "flow-state-update --phase planning --slug s" }),
    102_000,
  ),
  JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
  }),
  JSON.stringify({
    type: "attachment",
    attachment: {
      type: "invoked_skills",
      skills: [
        {
          name: "flow-module-core:flow-pipeline",
          path: "p",
          content: "x".repeat(20_000),
        },
        {
          name: "flow-module-core:flow-verify",
          path: "p",
          content: "y".repeat(5_000),
        },
      ],
    },
  }),
  asst("g", use("Read", { file_path: `${DOCS}/SKILL.md` }), 40_000),
];

describe("analyzeSession", () => {
  const s = analyzeSession(fixture);
  it("measures the context the skill load added", () => {
    expect(s.skillLoads).toBe(1);
    expect(s.loadDeltaTokens).toEqual([90_000 + 0]);
  });
  it("counts the compaction and the re-attached skill length", () => {
    expect(s.compactions).toBe(1);
    expect(s.reattachChars).toEqual([20_000]);
    expect(s.reloadedAfterCompaction).toBe(true);
  });
  it("does not count a skill load or doc read from before the compaction as a reload", () => {
    const notReloaded = analyzeSession(fixture.slice(0, -1));
    expect(notReloaded.compactions).toBe(1);
    expect(notReloaded.reattachChars).toEqual([20_000]);
    expect(notReloaded.reloadedAfterCompaction).toBe(false);
  });
  it("counts reads of flow-pipeline docs only by relative path", () => {
    expect(s.docReads).toEqual({
      "references/phases/step-01-triage.md": 1,
      "references/step3-threading.md": 1,
      "SKILL.md": 1,
    });
  });
  it("lists the phases the run wrote, in order", () => {
    expect(s.phasesReached).toEqual(["triaged", "planning"]);
  });
  it("ignores unparseable lines and sessions without a load", () => {
    const empty = analyzeSession([
      "not json",
      asst("z", use("Bash", { command: "ls" }), 5),
    ]);
    expect(empty.skillLoads).toBe(0);
    expect(empty.loadDeltaTokens).toEqual([]);
  });
});

describe("summarizeSessions", () => {
  it("renders per-doc reads and sessions", () => {
    const md = renderSessions(summarizeSessions([analyzeSession(fixture)]));
    expect(md).toContain(
      "| Median context added by a skill load (tokens) | 90,000 |",
    );
    expect(md).toContain("| SKILL.md | 1 | 1 | 1 |");
  });
});

describe("staticSizes", () => {
  const make = (core: string, files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "skill-payload-"));
    writeFileSync(join(dir, "SKILL.md"), core);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    return dir;
  };
  it("treats an unsplit skill as fully resident at every step", () => {
    const core = "# Goal\n## Step 0 — a\nx\n## Step 1 — b\ny\n";
    const s = staticSizes(make(core, { "references/r.md": "12345" }));
    expect(s.coreChars).toBe(core.length);
    expect(s.docs).toEqual({ "references/r.md": 5 });
    expect(s.residentAtStep).toEqual({ "0": core.length, "1": core.length });
  });
  it("resolves a bare doc name in the Doc cell against references/phases/", () => {
    const core = [
      "| Step | Phases | One-liner | Doc |",
      "|---|---|---|---|",
      "| 3 | `planning` | x.md notes | `references/phases/step-03-plan.md` + `shared.md` |",
    ].join("\n");
    const s = staticSizes(
      make(core, {
        "references/phases/step-03-plan.md": "aa",
        "references/phases/shared.md": "bbb",
      }),
    );
    expect(s.residentAtStep).toEqual({ "3": core.length + 5 });
  });
  it("accumulates phase docs along the dispatch table", () => {
    const core = [
      "| Step | doc |",
      "|---|---|",
      "| 0 | references/phases/step-00-echo.md |",
      "| 1 | references/phases/step-01-triage.md, references/phases/shared.md |",
      "| 5.5 | references/phases/step-05.5-x.md |",
    ].join("\n");
    const s = staticSizes(
      make(core, {
        "references/phases/step-00-echo.md": "aa",
        "references/phases/step-01-triage.md": "bbb",
        "references/phases/shared.md": "c",
        "references/phases/step-05.5-x.md": "dddd",
      }),
    );
    expect(s.residentAtStep).toEqual({
      "0": core.length + 2,
      "1": core.length + 6,
      "5.5": core.length + 10,
    });
  });
});
