/**
 * Shared-artifact producer predicates for the epic-designer layer's feature
 * DAG. Split out of `bin/flow-epic-dag.ts` to keep that file under its
 * target line budget; imported there rather than restated. `DagViolation` /
 * `Feature` stay owned by `flow-epic-dag.ts` / `epic-manifest-schema.ts`
 * respectively — this module only computes against them.
 */

import type { Feature } from "./epic-manifest-schema";
import type { DagViolation } from "../flow-epic-dag";

/** Strip a leading `./` and a trailing `/` from a repo-relative path. */
export function normalizeArtifactPath(p: string): string {
  let out = p;
  if (out.startsWith("./")) out = out.slice(2);
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Group producer feature ids by normalized shared-artifact path. */
function producersByArtifact(features: Feature[]): Map<string, string[]> {
  const byArtifact = new Map<string, string[]>();
  for (const f of features) {
    for (const artifact of f.sharedArtifacts ?? []) {
      const norm = normalizeArtifactPath(artifact);
      const ids = byArtifact.get(norm) ?? [];
      ids.push(f.id);
      byArtifact.set(norm, ids);
    }
  }
  return byArtifact;
}

/**
 * `reaches(from, to)`: true when `to` is a transitive ancestor of `from` —
 * i.e. reachable by walking `dependsOn` forward only, one direction per
 * call. `findUnorderedProducers` below calls this both ways
 * (`reaches(a, b) || reaches(b, a)`) so a producer pair counts as "ordered"
 * whichever way the dependency edge points; mixing both directions inside a
 * single walk would collapse this into connected-component membership and
 * accept sibling producers that share only a common dependency (or a common
 * dependent) as ordered, when the runner can still launch them concurrently.
 */
function reaches(
  from: string,
  to: string,
  byId: Map<string, Feature>,
): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const f = byId.get(id);
    if (!f) continue;
    for (const dep of f.dependsOn) queue.push(dep);
  }
  return false;
}

/**
 * Every artifact listed under `sharedArtifacts` by two or more features must
 * be transitively ordered (via `dependsOn`, either direction) between every
 * pair of its producers — otherwise the runner can schedule both producers
 * concurrently and race the shared file.
 */
export function findUnorderedProducers(features: Feature[]): DagViolation[] {
  const byId = new Map(features.map((f) => [f.id, f]));
  const byArtifact = producersByArtifact(features);
  const violations: DagViolation[] = [];
  for (const [artifact, producers] of byArtifact) {
    for (let i = 0; i < producers.length; i++) {
      for (let j = i + 1; j < producers.length; j++) {
        const a = producers[i];
        const b = producers[j];
        if (reaches(a, b, byId) || reaches(b, a, byId)) continue;
        violations.push({
          kind: "unordered-producers",
          offendingIds: [a, b],
          message: `features "${a}" and "${b}" both produce "${artifact}" but neither depends on the other`,
        });
      }
    }
  }
  return violations;
}

/**
 * A touched path that some feature declares under `sharedArtifacts` must
 * either bring the manifest itself into the same diff (legacy,
 * `opts.featureId` undefined) or be declared by the PR's own feature
 * (`opts.featureId` set) — otherwise a new producer (or a producer edge)
 * is landing without the write-back the manifest owns.
 */
export function findUndeclaredProducers(
  features: Feature[],
  manifestPath: string,
  touched: string[],
  opts: { featureId?: string } = {},
): DagViolation[] {
  const normManifest = normalizeArtifactPath(manifestPath);
  const normTouched = new Set(touched.map((t) => normalizeArtifactPath(t)));
  if (opts.featureId === undefined && normTouched.has(normManifest)) {
    return [];
  }

  const byArtifact = producersByArtifact(features);
  const violations: DagViolation[] = [];
  for (const path of normTouched) {
    const ids = byArtifact.get(path);
    if (!ids || ids.length === 0) continue;
    if (opts.featureId !== undefined) {
      if (ids.includes(opts.featureId)) continue;
      violations.push({
        kind: "undeclared-producer",
        offendingIds: ids,
        message: `"${path}" is a shared artifact of ${ids.join(", ")} but this PR's feature "${opts.featureId}" is not among them — declare "${opts.featureId}" under sharedArtifacts (ordered against the other producers) in the same PR`,
      });
      continue;
    }
    violations.push({
      kind: "undeclared-producer",
      offendingIds: ids,
      message: `"${path}" is a shared artifact of ${ids.join(", ")} but ${manifestPath} is not in this diff — write the producer edge back in the same PR`,
    });
  }
  return violations;
}
