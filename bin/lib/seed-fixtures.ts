/**
 * Canonical production-seed fixture list — extracted here so the two
 * hand-written builder tables in `bin/lib/seed-delivery.test.ts` and the
 * per-builder matrix in `bin/flow-seed-ingested-hook.test.ts` draw from ONE
 * source instead of re-listing the six builders inline, where they can
 * silently drift apart (exactly what made an earlier `it.each` table
 * constant-true — see `bin/lib/seed-delivery.test.ts`'s "flowPipelineSeed is
 * exported ... instead of a hand-copied literal" comment).
 *
 * Every seed here is built by calling the REAL production builders with
 * fixed, machine-independent arguments — never a hand-copied literal — so a
 * signature change or a text change in any of the six builders surfaces here
 * as a compile error or a changed fixture, not silent drift.
 *
 * Test-support module: no bun shebang, no `import.meta.main` gate — it is
 * imported by test files, never executed directly.
 */

import { epicCreateSeed, epicResumeSeed, epicRunSeed } from "./epic-seed";
import * as epicSeedModule from "./epic-seed";
import { flowPipelineResumeSeed, flowPipelineSeed } from "./feature";
import * as featureModule from "./feature";
import { terminalContinueSeed } from "../flow-session-start-hook";
import * as sessionStartHookModule from "../flow-session-start-hook";

export type SeedFixture = {
  name: string;
  seed: string;
  singleLine: boolean;
};

// Fixed synthetic stateDir — a literal, never a real machine path (os.tmpdir()
// resolves to a per-user ~73-char /var/folders/... path on macOS vs 4-char
// /tmp on Linux CI, which is not byte-identical) — so PRODUCTION_SEEDS stays
// byte-identical across machines and CI runs. Nothing is written to disk: the
// seeds are string-built only. Exported so bin/lib/seed-delivery.test.ts's
// cap-slug builder table (which needs a 60-char slug PRODUCTION_SEEDS's fixed
// "demo" slug can't represent) reuses this ONE definition instead of a second
// hand-copied literal; omitting a fixed dir entirely would interpolate the
// real $HOME into flowPipelineSeed's REQUEST_FILE segment.
export const FIXTURE_STATE_DIR = "/tmp/flow-seed-bounds-fixture";

/**
 * The six production seed shapes, built via the real builders (never
 * hand-copied literals). `singleLine` is true for every launch/resume seed
 * — each is a single control-char-free line by construction — and false
 * only for `terminalContinueSeed`, which `.join("\n\n")`s multiple
 * paragraphs (818 chars for this fixture's arguments) because it is typed
 * into an already-idle pane, not capture-verified via the leading-line
 * handshake the other five rely on.
 */
export const PRODUCTION_SEEDS: readonly SeedFixture[] = [
  {
    name: "flowPipelineSeed",
    seed: flowPipelineSeed("demo", "csv export", FIXTURE_STATE_DIR),
    singleLine: true,
  },
  {
    name: "flowPipelineResumeSeed",
    seed: flowPipelineResumeSeed("demo"),
    singleLine: true,
  },
  {
    name: "epicCreateSeed",
    seed: epicCreateSeed("p", "/tmp/e", "/tmp/s", "/tmp/req.md"),
    singleLine: true,
  },
  {
    name: "epicResumeSeed",
    seed: epicResumeSeed("demo", "/tmp/e", "/tmp/s"),
    singleLine: true,
  },
  {
    name: "epicRunSeed",
    seed: epicRunSeed("demo", ".flow/epics/demo"),
    singleLine: true,
  },
  {
    name: "terminalContinueSeed",
    seed: terminalContinueSeed("demo", "merged", "feature", {
      repo: "/tmp/repo",
    }),
    singleLine: false,
  },
];

const REAL_SEED_MODULES: Record<string, Record<string, unknown>> = {
  "bin/lib/feature.ts": featureModule as unknown as Record<string, unknown>,
  "bin/lib/epic-seed.ts": epicSeedModule as unknown as Record<string, unknown>,
  "bin/flow-session-start-hook.ts": sessionStartHookModule as unknown as Record<
    string,
    unknown
  >,
};

/**
 * A future `*Seed` builder added to one of the three enumerated seed-owning
 * modules without a matching `PRODUCTION_SEEDS` fixture fails this assertion
 * rather than silently going unexercised by the shared fixture list. This is
 * exhaustive over those three hand-listed modules only, not the whole
 * repo — a `*Seed` builder shipped in a fourth module (e.g. a future
 * `bin/lib/<x>-seed.ts`) is invisible to this guard. Excludes `deliver*Seed`
 * names (currently only `deliverResumeSeed`): those are seams-taking
 * delivery FUNCTIONS (they type/verify a seed into a live pane), not string
 * builders — the next `deliver*Seed` inherits the same exclusion for the
 * same reason. Note this filter would also exclude `splitSeed` if
 * `bin/lib/seed-delivery.ts` were ever added to the module map — it ends
 * with neither `Seed` nor is excluded by the `deliver` prefix, so it would
 * need its own carve-out.
 *
 * `modules` is injectable (defaults to the real three modules) so this
 * guard's own throw path can be exercised directly in tests.
 */
export function assertSeedListExhaustive(
  modules: Record<string, Record<string, unknown>> = REAL_SEED_MODULES,
): void {
  const known = new Set(PRODUCTION_SEEDS.map((f) => f.name));
  for (const [moduleName, mod] of Object.entries(modules)) {
    for (const key of Object.keys(mod)) {
      if (
        key.endsWith("Seed") &&
        !key.startsWith("deliver") &&
        !known.has(key)
      ) {
        throw new Error(
          `${moduleName} exports '${key}', which ends with 'Seed' and is not a delivery function, but has no PRODUCTION_SEEDS fixture in bin/lib/seed-fixtures.ts`,
        );
      }
    }
  }
}
