/**
 * Structural spec over every committed suite under `evals/`: `loadSuite`
 * validates, every scenario materializes and dry-runs through the real
 * `flow-eval` CLI (stubbed probes, an injected tmp `stateDir` — never the
 * developer's real `~/.flow/state`), every `evalSlug` fits `isValidSlug`'s
 * cap, and an armed checkpoint fixture satisfies freshness ordering. Never
 * spawns `claude` or `gh` — `probeClaude`/`probeFlowInstall` are stubbed
 * `ok: true` so `main`'s dry-run path never reaches a real probe, and the
 * dry-run branch inside `eval-cli.ts` never calls `runScenarioOnce`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evalSlug, loadSuite } from "./lib/eval-suite";
import { materializeFixture } from "./lib/eval-fixture";
import { isValidSlug } from "./lib/slug";
import { isCheckpointUsable } from "./lib/checkpoint-freshness";
import { main, type Deps } from "./lib/eval-cli";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS_ROOT = path.join(HERE, "..", "evals");

function discoverSuiteIds(): string[] {
  if (!fs.existsSync(EVALS_ROOT)) return [];
  return fs
    .readdirSync(EVALS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_shims")
    .filter((d) => fs.existsSync(path.join(EVALS_ROOT, d.name, "suite.json")))
    .map((d) => d.name)
    .sort();
}

const suiteIds = discoverSuiteIds();

// A guard against a silently-empty describe.each: if evals/ ever loses
// every suite, this assertion is the loud failure rather than a green run
// that tested nothing.
it("discovers at least one committed suite under evals/", () => {
  expect(suiteIds.length).toBeGreaterThan(0);
});

describe.each(suiteIds)("evals/%s", (suiteId) => {
  const suiteDir = path.join(EVALS_ROOT, suiteId);

  it("loads and validates via loadSuite", () => {
    const result = loadSuite(suiteDir);
    expect(result.ok).toBe(true);
  });

  it("every scenario's evalSlug fits isValidSlug's 60-char cap", () => {
    const result = loadSuite(suiteDir);
    if (!result.ok) throw new Error(result.reason);
    for (const scenario of result.value.scenarios) {
      expect(isValidSlug(evalSlug(suiteId, scenario.id, 1))).toBe(true);
    }
  });

  it("every scenario's evalSlug fits the cap for the 'without' ablation arm too, and differs from the 'with' slug", () => {
    const result = loadSuite(suiteDir);
    if (!result.ok) throw new Error(result.reason);
    for (const scenario of result.value.scenarios) {
      const withSlug = evalSlug(suiteId, scenario.id, 1, "with");
      const withoutSlug = evalSlug(suiteId, scenario.id, 1, "without");
      expect(isValidSlug(withoutSlug)).toBe(true);
      expect(withoutSlug).not.toBe(withSlug);
    }
  });

  it("the plugin-loaded gate grader is marked withOnly (Task 6c: a correctly-ablated 'without' arm can never pass it)", () => {
    const result = loadSuite(suiteDir);
    if (!result.ok) throw new Error(result.reason);
    for (const scenario of result.value.scenarios) {
      const pluginLoaded = scenario.graders.find(
        (g) => g.id === "plugin-loaded",
      );
      if (pluginLoaded) {
        expect(pluginLoaded.withOnly).toBe(true);
      }
    }
  });
});

describe("materialization (real fixtures, tmp stateDir)", () => {
  let stateDir!: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-evals-suites-state-"),
    );
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  for (const suiteId of suiteIds) {
    it(`${suiteId}: every scenario with a fixture.repo resolves origin/main and carries .flow-tmp/; armed checkpoints are fresh`, () => {
      const loaded = loadSuite(path.join(EVALS_ROOT, suiteId));
      if (!loaded.ok) throw new Error(loaded.reason);

      for (const scenario of loaded.value.scenarios) {
        const fixture = materializeFixture(scenario, suiteId, 1, { stateDir });
        try {
          if (scenario.fixture?.repo) {
            const mergeBase = spawnSync(
              "git",
              ["merge-base", "origin/main", "HEAD"],
              {
                cwd: fixture.repoDir,
                encoding: "utf8",
              },
            );
            expect(mergeBase.status).toBe(0);
            expect(mergeBase.stdout.trim().length).toBeGreaterThan(0);
            expect(fs.existsSync(path.join(fixture.repoDir, ".flow-tmp"))).toBe(
              true,
            );
          }
          if (scenario.fixture?.checkpoint?.armed) {
            const state = JSON.parse(
              fs.readFileSync(
                path.join(stateDir, `${fixture.slug}.json`),
                "utf8",
              ),
            );
            expect(isCheckpointUsable(state, stateDir)).toBe(true);
          }
        } finally {
          fixture.teardown();
        }
      }
    });
  }
});

describe("dry-run via the real CLI", () => {
  let stateDir!: string;
  let outDir!: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-evals-suites-cli-state-"),
    );
    outDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-evals-suites-cli-out-"),
    );
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("dry-runs every committed suite and leaves no eval-* state behind", async () => {
    for (const suiteId of suiteIds) {
      const deps: Partial<Deps> = {
        probeClaude: () => ({ ok: true, version: "0.0.0-test" }),
        probeFlowInstall: () => ({ ok: true, version: "" }),
        materializeFixture: (scenario, sId, run, opts) =>
          materializeFixture(scenario, sId, run, { ...opts, stateDir }),
      };
      const code = await main(
        [
          "run",
          "--suite",
          suiteId,
          "--out",
          outDir,
          "--evals-dir",
          EVALS_ROOT,
          "--dry-run",
        ],
        deps,
      );
      expect(code).toBe(0);
      const reportPath = path.join(outDir, suiteId, "report.json");
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        scenarios: Array<{ id: string }>;
      };
      const loaded = loadSuite(path.join(EVALS_ROOT, suiteId));
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(report.scenarios.map((s) => s.id).sort()).toEqual(
        loaded.value.scenarios.map((s) => s.id).sort(),
      );
    }
    const leaked = fs
      .readdirSync(stateDir)
      .filter((n) => n.startsWith("eval-"));
    expect(leaked).toEqual([]);
  });
});
