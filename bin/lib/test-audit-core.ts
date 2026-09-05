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
 * Curated `alwaysRun` floor: contract linters whose local-verify coverage
 * is non-negotiable, named explicitly rather than left to derivation alone.
 * `scansRepoTree`'s per-call-site text analysis (see below) cannot see
 * through every shape a genuine repo-tree scanner takes — some read a
 * fixture in the TEST file but exercise a real repo-tree read only via the
 * production CLI they invoke as a subprocess (`flow-md-validate.test.ts`,
 * `flow-plugin-contract-lint.test.ts`), others read the tree only through
 * an imported sibling module rather than their own body
 * (`command-lint.test.ts`, `gate-summary-recipe-lint.test.ts`). Widening
 * the text-analysis detector to reach those shapes was tried and reverted
 * (see `docs/test-quality-methodology.md` ## Axes A3 — a naive one-hop
 * local-import inline ballooned `alwaysRun` from 46 files to 142, because
 * many unrelated test files transitively import the same widely-shared
 * `bin/lib/*.ts` helper that happens to contain an unrelated repo read).
 * A named floor is a correctness fix, not a scope-creep shortcut: `toTiers`
 * still derives the REST of `alwaysRun` from the `scansRepoTree` axis (see
 * `scoreFiles` below), so adding a genuinely new contract linter still
 * doesn't require editing this list unless it shares one of the two shapes
 * above. An entry that no longer names a real file (a rename/removal)
 * silently drops out at scoring time — `scoreFiles` only ever tests
 * membership against paths it was actually asked to score, never errors
 * on an unmatched floor entry.
 */
export const REQUIRED_LINTERS: readonly string[] = [
  "bin/skill-md-lint.test.ts",
  "bin/pane-read-lint.test.ts",
  "bin/slug-flag-contract-lint.test.ts",
  "bin/failure-docs-lint.test.ts",
  "bin/flow-backlog-triage-skill-lint.test.ts",
  "bin/flow-confidence-rubric-lint.test.ts",
  "bin/flow-plan-lint.test.ts",
  "bin/flow-research-budget-lint.test.ts",
  "bin/flow-research-cache-wiring-lint.test.ts",
  "bin/flow-research-skill-lint.test.ts",
  "bin/flow-value-rubric-lint.test.ts",
  "bin/forceresearch-wiring-lint.test.ts",
  "bin/gate-summary-recipe-lint.test.ts",
  "bin/headless-claude-lint.test.ts",
  "bin/flow-md-validate.test.ts",
  "bin/lib/command-lint.test.ts",
  "bin/flow-plugin-contract-lint.test.ts",
  "bin/lib/flow-pipeline-skill.test.ts",
  "bin/lib/stack-skill-frontmatter.test.ts",
  "bin/lib/model-routing-table.test.ts",
  "bin/flow-pipeline-step10.test.ts",
  "bin/flow-pipeline-step11.test.ts",
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

// Seed tokens for the two name-derivation traces below: an assignment (or
// helper-function return) whose right-hand side contains one of these is
// the ROOT of a repo-anchor or temp-root identifier chain.
const ANCHOR_SEED_PATTERN = /\b__dirname\b|import\.meta\.(?:dir|url|dirname)\b/;
const TEMP_SEED_PATTERN = /\bmkdtempSync\s*\(|os\.tmpdir\s*\(/;
// A literal naming a tracked repo surface — real even with no traceable
// anchor variable (e.g. a describe-body read of a hardcoded doc path).
const REPO_SURFACE_LITERAL_PATTERN =
  /["'`](?:\.\.\/)*(?:AGENTS\.md|README\.md|SKILL\.md|skills\/|docs\/|references\/|templates\/|\.github\/)/;

/**
 * Regex-based (no real parser, same documented-approximation discipline as
 * `stripDeferredCallbackBodies`) fixed-point name tracer. Starting from
 * every `NAME = <rhs>` assignment or `function NAME(...) { return <rhs>; }`
 * whose own `<rhs>` matches `seedPattern`, walks one-hop-at-a-time
 * `NAME = path.join(otherName, ...)` / `NAME = otherName` chains to grow
 * the set of identifiers that transitively derive from the seed — e.g.
 * `HERE` (seed, from `fileURLToPath(import.meta.url)`) ->
 * `BIN_DIR = path.resolve(HERE, "..")`, or `scratch` (seed, from
 * `mkdtempSync(...)`) -> `homeDir = path.join(scratch, "home")` ->
 * `settingsPath()`'s `return path.join(homeDir, ...)`. Growth is
 * deliberately narrow (a `path.join`/`path.resolve` call whose own first
 * argument is a known name, or a bare-alias assignment) rather than "the
 * RHS text contains the known name anywhere" — a multi-thousand-line test
 * file reuses generic names (`files`, `helpers`, `target`, ...) across many
 * unrelated `it()` blocks, and a substring check across all of them
 * cross-contaminates the derived set with unrelated identifiers. Bounded to
 * a handful of iterations — every chain observed in this repo is 2-3 hops
 * deep.
 */
function collectDerivedNames(source: string, seedPattern: RegExp): Set<string> {
  const assignmentPattern = /\b([A-Za-z_$][\w$]*)\s*=\s*([^;]{0,200});/g;
  const functionReturnPattern =
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{\s*return\s+([^;]{0,200});/g;
  const candidates: Array<{ name: string; rhs: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = assignmentPattern.exec(source)))
    candidates.push({ name: m[1], rhs: m[2] });
  while ((m = functionReturnPattern.exec(source)))
    candidates.push({ name: m[1], rhs: m[2] });

  function derivesFrom(rhs: string, known: string): boolean {
    const trimmed = rhs.trim();
    if (new RegExp(`^${known}(?:\\.[\\w.]+)?$`).test(trimmed)) return true;
    return new RegExp(`\\bpath\\.(?:join|resolve)\\(\\s*${known}\\b`).test(rhs);
  }

  const names = new Set<string>();
  for (const c of candidates) if (seedPattern.test(c.rhs)) names.add(c.name);
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const c of candidates) {
      if (names.has(c.name)) continue;
      for (const known of names) {
        if (derivesFrom(c.rhs, known)) {
          names.add(c.name);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }
  return names;
}

/** Text between `source[openParenIndex]` (a `(`) and its balanced `)`. */
function captureBalancedParens(source: string, openParenIndex: number): string {
  let depth = 0;
  let i = openParenIndex;
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return source.slice(openParenIndex, i);
}

/**
 * True when `text` contains at least one repo-read call (`readFileSync` /
 * `readdirSync` / `globSync` / `Bun.file`) whose OWN call arguments target a
 * real repo-tree path rather than a temp/fixture one. Each match's
 * arguments are classified independently (unlike the file-wide
 * `REPO_ROOT_ANCHOR_PATTERN.test(source)` this replaces, which fired on any
 * file containing both an unrelated anchor var and an unrelated read call):
 *   - a repo-surface literal (`AGENTS.md`, `skills/`, ...) or a reference to
 *     a name in `anchorNames` (or a raw `__dirname`/`import.meta.*` token)
 *     in the call args -> real, counts immediately.
 *   - a reference to a name in `tempNames` and nothing above -> excluded
 *     (an `os.tmpdir()`/`mkdtempSync` fixture read), keep scanning.
 *   - neither -> ambiguous. `requireAnchor` decides the default: `false`
 *     (module-scope call site) keeps the original permissive bias since a
 *     module-scope read is already a strong signal; `true` (only reachable
 *     from inside a deferred it()/hook body) requires explicit anchor
 *     evidence, since "deferred + unclear target" is too weak a signal on
 *     its own.
 */
function hasQualifyingRepoRead(
  text: string,
  anchorNames: Set<string>,
  tempNames: Set<string>,
  requireAnchor: boolean,
): boolean {
  const pattern = new RegExp(REPO_READ_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    const openParen = text.indexOf("(", m.index);
    if (openParen === -1) continue;
    const args = captureBalancedParens(text, openParen);
    if (
      !requireAnchor &&
      (REPO_SURFACE_LITERAL_PATTERN.test(args) ||
        ANCHOR_SEED_PATTERN.test(args))
    ) {
      return true;
    }
    let anchored = ANCHOR_SEED_PATTERN.test(args);
    if (!anchored) {
      for (const name of anchorNames) {
        if (new RegExp(`\\b${name}\\b`).test(args)) {
          anchored = true;
          break;
        }
      }
    }
    if (anchored) return true;
    let temp = false;
    for (const name of tempNames) {
      if (new RegExp(`\\b${name}\\b`).test(args)) {
        temp = true;
        break;
      }
    }
    if (temp) continue;
    if (!requireAnchor) return true;
  }
  return false;
}

function scansRepoTree(source: string): boolean {
  const anchorNames = collectDerivedNames(source, ANCHOR_SEED_PATTERN);
  const tempNames = collectDerivedNames(source, TEMP_SEED_PATTERN);
  const stripped = stripDeferredCallbackBodies(source);
  // 1. A module-scope (non-deferred) read of a real (non-temp) path.
  if (hasQualifyingRepoRead(stripped, anchorNames, tempNames, false))
    return true;
  // 2. A read reachable only from inside it()/hooks, but explicitly
  //    anchored to the repo root — real repo-tree access regardless of
  //    where in the file it's written.
  return hasQualifyingRepoRead(source, anchorNames, tempNames, true);
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

  const requiredLinters = new Set(REQUIRED_LINTERS);
  return raw.map((r) => {
    const source = input.sources.get(r.filePath) ?? "";
    const spawnsSubprocess = SPAWN_PATTERN.test(source);
    const isLive = r.filePath.endsWith(".live.test.ts");
    const repoTree = scansRepoTree(source);
    const expensiveSpawner =
      spawnsSubprocess && r.wallMs > DEFER_WALL_MS_THRESHOLD;
    // alwaysRun = REQUIRED_LINTERS (a curated floor — see its docstring)
    // UNION { scansRepoTree AND NOT expensiveSpawner } (the derived half:
    // a cheap/moderate repo-tree read always runs, but an EXPENSIVE
    // subprocess spawner that only incidentally trips scansRepoTree
    // doesn't get pinned into alwaysRun by that alone — it defers unless
    // the floor names it explicitly). The floor is unconditional, ahead of
    // even isLive: an entry in REQUIRED_LINTERS is never a `.live.test.ts`
    // file in practice, but if one ever were, the floor still wins.
    // deferToCi = { isLive OR expensiveSpawner } MINUS alwaysRun.
    const tier: FileScore["tier"] =
      requiredLinters.has(r.filePath) || (repoTree && !expensiveSpawner)
        ? "alwaysRun"
        : isLive || expensiveSpawner
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
