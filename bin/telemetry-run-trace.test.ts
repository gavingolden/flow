/**
 * Cross-helper integration test: drives a contrived pipeline end to end
 * through the REAL `flow-state-update` / `flow-gate-summary` subprocesses
 * and asserts the resulting whole-run event trace lands in the shared
 * telemetry log (`~/.flow/telemetry/events.jsonl`, written by
 * `bin/lib/telemetry.ts`'s `recordEvent`).
 *
 * PR #778 added the telemetry substrate. Two of its Test Steps were gated
 * as manual only because they named a real post-merge `flow feature
 * create` run as their precondition. That precondition is local and
 * reversible: a contrived pipeline driven through the real helper
 * subprocesses in a sandbox HOME satisfies both assertions
 * deterministically, with no git fixture and no live pipeline needed. This
 * file is that automation.
 *
 * `bin/flow-state-update.test.ts` and `bin/flow-gate-summary.test.ts`
 * already cover each emit site in-process and in isolation — this file
 * deliberately does NOT re-assert those per-helper unit behaviours. What
 * is unique here: a whole run's worth of events, emitted by TWO SEPARATE
 * helper processes, lands correlated under one slug in one shared log,
 * and the plan-review redirect is derivable from that log with no
 * dedicated event — see `docs/configuration.md`'s worked `jq` one-liner.
 *
 * Follows `bin/flow-conflict-marker-check.test.ts`'s subprocess-
 * integration idiom: a `spawnSync("bun", ["--version"])` skip guard,
 * `import.meta.dirname` for resolving sibling script paths, and
 * `describe.skipIf(!bunOnPath)` so the suite degrades cleanly where bun
 * is absent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

const here =
  import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
const STATE_UPDATE_PATH = path.join(here, "flow-state-update.ts");
const GATE_SUMMARY_PATH = path.join(here, "flow-gate-summary.ts");

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Seeds `<home>/.flow/state/<slug>.json` with the minimal fields
 * `isPipelineState` (bin/lib/state.ts) requires. Deliberately NO
 * `worktree` field — that is what makes `checkWorktreeBranch` a no-op, so
 * this fixture never needs a real git worktree.
 */
function seedState(home: string, slug: string, repo: string): void {
  const stateDir = path.join(home, ".flow", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `${slug}.json`),
    JSON.stringify({
      slug,
      phase: "starting",
      repo,
      kind: "feature",
      updatedAt: new Date().toISOString(),
    }),
  );
}

function makeSandboxHome(slug: string, repo: string): string {
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "flow-telemetry-run-trace-"),
  );
  scratchDirs.push(home);
  seedState(home, slug, repo);
  return home;
}

/**
 * `TMUX` / `TMUX_PANE` are deliberately DELETED (not merely set to
 * `undefined`, which Node would still serialize into the child's env) from
 * the subprocess env: a leaked pane var would let `resolveSlugAmbient`
 * widen ambient slug resolution to this session's OWN live tmux pane and
 * misattribute events under a developer's real pipeline instead of the
 * sandbox slug.
 */
function sandboxEnv(home: string, slug: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    FLOW_SLUG: slug,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function driveStateUpdate(env: NodeJS.ProcessEnv, phase: string) {
  return spawnSync("bun", [STATE_UPDATE_PATH, "--phase", phase], {
    env,
    encoding: "utf8",
  });
}

function driveGateSummary(
  env: NodeJS.ProcessEnv,
  status: "merged" | "gated",
  tldr: string,
) {
  return spawnSync(
    "bun",
    [
      GATE_SUMMARY_PATH,
      "--status",
      status,
      "--pr-url",
      "https://example.invalid/pr/1",
      "--tldr",
      tldr,
    ],
    { env, encoding: "utf8" },
  );
}

/**
 * Drives every phase in `phases` via the real `flow-state-update`
 * subprocess, asserting `status === 0` on EVERY call so a helper
 * regression fails loudly instead of silently producing a short trace.
 */
function driveSequence(env: NodeJS.ProcessEnv, phases: string[]): void {
  for (const phase of phases) {
    const result = driveStateUpdate(env, phase);
    expect(result.status).toBe(0);
  }
}

function readEvents(home: string): Array<Record<string, any>> {
  const logPath = path.join(home, ".flow", "telemetry", "events.jsonl");
  const raw = fs.readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

const STRAIGHT_THROUGH_PHASES = [
  "triaging",
  "worktree-create",
  "planning",
  "plan-pending-review",
  "checkpoint-pending-clear",
  "implementing",
  "verifying",
  "ci-wait",
  "reviewing",
  "gating",
  "merging",
];

// Exactly ONE plan-review redirect: planning -> plan-pending-review ->
// planning (the redirect back into planning) -> plan-pending-review ->
// ... -> gating.
const REDIRECT_PHASES = [
  "triaging",
  "worktree-create",
  "planning",
  "plan-pending-review",
  "planning",
  "plan-pending-review",
  "checkpoint-pending-clear",
  "implementing",
  "verifying",
  "ci-wait",
  "reviewing",
  "gating",
];

/**
 * In-test equivalent of `docs/configuration.md`'s "Derive the plan-review
 * redirect count" `jq` one-liner:
 *
 *   jq -c 'select(.event == "phase.transition" and .attrs.from == "plan-pending-review" and .attrs.to == "planning")'
 *
 * Hand-writing this predicate (rather than shelling out to `jq`) means a
 * future edit to either side shows up as a failing assertion here instead
 * of silent doc/test drift.
 */
function isRedirectEvent(e: Record<string, any>): boolean {
  return (
    e.event === "phase.transition" &&
    e.attrs?.from === "plan-pending-review" &&
    e.attrs?.to === "planning"
  );
}

describe.skipIf(!bunOnPath)(
  "integration: a whole pipeline run's telemetry trace, driven through the real flow-state-update / flow-gate-summary subprocesses",
  () => {
    it("(A) a whole run's events land correlated under one slug, with exactly one run.terminal — automated form of PR #778's first manual Test Step", () => {
      const slug = "contrived-straight-through";
      const home = makeSandboxHome(slug, "/tmp/contrived-" + slug);
      const env = sandboxEnv(home, slug);

      driveSequence(env, STRAIGHT_THROUGH_PHASES);
      const gate = driveGateSummary(env, "merged", "ship it");
      expect(gate.status).toBe(0);

      const events = readEvents(home).filter((e) => e.slug === slug);
      const transitions = events.filter((e) => e.event === "phase.transition");
      const terminals = events.filter((e) => e.event === "run.terminal");

      expect(transitions.length).toBeGreaterThan(0);
      expect(terminals).toHaveLength(1);
      expect(terminals[0].attrs.status).toBe("merged");
      for (const e of events) {
        expect(e.version).toBe(1);
        expect(e.ts).toBeTruthy();
      }
    });

    it("(B) a plan-review redirect is derivable with no dedicated event — automated form of PR #778's second manual Test Step", () => {
      const slug = "contrived-plan-redirect";
      const home = makeSandboxHome(slug, "/tmp/contrived-" + slug);
      const env = sandboxEnv(home, slug);

      driveSequence(env, REDIRECT_PHASES);
      const gate = driveGateSummary(env, "gated", "needs a human look");
      expect(gate.status).toBe(0);

      const events = readEvents(home).filter((e) => e.slug === slug);
      const redirects = events.filter(isRedirectEvent);
      expect(redirects).toHaveLength(1);

      // "derive, don't emit" (bin/lib/telemetry.ts's header comment): no
      // helper ever writes a dedicated `plan.redirect` event. This is the
      // only place that contract is asserted end to end.
      expect(events.some((e) => e.event === "plan.redirect")).toBe(false);
    });

    it("(C) two runs sharing one log stay attributed to their own slug", () => {
      const straightSlug = "contrived-shared-straight";
      const redirectSlug = "contrived-shared-redirect";
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-telemetry-run-trace-shared-"),
      );
      scratchDirs.push(home);
      seedState(home, straightSlug, "/tmp/contrived-" + straightSlug);
      seedState(home, redirectSlug, "/tmp/contrived-" + redirectSlug);

      const straightEnv = sandboxEnv(home, straightSlug);
      driveSequence(straightEnv, STRAIGHT_THROUGH_PHASES);
      expect(driveGateSummary(straightEnv, "merged", "ship it").status).toBe(0);

      const redirectEnv = sandboxEnv(home, redirectSlug);
      driveSequence(redirectEnv, REDIRECT_PHASES);
      expect(
        driveGateSummary(redirectEnv, "gated", "needs a look").status,
      ).toBe(0);

      // This is the property that justifies ONE shared log over a
      // per-run file: two runs' events interleave in the same file but
      // stay cleanly separable by `.slug`.
      const allEvents = readEvents(home);
      for (const slug of [straightSlug, redirectSlug]) {
        const terminals = allEvents.filter(
          (e) => e.slug === slug && e.event === "run.terminal",
        );
        expect(terminals).toHaveLength(1);
      }

      const straightRedirects = allEvents.filter(
        (e) => e.slug === straightSlug && isRedirectEvent(e),
      );
      const redirectRedirects = allEvents.filter(
        (e) => e.slug === redirectSlug && isRedirectEvent(e),
      );
      expect(straightRedirects).toHaveLength(0);
      expect(redirectRedirects).toHaveLength(1);
    });
  },
);
