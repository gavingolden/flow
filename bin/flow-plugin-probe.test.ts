/**
 * Unit tests for the probe harness's DISPATCH logic (D4 degradation, id
 * filtering, JSON shape). Never invoke the real `claude` here — every case
 * injects `claudeOnPath` and never lets `main()` run against a real binary.
 * The harness's actual per-probe verdicts are exercised live by running
 * `bun bin/flow-plugin-probe.ts --json` directly (see the file's own doc
 * comment); that is a maintainer/CI action, not a unit test.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  runProbes,
  runProbesFiltered,
  type ProbeId,
} from "./flow-plugin-probe";

const ALL_IDS: ProbeId[] = [
  "add-dir-discovery",
  "symlink-materialization",
  "bin-path-injection",
  "enabled-plugins",
  "skill-invocation-name",
  "agent-invocation-name",
  "agent-memory-scope",
  "skills-preload-name",
  "max-turns-partial",
  "cache-ttl-1h",
];

const LIVE_ONLY_IDS: ProbeId[] = [
  "agent-memory-scope",
  "skills-preload-name",
  "max-turns-partial",
  "cache-ttl-1h",
];

describe(runProbes, () => {
  it("emits exactly one verdict per ProbeId", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    const ids = verdicts.map((v) => v.id);
    expect(new Set(ids).size).toBe(ALL_IDS.length);
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it("D4 degradation: every verdict is 'skipped' with a named reason when claudeOnPath returns false", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    expect(verdicts).toHaveLength(ALL_IDS.length);
    for (const v of verdicts) {
      expect(v.verdict).toBe("skipped");
      expect(v.evidence).toContain("PATH");
    }
  });

  it("fixtures are built under the injected tmpRoot and the real HOME is never read or written", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-plugin-probe-test-"),
    );
    try {
      // claude absent -> D4 short-circuit before any fixture is built, so
      // tmpRoot stays empty. This asserts the harness never touches the real
      // HOME on the degraded path (the only path this unit suite exercises
      // without a live claude dependency).
      await runProbes({ claudeOnPath: () => false, tmpRoot });
      expect(fs.readdirSync(tmpRoot)).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("--json output parses and every entry has id/verdict/evidence", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    const parsed = JSON.parse(JSON.stringify(verdicts)) as typeof verdicts;
    for (const entry of parsed) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.verdict).toBe("string");
      expect(typeof entry.evidence).toBe("string");
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
  });

  it("a non-confirmed (skipped) verdict never carries a fabricated fallback — D4 short-circuits before any probe's own fallback ladder runs", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    for (const v of verdicts) {
      expect(v.fallback).toBeUndefined();
    }
  });

  it("without --live, the four live-only ids report skipped with '--live' named as the reason — scoped via runProbesFiltered so no real `claude` spawn is triggered by the other ids", async () => {
    const verdicts = await runProbesFiltered(LIVE_ONLY_IDS, {
      claudeOnPath: () => true,
    });
    expect(verdicts).toHaveLength(LIVE_ONLY_IDS.length);
    for (const v of verdicts) {
      expect(v.verdict).toBe("skipped");
      expect(v.evidence).toContain("--live");
      expect(v.fallback).toBeUndefined();
    }
  });

  it("without --live, the tmpRoot invariant holds for the live-only subset even when claudeOnPath is true (never builds a fixture)", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-plugin-probe-test-live-gate-"),
    );
    try {
      await runProbesFiltered(LIVE_ONLY_IDS, {
        claudeOnPath: () => true,
        tmpRoot,
      });
      expect(fs.readdirSync(tmpRoot)).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe(parseArgs, () => {
  it("--probe <id> narrows the CLI to that single id", () => {
    expect(parseArgs(["--probe", "enabled-plugins"])).toEqual({
      json: false,
      probe: "enabled-plugins",
      live: false,
    });
  });

  it("--json sets json:true independent of --probe", () => {
    expect(parseArgs(["--json", "--probe", "bin-path-injection"])).toEqual({
      json: true,
      probe: "bin-path-injection",
      live: false,
    });
  });

  it("an unrecognized --probe value leaves probe undefined (falls through to running every id)", () => {
    expect(parseArgs(["--probe", "not-a-real-probe"])).toEqual({
      json: false,
      probe: undefined,
      live: false,
    });
  });

  it("no flags at all: json:false, probe:undefined, live:false", () => {
    expect(parseArgs([])).toEqual({
      json: false,
      probe: undefined,
      live: false,
    });
  });

  it("--live sets live:true independent of other flags", () => {
    expect(parseArgs(["--live"])).toEqual({
      json: false,
      probe: undefined,
      live: true,
    });
  });
});
