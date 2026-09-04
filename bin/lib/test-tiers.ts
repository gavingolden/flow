/**
 * Pure manifest schema + selection planning for `flow-pre-commit`'s test
 * tiering. No I/O — every decision is a function of the values the caller
 * hands in, so this module stays unit-testable without on-disk fixtures.
 * See `docs/test-quality-methodology.md` for the rubric this manifest
 * shape and selection algorithm implement.
 */

import picomatch from "picomatch";

export type TestTiers = {
  version: 1;
  alwaysRun: string[];
  deferToCi: string[];
  forceFullOn: string[];
};

export type SelectionPlan =
  | { mode: "full"; reason: string }
  | {
      mode: "selected";
      explicitFiles: string[];
      relatedInputs: string[];
      excluded: string[];
      isolatedFiles: string[];
      deferredCount: number;
    };

/**
 * Tolerant by construction — mirrors every other optional consumer-repo
 * manifest in this codebase (filterDefinedChecks, loadDynamicScopes,
 * `bin/lib/stack-table.ts`'s "a silent pass"): a malformed manifest in a
 * consumer repo degrades to the built-in full-suite behaviour, never a
 * hard gate failure. Never throws.
 */
export function parseTestTiers(raw: unknown): TestTiers | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  const fields = ["alwaysRun", "deferToCi", "forceFullOn"] as const;
  for (const field of fields) {
    const value = obj[field];
    if (!Array.isArray(value)) return null;
    if (!value.every((v) => typeof v === "string")) return null;
  }
  return {
    version: 1,
    alwaysRun: obj.alwaysRun as string[],
    deferToCi: obj.deferToCi as string[],
    forceFullOn: obj.forceFullOn as string[],
  };
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function colocatedTestPath(changedFile: string): string | null {
  if (!changedFile.endsWith(".ts") || changedFile.endsWith(".test.ts")) {
    return null;
  }
  return `${changedFile.slice(0, -".ts".length)}.test.ts`;
}

export function planSelection(
  changedFiles: string[] | undefined,
  tiers: TestTiers,
  opts?: { discoveredTestFiles?: string[] },
): SelectionPlan {
  // `bin/flow-pre-commit.ts` deliberately leaves changedFiles undefined on
  // the `--scope <list>` path (no diff to detect against). Without this
  // early guard, explicitFiles would equal alwaysRun, the fail-closed
  // length guard below would NOT fire (the lengths are equal), and every
  // `--scope` invocation would silently run only the always-run linters.
  if (changedFiles === undefined) {
    return { mode: "full", reason: "no changed-file list" };
  }

  const discovered = opts?.discoveredTestFiles;
  const alwaysRun = discovered
    ? tiers.alwaysRun.filter((f) => discovered.includes(f))
    : tiers.alwaysRun;
  const deferToCi = discovered
    ? tiers.deferToCi.filter((f) => discovered.includes(f))
    : tiers.deferToCi;

  for (const trigger of tiers.forceFullOn) {
    const isMatch = picomatch(trigger);
    const hit = changedFiles.find((f) => f === trigger || isMatch(f));
    if (hit) {
      return { mode: "full", reason: `force-full trigger: ${hit}` };
    }
  }

  const deferSet = new Set(deferToCi);
  const colocated = new Set<string>();
  const isolatedFiles = new Set<string>();
  for (const changed of changedFiles) {
    const sibling = colocatedTestPath(changed);
    if (!sibling) continue;
    colocated.add(sibling);
    if (deferSet.has(sibling)) isolatedFiles.add(sibling);
  }

  const explicitFiles = dedupeSorted([...alwaysRun, ...colocated]);

  const relatedInputs = dedupeSorted(
    changedFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")),
  );

  const explicitSet = new Set(explicitFiles);
  const excluded = dedupeSorted(deferToCi.filter((f) => !explicitSet.has(f)));

  // Fail-closed against manifest rot: explicitFiles is a UNION of the
  // (possibly rot-filtered) alwaysRun set with colocated files, so it can
  // never be shorter than that same filtered set — comparing against it
  // would be dead code. Compare against the manifest's DECLARED (pre-rot)
  // alwaysRun length instead: when discoveredTestFiles filtering drops
  // enough alwaysRun entries that even the colocated additions don't make
  // up the difference, something is badly out of sync between the
  // manifest and the repo tree — better to run the full suite than
  // silently skip most of the always-run set.
  if (explicitFiles.length < tiers.alwaysRun.length) {
    return { mode: "full", reason: "selection shorter than always-run set" };
  }

  return {
    mode: "selected",
    explicitFiles,
    relatedInputs,
    excluded,
    isolatedFiles: dedupeSorted([...isolatedFiles]),
    deferredCount: excluded.length,
  };
}
