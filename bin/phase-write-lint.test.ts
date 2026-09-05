import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint pinning the phase-write funnel's invariant: exactly one
 * module (`bin/lib/phase-write.ts`) is allowed to import `setWindowPhase`,
 * and a frozen, hand-verified set of modules is allowed to import
 * `writeState` directly. A future helper that grows a phase-write side
 * effect without routing through `writePhaseState` fails CI here instead of
 * silently freezing the tmux `@flow-phase` status-bar mirror. Structural
 * sibling of `bin/pane-read-lint.test.ts`: hand-rolled
 * `readdirSync(dir, { recursive: true })` (no glob dependency — `picomatch`
 * has a documented recurring failure mode in this repo: a canonical
 * checkout missing it degrades PATH helpers silently), exported pure
 * detectors over `{path, contents}[]`, and a frozen named allowlist with one
 * inline reason per entry.
 *
 * Detectors match IMPORT STATEMENTS and CALL EXPRESSIONS only — never
 * comments, never `import type` lines — so a docblock mentioning
 * `writeState` or `setWindowPhase` is not a false positive. A pattern-shaped
 * allowlist (`bin/**`, a bare prefix rule) is explicitly FORECLOSED here —
 * every entry below is a concrete, named file path; widening the allowlist
 * into a pattern defeats the entire point of freezing it.
 *
 * Known limit, stated honestly rather than overclaimed: check (c)
 * (`findPhaseMutatingWrites`) is a syntactic scan over the LITERAL object
 * expression passed as `writeState`'s first argument. A state object
 * ASSEMBLED BY A HELPER FUNCTION and then handed to `writeState` — e.g.
 * `writeState(makeBaseState("plain"), dir)` in `bin/lib/feature.ts` — is
 * invisible to this scan: the argument is a call expression, not an object
 * literal, so no top-level keys are visible to inspect. That is exactly why
 * the importer-set freeze in check (b) remains the wider net: a file that
 * grows a brand-new `writeState` import at all — regardless of what shape
 * of state object it constructs — fails check (b) until a human adds it to
 * `PHASE_WRITE_ALLOWLIST` with a reason.
 */

export type ImportHit = { path: string };

const IMPORT_BLOCK_RE =
  /import\s+(type\s+)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;

function importedNames(rawNames: string): string[] {
  return rawNames
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => n.replace(/^type\s+/, "").trim())
    .map((n) => n.split(/\s+as\s+/)[0]!.trim());
}

/**
 * Modules with a non-type-only import of `setWindowPhase` from `./tmux` (the
 * `bin/lib/*.ts` spelling) or `./lib/tmux` (the `bin/*.ts` spelling).
 */
export function findMirrorPublishers(
  files: { path: string; contents: string }[],
): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const m of f.contents.matchAll(IMPORT_BLOCK_RE)) {
      const isTypeOnly = Boolean(m[1]);
      const spec = m[3]!;
      if (isTypeOnly) continue;
      if (spec !== "./tmux" && spec !== "./lib/tmux") continue;
      if (importedNames(m[2]!).includes("setWindowPhase")) {
        hits.push(f.path);
        break;
      }
    }
  }
  return hits;
}

/**
 * Modules with a non-type-only import of `writeState` from `./state` (the
 * `bin/lib/*.ts` spelling) or `./lib/state` (the `bin/*.ts` spelling).
 */
export function findStateWriters(
  files: { path: string; contents: string }[],
): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const m of f.contents.matchAll(IMPORT_BLOCK_RE)) {
      const isTypeOnly = Boolean(m[1]);
      const spec = m[3]!;
      if (isTypeOnly) continue;
      if (spec !== "./state" && spec !== "./lib/state") continue;
      if (importedNames(m[2]!).includes("writeState")) {
        hits.push(f.path);
        break;
      }
    }
  }
  return hits;
}

/**
 * Extracts the balanced `{...}` substring starting at `contents[start]`
 * (which must be `{`), or `null` if unbalanced.
 */
function extractBalancedObject(contents: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < contents.length; i++) {
    if (contents[i] === "{") depth++;
    else if (contents[i] === "}") {
      depth--;
      if (depth === 0) return contents.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Blanks out every NESTED `{...}` inside an outer object-literal string,
 * keeping only the outer braces and the depth-1 content — so a nested key
 * (e.g. `checkpoint: { phase: … }`) never surfaces as a top-level key.
 */
function topLevelContent(objectLiteral: string): string {
  let out = "";
  let depth = 0;
  for (const ch of objectLiteral) {
    if (ch === "{") {
      depth++;
      if (depth === 1) out += ch;
      continue;
    }
    if (ch === "}") {
      if (depth === 1) out += ch;
      depth--;
      continue;
    }
    if (depth <= 1) out += ch;
  }
  return out;
}

const WRITE_STATE_CALL_RE = /writeState\s*\(/g;
const TOP_LEVEL_PHASE_KEY_RE = /(^|[,{\s])phase\s*:/;

/**
 * Files with a `writeState(...)` CALL whose first argument is an object
 * LITERAL carrying a top-level `phase:` key (nesting-aware — a `phase:` key
 * buried inside a nested object, e.g. `checkpoint: { phase: … }`, does not
 * count). Reports every such call site regardless of whether the file is on
 * `PHASE_WRITE_ALLOWLIST` — the frozen exception list for the two legitimate
 * `phase: "starting"` initial-state sites lives in this test's own
 * `describe` block, not in this detector, so the detector stays a pure,
 * unopinionated scan.
 */
export function findPhaseMutatingWrites(
  files: { path: string; contents: string }[],
): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const m of f.contents.matchAll(WRITE_STATE_CALL_RE)) {
      const argStart = m.index! + m[0].length;
      let i = argStart;
      while (i < f.contents.length && /\s/.test(f.contents[i]!)) i++;
      if (f.contents[i] !== "{") continue;
      const obj = extractBalancedObject(f.contents, i);
      if (!obj) continue;
      if (TOP_LEVEL_PHASE_KEY_RE.test(topLevelContent(obj))) {
        hits.push(f.path);
        break;
      }
    }
  }
  return hits;
}

/**
 * Frozen writeState-importer allowlist, scout-verified against the tree at
 * implement time (2026-09-04). `bin/lib/state.ts` is deliberately absent —
 * it DEFINES writeState and never imports it. `bin/lib/phase-advance.ts` is
 * deliberately absent — this PR removes its writeState import in favour of
 * the funnel. Each entry is a real, current call site; none is cargo.
 */
export const PHASE_WRITE_ALLOWLIST: readonly string[] = [
  // The funnel itself — the ONE place writeState and setWindowPhase are
  // called from the same statement.
  "bin/lib/phase-write.ts",
  // --phase branch now routes through writePhaseState; the non-phase
  // (--pr-only etc.) branch still calls writeState directly.
  "bin/flow-state-update.ts",
  // Clears/arms the checkpoint record — no phase field involved.
  "bin/flow-checkpoint.ts",
  // Persists a plan-review record — no phase field involved.
  "bin/flow-plan-review.ts",
  // Hook: saves resume-seed state — no phase field involved.
  "bin/flow-seed-ingested-hook.ts",
  // Hook: session-start bookkeeping — no phase field involved.
  "bin/flow-session-start-hook.ts",
  // Clears the untracked-files record — no phase field involved.
  "bin/flow-untracked.ts",
  // Advances phase itself as a side effect of a merge-guard decision, via
  // the funnel elsewhere; its OWN writeState call here persists the guard's
  // non-phase record fields.
  "bin/flow-merge-guard.ts",
  // Records reap/teardown outcome — no phase field involved.
  "bin/flow-browser-teardown.ts",
  // Records the CI-wait outcome — no phase field involved (phase advances
  // go through advancePhase -> the funnel elsewhere in this file).
  "bin/flow-ci-check.ts",
  // Records launch pid/procStartedAt post-launch — no phase field involved.
  "bin/lib/launcher.ts",
  // Eval-harness fixture seeding — test-support infrastructure, not a live
  // pipeline phase transition.
  "bin/lib/eval-fixture.ts",
  // Initial-state creation for `flow feature create` (makeBaseState stamps
  // phase: "starting" before any window exists to publish onto — see the
  // PHASE_STARTING_EXCEPTIONS note below).
  "bin/lib/feature.ts",
  // Initial-state creation for `flow epic create` (same phase: "starting"
  // rationale as feature.ts).
  "bin/lib/epic.ts",
];

/**
 * The two initial-state creation sites that legitimately stamp a literal
 * top-level `phase: "starting"` directly in a `writeState` call, before any
 * tmux window exists for a publish to target — `bin/lib/tmux.ts` already
 * seeds `@flow-phase` at window-creation time instead, so a publish here
 * would be a no-op at best. Named, not derived, each with its own reason —
 * mirrors `PANE_READ_ALLOWLIST`'s discipline in `bin/pane-read-lint.test.ts`.
 */
const PHASE_STARTING_EXCEPTIONS: readonly string[] = [
  // Literal `phase: "starting"` as a direct top-level key in the
  // writeState({...}) call — a REAL hit for findPhaseMutatingWrites.
  "bin/lib/epic.ts",
  // Also stamps `phase: "starting"`, but via `makeBaseState()` — a helper
  // function whose returned object is handed to writeState, not an inline
  // object literal. This is the documented blind spot above:
  // findPhaseMutatingWrites cannot see through the function call, so this
  // file is not actually flagged today. Named anyway so the exception stays
  // honest and ready if the call site is ever inlined.
  "bin/lib/feature.ts",
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

/**
 * `Dirent.parentPath` (Node >=20.12/18.20) is what this repo's Node floor
 * (`engines.node >= 20`) does not strictly guarantee; `Dirent.path` is the
 * same value but `@deprecated` in the type declarations. Reading through an
 * untyped `Record` — rather than `d.parentPath ?? d.path` — gets the same
 * runtime fallback without the property access itself carrying the
 * `@deprecated` JSDoc tag, which editors/tsc surface as a live diagnostic.
 */
function direntDir(d: fs.Dirent): string {
  const rec = d as unknown as Record<string, string | undefined>;
  return rec.parentPath ?? rec.path ?? "";
}

function filesUnderBin(): string[] {
  const dirPath = path.join(REPO_ROOT, "bin");
  return fs
    .readdirSync(dirPath, { recursive: true, withFileTypes: true })
    .filter((d) => {
      if (!d.isFile()) return false;
      if (!d.name.endsWith(".ts")) return false;
      if (d.name.endsWith(".test.ts")) return false;
      const dirName = direntDir(d).split(path.sep);
      return !dirName.includes("node_modules");
    })
    .map((d) =>
      path.relative(REPO_ROOT, path.join(direntDir(d) || dirPath, d.name)),
    )
    .sort();
}

function loadFiles(relPaths: string[]): { path: string; contents: string }[] {
  return relPaths.map((relPath) => ({
    path: relPath,
    contents: fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8"),
  }));
}

describe("phase-write-lint", () => {
  it("exactly one module imports setWindowPhase: the funnel itself", () => {
    const files = loadFiles(filesUnderBin());
    expect(findMirrorPublishers(files)).toEqual(["bin/lib/phase-write.ts"]);
  });

  it("the writeState-importer set equals the frozen PHASE_WRITE_ALLOWLIST", () => {
    const files = loadFiles(filesUnderBin());
    const found = new Set(findStateWriters(files));
    const allowed = new Set(PHASE_WRITE_ALLOWLIST);

    const unexplained = [...found].filter((p) => !allowed.has(p));
    expect(
      unexplained,
      "new writeState importer(s) not covered by PHASE_WRITE_ALLOWLIST — " +
        "route the phase write through writePhaseState (bin/lib/phase-write.ts) " +
        "or add ONE named allowlist entry with an inline reason",
    ).toEqual([]);

    const dead = [...allowed].filter((p) => !found.has(p));
    expect(
      dead,
      "PHASE_WRITE_ALLOWLIST names a file that no longer imports writeState " +
        "— remove the dead entry",
    ).toEqual([]);
  });

  it("no file passes a top-level phase key to writeState, outside the two named PHASE_STARTING_EXCEPTIONS sites", () => {
    const files = loadFiles(filesUnderBin());
    const found = findPhaseMutatingWrites(files);
    const unexplained = found.filter(
      (p) => !PHASE_STARTING_EXCEPTIONS.includes(p),
    );
    expect(
      unexplained,
      "a writeState({...}) call passes a top-level phase key outside the " +
        "funnel — route the phase write through writePhaseState " +
        "(bin/lib/phase-write.ts) instead",
    ).toEqual([]);
  });

  describe("negative fixtures", () => {
    it("(i) a synthetic off-allowlist writeState importer IS reported", () => {
      const files = [
        {
          path: "bin/synthetic-off-allowlist.ts",
          contents: `import { writeState } from "./lib/state";\nwriteState({ slug: "x" }, dir);\n`,
        },
      ];
      expect(findStateWriters(files)).toEqual([
        "bin/synthetic-off-allowlist.ts",
      ]);
    });

    it("(ii) a synthetic ALLOWLISTED module passing a top-level phase: to writeState IS reported by findPhaseMutatingWrites", () => {
      const files = [
        {
          path: "bin/lib/feature.ts",
          contents: `writeState({ slug: "x", phase: "starting" }, dir);\n`,
        },
      ];
      expect(findPhaseMutatingWrites(files)).toEqual(["bin/lib/feature.ts"]);
    });

    it("(iii) a synthetic module importing setWindowPhase outside the funnel IS reported", () => {
      const files = [
        {
          path: "bin/synthetic-mirror.ts",
          contents: `import { setWindowPhase } from "./lib/tmux";\nsetWindowPhase("s", "p");\n`,
        },
      ];
      expect(findMirrorPublishers(files)).toEqual(["bin/synthetic-mirror.ts"]);
    });

    it("(iv) a docblock / import type mention of writeState or setWindowPhase is NOT reported", () => {
      const files = [
        {
          path: "bin/synthetic-docblock.ts",
          contents:
            `/** Mentions writeState and setWindowPhase in prose only. */\n` +
            `import type { PipelineState } from "./lib/state";\n` +
            `import type { TmuxWindow } from "./lib/tmux";\n`,
        },
      ];
      expect(findStateWriters(files)).toEqual([]);
      expect(findMirrorPublishers(files)).toEqual([]);
    });

    it("(v) a NESTED phase key (the checkpoint: { phase: … } shape) is NOT reported", () => {
      const files = [
        {
          path: "bin/synthetic-nested.ts",
          contents: `writeState({ slug: "x", checkpoint: { site: "a", phase: state.phase, armedAt: now } }, dir);\n`,
        },
      ];
      expect(findPhaseMutatingWrites(files)).toEqual([]);
    });
  });
});
