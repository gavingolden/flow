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
  parseRetryLog,
  parseSafeguardsStop,
  renderSafeguardsNote,
  validateRetryRecord,
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

  it("force leaves a normally aligned table alone", () => {
    const src = "| a  | b |\n| ---- | - |\n| cc | d |";
    expect(collapsePadding(src, { force: true })).toMatchObject({
      text: src,
      changed: false,
    });
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

  it("words one request id as a single stop and omits empty ids", () => {
    const one = upsertDecisionItems(body, [
      { lens: "security", requestIds: ["req_1"] },
    ]);
    expect(one).toContain(
      "reviewer was skipped after a safeguards stop (request req_1)",
    );
    expect(one).not.toContain("two safeguards stops");
    const none = upsertDecisionItems(body, [
      { lens: "security", requestIds: [] },
    ]);
    expect(none).not.toContain("(request");
    expect(none).not.toContain("review lens");
  });

  it("a ticked item from an earlier stop does not cover a new stop of the same lens", () => {
    const ticked = upsertDecisionItems(body, skip).replace(
      "- [ ] DECISION",
      "- [x] DECISION",
    );
    const next = upsertDecisionItems(ticked, [
      { lens: "security", requestIds: ["req_3", "req_4"] },
    ]);
    expect(next).toContain("- [ ] DECISION");
    expect(next).not.toContain("- [x] DECISION");
    expect(next).toContain("req_3, req_4");
  });

  it("leaves a blank line between a closing details block and the item", () => {
    const withDetails =
      "## Test Steps\n\n<details>\n<summary>e</summary>\n\nx\n\n</details>\n";
    const out = upsertDecisionItems(withDetails, skip);
    expect(out).toContain("</details>\n\n- [ ] DECISION");
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

  it("names the request id and the dropped guidance", () => {
    const note = renderSafeguardsNote([rec]);
    expect(note).toContain("req_a");
    expect(note).toContain("/docs/x.md");
  });

  it("discloses that collapsed padding hid whitespace-only changes", () => {
    const note = renderSafeguardsNote([
      { ...rec, outcome: "proactive-collapse", paddedFiles: ["r.md"] },
    ]);
    expect(note).toContain("Whitespace-only changes");
    expect(renderSafeguardsNote([rec])).not.toContain("Whitespace-only");
  });

  it("calls a skipped agent a reviewer, not a lens", () => {
    const note = renderSafeguardsNote([
      { ...rec, site: "lens:security", outcome: "skipped" },
    ]);
    expect(note).toContain("The security reviewer");
    expect(note).not.toContain("lens");
  });
});

describe("retry records", () => {
  const rec: RetryRecord = {
    site: "lens:security",
    firstRequestId: "req_a",
    retryRequestId: null,
    model: null,
    shape: "none",
    paddedFiles: [],
    droppedGuidance: [],
    outcome: "skipped",
    at: "2026-11-10T00:00:00Z",
  };

  it("accepts a lens site with the none shape and a skipped outcome", () => {
    expect(validateRetryRecord(rec)).toEqual({ ok: true, record: rec });
  });

  it.each([
    ["site", { site: "lens:" }],
    ["site", { site: "other" }],
    ["firstRequestId", { firstRequestId: 3 }],
    ["shape", { shape: "bogus" }],
    ["outcome", { outcome: "bogus" }],
    ["paddedFiles", { paddedFiles: "x" }],
    ["droppedGuidance", { droppedGuidance: [1] }],
    ["at", { at: "" }],
  ])("rejects a bad %s", (_k, over) => {
    expect(validateRetryRecord({ ...rec, ...over }).ok).toBe(false);
  });

  it("parseRetryLog keeps valid lines and drops invalid ones", () => {
    const log = [
      JSON.stringify(rec),
      "not json",
      JSON.stringify({ ...rec, shape: "bogus" }),
      JSON.stringify({ ...rec, site: "lens:" }),
    ].join("\n");
    expect(parseRetryLog(log)).toEqual([rec]);
  });
});

describe("CLI", () => {
  const cli = (args: string[], cwd = tmp) =>
    spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8", cwd });

  it("compact --out-dir prints the JSON map and exits 0", () => {
    const file = path.join(tmp, "padded.md");
    fs.writeFileSync(file, paddedTable());
    const outDir = path.join(tmp, "out");
    const r = cli(["compact", "--out-dir", outDir, file]);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.anyCompacted).toBe(true);
    expect(json.files[0].compacted).toBe(true);
    expect(fs.existsSync(json.files[0].copy)).toBe(true);
    expect(json.files[0].bytesAfter).toBeLessThan(json.files[0].bytesBefore);
    expect(json.copies).toEqual({ [file]: json.files[0].copy });
  });

  it("compact --in-place --no-marker collapses a diff and keeps every prefix", () => {
    const file = path.join(tmp, "diff.txt");
    const diff = `@@ -1,3 +1,3 @@\n+| a${" ".repeat(1500)}| b |\n+| c | d |\n tail`;
    fs.writeFileSync(file, diff);
    const r = cli(["compact", "--in-place", "--no-marker", file]);
    expect(r.status).toBe(0);
    const out = fs.readFileSync(file, "utf8");
    expect(JSON.parse(r.stdout).files[0].compacted).toBe(true);
    expect(findPaddingRuns(out, 64)).toEqual([]);
    expect(out.split("\n")).toEqual([
      "@@ -1,3 +1,3 @@",
      "+| a | b |",
      "+| c | d |",
      " tail",
    ]);
  });

  it("exits 2 with no args", () => {
    const r = spawnSync("bun", [SCRIPT], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  describe("lens-retry-plan", () => {
    const plan = (dir: string, file: string, extra: string[] = []) =>
      JSON.parse(
        cli(
          [
            "lens-retry-plan",
            "--lens",
            "security",
            "--out-dir",
            dir,
            ...extra,
            file,
          ],
          path.dirname(file),
        ).stdout,
      );

    it("does not respawn over copies the lens already read", () => {
      const dir = fs.mkdtempSync(path.join(tmp, "plan-"));
      const f = path.join(dir, "rules.md");
      fs.writeFileSync(f, paddedTable());
      const out = path.join(dir, "g");
      expect(cli(["compact", "--out-dir", out, f], dir).status).toBe(0);
      expect(plan(out, f).route).toBe("skip");
      expect(plan(out, f, ["--agy-available"]).route).toBe("delegated");
    });

    it("respawns when the collapse is new to the lens", () => {
      const dir = fs.mkdtempSync(path.join(tmp, "plan-"));
      const f = path.join(dir, "rules.md");
      fs.writeFileSync(f, paddedTable());
      const r = plan(path.join(dir, "g"), f);
      expect(r.route).toBe("respawn");
      expect(Object.keys(r.copies)).toEqual([f]);
    });

    it("treats an ordinary aligned table as unchanged input", () => {
      const dir = fs.mkdtempSync(path.join(tmp, "plan-"));
      const f = path.join(dir, "t.md");
      fs.writeFileSync(f, "| a  | b |\n| ---- | - |\n");
      expect(plan(path.join(dir, "g"), f).route).toBe("skip");
    });
  });

  describe("write-path confinement", () => {
    const outside = () => fs.mkdtempSync(path.join(os.tmpdir(), "fs-out-"));
    const inside = () => fs.mkdtempSync(path.join(tmp, "cwd-"));

    it("compact --in-place refuses a file outside the cwd tree", () => {
      const o = outside();
      const f = path.join(o, "p.md");
      fs.writeFileSync(f, paddedTable());
      const r = cli(["compact", "--in-place", f], inside());
      expect(r.status).toBe(2);
      expect(fs.readFileSync(f, "utf8")).toBe(paddedTable());
    });

    it("compact --out-dir refuses a directory outside the cwd tree", () => {
      const f = path.join(inside(), "p.md");
      fs.writeFileSync(f, paddedTable());
      const o = path.join(outside(), "o");
      expect(cli(["compact", "--out-dir", o, f], path.dirname(f)).status).toBe(
        2,
      );
      expect(fs.existsSync(o)).toBe(false);
    });

    it("compact --in-place refuses a symlink that escapes the cwd tree", () => {
      const o = outside();
      const target = path.join(o, "p.md");
      fs.writeFileSync(target, paddedTable());
      const cwd = inside();
      fs.symlinkSync(o, path.join(cwd, "link"));
      const r = cli(["compact", "--in-place", "link/p.md"], cwd);
      expect(r.status).toBe(2);
      expect(fs.readFileSync(target, "utf8")).toBe(paddedTable());
    });

    it("record --log refuses a path outside the cwd tree", () => {
      const log = path.join(outside(), "l.jsonl");
      const r = cli(["record", "--log", log, "--json", "{}"], inside());
      expect(r.status).toBe(2);
      expect(fs.existsSync(log)).toBe(false);
    });

    it("retry-set --out refuses a path outside the cwd tree", () => {
      const cwd = inside();
      fs.writeFileSync(path.join(cwd, "e.json"), "[]");
      fs.writeFileSync(path.join(cwd, "p.json"), "{}");
      const out = path.join(outside(), "o.json");
      const r = cli(
        [
          "retry-set",
          "--edit-set",
          "e.json",
          "--partial-result",
          "p.json",
          "--out",
          out,
        ],
        cwd,
      );
      expect(r.status).toBe(2);
      expect(fs.existsSync(out)).toBe(false);
    });

    it("map-paths only rewrites agent-output-*.json inside the cwd tree", () => {
      const cwd = inside();
      fs.writeFileSync(
        path.join(cwd, "m.json"),
        JSON.stringify({ "a.md": "/c/a.md" }),
      );
      const victim = path.join(cwd, "settings.json");
      fs.writeFileSync(victim, "/c/a.md");
      expect(
        cli(["map-paths", "--copies", "m.json", "settings.json"], cwd).status,
      ).toBe(2);
      expect(fs.readFileSync(victim, "utf8")).toBe("/c/a.md");
      const ok = path.join(cwd, "agent-output-security.json");
      fs.writeFileSync(ok, '{"file":"/c/a.md"}');
      expect(cli(["map-paths", "--copies", "m.json", ok], cwd).status).toBe(0);
      expect(fs.readFileSync(ok, "utf8")).toBe('{"file":"a.md"}');
    });
  });

  it("map-paths given compact output rewrites only the copies, never JSON keywords", () => {
    const cwd = fs.mkdtempSync(path.join(tmp, "mp-"));
    const f = path.join(cwd, "rules.md");
    fs.writeFileSync(f, paddedTable());
    const compact = cli(["compact", "--out-dir", path.join(cwd, "g"), f], cwd);
    fs.writeFileSync(path.join(cwd, "c.json"), compact.stdout);
    const copy = JSON.parse(compact.stdout).files[0].copy;
    const ao = path.join(cwd, "agent-output-bug-detection.json");
    fs.writeFileSync(ao, JSON.stringify({ ok: true, file: copy }));
    expect(cli(["map-paths", "--copies", "c.json", ao], cwd).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(ao, "utf8"))).toEqual({
      ok: true,
      file: f,
    });
  });

  it("decision-items ignores the optional product lens", () => {
    const cwd = fs.mkdtempSync(path.join(tmp, "di-"));
    fs.writeFileSync(path.join(cwd, "b.md"), "## Test Steps\n\n- [ ] one\n");
    fs.writeFileSync(
      path.join(cwd, "lens-skip-product.json"),
      JSON.stringify({ lens: "product", request_ids: ["req_9"] }),
    );
    fs.writeFileSync(
      path.join(cwd, "lens-skip-security.json"),
      JSON.stringify({ lens: "security", request_ids: ["req_1"] }),
    );
    const r = cli(
      [
        "decision-items",
        "--body-file",
        "b.md",
        "lens-skip-product.json",
        "lens-skip-security.json",
      ],
      cwd,
    );
    expect(r.stdout).toContain("security reviewer");
    expect(r.stdout).not.toContain("product");
  });
});
