/**
 * Pure scoring core for `flow-test-audit`: no fs, no subprocess. Split out
 * of `bin/flow-test-audit.ts` to keep that file under the 200-line budget
 * (re-exported from there so `import ... from "./flow-test-audit"` still
 * works for callers/tests). See `docs/test-quality-methodology.md` for the
 * rubric this implements.
 */

import type { TestTiers } from "./test-tiers";

export type FileScore = {
  path: string;
  wallMs: number;
  assertions: number;
  msPerAssertion: number;
  medianRatio: number;
  spawnsSubprocess: boolean;
  scansRepoTree: boolean;
  isLive: boolean;
  tier: "alwaysRun" | "deferToCi" | "default";
  quadrant:
    | "cheap-valuable"
    | "expensive-irreplaceable"
    | "expensive-avoidable"
    | "cheap-low-value";
};

const SPAWN_PATTERN =
  /execFileSync|spawnSync|execSync|Bun\.spawn|execa|child_process/;
const REPO_READ_PATTERN =
  /\breadFileSync\s*\(|\breaddirSync\s*\(|\bglobSync\s*\(|Bun\.file\s*\(/;
const DEFER_WALL_MS_THRESHOLD = 2000;
// A file counts as "expensive" for quadrant assignment once its ms/assert
// is at least this many times the repo median. Mirrored in
// docs/test-quality-methodology.md's ## Axes section.
const EXPENSIVE_MEDIAN_MULTIPLIER = 10;
// "High assertion count" for the irreplaceable-vs-avoidable split, and the
// "very low assertion count" cutoff for cheap-low-value. Both mirrored in
// the doc above.
const HIGH_ASSERTION_COUNT = 5;
const LOW_ASSERTION_COUNT = 3;

export const FORCE_FULL_ON = [
  "vitest.config.ts",
  "vitest.setup.ts",
  "tsconfig*.json",
  "package.json",
  "package-lock.json",
];

/**
 * Approximates "module scope" by stripping the bodies of vitest's
 * DEFERRED callbacks — it/test and the before/after hooks, whose bodies
 * run later, at execution time — via brace-depth matching, then
 * re-checking the repo-read pattern against what's left. Deliberately
 * does NOT strip `describe(...)` bodies (vitest runs a describe callback
 * synchronously at collection time, so a top-level statement inside one —
 * including a call to a plain helper function defined elsewhere in the
 * file — really does execute on every file load, same as true module
 * scope) or plain helper-function bodies (a helper's body text is left
 * visible so a read reachable from collection-time code, even through an
 * intermediate helper, still counts — the conservative direction, since
 * flagging one runtime-only helper as "module scope" only pushes a file
 * toward `alwaysRun`, never causes a coverage hole). Approximate (no real
 * parser), documented rather than hidden.
 */
function stripDeferredCallbackBodies(source: string): string {
  const opener =
    /\b(it|test|beforeAll|beforeEach|afterAll|afterEach)(?:\.\w+)?\s*\(/g;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    if (match.index < cursor) continue;
    const braceStart = source.indexOf("{", match.index);
    if (braceStart === -1) continue;
    let depth = 0;
    let i = braceStart;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    result += source.slice(cursor, match.index);
    cursor = i;
    opener.lastIndex = i;
  }
  result += source.slice(cursor);
  return result;
}

// A file that anchors its own paths to the repo root — the
// `fileURLToPath(import.meta.url)` + `path.resolve(HERE, "..")` idiom
// every structural-anchor lint in this repo uses — is reading COMMITTED
// repo content wherever it later calls a repo-read function, even from
// inside a deferred it() body (unlike an ephemeral mkdtempSync fixture
// path, which never gets a REPO_ROOT-style constant). This catches lints
// whose read sits inside `describe`'s `it()` children rather than
// directly in the describe body itself.
const REPO_ROOT_ANCHOR_PATTERN = /\b(REPO_ROOT|repoRoot)\s*=/;

function scansRepoTree(source: string): boolean {
  if (!REPO_READ_PATTERN.test(source)) return false;
  if (REPO_READ_PATTERN.test(stripDeferredCallbackBodies(source))) return true;
  return REPO_ROOT_ANCHOR_PATTERN.test(source);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function quadrantFor(
  msPerAssertion: number,
  medianMsPerAssertion: number,
  spawnsSubprocess: boolean,
  assertions: number,
): FileScore["quadrant"] {
  const expensive =
    medianMsPerAssertion > 0 &&
    msPerAssertion > medianMsPerAssertion * EXPENSIVE_MEDIAN_MULTIPLIER;
  if (expensive) {
    return spawnsSubprocess && assertions >= HIGH_ASSERTION_COUNT
      ? "expensive-irreplaceable"
      : "expensive-avoidable";
  }
  return assertions < LOW_ASSERTION_COUNT
    ? "cheap-low-value"
    : "cheap-valuable";
}

export function scoreFiles(input: {
  timings: Map<string, { wallMs: number; assertions: number }>;
  sources: Map<string, string>;
}): FileScore[] {
  const raw = [...input.timings.entries()].map(([filePath, t]) => ({
    filePath,
    wallMs: t.wallMs,
    assertions: t.assertions,
    msPerAssertion: t.wallMs / Math.max(t.assertions, 1),
  }));
  const medianMsPerAssertion = median(raw.map((r) => r.msPerAssertion));

  return raw.map((r) => {
    const source = input.sources.get(r.filePath) ?? "";
    const spawnsSubprocess = SPAWN_PATTERN.test(source);
    const isLive = r.filePath.endsWith(".live.test.ts");
    const repoTree = scansRepoTree(source);
    // isLive is checked first, ahead of scansRepoTree: a `.live.test.ts`
    // file spawns a real end-to-end process and must always defer to CI
    // regardless of measured cost OR of a runtime-only helper (e.g. one
    // polling a JSONL registry file it wrote itself) incidentally tripping
    // the repo-read pattern.
    const tier: FileScore["tier"] = isLive
      ? "deferToCi"
      : repoTree
        ? "alwaysRun"
        : spawnsSubprocess && r.wallMs > DEFER_WALL_MS_THRESHOLD
          ? "deferToCi"
          : "default";
    return {
      path: r.filePath,
      wallMs: r.wallMs,
      assertions: r.assertions,
      msPerAssertion: r.msPerAssertion,
      medianRatio:
        medianMsPerAssertion > 0 ? r.msPerAssertion / medianMsPerAssertion : 0,
      spawnsSubprocess,
      scansRepoTree: repoTree,
      isLive,
      tier,
      quadrant: quadrantFor(
        r.msPerAssertion,
        medianMsPerAssertion,
        spawnsSubprocess,
        r.assertions,
      ),
    };
  });
}

export function toTiers(scores: FileScore[]): TestTiers {
  const alwaysRun = scores
    .filter((s) => s.tier === "alwaysRun")
    .map((s) => s.path)
    .sort();
  const deferToCi = scores
    .filter((s) => s.tier === "deferToCi")
    .map((s) => s.path)
    .sort();
  return { version: 1, alwaysRun, deferToCi, forceFullOn: FORCE_FULL_ON };
}

export { median };
