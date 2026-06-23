import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Feature } from "./lib/epic-manifest-schema";
import {
  type DagViolation,
  detectCycle,
  findDuplicateIds,
  findOrphanEdges,
  findSelfDependencies,
  validateDag,
} from "./flow-epic-dag";

const SCRIPT = path.resolve(__dirname, "flow-epic-dag.ts");

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTmpFile(contents: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "flow-epic-dag-test-"));
  const filePath = path.join(dir, "manifest.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a Feature with the four required fields; others stay omitted. */
function feat(id: string, dependsOn: string[] = []): Feature {
  return {
    id,
    title: id.toUpperCase(),
    description: `feature ${id}`,
    dependsOn,
  };
}

/** Wrap a Feature[] in a shape-valid EpicManifest for CLI round-trips. */
function manifest(features: Feature[]): string {
  return JSON.stringify({
    epicId: "epic-test",
    prompt: "test epic",
    createdAt: "2026-06-22",
    features,
  });
}

function kinds(violations: DagViolation[]): Set<string> {
  return new Set(violations.map((v) => v.kind));
}

/**
 * Semantics (DAG well-formedness) tests for the epic feature graph. F1 owns
 * the manifest shape; this suite pins the F2 contract: the all-violations
 * `validateDag` discriminated result, the per-check predicates, and the
 * `--validate <path>` CLI (shape gate -> DAG checks, exit 0/1/2).
 */

// --- Required matrix: well-formed graphs (validateDag ok + CLI exit 0) ---

describe("validateDag — well-formed DAGs are accepted", () => {
  const accepted: Array<[string, Feature[]]> = [
    ["empty (no features)", []],
    [
      "linear chain a -> b -> c",
      [feat("a"), feat("b", ["a"]), feat("c", ["b"])],
    ],
    [
      "diamond a -> {b,c} -> d",
      [feat("a"), feat("b", ["a"]), feat("c", ["a"]), feat("d", ["b", "c"])],
    ],
    [
      "disconnected components (two independent sub-DAGs)",
      [feat("a"), feat("b", ["a"]), feat("x"), feat("y", ["x"])],
    ],
  ];

  it.each(accepted)("accepts %s", (_label, features) => {
    expect(validateDag(features)).toEqual({ ok: true });
  });

  it.each(accepted)("CLI exits 0 for %s", (_label, features) => {
    withTmpFile(manifest(features), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true });
      expect(result.stderr).toBe("");
    });
  });
});

// --- Required matrix: cycle ---

describe("validateDag — cycle is rejected and named", () => {
  const cyclic = [feat("a", ["b"]), feat("b", ["a"])];

  it("returns a kind:'cycle' violation naming a and b", () => {
    const result = validateDag(cyclic);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const cycle = result.violations.find((v) => v.kind === "cycle");
    expect(cycle).toBeDefined();
    expect(cycle!.offendingIds).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("detectCycle recovers a path containing the cycle members", () => {
    const cycle = detectCycle(cyclic);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("detectCycle returns null for an acyclic graph", () => {
    expect(detectCycle([feat("a"), feat("b", ["a"])])).toBeNull();
  });

  it("CLI exits non-zero with both ids on stderr", () => {
    withTmpFile(manifest(cyclic), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("a");
      expect(result.stderr).toContain("b");
    });
  });
});

// --- Required matrix: orphan edge ---

describe("validateDag — orphan edge is rejected and named", () => {
  const orphan = [feat("a", ["ghost"])];

  it("returns a kind:'orphan-edge' violation naming the missing id", () => {
    const result = validateDag(orphan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const edge = result.violations.find((v) => v.kind === "orphan-edge");
    expect(edge).toBeDefined();
    expect(edge!.offendingIds).toContain("ghost");
  });

  it("findOrphanEdges flags the dangling dependency", () => {
    const found = findOrphanEdges(orphan);
    expect(found).toHaveLength(1);
    expect(found[0].offendingIds).toEqual(
      expect.arrayContaining(["a", "ghost"]),
    );
  });

  it("CLI exits non-zero with the missing id on stderr", () => {
    withTmpFile(manifest(orphan), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ghost");
    });
  });
});

// --- duplicate id ---

describe("validateDag — duplicate id is rejected", () => {
  const dup = [feat("a"), feat("a")];

  it("returns a kind:'duplicate-id' violation naming the duplicate", () => {
    const result = validateDag(dup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const violation = result.violations.find((v) => v.kind === "duplicate-id");
    expect(violation).toBeDefined();
    expect(violation!.offendingIds).toContain("a");
  });

  it("findDuplicateIds reports each duplicate id once", () => {
    expect(findDuplicateIds(dup)).toHaveLength(1);
    expect(findDuplicateIds([feat("a"), feat("a"), feat("a")])).toHaveLength(1);
  });

  it("CLI exits non-zero with the duplicate id on stderr", () => {
    withTmpFile(manifest(dup), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("a");
    });
  });
});

// --- self-dependency ---

describe("validateDag — self-dependency is rejected", () => {
  const selfDep = [feat("a", ["a"])];

  it("returns a kind:'self-dependency' violation naming the id", () => {
    const result = validateDag(selfDep);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const violation = result.violations.find(
      (v) => v.kind === "self-dependency",
    );
    expect(violation).toBeDefined();
    expect(violation!.offendingIds).toContain("a");
  });

  it("reports EXACTLY one self-dependency violation, never a spurious cycle", () => {
    // A pure self-loop a -> a must surface as a single self-dependency, not be
    // double-reported as both self-dependency AND a 1-node `cycle: a -> a`.
    const result = validateDag(selfDep);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(1);
    expect(kinds(result.violations)).toEqual(new Set(["self-dependency"]));
  });

  it("findSelfDependencies flags the self-referential feature", () => {
    const found = findSelfDependencies(selfDep);
    expect(found).toHaveLength(1);
    expect(found[0].offendingIds).toContain("a");
  });

  it("CLI exits non-zero with the id on stderr", () => {
    withTmpFile(manifest(selfDep), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("a");
    });
  });
});

// --- Story 6: multi-violation aggregation (all violations, not fail-fast) ---

describe("validateDag — aggregates ALL violations", () => {
  it("reports a duplicate id AND an orphan edge together", () => {
    // 'a' appears twice (duplicate-id) and 'b' depends on a missing 'ghost'
    // (orphan-edge): two distinct violation categories in one graph.
    const features = [feat("a"), feat("a"), feat("b", ["ghost"])];
    const result = validateDag(features);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(2);
    expect(kinds(result.violations)).toEqual(
      new Set(["duplicate-id", "orphan-edge"]),
    );
  });
});

// --- Story 8: CLI shape cases (mirror F1's validator) ---

describe("flow-epic-dag CLI — shape and error cases", () => {
  it("exits 2 with usage on stderr when --validate is missing", () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
    expect(result.stdout).toBe("");
  });

  it("exits 1 with read failure on stderr for an unreadable path", () => {
    const missing = path.join(tmpdir(), "flow-epic-dag-missing-" + Date.now());
    const result = runCli(["--validate", missing]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("read failed");
    expect(parsed.path).toBe(missing);
  });

  it("exits 1 with JSON parse failure on stderr for malformed JSON", () => {
    withTmpFile("{ not valid json", (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("JSON parse failed");
      expect(parsed.path).toBe(filePath);
    });
  });

  it("exits 1 with the shape reason on stderr for an off-shape manifest", () => {
    // missing epicId -> F1's shape gate rejects before any DAG check runs.
    withTmpFile(
      JSON.stringify({ prompt: "p", createdAt: "2026-06-22", features: [] }),
      (filePath) => {
        const result = runCli(["--validate", filePath]);
        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stderr.trim());
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toContain("epicId");
      },
    );
  });
});
