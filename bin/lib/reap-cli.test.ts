import { beforeEach, describe, expect, it, vi } from "vitest";

const procSweepRunMock = vi.hoisted(() => ({
  runProcSweep: vi.fn(() => ({
    mode: "sweep" as const,
    yes: false,
    slugs: [] as unknown[],
    totals: {} as Record<string, number>,
    unknownRows: 0,
    aliveRows: 0,
  })),
}));
vi.mock("./proc-sweep-run", () => procSweepRunMock);

const browserTeardownMock = vi.hoisted(() => ({
  buildDefaultDeps: vi.fn(() => ({
    listProcs: () => [] as unknown[],
    kill: vi.fn(),
    alive: () => false,
    sleepMs: () => {},
    env: {} as NodeJS.ProcessEnv,
    selfPid: 1,
    homeDir: "/home/test",
    tmpDir: "/tmp",
    nowMs: () => 0,
    selfPgid: null,
    groupMembers: () => null,
  })),
  runOrphanSweep: vi.fn(() => ({
    ran: true,
    found: [] as unknown[],
    foundServers: [] as unknown[],
    signalled: [] as number[],
  })),
}));
vi.mock("../flow-browser-teardown", () => browserTeardownMock);

const livenessMock = vi.hoisted(() => ({
  pidStartEpoch: vi.fn((_pid: number) => 1_234_567), // SECONDS, deliberately
}));
vi.mock("./liveness", () => livenessMock);

import { collectReapReport, runReapCli } from "./reap-cli";

beforeEach(() => {
  vi.clearAllMocks();
  procSweepRunMock.runProcSweep.mockReturnValue({
    mode: "sweep" as const,
    yes: false,
    slugs: [],
    totals: {},
    unknownRows: 0,
    aliveRows: 0,
  });
  browserTeardownMock.runOrphanSweep.mockReturnValue({
    ran: true,
    found: [],
    foundServers: [],
    signalled: [],
  });
});

describe("runReapCli --help / -h short-circuit", () => {
  for (const flag of ["--help", "-h"]) {
    it(`exits 0 for '${flag}' WITHOUT calling either sweep (assert before any side effect)`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = runReapCli([flag]);
      expect(code).toBe(0);
      expect(procSweepRunMock.runProcSweep).not.toHaveBeenCalled();
      expect(browserTeardownMock.runOrphanSweep).not.toHaveBeenCalled();
      expect(browserTeardownMock.buildDefaultDeps).not.toHaveBeenCalled();
      log.mockRestore();
    });
  }

  it("--help short-circuits even after other flags", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = runReapCli(["--yes", "--help"]);
    expect(code).toBe(0);
    expect(procSweepRunMock.runProcSweep).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("runReapCli report-only default", () => {
  it("a bare run is report-only: runProcSweep receives yes:false", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli([]);
    expect(procSweepRunMock.runProcSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ yes: false }),
    );
    log.mockRestore();
  });
});

describe("runReapCli --yes / --include-strays gating (SAFETY: bare --yes never signals a stray)", () => {
  it("--yes ALONE never signals a stray: runOrphanSweep receives yes:false", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli(["--yes"]);
    expect(browserTeardownMock.runOrphanSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ yes: false }),
    );
    log.mockRestore();
  });

  it("--include-strays ALONE (no --yes) never signals a stray: runOrphanSweep receives yes:false", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli(["--include-strays"]);
    expect(browserTeardownMock.runOrphanSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ yes: false }),
    );
    log.mockRestore();
  });

  it("--yes AND --include-strays TOGETHER signal strays: runOrphanSweep receives yes:true", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli(["--yes", "--include-strays"]);
    expect(browserTeardownMock.runOrphanSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ yes: true }),
    );
    log.mockRestore();
  });

  it("--yes ALONE still passes yes:true through to the registry sweep (registry rows have their own verifyRow ladder)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli(["--yes"]);
    expect(procSweepRunMock.runProcSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ yes: true }),
    );
    log.mockRestore();
  });
});

describe("runReapCli --record safety", () => {
  it("--record never appears in any argv this CLI constructs — it never shells out at all", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli(["--yes", "--include-strays", "--json"]);
    const serializedCalls = JSON.stringify([
      ...procSweepRunMock.runProcSweep.mock.calls,
      ...browserTeardownMock.runOrphanSweep.mock.calls,
      ...browserTeardownMock.buildDefaultDeps.mock.calls,
    ]);
    expect(serializedCalls).not.toContain("--record");
    const output = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).not.toContain("--record");
    log.mockRestore();
  });
});

describe("runReapCli --json", () => {
  it("embeds runOrphanSweep's OrphanSweepResult VERBATIM under a heuristic key", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stray = {
      ran: true,
      found: [
        {
          pid: 1234,
          command: "chrome --enable-automation",
          userDataDir: "/tmp/rod/user-data/deadbeef",
          ageMs: 5000,
          profileShape: "go-rod-temp" as const,
          matched: true,
        },
      ],
      foundServers: [],
      signalled: [],
    };
    browserTeardownMock.runOrphanSweep.mockReturnValueOnce(stray);
    const code = runReapCli(["--json"]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0][0]));
    expect(parsed.heuristic).toEqual(stray);
    log.mockRestore();
  });
});

describe("runReapCli usage errors (non-zero exit, per the verb convention)", () => {
  it("an unknown flag exits non-zero", () => {
    const errWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = runReapCli(["--bogus-flag"]);
    expect(code).not.toBe(0);
    expect(procSweepRunMock.runProcSweep).not.toHaveBeenCalled();
    errWrite.mockRestore();
  });

  it("--slug with no following value exits non-zero", () => {
    const errWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = runReapCli(["--slug"]);
    expect(code).not.toBe(0);
    errWrite.mockRestore();
  });
});

describe("toReapCliDeps' startEpochOf bridge", () => {
  it("forwards pidStartEpoch's raw SECONDS value verbatim — no millisecond scaling", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli([]);
    const calls = procSweepRunMock.runProcSweep.mock.calls as unknown as [
      { startEpochOf: (pid: number) => number | null },
    ][];
    const depsArg = calls[0]?.[0];
    expect(depsArg).toBeDefined();
    // If this bridge ever forwarded a millisecond-scaled field instead
    // (`startEpochMsOf`, per the module doc comment's own warning), this
    // would return ~1_234_567_000, not the raw seconds value below.
    expect(depsArg!.startEpochOf(999)).toBe(1_234_567);
    expect(livenessMock.pidStartEpoch).toHaveBeenCalledWith(999);
    log.mockRestore();
  });
});

describe("runReapCli --slug scoping", () => {
  it("--slug narrows the sweep to one slug", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli(["--slug", "my-pipeline-slug"]);
    expect(procSweepRunMock.runProcSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slug: "my-pipeline-slug" }),
    );
    log.mockRestore();
  });

  it("no --slug sweeps host-wide (slug undefined)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli([]);
    expect(procSweepRunMock.runProcSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slug: undefined }),
    );
    log.mockRestore();
  });
});

/**
 * The human-readable report is the surface a user actually reads, and its two
 * sections carry DIFFERENT act-authorities — registry rows are verified by
 * reap.ts's verifyRow ladder, strays are selected by shape alone. Without
 * these assertions only `--json`'s shape is pinned, so a reordered or
 * reworded section could silently drop the distinction that keeps a bare
 * `--yes` from widening the weaker discipline's blast radius.
 */
describe("runReapCli text report", () => {
  function captureReport(args: string[]): string {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runReapCli(args);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    return out;
  }

  it("heads the two sections separately, each naming its own act-authority", () => {
    const out = captureReport([]);
    const registryIdx = out.indexOf("Registry rows");
    const straysIdx = out.indexOf("Shape-heuristic strays");
    expect(registryIdx).toBeGreaterThanOrEqual(0);
    expect(straysIdx).toBeGreaterThan(registryIdx);
    expect(out).toContain("verified pid+pgid+startEpoch identity");
    expect(out).toContain("no startEpoch re-verification, no session check");
  });

  it("footers report-only runs with the exact command to act, and names the separate strays gate", () => {
    const out = captureReport([]);
    expect(out).toContain("Report-only.");
    expect(out).toContain("flow reap --yes");
    expect(out).toContain(
      "add --include-strays to also act on shape-heuristic strays",
    );
  });

  it("carries --slug into the footer's act command so the two-invocation flow is copy-pasteable", () => {
    const out = captureReport(["--slug", "my-pipeline-slug"]);
    expect(out).toContain("flow reap --slug my-pipeline-slug --yes");
  });

  it("groups the unknown bucket by reason and never describes a held row as acted on", () => {
    procSweepRunMock.runProcSweep.mockReturnValue({
      mode: "sweep" as const,
      yes: false,
      slugs: [
        {
          slug: "crashed-pipeline",
          reap: { ran: false, skipReason: "no-rows" },
          reported: { dead: 0, alive: 1, unknown: 2 },
          classified: [
            { verdict: "alive" },
            { verdict: "unknown", reason: "no-state-file" },
            { verdict: "unknown", reason: "state-unknown" },
          ],
        },
      ],
      totals: {},
      unknownRows: 2,
      aliveRows: 1,
    } as never);

    const out = captureReport([]);
    expect(out).toContain("unknown/no-state-file: 1");
    expect(out).toContain("unknown/state-unknown: 1");
    expect(out).toContain("held (report-only)");
    expect(out).toContain("alive = never signalled");
    // The B4 rationale must stay in front of the user, not just in the source.
    expect(out).toContain("absence of evidence is never evidence of death");
    // `ran: false` is the COMMON case for a report-only sweep (reap.ts returns
    // skipReason "no-rows" whenever the pre-filtered dead set is empty), so it
    // must never be rendered as "the sweep did not run".
    expect(out).not.toContain("did not run");
  });

  it("names a deadline-skipped slug with its own follow-up command rather than dropping it", () => {
    procSweepRunMock.runProcSweep.mockReturnValue({
      mode: "sweep" as const,
      yes: false,
      slugs: [
        {
          slug: "late-slug",
          reap: { ran: false, skipReason: "no-rows" },
          reported: { dead: 0, alive: 0, unknown: 0 },
          classified: [],
          skipped: "deadline-exceeded",
        },
      ],
      totals: {},
      unknownRows: 0,
      aliveRows: 0,
    } as never);

    const out = captureReport([]);
    expect(out).toContain("late-slug: skipped (sweep deadline exceeded)");
    expect(out).toContain("flow reap --slug late-slug");
  });

  describe("summary, hidden empties, legend", () => {
    const emptySlug = (slug: string, extra: Record<string, unknown> = {}) => ({
      slug,
      reap: { ran: false, skipReason: "no-rows" },
      reported: { dead: 0, alive: 0, unknown: 0 },
      classified: [],
      ...extra,
    });
    const rowSlug = (slug: string, verdicts: Array<[string, string?]>) => ({
      slug,
      reap: { ran: false, skipReason: "no-rows" },
      reported: { dead: 0, alive: 0, unknown: 0 },
      classified: verdicts.map(([verdict, reason]) => ({ verdict, reason })),
    });
    const mockSlugs = (
      slugs: unknown[],
      yes = false,
      totals: Record<string, number> = {},
    ) =>
      procSweepRunMock.runProcSweep.mockReturnValue({
        mode: "sweep" as const,
        yes,
        slugs,
        totals,
        unknownRows: 0,
        aliveRows: 0,
      } as never);

    it("leads a clean sweep with a no-leak verdict", () => {
      mockSlugs([rowSlug("live-one", [["alive"]])]);
      const out = captureReport([]);
      expect(out.split("\n")[0]).toMatch(
        /^Summary: no leaked processes recorded/,
      );
    });

    it("names dead and unknown counts in the verdict", () => {
      mockSlugs([rowSlug("a", [["dead"], ["unknown", "no-state-file"]])]);
      const first = captureReport([]).split("\n")[0];
      expect(first).toMatch(/^Summary:/);
      expect(first).toContain("1 dead (reapable with --yes)");
      expect(first).toContain("1 unknown (held)");
    });

    it("hides zero-row pipelines behind one count", () => {
      mockSlugs([
        emptySlug("empty-one"),
        emptySlug("empty-two"),
        emptySlug("empty-three"),
        rowSlug("busy", [["alive"]]),
      ]);
      const out = captureReport([]);
      expect(out).not.toContain("empty-one");
      expect(out).toContain("3 empty registries hidden");
      expect(out).not.toContain("also reaps");
    });

    it("mentions reaping dead rows in the count line when dead > 0", () => {
      mockSlugs([emptySlug("empty-one"), rowSlug("busy", [["dead"]])]);
      expect(captureReport([])).toContain("also reaps the 1 dead rows above");
    });

    it("prints the legend exactly once", () => {
      mockSlugs([
        rowSlug("a", [["unknown", "no-state-file"]]),
        rowSlug("b", [["unknown", "no-state-file"]]),
      ]);
      const out = captureReport([]);
      expect(
        out.split("absence of evidence is never evidence of death"),
      ).toHaveLength(2);
    });

    it("still lists deadline-skipped and unreadable-line pipelines by name", () => {
      mockSlugs([
        emptySlug("late", { skipped: "deadline-exceeded" }),
        emptySlug("garbled", {
          reap: { ran: false, skipReason: "no-rows", malformed: 2 },
        }),
      ]);
      const out = captureReport([]);
      expect(out).toContain("late: skipped (sweep deadline exceeded)");
      expect(out).toContain(
        "garbled: no readable rows (2 unreadable lines — left untouched)",
      );
    });

    it("lists a --slug zero-row slug by name with no hidden-count line", () => {
      mockSlugs([emptySlug("solo")]);
      const out = captureReport(["--slug", "solo"]);
      expect(out).toContain("solo: no recorded processes");
      expect(out).not.toContain("hidden");
    });

    it("reports removed empty registries on --yes", () => {
      mockSlugs(
        [
          emptySlug("e1", {
            compacted: { kept: 0, dropped: 0, removed: true },
          }),
          emptySlug("e2", {
            compacted: { kept: 0, dropped: 0, removed: true },
          }),
        ],
        true,
      );
      expect(captureReport(["--yes"])).toContain("removed 2 empty registries");
    });

    it("never reads clean on --yes when a dead row was not reaped", () => {
      mockSlugs([rowSlug("stuck", [["dead"]])], true);
      const first = captureReport(["--yes"]).split("\n")[0];
      expect(first).toContain("1 dead not reaped");
      expect(first).not.toContain("no leaked processes recorded");
    });

    it("--yes reads clean when every dead row was reaped", () => {
      mockSlugs([rowSlug("a", [["dead"], ["dead"]])], true, { reaped: 2 });
      const first = captureReport(["--yes"]).split("\n")[0];
      expect(first).toContain("reaped 2");
      expect(first).not.toContain("dead not reaped");
    });

    it("--yes routes a leaked-group row to need investigation, not dead not reaped", () => {
      mockSlugs(
        [
          {
            ...rowSlug("a", [["dead"]]),
            reap: { ran: true, counts: { "skipped-dead-leader": 1 } },
          },
        ],
        true,
      );
      const first = captureReport(["--yes"]).split("\n")[0];
      expect(first).toContain("1 needs investigation");
      expect(first).not.toContain("dead not reaped");
    });

    it("--yes counts an already-dead row as resolved, not a leak", () => {
      mockSlugs([rowSlug("a", [["dead"]])], true, { "already-dead": 1 });
      const first = captureReport(["--yes"]).split("\n")[0];
      expect(first).not.toContain("dead not reaped");
      expect(first).toMatch(/^Summary: no leaked processes recorded/);
    });

    it("--yes surfaces an empty registry that could not be removed", () => {
      mockSlugs(
        [
          emptySlug("stuck", { compacted: { kept: 0, dropped: 0 } }),
          emptySlug("gone", {
            compacted: { kept: 0, dropped: 0, removed: true },
          }),
        ],
        true,
      );
      const out = captureReport(["--yes"]);
      expect(out.split("\n")[0]).toContain("1 empty registry not removed");
      expect(out).toContain("1 empty registry could not be removed");
      expect(out).toContain("removed 1 empty registry");
    });

    it("the legend's dead clause follows --yes", () => {
      mockSlugs([rowSlug("a", [["dead"]])], true, { reaped: 1 });
      const out = captureReport(["--yes"]);
      expect(out).toContain("dead = acted on");
      expect(out).not.toContain("held (report-only) until --yes");
    });

    it("stray browsers and mcp servers keep the Summary from reading clean", () => {
      browserTeardownMock.runOrphanSweep.mockReturnValueOnce({
        ran: true,
        found: [{}],
        foundServers: [{}, {}],
        signalled: [],
      } as never);
      mockSlugs([rowSlug("a", [["alive"]])]);
      const first = captureReport([]).split("\n")[0];
      expect(first).toContain("1 stray browser,");
      expect(first).toContain("2 stray mcp servers");
      expect(first).not.toContain("no leaked processes recorded");
    });

    it("--json keeps zero-row pipelines and redacts argv to argv[0]", () => {
      const row = {
        pid: 1,
        pgid: 1,
        startEpoch: 1,
        slug: "busy",
        class: "default",
        argv: ["bun", "--token", "secret"],
        recordedAt: 0,
        sessionPid: null,
        sessionStartEpoch: null,
      };
      mockSlugs([
        emptySlug("empty-one"),
        {
          ...rowSlug("busy", []),
          classified: [{ verdict: "alive", row }],
        },
      ]);
      const out = captureReport(["--json"]);
      const parsed = JSON.parse(out);
      expect(
        parsed.registry.slugs.map((x: { slug: string }) => x.slug),
      ).toEqual(["empty-one", "busy"]);
      expect(parsed.registry.slugs[1].classified[0].row.argv).toEqual(["bun"]);
      expect(out).not.toContain("secret");
    });
  });
});

describe("collectReapReport report-only mode", () => {
  it("yes:false never signals: both sweeps run with yes:false and no kill is issued", () => {
    const result = collectReapReport({ yes: false, includeStrays: true });
    expect(procSweepRunMock.runProcSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ yes: false }),
    );
    expect(browserTeardownMock.runOrphanSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ yes: false }),
    );
    const deps = browserTeardownMock.buildDefaultDeps.mock.results[0]?.value;
    expect(deps.kill).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "reap",
      yes: false,
      includeStrays: true,
    });
    expect(result.registry.slugs).toEqual([]);
    expect(result.heuristic.found).toEqual([]);
  });

  it("threads baseDir and deadlineMs to the registry sweep", () => {
    collectReapReport({ baseDir: "/x/reg", deadlineMs: 5000 });
    expect(procSweepRunMock.runProcSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ baseDir: "/x/reg", deadlineMs: 5000 }),
    );
  });

  it("defaults to report-only with no options", () => {
    const result = collectReapReport({});
    expect(result.yes).toBe(false);
    expect(result.includeStrays).toBe(false);
  });
});
