import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  measureSpawn,
  referenceOpenRates,
  sectionSizes,
  streamSpawns,
  summarize,
  type SpawnPayload,
} from "./discovery-payload";
import { DEFAULT_INSTRUCTIONS } from "./discovery-payload-parse";

const MODEL = "claude-opus-5";
const IR = "/x/references/discovery-instructions.md";

const usage = (write: number, read = 0, output = 1) => ({
  input_tokens: 5,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: output,
});
const user = (text: string) => ({
  type: "user",
  message: { role: "user", content: text },
});
const asst = (
  id: string,
  u: object,
  content: object[] = [{ type: "text", text: "x" }],
) => ({
  type: "assistant",
  message: { id, model: MODEL, usage: u, content },
});
const read = (toolId: string, file: string) => ({
  type: "tool_use",
  id: toolId,
  name: "Read",
  input: { file_path: file },
});
const result = (toolId: string) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }],
  },
});

// The fixed spawn-template prose names MODE: epic and epic-discovery-instructions.md
// for every run; only the path after "Read the full instructions at:" differs.
const spawnPrompt = (file: string) =>
  `Read the full instructions at:\n  /s/references/${file}\n\nFollow the /s/references/${file} steps in order (the feature-grain\ndiscovery-instructions.md by default; under \`MODE: epic\` this resolves to\nepic-discovery-instructions.md)`;

// Three instruction chunks, each followed by a request that writes 100/200/300.
const threeChunks = () => [
  user("Task: plan it"),
  asst("m1", usage(1000, 50), [read("t1", IR)]),
  result("t1"),
  asst("m2", usage(100), [read("t2", IR)]),
  result("t2"),
  asst("m3", usage(200), [read("t3", IR)]),
  result("t3"),
  asst("m4", usage(300), [read("t4", "/x/other.ts")]),
  result("t4"),
  asst("m5", usage(7)),
  asst("m6", usage(7)),
];

describe("measureSpawn", () => {
  it("should compute firstContext and firstWrite from the first assistant request", () => {
    const m = measureSpawn(threeChunks())!;
    expect(m.firstWrite).toBe(1000);
    expect(m.firstContext).toBe(5 + 50 + 1000);
    expect(m.model).toBe(MODEL);
  });

  it("should keep the LAST row per message.id when output_tokens repeats", () => {
    const rows = [
      user("t"),
      asst("m1", usage(10, 0, 1)),
      asst("m1", usage(10, 0, 1_000_000)),
    ];
    const once = measureSpawn([user("t"), asst("m1", usage(10, 0, 1_000_000))]);
    expect(measureSpawn(rows)!.usd).toBeCloseTo(once!.usd, 10);
    expect(measureSpawn(rows)!.usd).toBeGreaterThan(20);
  });

  it("should attribute instructionTokens to the request after each instruction Read result and count chunks", () => {
    const m = measureSpawn(threeChunks())!;
    expect(m.instructionChunks).toBe(3);
    expect(m.instructionTokens).toBe(100 + 200 + 300);
  });

  it("should sum reads of multiple instructions names into instructionTokens", () => {
    const rows = [
      user("t"),
      asst("m1", usage(1000), [read("t1", IR)]),
      result("t1"),
      asst("m2", usage(100), [
        read("t2", "/x/references/discovery-research.md"),
      ]),
      result("t2"),
      asst("m3", usage(40)),
    ];
    const names = ["discovery-instructions.md", "discovery-research.md"];
    const m = measureSpawn(rows, { instructionNames: names })!;
    expect(m.instructionChunks).toBe(2);
    expect(m.instructionTokens).toBe(100 + 40);
    expect(
      measureSpawn(rows, { instructionNames: ["discovery-instructions.md"] })!
        .instructionChunks,
    ).toBe(1);
    expect(measureSpawn(rows)!.instructionChunks).toBe(2);
    expect(m.referencesRead).toEqual([
      "discovery-instructions.md",
      "discovery-research.md",
    ]);
  });

  it("should default the instruction names to the core plus all five discovery references", () => {
    expect([...DEFAULT_INSTRUCTIONS].sort()).toEqual([
      "discovery-instructions.md",
      "discovery-prompt-interpretation.md",
      "discovery-research.md",
      "discovery-revision.md",
      "discovery-survey-epic.md",
      "discovery-ui.md",
    ]);
  });

  it("should attribute a shell cat of the instructions and its spilled-output Read", () => {
    const bash = (toolId: string, command: string) => ({
      type: "tool_use",
      id: toolId,
      name: "Bash",
      input: { command },
    });
    const rows = [
      user("t"),
      asst("m1", usage(1000), [bash("t1", `cat ${IR}; echo ===`)]),
      result("t1"),
      asst("m2", usage(50), [read("t2", "/s/tool-results/b1.txt")]),
      result("t2"),
      asst("m3", usage(400), [read("t3", "/x/src/other.ts")]),
      result("t3"),
      asst("m4", usage(9)),
    ];
    const m = measureSpawn(rows)!;
    expect(m.instructionChunks).toBe(2);
    expect(m.instructionTokens).toBe(50 + 400);
    expect(m.referencesRead).toEqual(["discovery-instructions.md"]);
  });

  it("should not attribute a later unrelated tool-results Read to the instructions", () => {
    const bash = {
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: `cat ${IR}; echo ===` },
    };
    const rows = [
      user("t"),
      asst("m1", usage(1000), [bash]),
      result("t1"),
      asst("m2", usage(50), [read("t2", "/s/tool-results/b1.txt")]),
      result("t2"),
      asst("m3", usage(400), [read("t3", "/s/tool-results/unrelated.txt")]),
      result("t3"),
      asst("m4", usage(9)),
    ];
    const m = measureSpawn(rows)!;
    expect(m.instructionChunks).toBe(2);
    expect(m.instructionTokens).toBe(50 + 400);
    const noSpill = [
      user("t"),
      asst("m1", usage(1000), [bash]),
      result("t1"),
      asst("m2", usage(50), [read("t2", "/x/src/a.ts")]),
      result("t2"),
      asst("m3", usage(400), [read("t3", "/s/tool-results/unrelated.txt")]),
      result("t3"),
      asst("m4", usage(9)),
    ];
    const n = measureSpawn(noSpill)!;
    expect(n.instructionChunks).toBe(1);
    expect(n.instructionTokens).toBe(50);
  });

  it("should count turnsAfterInstructions after the last instruction result", () => {
    expect(measureSpawn(threeChunks())!.turnsAfterInstructions).toBe(3);
  });

  it("should report zero instruction metrics when no instruction Read happened", () => {
    const m = measureSpawn([user("t"), asst("m1", usage(9))])!;
    expect(m.instructionChunks).toBe(0);
    expect(m.instructionTokens).toBe(0);
    expect(m.turnsAfterInstructions).toBe(0);
  });

  it("should classify mode revision, epic and feature from the first user text", () => {
    const mode = (t: string) =>
      measureSpawn([user(t), asst("m", usage(1))])!.mode;
    expect(mode("hi\nREVISION: 1\nUSER REDIRECT")).toBe("revision");
    expect(mode(spawnPrompt("epic-discovery-instructions.md"))).toBe("epic");
    expect(mode(spawnPrompt("discovery-instructions.md"))).toBe("feature");
    expect(mode("plain feature request")).toBe("feature");
    expect(
      measureSpawn([user("12345"), asst("m", usage(1))])!.taskTextChars,
    ).toBe(5);
  });

  it("should return null for rows with no assistant request", () => {
    expect(measureSpawn([user("t")])).toBeNull();
    expect(measureSpawn([])).toBeNull();
  });

  it("should record sibling and discovery references read", () => {
    const rows = [
      user("t"),
      asst("m1", usage(1), [
        read("a", "/s/templates/prd-template.md"),
        read("b", "/s/references/discovery-ui.md"),
        read("c", "/s/src/index.ts"),
      ]),
    ];
    expect(measureSpawn(rows)!.referencesRead).toEqual([
      "prd-template.md",
      "discovery-ui.md",
    ]);
  });

  it("should price a known model above zero", () => {
    expect(measureSpawn(threeChunks())!.usd).toBeGreaterThan(0);
  });

  it("should price the 5m/1h cache-write split exactly and fall back to the 5m rate without it", () => {
    const base = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 3_000_000,
    };
    const split = {
      ...base,
      cache_creation: {
        ephemeral_5m_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 2_000_000,
      },
    };
    expect(measureSpawn([user("t"), asst("m", split)])!.usd).toBeCloseTo(
      26.25,
      10,
    );
    expect(measureSpawn([user("t"), asst("m", base)])!.usd).toBeCloseTo(
      18.75,
      10,
    );
  });
});

const spawn = (o: Partial<SpawnPayload>): SpawnPayload => ({
  model: MODEL,
  mode: "feature",
  firstContext: 0,
  firstWrite: 0,
  taskTextChars: 0,
  instructionTokens: 0,
  instructionChunks: 0,
  turnsAfterInstructions: 0,
  referencesRead: [],
  usd: 0,
  ...o,
});

describe("summarize", () => {
  it("should compute median, p25 and p75 on known inputs", () => {
    const s = summarize(
      [10, 20, 30, 40, 50].map((n) => spawn({ firstContext: n, usd: n / 10 })),
    );
    expect(s.median.firstContext).toBe(30);
    expect(s.p25.firstContext).toBe(20);
    expect(s.p75.firstContext).toBe(40);
    expect(s.usdPerRunByModel[MODEL]).toBeCloseTo(3, 10);
  });
});

describe("sectionSizes", () => {
  it("should ignore headings inside three- and four-backtick fences", () => {
    const md = [
      "# A",
      "body",
      "```md",
      "## not a heading",
      "```",
      "````md",
      "### also not",
      "```",
      "## still fenced",
      "````",
      "## B",
      "x",
    ].join("\n");
    const out = sectionSizes(md);
    expect(out.map((s) => s.heading)).toEqual(["# A", "## B"]);
    expect(out[0].chars).toBeGreaterThan(out[1].chars);
  });
});

describe("referenceOpenRates", () => {
  it("should count opened and total per reference", () => {
    const r = referenceOpenRates(
      [
        { referencesRead: ["a.md", "b.md"] },
        { referencesRead: ["a.md"] },
        { referencesRead: [] },
      ],
      ["a.md", "b.md", "c.md"],
    );
    expect(r).toEqual({
      "a.md": { opened: 2, total: 3 },
      "b.md": { opened: 1, total: 3 },
      "c.md": { opened: 0, total: 3 },
    });
  });
});

describe("streamSpawns", () => {
  it("should pick the largest parent group, add the synthetic user row, and ignore stray parents", () => {
    const dir = mkdtempSync(join(tmpdir(), "discovery-stream-"));
    mkdirSync(join(dir, "run-1"));
    const child = (id: string, parent: string, u: object) => ({
      ...asst(id, u, [read(`r-${id}`, "/x/src/a.ts")]),
      parent_tool_use_id: parent,
    });
    const rows = [
      asst("top", usage(1), [
        {
          type: "tool_use",
          id: "T",
          name: "Task",
          input: { prompt: "REVISION: 2\nredo it" },
        },
      ]),
      child("c1", "T", usage(100)),
      child("c2", "T", usage(200)),
      child("c3", "T", usage(300)),
      child("s1", "OTHER", usage(9)),
    ];
    writeFileSync(
      join(dir, "run-1", "stream.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n"),
    );
    const runs = streamSpawns(dir);
    expect(runs).toHaveLength(1);
    const group = runs[0] as any[];
    expect(group.filter((r) => r.parent_tool_use_id === "T")).toHaveLength(3);
    expect(group[0].type).toBe("user");
    expect(group).toHaveLength(4);
    expect(measureSpawn(group)!.mode).toBe("revision");
  });
});
