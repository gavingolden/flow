/**
 * Tests for the one-way GitHub sub-issue projection. Mirrors
 * flow-create-issue.test.ts: the `gh` runner is a `vi.fn()` routing stub, so
 * every assertion runs with zero real GitHub access. Covers create + link,
 * idempotent re-run (zero mutating calls), merged→closed, dry-run, and the
 * >100-feature guard.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectionPlan, projectEpic } from "./epic-project";
import type { GhRunner } from "../flow-create-issue";
import type { EpicManifest } from "./epic-manifest-schema";
import type { BoardRow, FeatureStatus } from "./epic-reconcile";

type GhResult = ReturnType<GhRunner>;
const ok = (stdout = ""): GhResult => ({ stdout, stderr: "", exitCode: 0 });

const PARENT_NO = 100;
const CHILD_BASE = 200; // child issue numbers: 200 + index
const DB_BASE = 9000; // child database ids: 9000 + index

function manifest(ids: string[]): EpicManifest {
  return {
    epicId: "epic-x",
    prompt: "build the thing",
    createdAt: "2026-01-01",
    features: ids.map((id) => ({
      id,
      title: id.toUpperCase(),
      description: `build ${id}`,
      dependsOn: [],
    })),
  };
}

function board(statuses: Record<string, FeatureStatus>): BoardRow[] {
  return Object.entries(statuses).map(([id, status]) => ({
    id,
    status,
    dependsOn: [],
  }));
}

/** Index of a feature id in a fixed manifest order, for stable issue numbers. */
function childIndex(ids: string[], title: string): number {
  // child title is `<id>: <ID>` — match on the leading id token.
  const id = title.split(":")[0];
  return ids.indexOf(id);
}

/**
 * A routing `gh` stub. `existing` controls whether the parent / each child is
 * reported as an already-open issue by the title probe (idempotent paths); when
 * false the probe returns `[]` (none) so the orchestrator creates it.
 */
function makeGh(opts: {
  ids: string[];
  parentExists: boolean;
  childrenExist: boolean;
  existingLinks?: number[]; // child issue numbers already linked under parent
}): ReturnType<typeof vi.fn> {
  const { ids, parentExists, childrenExist, existingLinks = [] } = opts;
  return vi.fn((argv: string[]): GhResult => {
    // issue list --search 'in:title "<title>"' (the probe)
    if (argv[0] === "issue" && argv[1] === "list") {
      const search = argv[argv.indexOf("--search") + 1] ?? "";
      const m = search.match(/in:title "(.*)"/);
      const title = m ? m[1] : "";
      if (title.startsWith("Epic:")) {
        if (!parentExists) return ok("[]");
        return ok(
          JSON.stringify([
            {
              number: PARENT_NO,
              title,
              url: `https://github.com/me/r/issues/${PARENT_NO}`,
            },
          ]),
        );
      }
      if (!childrenExist) return ok("[]");
      const idx = childIndex(ids, title);
      const number = CHILD_BASE + idx;
      return ok(
        JSON.stringify([
          { number, title, url: `https://github.com/me/r/issues/${number}` },
        ]),
      );
    }
    // gh label create flow-epic --force
    if (argv[0] === "label") return ok("");
    // gh issue create
    if (argv[0] === "issue" && argv[1] === "create") {
      const title = argv[argv.indexOf("--title") + 1] ?? "";
      if (title.startsWith("Epic:")) {
        return ok(`https://github.com/me/r/issues/${PARENT_NO}\n`);
      }
      const idx = childIndex(ids, title);
      return ok(`https://github.com/me/r/issues/${CHILD_BASE + idx}\n`);
    }
    // gh issue close
    if (argv[0] === "issue" && argv[1] === "close") return ok("");
    // gh api ...
    if (argv[0] === "api") {
      // POST .../sub_issues (the link write)
      if (argv.includes("--method")) return ok("");
      // GET .../{n}/sub_issues (existing links)
      if (argv.some((a) => a.endsWith("/sub_issues"))) {
        return ok(
          JSON.stringify(
            existingLinks.map((number) => ({ number, id: number })),
          ),
        );
      }
      // GET .../issues/{n} --jq .id (database id)
      const m = argv[1]?.match(/issues\/(\d+)$/);
      const num = m ? Number(m[1]) : 0;
      const idx = num - CHILD_BASE;
      return ok(String(DB_BASE + idx));
    }
    return ok("");
  });
}

function callsOf(gh: ReturnType<typeof vi.fn>): string[][] {
  return gh.mock.calls.map((c) => c[0] as string[]);
}
const isCreate = (a: string[]) => a[0] === "issue" && a[1] === "create";
const isClose = (a: string[]) => a[0] === "issue" && a[1] === "close";
const isLinkPost = (a: string[]) =>
  a[0] === "api" && a.includes("--method") && a.includes("POST");

let epicsDir!: string;
beforeEach(() => {
  epicsDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-proj-"));
});
afterEach(() => {
  fs.rmSync(epicsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("buildProjectionPlan", () => {
  it("maps titles, child bodies, and the merged-close set", () => {
    const m = manifest(["schema", "backend"]);
    const plan = buildProjectionPlan(
      m,
      board({ schema: "merged", backend: "running" }),
    );
    expect(plan.parent.title).toBe("Epic: build the thing");
    expect(plan.children.map((c) => c.title)).toEqual([
      "schema: SCHEMA",
      "backend: BACKEND",
    ]);
    expect(plan.linksToCreate).toEqual(["schema", "backend"]);
    expect(plan.subIssuesToClose).toEqual(["schema"]);
  });
});

describe("projectEpic — create", () => {
  it("creates the parent + one child per feature and links each via the integer database id", () => {
    const ids = ["schema"];
    const gh = makeGh({ ids, parentExists: false, childrenExist: false });
    const confirm = vi.fn((_msg: string) => true);
    const outcome = projectEpic({
      slug: "e",
      manifest: manifest(ids),
      board: board({ schema: "ready" }),
      gh,
      epicsDir,
      confirm,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.created).toEqual(["parent", "schema"]);
    expect(outcome.linked).toEqual(["schema"]);

    const calls = callsOf(gh);
    expect(calls.filter(isCreate)).toHaveLength(2);
    const link = calls.find(isLinkPost);
    expect(link).toBeDefined();
    // integer database id (DB_BASE + 0), not the issue number/node_id, via -F.
    expect(link).toContain("-F");
    expect(link).toContain(`sub_issue_id=${DB_BASE + 0}`);
    expect(
      link!.some((s) => s.endsWith(`/issues/${PARENT_NO}/sub_issues`)),
    ).toBe(true);

    // The confirmation gate fired and named the count (parent + 1 child = 2).
    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0][0])).toMatch(/2 real GitHub issues/);

    // projection.json hint persisted.
    const hint = JSON.parse(
      fs.readFileSync(path.join(epicsDir, "e", "projection.json"), "utf8"),
    );
    expect(hint.parentNumber).toBe(PARENT_NO);
    expect(hint.features.schema.databaseId).toBe(DB_BASE + 0);
  });
});

describe("projectEpic — idempotent re-run", () => {
  it("makes zero create/link/close calls when issues + links already exist", () => {
    const ids = ["schema", "backend"];
    const gh = makeGh({
      ids,
      parentExists: true,
      childrenExist: true,
      existingLinks: [CHILD_BASE + 0, CHILD_BASE + 1],
    });
    const outcome = projectEpic({
      slug: "e",
      manifest: manifest(ids),
      board: board({ schema: "running", backend: "running" }),
      gh,
      epicsDir,
      confirm: vi.fn(() => true),
    });
    expect(outcome.ok).toBe(true);
    const calls = callsOf(gh);
    expect(calls.some(isCreate)).toBe(false);
    expect(calls.some(isLinkPost)).toBe(false);
    expect(calls.some(isClose)).toBe(false);
    expect(outcome.skipped).toEqual(["schema", "backend"]);
  });
});

describe("projectEpic — merged → closed", () => {
  it("closes only the merged feature's sub-issue; not-merged stay open", () => {
    const ids = ["schema", "backend"];
    const gh = makeGh({
      ids,
      parentExists: true,
      childrenExist: true,
      existingLinks: [CHILD_BASE + 0, CHILD_BASE + 1],
    });
    const outcome = projectEpic({
      slug: "e",
      manifest: manifest(ids),
      board: board({ schema: "merged", backend: "running" }),
      gh,
      epicsDir,
      confirm: vi.fn(() => true),
    });
    expect(outcome.ok).toBe(true);
    const closes = callsOf(gh).filter(isClose);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain(String(CHILD_BASE + 0)); // schema's issue
    expect(outcome.closed).toEqual(["schema"]);
  });
});

describe("projectEpic — dry-run", () => {
  it("prints the plan JSON and makes zero gh calls", () => {
    const ids = ["schema"];
    const gh = vi.fn();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const outcome = projectEpic({
      slug: "e",
      manifest: manifest(ids),
      board: board({ schema: "merged" }),
      gh: gh as unknown as GhRunner,
      epicsDir,
      dryRun: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.dryRun).toBe(true);
    expect(gh).not.toHaveBeenCalled();
    const written = JSON.parse(String(stdout.mock.calls[0][0]));
    expect(written.parent.title).toBe("Epic: build the thing");
    expect(written.children).toHaveLength(1);
    expect(written.subIssuesToClose).toEqual(["schema"]);
    stdout.mockRestore();
  });
});

describe("projectEpic — >100-feature guard", () => {
  it("refuses before any gh call when the manifest exceeds 100 features", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `f${i}`);
    const gh = vi.fn();
    const outcome = projectEpic({
      slug: "e",
      manifest: manifest(ids),
      board: board({}),
      gh: gh as unknown as GhRunner,
      epicsDir,
      yes: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/100/);
    expect(gh).not.toHaveBeenCalled();
  });
});

describe("projectEpic — confirmation gate", () => {
  it("aborts with zero mutating calls when confirm returns false", () => {
    const ids = ["schema"];
    const gh = makeGh({ ids, parentExists: false, childrenExist: false });
    const outcome = projectEpic({
      slug: "e",
      manifest: manifest(ids),
      board: board({ schema: "ready" }),
      gh,
      epicsDir,
      confirm: () => false,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.aborted).toBe(true);
    const calls = callsOf(gh);
    expect(calls.some(isCreate)).toBe(false);
    expect(calls.some(isLinkPost)).toBe(false);
    expect(calls.some((a) => a[0] === "label")).toBe(false);
  });
});
