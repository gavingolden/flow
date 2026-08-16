import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attach,
  crossCheckAgainstSource,
  MARKER,
  MAX_COMMENT_CHARS,
  parseArgs,
  parseMapFile,
  parseRefIndex,
  parseSourcePath,
  parseVerbatimFile,
  renderComment,
  run,
  type Args,
  type GhRunner,
  type MapFile,
} from "./flow-verbatim-notes";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-verbatim-notes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const CAPTURE = [
  "<!-- flow-verbatim-refs: H5, M33 -->",
  "<!-- flow-verbatim-source: ./notes-source.md -->",
  "",
  "**H5** — adhoc notes, high priority",
  "",
  "> This woudln't work without the migration first.",
  "> \t1. Check the migration script",
  "> ---",
  "> ?",
  "",
  "**M33** — adhoc notes, medium priority",
  "",
  "> Should we redesign the settings page or just patch it for now.",
].join("\n");

const NOTES_SOURCE = [
  "H5. This woudln't work without the migration first.",
  "\t1. Check the migration script",
  "---",
  "?",
  "",
  "M33. Should we redesign the settings page or just patch it for now.",
].join("\n");

function fakeGh(
  responses: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }[],
): { gh: GhRunner; calls: { argv: string[]; stdin?: string }[] } {
  const calls: { argv: string[]; stdin?: string }[] = [];
  let i = 0;
  const gh: GhRunner = (argv, stdin) => {
    calls.push({ argv, stdin });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? 0,
    };
  };
  return { gh, calls };
}

const MAP: MapFile = {
  version: 1,
  sourceOfTruth: "./notes-source.md",
  preamble: { triageDates: "the 2026-08-07 triage" },
  attachments: [
    {
      issue: 100,
      refs: [
        { ref: "H5", label: "adhoc, high priority" },
        { ref: "M33", label: "adhoc, medium priority" },
      ],
    },
  ],
  unattached: [{ ref: "H9", reason: "no matching open issue" }],
};

describe(parseRefIndex, () => {
  it("reads the refs index line", () => {
    expect(parseRefIndex(CAPTURE)).toEqual(new Set(["H5", "M33"]));
  });

  it("is fatal when the index line is missing", () => {
    expect(() => parseRefIndex("**H5**\n> body")).toThrow(/flow-verbatim-refs/);
  });
});

describe(parseSourcePath, () => {
  it("reads the provenance line", () => {
    expect(parseSourcePath(CAPTURE)).toBe("./notes-source.md");
  });
});

describe(parseVerbatimFile, () => {
  const refIndex = new Set(["H5", "M33"]);

  it("preserves body bytes exactly, including a typo, a tab sub-bullet, and a bare `?` line", () => {
    const blocks = parseVerbatimFile(CAPTURE, refIndex);
    expect(blocks.get("H5")).toBe(
      [
        "> This woudln't work without the migration first.",
        "> \t1. Check the migration script",
        "> ---",
        "> ?",
      ].join("\n"),
    );
  });

  it("does not treat a bare `---` line inside a note body as a boundary", () => {
    const blocks = parseVerbatimFile(CAPTURE, refIndex);
    expect(blocks.get("H5")).toContain("> ---");
    expect(blocks.size).toBe(2);
  });

  it("does not treat an ATX heading inside a note body as a boundary", () => {
    const text = [
      "<!-- flow-verbatim-refs: H5 -->",
      "<!-- flow-verbatim-source: ./x.md -->",
      "",
      "**H5** — a note",
      "",
      "> ## Not a real heading",
      "> more body",
    ].join("\n");
    const blocks = parseVerbatimFile(text, new Set(["H5"]));
    expect(blocks.get("H5")).toBe("> ## Not a real heading\n> more body");
  });

  it("does not treat a `**ref**`-shaped line naming an unknown ref as a boundary", () => {
    const text = [
      "<!-- flow-verbatim-refs: H5 -->",
      "<!-- flow-verbatim-source: ./x.md -->",
      "",
      "**H5** — a note",
      "",
      "> quoting **Bold** text inline is fine",
      "> **Unknown** — this looks like a heading but isn't indexed",
      "> tail body",
    ].join("\n");
    const blocks = parseVerbatimFile(text, new Set(["H5"]));
    expect(blocks.size).toBe(1);
    expect(blocks.get("H5")).toContain(
      "> **Unknown** — this looks like a heading but isn't indexed",
    );
  });
});

describe(crossCheckAgainstSource, () => {
  it("passes for a clean capture", () => {
    const refIndex = parseRefIndex(CAPTURE);
    const blocks = parseVerbatimFile(CAPTURE, refIndex);
    expect(crossCheckAgainstSource(blocks, NOTES_SOURCE)).toEqual([]);
  });

  it("is fatal (names the ref) when a block was silently normalized at capture", () => {
    const blocks = new Map([["H5", "> This wouldn't work."]]); // typo fixed
    const source = "This woudln't work.";
    const failures = crossCheckAgainstSource(blocks, source);
    expect(failures).toEqual([
      { ref: "H5", reason: expect.stringContaining("byte-for-byte") },
    ]);
  });

  it("is fatal when a trailing `?` was dropped (a dropped suffix is still a valid substring, so the check needs the trailing-boundary guard)", () => {
    const blocks = new Map([["H5", "> body without the question mark"]]);
    const source = "body without the question mark? more text follows";
    expect(crossCheckAgainstSource(blocks, source)).toEqual([
      {
        ref: "H5",
        reason: expect.stringContaining("truncated"),
      },
    ]);
  });

  it("is fatal on collapsed whitespace", () => {
    const collapsedBlocks = new Map([["H5", "> a  double  space  body"]]);
    const collapsedSource = "a double space body";
    expect(crossCheckAgainstSource(collapsedBlocks, collapsedSource)).toEqual([
      { ref: "H5", reason: expect.any(String) },
    ]);
  });

  it("passes when the block legitimately ends at a whitespace/EOF boundary", () => {
    const blocks = new Map([["H5", "> body text"]]);
    expect(crossCheckAgainstSource(blocks, "body text")).toEqual([]);
    expect(
      crossCheckAgainstSource(blocks, "prefix\nbody text\nmore stuff"),
    ).toEqual([]);
  });
});

describe(parseMapFile, () => {
  it("rejects an unattached entry with no reason", () => {
    const bad = {
      version: 1,
      sourceOfTruth: "./x.md",
      preamble: { triageDates: "d" },
      attachments: [],
      unattached: [{ ref: "H1", reason: "" }],
    };
    const result = parseMapFile(JSON.stringify(bad));
    expect(result).toEqual({ error: expect.stringContaining("reason") });
  });

  it("parses a valid map", () => {
    expect(parseMapFile(JSON.stringify(MAP))).toEqual(MAP);
  });
});

describe(renderComment, () => {
  it("starts with MARKER and carries every ref's body", () => {
    const refIndex = parseRefIndex(CAPTURE);
    const blocks = parseVerbatimFile(CAPTURE, refIndex);
    const body = renderComment(MAP.attachments[0], blocks, MAP);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("H5");
    expect(body).toContain("M33");
    expect(body).toContain("Source of truth: ./notes-source.md");
  });
});

describe("attach", () => {
  function setupFixture(): Args {
    write("notes-source.md", NOTES_SOURCE);
    const verbatimFile = write("capture.md", CAPTURE);
    const mapFile = write("map.json", JSON.stringify(MAP));
    // parseSourcePath resolves relative to cwd, not the capture file's own
    // directory, so point the provenance line at the fixture's absolute path.
    const rewritten = fs
      .readFileSync(verbatimFile, "utf8")
      .replace(
        "<!-- flow-verbatim-source: ./notes-source.md -->",
        `<!-- flow-verbatim-source: ${path.join(dir, "notes-source.md")} -->`,
      );
    fs.writeFileSync(verbatimFile, rewritten);
    return { verbatimFile, mapFile, dryRun: false };
  }

  it("no prior marker comment: creates, first line is MARKER", () => {
    const args = setupFixture();
    const { gh, calls } = fakeGh([
      { stdout: JSON.stringify({ state: "OPEN" }) }, // issue view
      { stdout: "[]" }, // list comments
      { stdout: JSON.stringify({ html_url: "https://x/1" }) }, // POST
    ]);
    const envelope = attach(args, gh);
    expect(envelope.attachments).toEqual([
      {
        issue: 100,
        refs: ["H5", "M33"],
        action: "created",
        reason: null,
        commentUrl: "https://x/1",
      },
    ]);
    const postCall = calls[2];
    expect(postCall.argv).toContain("--input");
    const posted = JSON.parse(postCall.stdin!) as { body: string };
    expect(posted.body.startsWith(MARKER)).toBe(true);
  });

  it("existing marker comment with different content: PATCHes that comment (never a second comment)", () => {
    const args = setupFixture();
    const { gh, calls } = fakeGh([
      { stdout: JSON.stringify({ state: "OPEN" }) },
      {
        stdout: JSON.stringify([{ id: 42, body: MARKER + "\nstale content" }]),
      },
      { stdout: JSON.stringify({ html_url: "https://x/2" }) },
    ]);
    const envelope = attach(args, gh);
    expect(envelope.attachments[0].action).toBe("updated");
    const patchCall = calls[2];
    expect(patchCall.argv).toContain("repos/{owner}/{repo}/issues/comments/42");
    expect(patchCall.argv).toContain("--method");
    expect(patchCall.argv).toContain("PATCH");
  });

  it("identical existing body: unchanged with zero write calls", () => {
    const args = setupFixture();
    const refIndex = parseRefIndex(fs.readFileSync(args.verbatimFile, "utf8"));
    const blocks = parseVerbatimFile(
      fs.readFileSync(args.verbatimFile, "utf8"),
      refIndex,
    );
    const body = renderComment(MAP.attachments[0], blocks, MAP);
    const { gh, calls } = fakeGh([
      { stdout: JSON.stringify({ state: "OPEN" }) },
      { stdout: JSON.stringify([{ id: 7, body }]) },
    ]);
    const envelope = attach(args, gh);
    expect(envelope.attachments[0].action).toBe("unchanged");
    expect(calls).toHaveLength(2); // issue view + list comments — no write call
  });

  it("fatal: a ref named in the map but absent from the capture file posts nothing for any issue", () => {
    write("notes-source.md", NOTES_SOURCE);
    const verbatimFile = write(
      "capture.md",
      [
        "<!-- flow-verbatim-refs: H5 -->",
        `<!-- flow-verbatim-source: ${path.join(dir, "notes-source.md")} -->`,
        "",
        "**H5** — adhoc notes",
        "",
        "> This woudln't work without the migration first.",
      ].join("\n"),
    );
    const mapFile = write("map.json", JSON.stringify(MAP)); // MAP references M33 too
    const { gh, calls } = fakeGh([{ stdout: "should never be reached" }]);
    expect(() => attach({ verbatimFile, mapFile, dryRun: false }, gh)).toThrow(
      /M33/,
    );
    expect(calls).toHaveLength(0);
  });

  it("scope: a closed issue is skipped:issue-closed and the run continues", () => {
    const args = setupFixture();
    const { gh } = fakeGh([{ stdout: JSON.stringify({ state: "CLOSED" }) }]);
    const envelope = attach(args, gh);
    expect(envelope.attachments[0]).toMatchObject({
      action: "skipped",
      reason: "issue-closed",
    });
  });

  it("scope: an oversized body is skipped:body-too-large naming the refs, and posts nothing", () => {
    const args = setupFixture();
    const hugeMap: MapFile = {
      ...MAP,
      attachments: [
        {
          issue: 100,
          refs: [
            { ref: "H5", label: "x".repeat(MAX_COMMENT_CHARS) },
            { ref: "M33", label: "adhoc" },
          ],
        },
      ],
    };
    fs.writeFileSync(args.mapFile, JSON.stringify(hugeMap));
    const { gh, calls } = fakeGh([
      { stdout: JSON.stringify({ state: "OPEN" }) },
    ]);
    const envelope = attach(args, gh);
    expect(envelope.attachments[0].action).toBe("skipped");
    expect(envelope.attachments[0].reason).toContain("body-too-large");
    expect(envelope.attachments[0].reason).toContain("H5");
    expect(calls).toHaveLength(1); // issue view only — no list/post call
  });

  it("scope: a per-issue gh failure is skipped:gh-error with a bounded excerpt, and the run continues to remaining issues", () => {
    const args = setupFixture();
    const twoIssueMap: MapFile = {
      ...MAP,
      attachments: [
        { issue: 100, refs: [{ ref: "H5", label: "x" }] },
        { issue: 200, refs: [{ ref: "M33", label: "y" }] },
      ],
    };
    fs.writeFileSync(args.mapFile, JSON.stringify(twoIssueMap));
    const { gh } = fakeGh([
      { stdout: JSON.stringify({ state: "OPEN" }) }, // issue 100 state
      { exitCode: 1, stderr: "boom".repeat(1000) }, // issue 100 list fails
      { stdout: JSON.stringify({ state: "OPEN" }) }, // issue 200 state
      { stdout: "[]" }, // issue 200 list
      { stdout: JSON.stringify({ html_url: "https://x/3" }) }, // issue 200 create
    ]);
    const envelope = attach(args, gh);
    expect(envelope.attachments[0]).toMatchObject({
      issue: 100,
      action: "skipped",
    });
    expect(envelope.attachments[0].reason).toContain("gh-error");
    expect(envelope.attachments[0].reason!.length).toBeLessThan(600);
    expect(envelope.attachments[1]).toMatchObject({
      issue: 200,
      action: "created",
    });
  });

  it("duplicate markers: updates the first, populates duplicateMarkers, deletes nothing", () => {
    const args = setupFixture();
    const { gh, calls } = fakeGh([
      { stdout: JSON.stringify({ state: "OPEN" }) },
      {
        stdout: JSON.stringify([
          { id: 1, body: MARKER + "\nfirst" },
          { id: 2, body: MARKER + "\nsecond" },
        ]),
      },
      { stdout: JSON.stringify({ html_url: "https://x/4" }) },
    ]);
    const envelope = attach(args, gh);
    expect(envelope.duplicateMarkers).toEqual([100]);
    expect(envelope.attachments[0].action).toBe("updated");
    const patchCall = calls[2];
    expect(patchCall.argv).toContain("repos/{owner}/{repo}/issues/comments/1");
    expect(
      calls.some((c) => c.argv.includes("-X") && c.argv.includes("DELETE")),
    ).toBe(false);
  });

  it("--dry-run: would-create/would-update with zero write calls", () => {
    const args = setupFixture();
    args.dryRun = true;
    const { gh, calls } = fakeGh([
      { stdout: JSON.stringify({ state: "OPEN" }) },
      { stdout: "[]" },
    ]);
    const envelope = attach(args, gh);
    expect(envelope.attachments[0].action).toBe("would-create");
    expect(calls).toHaveLength(2); // issue view + list — no POST/PATCH
  });
});

describe(parseArgs, () => {
  it("parses the attach subcommand flags", () => {
    expect(
      parseArgs(["--verbatim-file", "a.md", "--map-file", "b.json"]),
    ).toEqual({ verbatimFile: "a.md", mapFile: "b.json", dryRun: false });
  });

  it("requires --verbatim-file and --map-file", () => {
    expect(parseArgs([])).toEqual({
      error: expect.stringContaining("--verbatim-file"),
    });
  });
});

describe("run (CLI)", () => {
  it("exits non-zero and posts nothing on a fatal error", () => {
    write("notes-source.md", NOTES_SOURCE);
    const verbatimFile = write("capture.md", "**H5**\n> no index line");
    const mapFile = write("map.json", JSON.stringify(MAP));
    const { gh, calls } = fakeGh([{ stdout: "unreachable" }]);
    const code = run(
      ["attach", "--verbatim-file", verbatimFile, "--map-file", mapFile],
      gh,
    );
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
