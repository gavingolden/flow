import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRow, registryPath, type ProcRegistryRow } from "./proc-registry";
import type { ReapDeps } from "./reap";
import { runProcSweep, DEFAULT_SWEEP_DEADLINE_MS } from "./proc-sweep-run";
import type { SweepDeps } from "./proc-sweep";

function makeRow(overrides: Partial<ProcRegistryRow> = {}): ProcRegistryRow {
  return {
    pgid: 500,
    pid: 500,
    startEpoch: 1_000,
    slug: "sweep-run-test",
    class: "default",
    argv: ["sh", "-c", "sleep 30"],
    recordedAt: 1_700_000_000_000,
    sessionPid: 400,
    sessionStartEpoch: 999,
    ...overrides,
  };
}

function fakeReapDeps(overrides: Partial<ReapDeps> = {}): ReapDeps {
  return {
    kill: vi.fn(),
    alive: () => false,
    sleepMs: () => {},
    startEpochOf: () => 1_000,
    groupMembers: () => [],
    nowMs: () => 0,
    selfPid: 99_999,
    selfPgid: 88_888,
    ...overrides,
  };
}

describe("runProcSweep", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-proc-sweep-run-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  // Rows built on these deps classify "dead". Under B4 only the STATE channel
  // can positively establish death, so readState must return a state whose
  // liveness reads dead/stale — a null state would yield "unknown", not "dead".
  function deadDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
    return {
      readState: () => ({
        slug: "irrelevant",
        phase: "implementing",
        repo: "/r",
        updatedAt: "2026-01-01T00:00:00Z",
        pid: 1,
        procStartedAt: 1,
      }),
      livenessOf: ((s: { pid?: number; procStartedAt?: number }) =>
        s.pid === 1 ? "dead" : "stale") as SweepDeps["livenessOf"],
      livenessDeps: { isAlive: () => false },
      ...overrides,
    };
  }

  it("report-only is the default: runRegistryReap receives dryRun: true, compact is NOT called, and NOTHING is signalled end-to-end", () => {
    appendRow(
      makeRow({ pid: 500, pgid: 500, slug: "report-only-slug" }),
      baseDir,
    );
    const deps = { ...fakeReapDeps(), ...deadDeps() };
    const result = runProcSweep(deps, {
      yes: false,
      slug: "report-only-slug",
      baseDir,
    });
    expect(result.yes).toBe(false);
    expect(result.slugs).toHaveLength(1);
    expect(result.slugs[0].reap.dryRun).toBe(true);
    expect(result.slugs[0].compacted).toBeUndefined();
    // Non-vacuous denominator: a row genuinely reached the reap engine
    // (this fixture's `deadDeps` + `alive: () => false` classifies it
    // "dead" and `verifyRow` resolves it "already-dead" — either way it was
    // handed to the kill engine's row-level decision), so `kill` had an
    // actual opportunity to fire here and didn't.
    expect(result.slugs[0].reported.dead).toBeGreaterThan(0);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("only dead-bucket rows reach the injected readRows seam (alive and unknown rows never reach runRegistryReap)", () => {
    appendRow(
      makeRow({ pid: 500, pgid: 500, slug: "mixed-slug", sessionPid: 400 }),
      baseDir,
    );
    appendRow(
      makeRow({ pid: 501, pgid: 501, slug: "mixed-slug", sessionPid: 401 }),
      baseDir,
    );
    appendRow(
      makeRow({ pid: 502, pgid: 502, slug: "mixed-slug", sessionPid: 402 }),
      baseDir,
    );

    const readStateMock = vi.fn((_slug: string) => null);
    const livenessOfMock = vi.fn(
      (s: {
        pid?: number;
        procStartedAt?: number;
      }): "alive" | "dead" | "stale" | "unknown" => {
        // wrapper channel: pid 400 alive, 401 dead(non-alive), 402 dead(non-alive)
        if (s.pid === 400) return "alive";
        if (s.pid === 401) return "dead";
        if (s.pid === 402) return "dead";
        return "unknown";
      },
    );
    const deps: ReapDeps & SweepDeps = {
      ...fakeReapDeps(),
      readState: readStateMock,
      livenessOf: livenessOfMock as SweepDeps["livenessOf"],
      livenessDeps: { isAlive: () => false },
    };
    // With readState always null, stateVerdict is always "unknown" — so per
    // B4, NOTHING here can be "dead" (state is the only channel that can
    // positively confirm death). pid 400's wrapper is alive -> "alive". The
    // other two are "unknown" (state unknown, wrapper not alive). This
    // fixture asserts the non-vacuous claim: dead is empty, so readRows
    // never even gets a non-empty dead set — assert via the reap outcome
    // shape instead (ran:false skipReason:no-rows) plus the reported counts.
    const result = runProcSweep(deps, {
      yes: false,
      slug: "mixed-slug",
      baseDir,
    });
    const slugResult = result.slugs[0];
    expect(slugResult.reported.dead).toBe(0);
    expect(slugResult.reported.alive).toBe(1);
    expect(slugResult.reported.unknown).toBe(2);
    expect(slugResult.reap.ran).toBe(false);
    expect(slugResult.reap.skipReason).toBe("no-rows");
    // non-zero denominator: the classified array is populated for all rows.
    expect(slugResult.classified.length).toBeGreaterThanOrEqual(1);
    expect(slugResult.classified).toHaveLength(3);
  });

  it("only dead-bucket rows reach the injected readRows seam — positive case: a genuinely dead row is fed through, alive/unknown are not", () => {
    appendRow(
      makeRow({ pid: 500, pgid: 500, slug: "dead-mix-slug", sessionPid: 400 }),
      baseDir,
    );
    appendRow(
      makeRow({ pid: 501, pgid: 501, slug: "dead-mix-slug", sessionPid: 401 }),
      baseDir,
    );

    const deps: ReapDeps & SweepDeps = {
      ...fakeReapDeps({ alive: () => false }),
      readState: (slug) =>
        slug === "dead-mix-slug"
          ? {
              slug,
              phase: "implementing",
              repo: "/r",
              updatedAt: "2026-01-01T00:00:00Z",
              pid: 900,
              procStartedAt: 1,
            }
          : null,
      livenessOf: ((s: { pid?: number; procStartedAt?: number }) => {
        if (s.pid === 900) return "dead"; // state channel: dead
        if (s.pid === 400) return "alive"; // pid 500's wrapper: alive -> row alive
        if (s.pid === 401) return "stale"; // pid 501's wrapper: stale (not alive) -> row dead
        return "unknown";
      }) as SweepDeps["livenessOf"],
      livenessDeps: { isAlive: () => false },
    };
    const result = runProcSweep(deps, {
      yes: false,
      slug: "dead-mix-slug",
      baseDir,
    });
    const slugResult = result.slugs[0];
    expect(slugResult.reported.dead).toBe(1);
    expect(slugResult.reported.alive).toBe(1);
    expect(slugResult.reap.ran).toBe(true);
    expect(slugResult.reap.rows).toHaveLength(1);
    expect(slugResult.reap.rows[0].pid).toBe(501);
  });

  it("--yes passes dryRun: false and calls compact(slug) once per slug that had rows", () => {
    appendRow(makeRow({ pid: 500, pgid: 500, slug: "yes-slug" }), baseDir);
    const deps = { ...fakeReapDeps({ alive: () => false }), ...deadDeps() };
    const result = runProcSweep(deps, { yes: true, slug: "yes-slug", baseDir });
    expect(result.slugs[0].reap.dryRun).toBe(false);
    // `toBeDefined()` rather than an exact `{kept, dropped}` shape is
    // deliberate: `compact`'s real `isLive` path forks an actual `ps`
    // (`defaultIsLive` -> `pidStartEpoch`), which this test does not (and
    // per the guard below, cannot cheaply) inject a fake for — asserting an
    // exact shape here would couple to that real subprocess result rather
    // than to `runProcSweep`'s own contract, which is simply "compact ran
    // for this slug". See the next test for the `rows.length > 0` guard's
    // OTHER half — that one needs no real fork since it never calls
    // `compact` at all.
    expect(result.slugs[0].compacted).toBeDefined();
  });

  it("--yes does NOT call compact for a slug whose registry had no rows to begin with (the other half of the `rows.length > 0` guard)", () => {
    // No appendRow call at all for this slug — readRows resolves to an
    // empty registry, so the guard's `rows.length > 0` half must be false
    // even though `opts.yes` is true.
    const deps = { ...fakeReapDeps(), ...deadDeps() };
    const result = runProcSweep(deps, {
      yes: true,
      slug: "no-rows-yes-slug",
      baseDir,
    });
    expect(result.slugs[0].compacted).toBeUndefined();
  });

  it("the sweep-level deadline is threaded down as each slug's remaining registryDeadlineMs, and an exhausted budget marks later slugs skipped:'deadline-exceeded' rather than dropping them", () => {
    // Both rows classify "unknown" (readState null, wrapper unknown), so
    // `dead` is empty for every slug and runRegistryReap's readRows override
    // takes its immediate no-rows early return — the ONLY nowMs() calls in
    // this whole run are the sweep's own deadline bookkeeping (one to seed
    // `deadline`, one per-slug top-of-loop check, one per-slug `remaining`
    // calc for slugs that aren't skipped), which keeps this test's fixed
    // call-count sequence exact regardless of listRegistrySlugs' enumeration
    // order between the two slugs.
    appendRow(
      makeRow({ pid: 500, pgid: 500, slug: "slug-a", sessionPid: null }),
      baseDir,
    );
    appendRow(
      makeRow({ pid: 501, pgid: 501, slug: "slug-b", sessionPid: null }),
      baseDir,
    );

    // call 0: seeds `deadline` (0 + 100 = 100)
    // call 1: first slug's top-of-loop check (10 < 100 -> proceeds)
    // call 2: first slug's `remaining` calc (10 -> remaining = 90)
    // call 3+: second slug's top-of-loop check (1_000_000 >= 100 -> skipped)
    const sequence = [0, 10, 10, 1_000_000];
    let calls = 0;
    const deps: ReapDeps & SweepDeps = {
      ...fakeReapDeps(),
      readState: () => null,
      livenessDeps: { isAlive: () => false },
      nowMs: () => {
        const v = sequence[Math.min(calls, sequence.length - 1)];
        calls++;
        return v;
      },
    };
    const result = runProcSweep(deps, {
      yes: false,
      baseDir,
      deadlineMs: 100,
    });

    expect(result.slugs).toHaveLength(2);
    const skipped = result.slugs.filter(
      (s) => s.skipped === "deadline-exceeded",
    );
    const processed = result.slugs.filter(
      (s) => s.skipped !== "deadline-exceeded",
    );
    expect(skipped).toHaveLength(1);
    expect(processed).toHaveLength(1);
    expect(skipped[0].reap.rows).toEqual([]);
    expect(skipped[0].reap.counts).toBeDefined();
    expect(skipped[0].classified).toEqual([]);
  });

  it("totals aggregate correctly across slugs whose reap returned ran:false skipReason:'no-rows' with zero-filled counts", () => {
    // Both slugs' rows all classify unknown (readState null -> unknown
    // state channel, wrapper channel unknown too) so dead is always empty
    // and runRegistryReap reports ran:false/no-rows for every slug.
    appendRow(
      makeRow({ pid: 500, pgid: 500, slug: "empty-a", sessionPid: null }),
      baseDir,
    );
    appendRow(
      makeRow({ pid: 501, pgid: 501, slug: "empty-b", sessionPid: null }),
      baseDir,
    );
    const deps: ReapDeps & SweepDeps = {
      ...fakeReapDeps(),
      readState: () => null,
      livenessDeps: { isAlive: () => false },
    };
    const result = runProcSweep(deps, { yes: false, baseDir });
    expect(result.slugs.length).toBeGreaterThanOrEqual(2);
    expect(
      result.slugs.every(
        (s) => s.reap.ran === false && s.reap.skipReason === "no-rows",
      ),
    ).toBe(true);
    const total = Object.values(result.totals).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });

  it("classified[] is populated on each SweepSlugResult", () => {
    appendRow(
      makeRow({ pid: 500, pgid: 500, slug: "classified-slug" }),
      baseDir,
    );
    const deps = { ...fakeReapDeps(), ...deadDeps() };
    const result = runProcSweep(deps, {
      yes: false,
      slug: "classified-slug",
      baseDir,
    });
    expect(result.slugs[0].classified).toHaveLength(1);
    expect(result.slugs[0].classified[0].row.pid).toBe(500);
  });

  it("propagates readRows' malformed count through to each slug's reap.malformed", () => {
    appendRow(
      makeRow({ pid: 500, pgid: 500, slug: "malformed-slug" }),
      baseDir,
    );
    // A hand-corrupted line alongside the one valid row above — readRows
    // (bin/lib/proc-registry.ts) skips it and counts it as `malformed`
    // rather than throwing; this asserts that count survives the
    // readRows -> readRows-override -> runRegistryReap round trip inside
    // runProcSweep, not just at the proc-registry layer.
    fs.appendFileSync(
      registryPath("malformed-slug", baseDir),
      "{ this is not valid json\n",
    );
    const deps = { ...fakeReapDeps(), ...deadDeps() };
    const result = runProcSweep(deps, {
      yes: false,
      slug: "malformed-slug",
      baseDir,
    });
    expect(result.slugs[0].reap.malformed).toBe(1);
  });

  it("DEFAULT_SWEEP_DEADLINE_MS is 60 seconds", () => {
    expect(DEFAULT_SWEEP_DEADLINE_MS).toBe(60_000);
  });
});
