/**
 * Free-tier composition spec: proves, WITHOUT spawning a real `claude`
 * session, that `flow-open-pr` run as a real subprocess against a
 * materialized eval fixture with the real `evals/_shims/gh` on PATH takes
 * the read-back path and writes `phase: "implementing"` plus `pr: 7` — the
 * exact write `evals/phase-write-fidelity/s5-open-pr-implementing`
 * measures end-to-end via a paid `claude -p` run.
 *
 * Value over `bin/flow-open-pr.test.ts`'s existing `describe("phase
 * advance")` block: that block is fully in-process (stubbed `gh`/`git`
 * runners called directly against `run()`). This spec is strictly
 * COMPOSITION — a real subprocess, the real hermetic shim resolved off a
 * real `PATH`, and a real state file on disk — so it goes red if the shim,
 * `flow-open-pr`, or `advancePhase` drift apart from each other in a way
 * the in-process spec, which never crosses a process boundary, cannot
 * catch. Keep both: do not delete this as a "duplicate" of the in-process
 * block.
 *
 * Lives at `bin/evals-phase-write-shim.test.ts`, NOT under `evals/`:
 * `vitest.config.ts`'s `include` is `["bin/**\/*.test.ts",
 * "skills/**\/*.test.ts"]`, so a spec under `evals/` is never collected —
 * the same constraint `bin/evals-gh-shim.test.ts`'s header documents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSuite } from "./lib/eval-suite";
import { materializeFixture } from "./lib/eval-fixture";

const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS_ROOT = path.resolve(HERE, "..", "evals");

// Un-gated, unlike the describe block below: if `bun` ever stops being
// installed, this assertion is the loud failure rather than the whole
// skipIf block silently reading green on zero executed assertions.
it("bun is on PATH", () => {
  expect(bunOnPath).toBe(true);
});

describe.skipIf(!bunOnPath)("flow-open-pr against the hermetic gh shim", () => {
  it("takes the read-back path and writes phase: implementing + pr: 7", () => {
    const loaded = loadSuite(path.join(EVALS_ROOT, "phase-write-fidelity"));
    if (!loaded.ok) throw new Error(loaded.reason);
    const scenario = loaded.value.scenarios.find(
      (s) => s.id === "s5-open-pr-implementing",
    );
    if (!scenario) {
      throw new Error(
        "phase-write-fidelity suite is missing scenario 's5-open-pr-implementing'",
      );
    }

    // Derive the expected phase/pr from the scenario's own $STATE graders
    // rather than hard-coding "implementing"/7 — a hard-coded expectation
    // here would stay green even if case.json's graders drifted away from
    // this free spec's assertions, exactly the declaration-vs-reality drift
    // `ghCalls` exists to close for gh argv.
    const phaseGrader = scenario.graders.find(
      (g) => g.id === "state-phase-implementing",
    );
    const prGrader = scenario.graders.find((g) => g.id === "state-pr-recorded");
    if (
      !phaseGrader ||
      typeof phaseGrader.equals !== "string" ||
      !prGrader ||
      typeof prGrader.equals !== "number"
    ) {
      throw new Error(
        "s5-open-pr-implementing is missing its 'state-phase-implementing'/'state-pr-recorded' $STATE graders",
      );
    }
    const expectedPhase = phaseGrader.equals;
    const expectedPr = prGrader.equals;

    // PLAN-DEVIATION correction, load-bearing: `bin/lib/paths.ts`
    // computes FLOW_STATE_DIR from `os.homedir()` at import time, and
    // `flow-open-pr` exposes no `--state-dir` flag to a spawned
    // subprocess — `deps.stateDir` is an in-process seam only. Point
    // BOTH `materializeFixture`'s `stateDir` and the spawned child's
    // `HOME` at the same fake home dir. Verified (not the plan's
    // as-authored claim): without this override the child resolves
    // FLOW_STATE_DIR against the vitest sandbox's real HOME, where
    // materializeFixture never wrote a state file, so `run()`'s
    // `updater(...)` call fails loudly with "no state file for slug"
    // BEFORE it ever reaches `advancePhase` — a real (not vacuous)
    // failure this spec's `expect(r.status).toBe(0)` already catches.
    // The override is still required either way.
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "evals-phase-write-shim-home-"),
    );
    const stateDir = path.join(home, ".flow", "state");

    const fixture = materializeFixture(scenario, "phase-write-fidelity", 1, {
      stateDir,
    });
    try {
      const bodyFile = path.join(fixture.repoDir, ".flow-tmp", "pr-body.md");
      expect(fs.existsSync(bodyFile)).toBe(true);

      const r = spawnSync(
        "bun",
        [
          path.resolve(HERE, "flow-open-pr.ts"),
          "--body-file",
          bodyFile,
          "--title",
          "test: s5-open-pr-implementing eval fixture",
        ],
        {
          cwd: fixture.repoDir,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            // Second PLAN-DEVIATION correction: FLOW_EVAL_FIXTURE must be
            // `fixture.repoDir` (mirroring `bin/lib/eval-runner.ts`'s
            // `buildChildEnv`, ~line 242), NOT `path.join(scenario.dir,
            // "fixture")` — the shim reads `pr.json` from the
            // MATERIALIZED fixture dir, not the committed one.
            FLOW_EVAL_FIXTURE: fixture.repoDir,
            FLOW_SLUG: fixture.slug,
            PATH: `${fixture.shimDir}:${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(r.status, `stderr: ${r.stderr}`).toBe(0);

      const written = JSON.parse(
        fs.readFileSync(path.join(stateDir, `${fixture.slug}.json`), "utf8"),
      );
      expect(written.phase).toBe(expectedPhase);
      expect(written.pr).toBe(expectedPr);
    } finally {
      fixture.teardown();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
