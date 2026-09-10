import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Feature } from "./lib/epic-manifest-schema";
import {
  type DagViolation,
  computeFrontier,
  detectCycle,
  findDuplicateIds,
  findOrphanEdges,
  findSelfDependencies,
  findUndeclaredProducers,
  findUnorderedProducers,
  validateDag,
} from "./flow-epic-dag";

const SCRIPT = path.resolve(__dirname, "flow-epic-dag.ts");

function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf8",
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
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
function feat(
  id: string,
  dependsOn: string[] = [],
  sharedArtifacts?: string[],
): Feature {
  return {
    id,
    title: id.toUpperCase(),
    description: `feature ${id}`,
    dependsOn,
    ...(sharedArtifacts !== undefined ? { sharedArtifacts } : {}),
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

// --- computeFrontier: the orchestrator's ready-set (Story 1) ---

describe("computeFrontier — ready-set computation", () => {
  const ids = (features: Feature[]): string[] => features.map((f) => f.id);

  it("returns [] for an empty graph", () => {
    expect(computeFrontier([], { completed: [], launched: [] })).toEqual([]);
  });

  it("linear chain a -> b -> c: only the next undone node is ready", () => {
    const features = [feat("a"), feat("b", ["a"]), feat("c", ["b"])];
    // Nothing done yet: only the root `a` is ready.
    expect(
      ids(computeFrontier(features, { completed: [], launched: [] })),
    ).toEqual(["a"]);
    // `a` merged: `b` unblocks; `c` still waits on `b`.
    expect(
      ids(computeFrontier(features, { completed: ["a"], launched: [] })),
    ).toEqual(["b"]);
    // `a` merged but `b` already launched: nothing new is ready.
    expect(
      computeFrontier(features, { completed: ["a"], launched: ["b"] }),
    ).toEqual([]);
  });

  it("diamond a -> {b,c} -> d: both middles ready once root completes; tail only after both", () => {
    const features = [
      feat("a"),
      feat("b", ["a"]),
      feat("c", ["a"]),
      feat("d", ["b", "c"]),
    ];
    expect(
      ids(computeFrontier(features, { completed: ["a"], launched: [] })),
    ).toEqual(["b", "c"]);
    // Only one middle done: `d` still blocked (needs both b and c).
    expect(
      ids(
        computeFrontier(features, { completed: ["a", "b"], launched: ["c"] }),
      ),
    ).toEqual([]);
    // Both middles merged: the tail `d` is ready.
    expect(
      ids(
        computeFrontier(features, { completed: ["a", "b", "c"], launched: [] }),
      ),
    ).toEqual(["d"]);
  });

  it("disconnected components: independent roots are both ready", () => {
    const features = [feat("a"), feat("b", ["a"]), feat("x"), feat("y", ["x"])];
    expect(
      ids(computeFrontier(features, { completed: [], launched: [] })),
    ).toEqual(["a", "x"]);
  });

  it("partial completion: a feature with some-but-not-all deps complete is excluded", () => {
    const features = [feat("a"), feat("b"), feat("c", ["a", "b"])];
    // `a` done, `b` not: `c` must NOT be in the frontier; only `b` is ready.
    expect(
      ids(computeFrontier(features, { completed: ["a"], launched: [] })),
    ).toEqual(["b"]);
  });

  it("all-complete returns empty", () => {
    const features = [feat("a"), feat("b", ["a"]), feat("c", ["b"])];
    expect(
      computeFrontier(features, { completed: ["a", "b", "c"], launched: [] }),
    ).toEqual([]);
  });

  it("accepts Set inputs as well as arrays (iterable contract)", () => {
    const features = [feat("a"), feat("b", ["a"])];
    expect(
      ids(
        computeFrontier(features, {
          completed: new Set(["a"]),
          launched: new Set<string>(),
        }),
      ),
    ).toEqual(["b"]);
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

describe("flow-epic-dag CLI — --frontier", () => {
  // a → b → c (linear); plus an independent d.
  const chain = manifest([
    feat("a"),
    feat("b", ["a"]),
    feat("c", ["b"]),
    feat("d"),
  ]);

  it("prints the ready frontier for the given completed set", () => {
    withTmpFile(chain, (filePath) => {
      // Nothing completed → in-degree-0 nodes a and d are ready.
      const r0 = runCli(["--frontier", filePath, "--completed", ""]);
      expect(r0.status).toBe(0);
      const p0 = JSON.parse(r0.stdout.trim());
      expect(p0.ok).toBe(true);
      expect(p0.frontier.map((f: { id: string }) => f.id).sort()).toEqual([
        "a",
        "d",
      ]);
      // Each frontier entry carries id + title.
      expect(p0.frontier.find((f: { id: string }) => f.id === "a").title).toBe(
        "A",
      );

      // a completed → b unblocks (d still ready).
      const r1 = runCli(["--frontier", filePath, "--completed", "a"]);
      expect(
        JSON.parse(r1.stdout.trim())
          .frontier.map((f: { id: string }) => f.id)
          .sort(),
      ).toEqual(["b", "d"]);
    });
  });

  it("excludes features already in --launched (no duplicate launch)", () => {
    withTmpFile(chain, (filePath) => {
      const r = runCli([
        "--frontier",
        filePath,
        "--completed",
        "a",
        "--launched",
        "b",
      ]);
      expect(r.status).toBe(0);
      // b is launched → withheld; only d remains ready.
      expect(
        JSON.parse(r.stdout.trim()).frontier.map((f: { id: string }) => f.id),
      ).toEqual(["d"]);
    });
  });

  it("tolerates unknown ids in --completed (they simply never satisfy deps)", () => {
    withTmpFile(chain, (filePath) => {
      const r = runCli(["--frontier", filePath, "--completed", "ghost,a"]);
      expect(r.status).toBe(0);
      // The unknown 'ghost' is ignored; a is completed so b unblocks.
      expect(
        JSON.parse(r.stdout.trim())
          .frontier.map((f: { id: string }) => f.id)
          .sort(),
      ).toEqual(["b", "d"]);
    });
  });

  it("fails DAG validation first with the same error contract as --validate", () => {
    // A cycle: --frontier must run the shape+DAG gate before computing anything.
    withTmpFile(manifest([feat("x", ["y"]), feat("y", ["x"])]), (filePath) => {
      const r = runCli(["--frontier", filePath, "--completed", ""]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/cycle/i);
    });
  });

  it("fails the shape gate for an off-shape manifest (same JSON error contract)", () => {
    withTmpFile(
      JSON.stringify({ prompt: "p", createdAt: "2026-06-22", features: [] }),
      (filePath) => {
        const r = runCli(["--frontier", filePath]);
        expect(r.status).toBe(1);
        const parsed = JSON.parse(r.stderr.trim());
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toContain("epicId");
      },
    );
  });

  it("exits 2 with usage when --frontier has no path", () => {
    const r = runCli(["--frontier"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});

describe("findUnorderedProducers / validateDag — shared-artifact producer ordering", () => {
  it("rejects two producers of the same artifact with no edge between them", () => {
    const features = [
      feat("a", [], ["shared.json"]),
      feat("b", [], ["shared.json"]),
    ];
    const violations = findUnorderedProducers(features);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unordered-producers");
    expect(violations[0].offendingIds).toEqual(
      expect.arrayContaining(["a", "b"]),
    );
    expect(violations[0].message).toContain("shared.json");
    expect(violations[0].message).toContain("a");
    expect(violations[0].message).toContain("b");

    const result = validateDag(features);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(kinds(result.violations)).toContain("unordered-producers");
    }
  });

  it("accepts a direct dependsOn edge between the two producers", () => {
    const features = [
      feat("a", [], ["shared.json"]),
      feat("b", ["a"], ["shared.json"]),
    ];
    expect(findUnorderedProducers(features)).toEqual([]);
    expect(validateDag(features)).toEqual({ ok: true });
  });

  it("accepts a transitive path a -> x -> b between the two producers", () => {
    const features = [
      feat("a", [], ["shared.json"]),
      feat("x", ["a"]),
      feat("b", ["x"], ["shared.json"]),
    ];
    expect(findUnorderedProducers(features)).toEqual([]);
  });

  it("accepts a non-producer with no edge to a producer", () => {
    const features = [
      feat("a", [], ["shared.json"]),
      feat("b", ["a"], ["shared.json"]),
      feat("c"),
    ];
    expect(findUnorderedProducers(features)).toEqual([]);
  });

  it("accepts manifests without any sharedArtifacts field", () => {
    const features = [feat("a"), feat("b", ["a"])];
    expect(findUnorderedProducers(features)).toEqual([]);
  });

  it("rejects two producers that only share a common dependency (siblings run in parallel)", () => {
    const features = [
      feat("root"),
      feat("a", ["root"], ["shared.json"]),
      feat("b", ["root"], ["shared.json"]),
    ];
    expect(kinds(findUnorderedProducers(features))).toContain(
      "unordered-producers",
    );
    expect(
      computeFrontier(features, { completed: ["root"], launched: [] }).map(
        (f) => f.id,
      ),
    ).toEqual(["a", "b"]); // proves the runner would co-launch them
  });

  it("rejects two producers that only share a common dependent", () => {
    const features = [
      feat("a", [], ["shared.json"]),
      feat("b", [], ["shared.json"]),
      feat("y", ["a", "b"]),
    ];
    expect(kinds(findUnorderedProducers(features))).toContain(
      "unordered-producers",
    );
  });

  it("CLI --validate stderr names both ids and the artifact for an unordered pair", () => {
    withTmpFile(
      manifest([
        feat("a", [], ["shared.json"]),
        feat("b", [], ["shared.json"]),
      ]),
      (filePath) => {
        const r = runCli(["--validate", filePath]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("a");
        expect(r.stderr).toContain("b");
        expect(r.stderr).toContain("shared.json");
      },
    );
  });
});

describe("findUndeclaredProducers / --touched-files CLI", () => {
  const withProducer = [
    feat("a", [], ["backend/eval/baseline/scorecard.json"]),
  ];

  it("exits 0 when the touched artifact's manifest is also in the touched list", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const dir = path.dirname(filePath);
      const r = runCli(
        [
          "--touched-files",
          filePath,
          "backend/eval/baseline/scorecard.json",
          "manifest.json",
        ],
        { cwd: dir },
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true });
    });
  });

  it("exits 1 with undeclared-producer message when the manifest is missing from the touched list", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "backend/eval/baseline/scorecard.json",
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("backend/eval/baseline/scorecard.json");
      expect(r.stderr).toContain("is not in this diff");
    });
  });

  it("exits 0 when the touched path is not a declared shared artifact", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli(["--touched-files", filePath, "some/other/file.ts"]);
      expect(r.status).toBe(0);
    });
  });

  it("exits 0 with zero touched paths", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli(["--touched-files", filePath]);
      expect(r.status).toBe(0);
    });
  });

  it("normalizes a './'-prefixed path to match", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "./backend/eval/baseline/scorecard.json",
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("is not in this diff");
    });
  });

  it("findUndeclaredProducers returns no violations when zero paths are touched", () => {
    expect(findUndeclaredProducers(withProducer, "manifest.json", [])).toEqual(
      [],
    );
  });

  it("exits 2 with usage when --touched-files has no manifest path", () => {
    const r = runCli(["--touched-files"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  it("exits 2 with usage on a bare trailing --feature", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "backend/eval/baseline/scorecard.json",
        "--feature",
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage:");
    });
  });

  it("--feature '' falls back to the legacy manifest-in-diff rule", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "--feature",
        "",
        "backend/eval/baseline/scorecard.json",
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("is not in this diff");
    });
  });

  it("propagates a DAG violation from the manifest as exit 1 before the touched scan", () => {
    withTmpFile(manifest([feat("a", ["b"]), feat("b", ["a"])]), (filePath) => {
      const r = runCli(["--touched-files", filePath, "some/file.ts"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/cycle/i);
    });
  });

  it("reports one violation per touched artifact naming every declared producer", () => {
    const features = [
      feat("a", [], ["x.json", "y.json"]),
      feat("b", ["a"], ["x.json"]),
    ];
    const violations = findUndeclaredProducers(
      features,
      ".flow/epics/e/manifest.json",
      ["x.json", "./y.json", "unrelated.ts"],
    );
    expect(violations.map((v) => [v.kind, v.offendingIds])).toEqual([
      ["undeclared-producer", ["a", "b"]],
      ["undeclared-producer", ["a"]],
    ]);
  });

  it("findUndeclaredProducers with featureId: skips a path declared by the given feature, flags one that isn't", () => {
    const features = [feat("a", [], ["x.json"]), feat("c", [], ["y.json"])];
    const violations = findUndeclaredProducers(
      features,
      "manifest.json",
      ["x.json", "y.json"],
      { featureId: "a" },
    );
    expect(violations.map((v) => v.offendingIds)).toEqual([["c"]]);
    expect(violations[0].message).toContain('feature "a" is not among them');
    expect(violations[0].message).toContain(
      'declare "a" under sharedArtifacts',
    );
  });

  it("--feature a: exits 0 when the PR's own feature declares the touched artifact", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "--feature",
        "a",
        "backend/eval/baseline/scorecard.json",
      ]);
      expect(r.status).toBe(0);
    });
  });

  it("--feature b: exits 0 for an ordered second producer (b dependsOn a)", () => {
    const ordered = [
      feat("a", [], ["shared/x.json"]),
      feat("b", ["a"], ["shared/x.json"]),
    ];
    withTmpFile(manifest(ordered), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "--feature",
        "b",
        "shared/x.json",
      ]);
      expect(r.status).toBe(0);
    });
  });

  it("--feature c: exits 1 naming the feature and 'declare' when the feature doesn't declare the artifact", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "--feature",
        "c",
        "backend/eval/baseline/scorecard.json",
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('feature "c" is not among them');
      expect(r.stderr).toContain('declare "c" under sharedArtifacts');
    });
  });

  it("manifest in touched but --feature c undeclared still exits 1", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const dir = path.dirname(filePath);
      const r = runCli(
        [
          "--touched-files",
          filePath,
          "--feature",
          "c",
          "backend/eval/baseline/scorecard.json",
          "manifest.json",
        ],
        { cwd: dir },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('feature "c" is not among them');
    });
  });

  it("--feature placed after the touched paths is still parsed", () => {
    withTmpFile(manifest(withProducer), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "backend/eval/baseline/scorecard.json",
        "--feature",
        "a",
      ]);
      expect(r.status).toBe(0);
    });
  });

  it("--feature a: exits 1 with the unordered-producers message when a and b are unordered producers", () => {
    const unordered = [
      feat("a", [], ["shared/x.json"]),
      feat("b", [], ["shared/x.json"]),
    ];
    withTmpFile(manifest(unordered), (filePath) => {
      const r = runCli([
        "--touched-files",
        filePath,
        "--feature",
        "a",
        "shared/x.json",
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/neither depends on the other/);
    });
  });

  it("relative manifest path resolved against the git root matches git-diff-style touched paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "epic-dag-git-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(path.join(dir, ".flow/epics/e"), { recursive: true });
      writeFileSync(
        path.join(dir, ".flow/epics/e/manifest.json"),
        manifest(withProducer),
      );
      const ok = runCli(
        [
          "--touched-files",
          ".flow/epics/e/manifest.json",
          "--feature",
          "a",
          "backend/eval/baseline/scorecard.json",
        ],
        { cwd: dir },
      );
      expect(ok.status).toBe(0);
      const legacy = runCli(
        [
          "--touched-files",
          ".flow/epics/e/manifest.json",
          "backend/eval/baseline/scorecard.json",
          ".flow/epics/e/manifest.json",
        ],
        { cwd: dir },
      );
      expect(legacy.status).toBe(0);
      const bad = runCli(
        [
          "--touched-files",
          ".flow/epics/e/manifest.json",
          "--feature",
          "zzz",
          ".flow/epics/e/manifest.json",
          "backend/eval/baseline/scorecard.json",
        ],
        { cwd: dir },
      );
      expect(bad.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("--validate followups warning", () => {
  it("warns on stderr and still exits 0 when the manifest carries a top-level followups array", () => {
    withTmpFile(
      JSON.stringify({
        epicId: "epic-test",
        prompt: "test epic",
        createdAt: "2026-06-22",
        features: [feat("a")],
        followups: ["some deferred idea"],
      }),
      (filePath) => {
        const r = runCli(["--validate", filePath]);
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("warning:");
        expect(r.stderr).toContain("followups");
      },
    );
  });

  it("does not warn when the manifest has no followups key", () => {
    withTmpFile(manifest([feat("a")]), (filePath) => {
      const r = runCli(["--validate", filePath]);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    });
  });
});
