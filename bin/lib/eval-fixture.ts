/**
 * Turns a `ResolvedScenario` into a hermetic on-disk fixture: a real git
 * repo on branch `eval` (with a synthetic `refs/remotes/origin/main` so
 * `flow-pre-commit`'s merge-base scope detection resolves with no network),
 * a materialized `flow-module-core` plugin root, seeded pipeline state
 * (optionally an armed checkpoint), and copied shims — plus a teardown
 * that removes every trace under the real `FLOW_STATE_DIR`, mirroring
 * `bin/lib/done.ts`'s full per-slug teardown set.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evalSlug, type ResolvedScenario } from "./eval-suite";
import { isValidSlug } from "./slug";
import { FLOW_STATE_DIR } from "./paths";
import { writeState, deleteState, type PipelineState } from "./state";
import {
  checkpointBodyPath,
  checkpointDir,
  deleteCheckpointDir,
} from "./checkpoint-freshness";
import { checkpointMarkerPath } from "../flow-checkpoint";
import { deleteTurnTracking } from "./stop-turn-tracking";
import { registryPath } from "./proc-registry";
import { ensureFlowExcludes, writeBranchMarker } from "./worktree-marker";
import { git as gitRead } from "./git";
import { ensurePluginRoot, materializeModuleContent } from "./plugin-root";

export type MaterializedFixture = {
  root: string;
  repoDir: string;
  claudeHome: string;
  pluginRoots: string[];
  shimDir: string;
  slug: string;
  stateDir: string;
  checkpointDir?: string;
  teardown: () => void;
};

/**
 * The checkout that owns THIS file — deliberately NOT `resolveFlowSource()`
 * (which honours `~/.flow/config.json`'s `source` override and would
 * silently point an f2 branch's eval at `main`). A branch under evaluation
 * must evaluate its own tree.
 */
function ownCheckoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function defaultGit(argv: string[], cwd: string): void {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      `eval-fixture: git ${argv.join(" ")} failed in ${cwd}: ${stderr || `exit ${result.status}`}`,
    );
  }
}

/**
 * `armedAt` must be strictly newer than every `phaseLog[].at` for
 * `isCheckpointUsable` to treat the body as fresh — the fixture's static
 * `phaseLog` timestamps are authored once and don't track wall-clock time,
 * so this always bumps past them rather than trusting `now()` alone.
 */
function armedAtNewerThanPhaseLog(
  now: Date,
  phaseLog?: Array<{ at: string }>,
): string {
  const latest = (phaseLog ?? []).reduce(
    (acc, e) => (e.at > acc ? e.at : acc),
    "",
  );
  const nowIso = now.toISOString();
  if (!latest || nowIso > latest) return nowIso;
  return new Date(new Date(latest).getTime() + 1000).toISOString();
}

export function materializeFixture(
  scenario: ResolvedScenario,
  suiteId: string,
  run: number,
  opts: {
    flowSource?: string;
    tmpRoot?: string;
    stateDir?: string;
    git?: (argv: string[], cwd: string) => void;
    now?: () => Date;
  } = {},
): MaterializedFixture {
  const flowSource = opts.flowSource ?? ownCheckoutRoot();
  const stateDir = opts.stateDir ?? FLOW_STATE_DIR;
  const now = opts.now ?? (() => new Date());
  const git = opts.git ?? defaultGit;

  const slug = evalSlug(suiteId, scenario.id, run);
  if (!isValidSlug(slug)) {
    throw new Error(
      `materializeFixture: evalSlug produced an invalid slug '${slug}'`,
    );
  }

  const root = fs.mkdtempSync(
    path.join(opts.tmpRoot ?? os.tmpdir(), "flow-eval-fixture-"),
  );
  const repoDir = path.join(root, "repo");
  const claudeHome = path.join(root, "claude-home");
  const skillsRoot = path.join(claudeHome, ".claude", "skills");
  const shimDir = path.join(root, "shims");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o755 });

  if (scenario.fixture?.repo) {
    fs.cpSync(path.join(scenario.dir, scenario.fixture.repo), repoDir, {
      recursive: true,
    });
  }

  // Committed fixtures use the non-dot `flow-tmp/` name (`.flow-tmp/` is
  // git-ignored repo-wide, so `git add` would silently drop it) — rename
  // to the real dotted name at materialization time, mirroring a real
  // worktree.
  const nonDotFlowTmp = path.join(repoDir, "flow-tmp");
  if (fs.existsSync(nonDotFlowTmp)) {
    fs.renameSync(nonDotFlowTmp, path.join(repoDir, ".flow-tmp"));
  }

  git(["init", "-q"], repoDir);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], repoDir);
  git(["config", "user.email", "eval@flow.local"], repoDir);
  git(["config", "user.name", "flow-eval"], repoDir);
  git(["add", "-A"], repoDir);
  git(["commit", "-q", "-m", "eval fixture base", "--allow-empty"], repoDir);
  const mainSha = gitRead(["rev-parse", "HEAD"], repoDir);
  // No remote exists in this hermetic fixture — flow-pre-commit's scope
  // detection resolves `git merge-base origin/main HEAD` regardless, so a
  // synthetic remote-tracking ref (no network, no fetch) is required or
  // scope detection silently sees a clean tree and every check
  // vacuously passes without ever running.
  git(["update-ref", "refs/remotes/origin/main", mainSha], repoDir);
  git(["checkout", "-q", "-b", "eval"], repoDir);

  if (scenario.fixture?.overlay) {
    fs.cpSync(path.join(scenario.dir, scenario.fixture.overlay), repoDir, {
      recursive: true,
    });
    git(["add", "-A"], repoDir);
    git(["commit", "-q", "-m", "eval fixture overlay"], repoDir);
  }

  ensureFlowExcludes(repoDir);
  writeBranchMarker(repoDir, "eval");

  if (scenario.fixture?.linkNodeModules) {
    const src = path.join(flowSource, "node_modules");
    if (fs.existsSync(src)) {
      fs.symlinkSync(src, path.join(repoDir, "node_modules"), "dir");
    }
  }

  const statePartial: Partial<PipelineState> = scenario.fixture?.state
    ? (JSON.parse(
        fs.readFileSync(
          path.join(scenario.dir, scenario.fixture.state),
          "utf8",
        ),
      ) as Partial<PipelineState>)
    : {};

  let checkpointDirPath: string | undefined;
  let checkpointRecord: PipelineState["checkpoint"] | undefined =
    statePartial.checkpoint;

  if (scenario.fixture?.checkpoint) {
    const { body, site, armed } = scenario.fixture.checkpoint;
    checkpointDirPath = checkpointDir(slug, stateDir);
    fs.mkdirSync(checkpointDirPath, { recursive: true });
    const bodyText = fs.readFileSync(path.join(scenario.dir, body), "utf8");
    fs.writeFileSync(checkpointBodyPath(slug, stateDir), bodyText);
    if (armed) {
      const marker = checkpointMarkerPath(slug, stateDir);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${slug}\n${now().toISOString()}\n`);
      checkpointRecord = {
        site,
        phase: statePartial.phase ?? "implementing",
        armedAt: armedAtNewerThanPhaseLog(now(), statePartial.phaseLog),
      };
    }
  }

  const state: PipelineState = {
    ...statePartial,
    slug,
    repo: repoDir,
    worktree: repoDir,
    updatedAt: now().toISOString(),
    ...(checkpointRecord ? { checkpoint: checkpointRecord } : {}),
  } as PipelineState;
  writeState(state, stateDir);

  const coreRoot = path.join(skillsRoot, "flow-module-core");
  ensurePluginRoot({
    root: coreRoot,
    moduleId: "core",
    flowSource,
    version: "1.0.0",
    includeSkills: true,
    force: false,
  });
  materializeModuleContent(flowSource, skillsRoot, ["core"]);
  const pluginRoots = [coreRoot];

  for (const shim of scenario.fixture?.shims ?? []) {
    const src = path.join(scenario.dir, shim);
    const dest = path.join(shimDir, path.basename(shim));
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }

  const teardown = (): void => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    deleteState(slug, stateDir);
    deleteTurnTracking(slug, stateDir);
    deleteCheckpointDir(slug, stateDir);
    try {
      fs.unlinkSync(registryPath(slug, stateDir));
    } catch {
      // best-effort — the proc registry row may never have been written
    }
  };

  return {
    root,
    repoDir,
    claudeHome,
    pluginRoots,
    shimDir,
    slug,
    stateDir,
    checkpointDir: checkpointDirPath,
    teardown,
  };
}
