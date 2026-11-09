import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyUnfixedAntiPatterns,
  type BundleCandidate,
} from "./flow-fix-applier-bundle-check";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bundle-check-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const SCRIPT = path.join(__dirname, "flow-fix-applier-bundle-check.ts");

const W = "src/lib/components/watchlist";
const PAGE = `${W}/WatchlistListPage.svelte`;
const PAGE_TEST = `${PAGE}.test.ts`;
const SKEL = `${W}/WatchlistListLoadingSkeleton.svelte`;
const FILES: Record<string, string> = {
  [PAGE]: `import WatchlistListLoadingSkeleton from "./WatchlistListLoadingSkeleton.svelte";`,
  [PAGE_TEST]: "// test",
  [SKEL]: "<div/>",
  "src/lib/components/analysis/AnalysisListLoadingSkeleton.svelte": "<div/>",
};
const readFile = (p: string) => FILES[p] ?? null;
const touchedFiles = [
  PAGE,
  PAGE_TEST,
  "src/lib/components/analysis/AnalysisListLoadingSkeleton.svelte",
];
const FID = `test-coverage:${PAGE}:172:suggestion`;
const REJ = {
  finding_id: FID,
  considered_approach:
    "Assert zero skeleton elements in the refetch-with-rows spec",
  why_rejected: "Populated rows render their own per-cell skeletons (48 found)",
};
const gap = (extra: Record<string, unknown> = {}) => ({
  location: SKEL,
  pattern: "List-level skeleton has no distinguishing role/testid",
  recommendation: "Add a data-testid",
  introduced_by_this_pr: false,
  ...extra,
});
const classify = (
  art: Record<string, unknown>,
  ctx: Partial<Parameters<typeof classifyUnfixedAntiPatterns>[1]> = {},
) => classifyUnfixedAntiPatterns(art, { touchedFiles, readFile, ...ctx });

describe("classifyUnfixedAntiPatterns", () => {
  it("PR #1183: rejected alternative links the gap as blocked/missing", () => {
    const r = classify({
      rejected_alternatives: [REJ],
      anti_patterns_found: [gap()],
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      adjacency: "blocked",
      justification: "missing",
      blockedFindingId: FID,
    });
  });

  it("without the rejected alternative it is referenced/missing", () => {
    const r = classify({ anti_patterns_found: [gap()] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      adjacency: "referenced",
      justification: "missing",
    });
  });

  it("out of scope on an adjacent entry is still a candidate", () => {
    const r = classify({
      anti_patterns_found: [
        gap({ why_not_fixed: "out of scope: pre-existing file" }),
      ],
    });
    expect(r[0].justification).toBe("out-of-scope");
  });

  it("explicit blocked_finding_id on an unreferenced untouched file is blocked", () => {
    const r = classify(
      {
        anti_patterns_found: [
          gap({
            location: "src/other/Far.ts:3",
            blocked_finding_id: "x:a.ts:1:y",
            why_not_fixed: "out of scope: elsewhere",
          }),
        ],
      },
      { readFile: () => null },
    );
    expect(r[0]).toMatchObject({
      adjacency: "blocked",
      blockedFindingId: "x:a.ts:1:y",
    });
  });

  it("blocked entry re-justified not mechanical stays a candidate", () => {
    const r = classify({
      rejected_alternatives: [REJ],
      anti_patterns_found: [
        gap({ why_not_fixed: "not mechanical: design call" }),
      ],
    });
    expect(r[0]).toMatchObject({
      adjacency: "blocked",
      justification: "not-mechanical",
    });
  });

  it("adjacent unblocked with not small is not a candidate", () => {
    expect(
      classify({
        anti_patterns_found: [gap({ why_not_fixed: "not small: 40 files" })],
      }),
    ).toEqual([]);
  });

  it("adjacent with not confident is not a candidate", () => {
    expect(
      classify({
        anti_patterns_found: [gap({ why_not_fixed: "not confident: unsure" })],
      }),
    ).toEqual([]);
  });

  it("unreferenced, untouched, unlinked is not a candidate", () => {
    expect(
      classify({
        anti_patterns_found: [gap({ location: "src/far/Away.ts:1" })],
      }),
    ).toEqual([]);
  });

  const prior: BundleCandidate = {
    index: 0,
    location: SKEL,
    pattern: gap().pattern,
    adjacency: "blocked",
    justification: "missing",
    blockedFindingId: FID,
  };
  const findingCommit = { sha: "a", finding_id: FID, files: [PAGE_TEST] };

  it("post-fix artifact that re-strengthened the test clears the prior", () => {
    const r = classify(
      {
        commits: [
          findingCommit,
          { sha: "b", finding_id: `bundle:${SKEL}`, files: [SKEL, PAGE_TEST] },
        ],
        anti_patterns_found: [],
      },
      { priorBlocked: [prior] },
    );
    expect(r).toEqual([]);
  });

  it("bundle commit touching only the skeleton leaves a residual candidate", () => {
    const r = classify(
      {
        commits: [
          findingCommit,
          { sha: "b", finding_id: `bundle:${SKEL}`, files: [SKEL] },
        ],
        anti_patterns_found: [],
      },
      { priorBlocked: [prior] },
    );
    expect(r).toEqual([prior]);
  });

  it("introduced entry with not small is an introduced candidate", () => {
    const r = classify({
      anti_patterns_found: [
        gap({ introduced_by_this_pr: true, why_not_fixed: "not small: big" }),
      ],
    });
    expect(r[0]).toMatchObject({
      adjacency: "introduced",
      justification: "not-small",
    });
  });

  it("index.ts imported by directory name is referenced", () => {
    const r = classify(
      { anti_patterns_found: [gap({ location: "src/Foo/index.ts:2" })] },
      {
        touchedFiles: ["src/a.ts"],
        readFile: (p) => (p === "src/a.ts" ? `import x from './Foo'` : null),
      },
    );
    expect(r[0].adjacency).toBe("referenced");
  });

  it("row.svelte imported with extension is referenced", () => {
    const r = classify(
      { anti_patterns_found: [gap({ location: "src/row.svelte" })] },
      {
        touchedFiles: ["src/a.svelte"],
        readFile: (p) =>
          p === "src/a.svelte" ? `import R from "./row.svelte";` : null,
      },
    );
    expect(r[0].adjacency).toBe("referenced");
  });

  it("+page.svelte stem is regex-escaped", () => {
    const r = classify(
      { anti_patterns_found: [gap({ location: "src/routes/+page.svelte" })] },
      {
        touchedFiles: ["src/routes/x.ts"],
        readFile: (p) =>
          p === "src/routes/x.ts" ? `import P from './+page.svelte'` : null,
      },
    );
    expect(r[0].adjacency).toBe("referenced");
  });

  it("unknown why_not_fixed prefix counts as missing", () => {
    const r = classify({
      anti_patterns_found: [gap({ why_not_fixed: "whatever" })],
    });
    expect(r[0].justification).toBe("missing");
  });

  it("a bare comment-id finding_id neither crashes nor infers a block", () => {
    const r = classify({
      rejected_alternatives: [{ ...REJ, finding_id: "c-42" }],
      anti_patterns_found: [gap({ location: "src/far/Away.ts:1" })],
    });
    expect(r).toEqual([]);
  });

  it("a gap at file:line inside a touched file is touched/missing", () => {
    const r = classify(
      { anti_patterns_found: [gap({ location: `${PAGE}:12` })] },
      { readFile: () => null },
    );
    expect(r).toEqual([
      expect.objectContaining({
        adjacency: "touched",
        justification: "missing",
      }),
    ]);
  });

  it("a touched-file gap justified not mechanical is not a candidate", () => {
    expect(
      classify(
        {
          anti_patterns_found: [
            gap({
              location: `${PAGE}:12`,
              why_not_fixed: "not mechanical: x",
            }),
          ],
        },
        { readFile: () => null },
      ),
    ).toEqual([]);
  });

  it("a nearby rejected alternative that does not name the gap does not block it", () => {
    const r = classify({
      rejected_alternatives: [REJ],
      anti_patterns_found: [
        gap({
          location: `${PAGE}:200`,
          pattern: "Magic number sprinkled in timer",
          why_not_fixed: "not confident: unsure",
        }),
      ],
    });
    expect(r).toEqual([]);
  });

  it("same-named modules in different directories are not one hop away", () => {
    const r = classify(
      { anti_patterns_found: [gap({ location: "src/lib/server/utils.ts:1" })] },
      {
        touchedFiles: ["src/ui/a.ts"],
        readFile: (p) =>
          p === "src/ui/a.ts" ? `import u from "./utils"` : null,
      },
    );
    expect(r).toEqual([]);
    const hit = classify(
      { anti_patterns_found: [gap({ location: "src/ui/utils.ts:1" })] },
      {
        touchedFiles: ["src/ui/a.ts"],
        readFile: (p) =>
          p === "src/ui/a.ts" ? `import u from "./utils"` : null,
      },
    );
    expect(hit[0].adjacency).toBe("referenced");
  });

  it("a kept blocked entry is not duplicated by its prior", () => {
    const r = classify(
      {
        anti_patterns_found: [
          gap({ blocked_finding_id: FID, why_not_fixed: "not mechanical: x" }),
        ],
      },
      { priorBlocked: [prior] },
    );
    expect(r).toHaveLength(1);
    expect(r[0].adjacency).toBe("blocked");
  });

  it("a non-blocked prior is ignored", () => {
    expect(
      classify(
        { anti_patterns_found: [] },
        { priorBlocked: [{ ...prior, adjacency: "referenced" }] },
      ),
    ).toEqual([]);
  });

  it("a bundle commit clears a prior whose blocked finding has no commit", () => {
    const r = classify(
      {
        commits: [{ sha: "b", finding_id: `bundle:${SKEL}`, files: [SKEL] }],
        anti_patterns_found: [],
      },
      { priorBlocked: [{ ...prior, blockedFindingId: "x:unparsable" }] },
    );
    expect(r).toEqual([]);
  });

  it("the prior check tolerates an :<idx> suffix and a line-suffixed location", () => {
    const r = classify(
      {
        commits: [
          findingCommit,
          { sha: "b", finding_id: `bundle:${SKEL}`, files: [SKEL, PAGE_TEST] },
        ],
        anti_patterns_found: [],
      },
      {
        priorBlocked: [
          { ...prior, blockedFindingId: `${FID}:2`, location: `${SKEL}:4` },
        ],
      },
    );
    expect(r).toEqual([]);
  });

  it("tolerates the :<idx> finding-id suffix", () => {
    const r = classify({
      rejected_alternatives: [{ ...REJ, finding_id: `${FID}:2` }],
      anti_patterns_found: [gap()],
    });
    expect(r[0].adjacency).toBe("blocked");
  });
});

describe("CLI", () => {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, W), { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, SKEL), "<div/>");
  git("add", ".");
  git("commit", "-qm", "base");
  fs.writeFileSync(path.join(repo, PAGE), FILES[PAGE]);
  git("add", ".");
  git("commit", "-qm", "page");
  const artifact = path.join(tmp, "artifact.json");
  fs.writeFileSync(artifact, JSON.stringify({ anti_patterns_found: [gap()] }));
  const cli = (args: string[]) =>
    spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });

  it("prints the verdict and writes --out", () => {
    const out = path.join(tmp, "out.json");
    const r = cli([
      "--artifact",
      artifact,
      "--worktree",
      repo,
      "--base",
      "main~1",
      "--out",
      out,
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).needsContinuation).toBe(true);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).touchedFiles).toBe(1);
  });

  it("has the exec bit set", () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("exits 2 on an option-shaped --base", () => {
    const r = cli([
      "--artifact",
      artifact,
      "--worktree",
      repo,
      "--base",
      "--output=x",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not an option");
  });

  it("round-trips its own --out verdict through --prior", () => {
    const first = path.join(tmp, "first.json");
    const art1 = path.join(tmp, "art1.json");
    fs.writeFileSync(
      art1,
      JSON.stringify({
        rejected_alternatives: [REJ],
        anti_patterns_found: [gap()],
      }),
    );
    const args = ["--worktree", repo, "--base", "main~1"];
    expect(cli(["--artifact", art1, ...args, "--out", first]).status).toBe(0);
    const art2 = path.join(tmp, "art2.json");
    fs.writeFileSync(
      art2,
      JSON.stringify({
        rejected_alternatives: [REJ],
        commits: [{ sha: "a", finding_id: FID, files: [PAGE_TEST] }],
        anti_patterns_found: [],
      }),
    );
    const r = cli(["--artifact", art2, ...args, "--prior", first]);
    expect(r.status).toBe(0);
    const v = JSON.parse(r.stdout.trim());
    expect(v.needsContinuation).toBe(true);
    expect(v.candidates[0].adjacency).toBe("blocked");
  });

  it("exits 2 on an unparseable --prior", () => {
    const bad = path.join(tmp, "bad-prior.json");
    fs.writeFileSync(bad, "{nope");
    expect(
      cli([
        "--artifact",
        artifact,
        "--worktree",
        repo,
        "--base",
        "main~1",
        "--prior",
        bad,
      ]).status,
    ).toBe(2);
  });

  it("exits 2 without --base", () => {
    expect(cli(["--artifact", artifact, "--worktree", repo]).status).toBe(2);
  });

  it("exits 2 on an unparseable artifact", () => {
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{nope");
    expect(
      cli(["--artifact", bad, "--worktree", repo, "--base", "main~1"]).status,
    ).toBe(2);
  });
});
