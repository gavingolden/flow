import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecFn } from "./epic-manage-observe";
import {
  buildBrief,
  extractPrSections,
  scopeCandidates,
  BRIEF_PR_SECTIONS,
} from "./manager-brief";
import { recordLastPause } from "./pause-capture";
import { writeState, type PipelineState } from "./state";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbrief-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const BODY = `## TLDR
Fixes the export hang.

## User-facing changes
Export streams now.

## Secrets
do-not-show

## Deviations from plan
none
`;

describe("extractPrSections", () => {
  it("returns only listed sections and leaves missing ones absent", () => {
    const out = extractPrSections(BODY, BRIEF_PR_SECTIONS);
    expect(Object.keys(out)).toEqual([
      "TLDR",
      "User-facing changes",
      "Deviations from plan",
    ]);
    expect(JSON.stringify(out)).not.toContain("do-not-show");
  });
});

const put = (over: Partial<PipelineState> = {}) =>
  writeState(
    {
      slug: "a",
      phase: "gated",
      repo: "/r/flow",
      pr: 7,
      updatedAt: "2026-11-12T00:00:10.000Z",
      phaseLog: [
        {
          phase: "gated",
          at: "2026-11-12T00:00:05.000Z",
          outcome: "tests pending",
        },
      ],
      ...over,
    } as PipelineState,
    dir,
  );
const exec: ExecFn = async () => ({
  exitCode: 0,
  stdout: JSON.stringify({ body: BODY }),
  stderr: "",
});

describe("buildBrief", () => {
  it("returns null for an unknown slug", async () => {
    expect(await buildBrief("nope", { stateDir: dir, exec })).toBeNull();
  });

  it("carries PR sections and the saved pause block, with no diff", async () => {
    put();
    recordLastPause(
      "a",
      "gated",
      "**TLDR:** Gated: validate export.\n\n**Next action:** say merge.",
      dir,
    );
    const b = await buildBrief("a", {
      stateDir: dir,
      exec,
      now: () => new Date("2026-11-12T01:00:00.000Z"),
    });
    expect(b?.pause?.tldr).toContain("validate export");
    expect(b?.pauseMissing).toBe(false);
    expect(Object.keys(b?.prSections ?? {})).toContain("TLDR");
    expect(b?.ageMs).toBe(60 * 60_000 - 5_000);
    expect(JSON.stringify(b)).not.toContain("diff --git");
  });

  it("falls back to the outcome text and says the block is missing", async () => {
    put();
    const b = await buildBrief("a", { stateDir: dir, exec });
    expect(b?.pauseMissing).toBe(true);
    expect(b?.pause).toBeNull();
    expect(b?.outcome).toBe("tests pending");
  });

  it("reads a transcript tail only when asked and no pause block exists", async () => {
    const root = path.join(dir, "projects");
    const wt = path.join(dir, "wt");
    put({ worktree: wt });
    const proj = path.join(root, wt.replace(/[^A-Za-z0-9-]/g, "-"));
    fs.mkdirSync(proj, { recursive: true });
    const lines = [
      {
        type: "user",
        message: {
          content: "[pipeline-slug: a] Use the /flow-pipeline skill.",
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "working on it" }] },
      },
    ].map((l) => JSON.stringify(l));
    fs.writeFileSync(path.join(proj, "s.jsonl"), lines.join("\n") + "\n");
    const none = await buildBrief("a", {
      stateDir: dir,
      exec,
      projectsRoot: root,
    });
    expect(none?.transcriptTail).toBeUndefined();
    const tail = await buildBrief("a", {
      stateDir: dir,
      exec,
      projectsRoot: root,
      transcriptTail: 1,
    });
    expect(tail?.transcriptTail).toEqual(["assistant: working on it"]);
  });
});

describe("scopeCandidates", () => {
  it("lists unfinished pipelines by slug, repo and epic only", () => {
    const out = scopeCandidates([
      {
        slug: "b",
        phase: "gated",
        repo: "/r/flow",
        updatedAt: "x",
        epic: { slug: "e", featureId: "f" },
      },
      { slug: "a", phase: "merged", repo: "/r/flow", updatedAt: "x" },
    ] as PipelineState[]);
    expect(out).toEqual([{ slug: "b", repo: "flow", epic: "e" }]);
    expect(JSON.stringify(out)).not.toContain("gated");
  });
});
