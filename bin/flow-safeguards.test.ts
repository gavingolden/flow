import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as prettier from "prettier";
import { afterAll, describe, expect, it } from "vitest";
import {
  collapsePadding,
  findPaddingRuns,
  PRETTIER_IGNORE,
} from "./lib/guidance-padding";
import {
  buildRetryEditSet,
  mapCopyPaths,
  mergeCoderResults,
  planLensRetry,
  upsertDecisionItems,
  type EditEntry,
} from "./lib/safeguards-retry";
import {
  parseSafeguardsStop,
  renderSafeguardsNote,
  type RetryRecord,
} from "./lib/safeguards-stop";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-safeguards-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SCRIPT = path.join(__dirname, "flow-safeguards.ts");

const paddedTable = (n = 1500) =>
  [
    "# Title",
    "",
    `| Name${" ".repeat(n)} | Value${" ".repeat(n)} |`,
    `| ${"-".repeat(n)} | :${"-".repeat(n)}: |`,
    `| alpha${" ".repeat(n)} | beta${" ".repeat(n)} |`,
    "",
    "tail",
  ].join("\n");

const words = (t: string) =>
  t
    .replace(PRETTIER_IGNORE, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/-{3,}/g, "---"));

const OPUS =
  "Agent terminated early due to an API error: API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.\n\nDetails: [reasoning_extraction]\nRequest ID: req_011CgstQR1F8rme2LKQKysjG";

describe("findPaddingRuns", () => {
  it("finds a 1,500-space run and ignores a 999 run", () => {
    expect(findPaddingRuns(`a${" ".repeat(1500)}b`)).toEqual([
      { line: 1, length: 1500, char: " " },
    ]);
    expect(findPaddingRuns(`a${" ".repeat(999)}b`)).toEqual([]);
  });
});

describe("collapsePadding", () => {
  it("keeps every word and the line count", () => {
    const src = paddedTable();
    const out = collapsePadding(src);
    expect(out.changed).toBe(true);
    expect(out.tables).toBe(1);
    expect(words(out.text)).toEqual(words(src));
    expect(out.text.split("\n")).toHaveLength(src.split("\n").length);
    expect(findPaddingRuns(out.text)).toEqual([]);
    expect(out.text).toContain(":---:");
  });

  it("leaves unpadded input untouched without force", () => {
    const src = "| a    | b |\n| ---- | - |";
    expect(collapsePadding(src)).toEqual({
      text: src,
      changed: false,
      tables: 0,
    });
  });

  it("leaves fenced code untouched", () => {
    const src = ["```", `x${" ".repeat(1500)}y`, "```", paddedTable()].join(
      "\n",
    );
    const out = collapsePadding(src).text.split("\n");
    expect(out[1]).toBe(`x${" ".repeat(1500)}y`);
  });

  it("force collapses a run the threshold ignores", () => {
    const src = `| a${" ".repeat(200)}| b |`;
    expect(collapsePadding(src).changed).toBe(false);
    expect(collapsePadding(src, { force: true }).text).toBe("| a | b |");
  });

  it("collapses long prose runs to one space or dashes", () => {
    const src = `a${" ".repeat(1200)}b\n${"-".repeat(1200)}`;
    expect(collapsePadding(src).text).toBe("a b\n---");
  });

  it("preserveForPrettier adds one marker per table block and is idempotent", () => {
    const first = collapsePadding(paddedTable(), { preserveForPrettier: true });
    expect(first.text.split(PRETTIER_IGNORE)).toHaveLength(2);
    const second = collapsePadding(first.text, {
      force: true,
      preserveForPrettier: true,
    });
    expect(second.text).toBe(first.text);
  });

  it("produces output that passes prettier --check", async () => {
    const out = collapsePadding(paddedTable(), { preserveForPrettier: true });
    expect(await prettier.check(`${out.text}\n`, { parser: "markdown" })).toBe(
      true,
    );
  });
});

describe("parseSafeguardsStop", () => {
  it("parses the Opus failure text", () => {
    expect(parseSafeguardsStop(OPUS)).toEqual({
      stopped: true,
      model: "Opus 5.5",
      requestId: "req_011CgstQR1F8rme2LKQKysjG",
    });
  });

  it("parses the Sonnet variant", () => {
    const r = parseSafeguardsStop(OPUS.replace("Opus 5.5", "Sonnet 5.5"));
    expect(r).toMatchObject({ stopped: true, model: "Sonnet 5.5" });
  });

  it("recognises the bare harness text with null ids", () => {
    expect(
      parseSafeguardsStop(
        "Safeguards stopped this agent, and automatic model switching is off.",
      ),
    ).toEqual({ stopped: true, model: null, requestId: null });
  });

  it("ignores unrelated errors", () => {
    expect(parseSafeguardsStop("API Error: 529 overloaded")).toEqual({
      stopped: false,
    });
  });
});

describe("retry planning", () => {
  const entry = (file: string, docs?: string[]): EditEntry => ({
    file,
    intent: `edit ${file}`,
    expected_outcome: "ok",
    skill_docs: docs,
    acceptance: file === "b.ts" ? "npm test" : undefined,
  });

  it("drops applied entries and strips skill_docs", () => {
    const { remaining, droppedGuidance } = buildRetryEditSet(
      [entry("a.ts", ["/d1", "/d2"]), entry("b.ts", ["/d1"])],
      { edits: [{ file: "a.ts", intent: "edit a.ts", applied: true }] },
    );
    expect(remaining.map((e) => e.file)).toEqual(["b.ts"]);
    expect(remaining[0].skill_docs).toBeUndefined();
    expect(remaining[0].acceptance).toBe("npm test");
    expect(remaining[0].intent).toContain("Retry after a safeguards stop");
    expect(droppedGuidance).toEqual(["/d1"]);
  });

  it("mergeCoderResults keeps first applied edits", () => {
    const merged = mergeCoderResults(
      {
        edits: [
          { file: "a", intent: "i", applied: true },
          { file: "x", intent: "j", applied: false },
        ],
        status: "partial",
      },
      {
        edits: [{ file: "b", intent: "k", applied: true }],
        status: "complete",
      },
    );
    expect(merged.status).toBe("complete");
    expect(merged.edits?.map((e) => e.file)).toEqual(["a", "b"]);
  });

  it("planLensRetry never respawns unchanged inputs", () => {
    expect(planLensRetry({ inputsChanged: true, agyAvailable: false })).toBe(
      "respawn",
    );
    expect(planLensRetry({ inputsChanged: false, agyAvailable: true })).toBe(
      "delegated",
    );
    expect(planLensRetry({ inputsChanged: false, agyAvailable: false })).toBe(
      "skip",
    );
  });

  it("mapCopyPaths rewrites copy paths back, longest first", () => {
    const copies = { "a.md": "/c/a.md", "sub/a.md": "/c/sub__a.md" };
    expect(mapCopyPaths("see /c/sub__a.md and /c/a.md", copies)).toBe(
      "see sub/a.md and a.md",
    );
  });
});

describe("upsertDecisionItems", () => {
  const body =
    "## Summary\n\nx\n\n## Test Steps\n\n- [ ] one\n\n## Other\n\ny\n";
  const skip = [{ lens: "security", requestIds: ["req_1", "req_2"] }];

  it("adds one item inside Test Steps and is idempotent", () => {
    const once = upsertDecisionItems(body, skip);
    expect(once.match(/flow-safeguards-skip:security/g)).toHaveLength(1);
    expect(once.indexOf("DECISION")).toBeLessThan(once.indexOf("## Other"));
    expect(upsertDecisionItems(once, skip)).toBe(once);
  });

  it("creates the section when absent", () => {
    expect(upsertDecisionItems("intro\n", skip)).toContain("## Test Steps");
  });

  it("removes a stale item and keeps a ticked one", () => {
    const once = upsertDecisionItems(body, skip);
    expect(upsertDecisionItems(once, [])).not.toContain("flow-safeguards-skip");
    const ticked = once.replace("- [ ] DECISION", "- [x] DECISION");
    expect(upsertDecisionItems(ticked, skip)).toBe(ticked);
  });
});

describe("renderSafeguardsNote", () => {
  const rec: RetryRecord = {
    site: "coder",
    firstRequestId: "req_a",
    retryRequestId: null,
    model: "Opus 5.5",
    shape: "stripped",
    paddedFiles: [],
    droppedGuidance: ["/docs/x.md"],
    outcome: "recovered",
    at: "2026-11-10T00:00:00Z",
  };

  it("is empty for no records", () => {
    expect(renderSafeguardsNote([])).toBe("");
  });

  it("renders one callout, dedupes, and names the fix when padded", () => {
    const note = renderSafeguardsNote([
      rec,
      rec,
      {
        ...rec,
        site: "lens:security",
        paddedFiles: ["r.md"],
        outcome: "skipped",
      },
    ]);
    expect(note.split("\n").every((l) => l.startsWith(">"))).toBe(true);
    expect(note).toContain("> [!NOTE]");
    expect(note.match(/code-edit agent/gi)).toHaveLength(1);
    expect(note).toContain("flow-safeguards compact --in-place");
  });
});

describe("CLI", () => {
  it("compact --out-dir prints the JSON map and exits 0", () => {
    const file = path.join(tmp, "padded.md");
    fs.writeFileSync(file, paddedTable());
    const outDir = path.join(tmp, "out");
    const r = spawnSync("bun", [SCRIPT, "compact", "--out-dir", outDir, file], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.anyCompacted).toBe(true);
    expect(json.files[0].compacted).toBe(true);
    expect(fs.existsSync(json.files[0].copy)).toBe(true);
    expect(json.files[0].bytesAfter).toBeLessThan(json.files[0].bytesBefore);
  });

  it("compact --in-place --no-marker keeps the line count of a diff", () => {
    const file = path.join(tmp, "diff.txt");
    const diff = `@@ -1,3 +1,3 @@\n+| a${" ".repeat(1500)}| b |\n+| c | d |\n tail`;
    fs.writeFileSync(file, diff);
    const r = spawnSync(
      "bun",
      [SCRIPT, "compact", "--in-place", "--no-marker", file],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const out = fs.readFileSync(file, "utf8");
    expect(out.split("\n")).toHaveLength(diff.split("\n").length);
    expect(out).not.toContain(PRETTIER_IGNORE);
  });

  it("exits 2 with no args", () => {
    const r = spawnSync("bun", [SCRIPT], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
