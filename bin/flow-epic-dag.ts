#!/usr/bin/env bun
/**
 * DAG well-formedness validator for the epic-designer layer's feature graph.
 *
 * F1 (`bin/lib/epic-manifest-schema.ts`) owns the manifest *shape*; this helper
 * owns its *semantics* — the checks F1 explicitly defers: duplicate ids, orphan
 * dependency edges (a `dependsOn` referencing a non-existent feature), self-
 * dependencies, and cycles. The shape (`EpicManifest`, `Feature`) and the
 * shape gate (`validateEpicManifest`) are imported, never restated.
 *
 * Programmatic contract (the F4 consumer binds to this): `validateDag(features)`
 * returns a discriminated, ALL-violations result so the designer can branch on
 * `kind`/`offendingIds` rather than parse prose. It does NOT fail-fast; the CLI
 * is the only layer that exits early.
 *
 * CLI modes:
 *   `flow-epic-dag --validate <path>` runs F1's shape gate first (exit 1 with
 *   `{ok:false,reason,path}` on read/parse/shape failure, mirroring F1), then
 *   the DAG checks — exit 0 (well-formed) / non-zero (printing each violation
 *   message to stderr) / 2 (usage).
 *
 *   `flow-epic-dag --frontier <path> --completed <ids> [--launched <ids>]` runs
 *   the SAME shape + DAG gate first (identical error contract), then prints the
 *   ready frontier `{ ok: true, frontier: [{ id, title }] }` for the given
 *   completed/launched sets (comma-separated; absent flag = empty set). The LLM
 *   supplies these sets from its own reconciliation — they are deliberately NOT
 *   read from run.json (a stale hint).
 *
 * Kahn's in-degree machinery is used INTERNALLY by `topoSort` to prove
 * acyclicity. The orchestrator's ready frontier is now exported as the pure
 * `computeFrontier` — a net-additive sibling reusing the `dependsOn` walk, not
 * a promotion of the Kahn internal: `topoSort` itself stays private. No
 * stateful orchestrator frontier (the launched/completed bookkeeping) is built
 * here; `computeFrontier` is a stateless function of (features, completed,
 * launched), and the run-state lives in the orchestrator (`epic-run-state.ts`).
 */

import { type Feature, validateEpicManifest } from "./lib/epic-manifest-schema";

export type DagViolationKind =
  | "duplicate-id"
  | "self-dependency"
  | "orphan-edge"
  | "cycle";

export interface DagViolation {
  kind: DagViolationKind;
  offendingIds: string[];
  message: string;
}

export type DagResult =
  | { ok: true }
  | { ok: false; violations: DagViolation[] };

/** Ids that appear on more than one feature. */
export function findDuplicateIds(features: Feature[]): DagViolation[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const f of features) {
    if (seen.has(f.id)) dupes.add(f.id);
    seen.add(f.id);
  }
  return [...dupes].map((id) => ({
    kind: "duplicate-id" as const,
    offendingIds: [id],
    message: `duplicate feature id "${id}"`,
  }));
}

/** `dependsOn` entries that reference an id not present in the feature set. */
export function findOrphanEdges(features: Feature[]): DagViolation[] {
  const ids = new Set(features.map((f) => f.id));
  const violations: DagViolation[] = [];
  for (const f of features) {
    for (const dep of f.dependsOn) {
      if (!ids.has(dep)) {
        violations.push({
          kind: "orphan-edge",
          offendingIds: [f.id, dep],
          message: `feature "${f.id}" depends on missing feature "${dep}"`,
        });
      }
    }
  }
  return violations;
}

/** Features that list their own id in `dependsOn`. */
export function findSelfDependencies(features: Feature[]): DagViolation[] {
  const violations: DagViolation[] = [];
  for (const f of features) {
    if (f.dependsOn.includes(f.id)) {
      violations.push({
        kind: "self-dependency",
        offendingIds: [f.id],
        message: `feature "${f.id}" depends on itself`,
      });
    }
  }
  return violations;
}

/**
 * Kahn's algorithm: repeatedly remove in-degree-0 nodes. Returns the
 * topological order when the graph is acyclic, or null when a cycle remains.
 * Internal — the only public acyclicity signal is `detectCycle`/`validateDag`.
 * `validateDag` calls `detectCycle` unconditionally (no id-space gating), so
 * this IS fed dirty id spaces; rather than being protected from them it is
 * robust to them — orphan and self edges are skipped below and duplicate ids
 * collapse in the Maps, so a dirty id space never crashes or is misreported
 * here (it is reported separately by the id-space checks).
 */
function topoSort(features: Feature[]): string[] | null {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const f of features) {
    inDegree.set(f.id, 0);
    dependents.set(f.id, []);
  }
  for (const f of features) {
    for (const dep of f.dependsOn) {
      // Skip orphan edges (dep not a known node): they cannot form a cycle and
      // are reported separately, so they must not corrupt the in-degree count.
      if (!dependents.has(dep)) continue;
      // Skip self-edges (a -> a): same rationale — they are reported separately
      // as `self-dependency`, and counting one would strand the node out of the
      // ready queue and make Kahn's residue mislabel a self-loop as a `cycle`.
      if (dep === f.id) continue;
      inDegree.set(f.id, (inDegree.get(f.id) ?? 0) + 1);
      dependents.get(dep)!.push(f.id);
    }
  }
  const queue = [...inDegree].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  return order.length === features.length ? order : null;
}

/**
 * Returns the ids participating in a dependency cycle (as an `a -> b -> a`
 * path), or null when the graph is acyclic. Kahn's tells us a cycle EXISTS
 * (by residue) but not WHICH nodes form it; to name it, walk the residual
 * subgraph — the nodes Kahn's could not drain — following one unsatisfied
 * `dependsOn` edge per node via DFS until a node repeats on the active path,
 * then slice the recursion stack from that repeat to recover the actual cycle.
 */
export function detectCycle(features: Feature[]): string[] | null {
  if (topoSort(features) !== null) return null;

  const byId = new Map(features.map((f) => [f.id, f]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function walk(id: string): string[] | null {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // orphan edges are reported separately
      if (dep === id) continue; // self-edges are reported separately as self-dependency
      if (state.get(dep) === "visiting") {
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      if (state.get(dep) !== "done") {
        const found = walk(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  }

  for (const f of features) {
    if (state.get(f.id) === "done") continue;
    const found = walk(f.id);
    if (found) return found;
  }
  return null;
}

/**
 * Aggregate validator — runs every check and returns ALL violations (never
 * fail-fast) so a programmatic consumer can act on the full picture. Checks run
 * in detection order duplicate-id -> orphan-edge -> self-dependency -> cycle:
 * the id-space checks precede cycle detection so an unclean id space is
 * reported as such rather than mislabeled a cycle.
 */
export function validateDag(features: Feature[]): DagResult {
  const violations: DagViolation[] = [
    ...findDuplicateIds(features),
    ...findOrphanEdges(features),
    ...findSelfDependencies(features),
  ];

  const cycle = detectCycle(features);
  if (cycle) {
    violations.push({
      kind: "cycle",
      offendingIds: [...new Set(cycle)],
      message: `dependency cycle: ${cycle.join(" -> ")}`,
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * The ready frontier: every feature that is launchable RIGHT NOW given a
 * `completed` set (features whose work is done — `merged` in the orchestrator)
 * and a `launched` set (features already handed to `flow feature create` this run). A
 * feature is in the frontier iff every id in its `dependsOn` is in `completed`
 * AND the feature itself is in neither `completed` nor `launched`.
 *
 * Pure and stateless — the in-degree machinery of `topoSort` is reused in
 * spirit (the `dependsOn` walk) but not in code: the frontier is a one-shot
 * filter, not a drain. Both sets accept any iterable (Set or array). An orphan
 * or self `dependsOn` edge naturally excludes the feature (its dep can never be
 * in `completed`); the run phase validates the DAG before calling this, so a
 * well-formed graph never relies on that fallback.
 */
export function computeFrontier(
  features: Feature[],
  opts: { completed: Iterable<string>; launched: Iterable<string> },
): Feature[] {
  const completed = new Set(opts.completed);
  const launched = new Set(opts.launched);
  return features.filter(
    (f) =>
      !completed.has(f.id) &&
      !launched.has(f.id) &&
      f.dependsOn.every((dep) => completed.has(dep)),
  );
}

const USAGE =
  "usage: flow-epic-dag --validate <path-to-manifest.json>\n" +
  "       flow-epic-dag --frontier <path-to-manifest.json> --completed <id,id,...> [--launched <id,id,...>]\n";

/** Read the value token after `--flag`, or undefined when absent/at end. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1 || i === argv.length - 1) return undefined;
  return argv[i + 1];
}

/** Split a comma-separated id list into a trimmed, empty-dropping array. */
function parseIdList(csv: string | undefined): string[] {
  if (csv === undefined) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Load + shape-gate + DAG-validate the manifest at `path`, printing the SAME
 * `{ok:false,...}`-on-stderr contract `--validate` uses. Returns the validated
 * features on success, or the exit code on failure.
 */
async function loadValidatedFeatures(
  path: string,
): Promise<{ ok: true; features: Feature[] } | { ok: false; code: number }> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      JSON.stringify({ ok: false, reason: `read failed: ${reason}`, path }) +
        "\n",
    );
    return { ok: false, code: 1 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      JSON.stringify({
        ok: false,
        reason: `JSON parse failed: ${reason}`,
        path,
      }) + "\n",
    );
    return { ok: false, code: 1 };
  }

  const shape = validateEpicManifest(parsed);
  if (!shape.ok) {
    process.stderr.write(
      JSON.stringify({ ok: false, reason: shape.reason, path }) + "\n",
    );
    return { ok: false, code: 1 };
  }

  const dag = validateDag(shape.value.features);
  if (!dag.ok) {
    for (const v of dag.violations) {
      process.stderr.write(v.message + "\n");
    }
    return { ok: false, code: 1 };
  }
  return { ok: true, features: shape.value.features };
}

async function cliMain(argv: string[]): Promise<number> {
  if (argv.includes("--frontier")) {
    const path = flagValue(argv, "--frontier");
    if (path === undefined) {
      process.stderr.write(USAGE);
      return 2;
    }
    const loaded = await loadValidatedFeatures(path);
    if (!loaded.ok) return loaded.code;
    const completed = parseIdList(flagValue(argv, "--completed"));
    const launched = parseIdList(flagValue(argv, "--launched"));
    const frontier = computeFrontier(loaded.features, { completed, launched });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        frontier: frontier.map((f) => ({ id: f.id, title: f.title })),
      }) + "\n",
    );
    return 0;
  }

  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  const path = argv[flagIdx + 1];
  const loaded = await loadValidatedFeatures(path);
  if (!loaded.ok) return loaded.code;
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
  return 0;
}

if (import.meta.main) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code));
}
