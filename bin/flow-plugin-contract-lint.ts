#!/usr/bin/env bun
/**
 * CI-runnable drift lint: materializes one plugin root per module (via the
 * REAL `ensurePluginRoot` primitive) into a temp fixture and asserts, via
 * the first-party `claude` CLI, that every emitted manifest still passes
 * `claude plugin validate --strict` and that `claude plugin list --json`
 * reports each root enabled with no errors. A third phase then proves
 * repeated `--plugin-dir <root>` is not merely ACCEPTED but actually
 * HONOURED: two dedicated fixture roots outside the skills-dir fixture are
 * passed via `pluginDirArgs` and asserted loaded (`enabled:true`, matching
 * `installPath`) via `claude <pluginDirArgs> plugin list --json`. Root
 * loading is now verified semantically; intra-session `bin/` PATH
 * propagation (the launcher wiring) remains out of reach of a one-shot
 * `claude` invocation and is NOT covered here. This is the red signal when a
 * future Claude Code release changes the skills-dir plugin mechanism —
 * `docs/target-architecture.md`'s Consequences section names this drift
 * risk explicitly (the `bin/` PATH mechanism shipped 2.1.91, under a year
 * old at eval time). This is a LOCAL signal, not a CI one: `.github/workflows/ci.yml`
 * installs Node and Bun only, so `claude` is never on PATH there and this
 * check's real-CLI cases D4-skip on every CI run. The place it can actually
 * turn red is a maintainer's local `npm run test` / `flow-pre-commit`.
 *
 * Deliberately NOT symlinked onto PATH by `flow install` (the MAINTAINER_ONLY
 * exclusion in bin/lib/sources.ts) — same rationale as flow-plugin-probe.ts.
 *
 * CONTRACT CORRECTION vs plan Task 6 ("wire it into npm run verify via the
 * lint step"): there is no such step. `package.json`'s `verify` is
 * `typecheck:scripts && test && lint`, and `lint` is `prettier --check .`.
 * Every custom lint in this repo is a vitest file
 * (bin/skill-md-lint.test.ts, bin/lib/command-lint.test.ts), so this drift
 * check runs as bin/flow-plugin-contract-lint.test.ts under vitest — no
 * package.json change needed.
 *
 * D4 degradation: claude absent -> status "skipped", exit 0. CI on a runner
 * without Claude Code must stay green. Same HANG-PROOFING (in-process
 * timeout, CI=1, stdout-only capture) as flow-plugin-probe.ts, for the same
 * verified reason (no `timeout`/`gtimeout` binary on macOS).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn as spawnAsync, spawnSync } from "node:child_process";
import { resolveFlowSource } from "./lib/paths";
import { ensurePluginRoot, pluginDirArgs } from "./lib/plugin-root";
import { moduleIds, type ModuleId } from "./lib/modules";
import { pluginRootName } from "./lib/plugin-manifest";
import {
  discoverAgents,
  discoverSkills,
  type InstallTargets,
} from "./lib/sources";
import { ensureSymlink } from "./lib/symlink";

/**
 * `includeSkills: true` declares the manifest's `skills` key, and every
 * module's own `agents/` dir is unconditionally legitimate — but
 * `ensurePluginRoot` never populates either directory's CONTENT (that's
 * `sources.ts`'s/`setup.ts`'s job at real-install time). Without this, a
 * manifest that DECLARES `skills` but has no matching `<root>/skills/`
 * directory on disk fails `claude plugin validate --strict` with
 * `Path not found: ./skills`, and `claude plugin list --json` reports the
 * same as a non-empty `errors[]` — both would misreport genuine Claude Code
 * drift when the real cause is this fixture harness's own incompleteness.
 * Mirrors `setup.ts`'s install loop exactly: `discoverSkills`/`discoverAgents`
 * already route each artifact's target into its OWNING module's root
 * (`sources.ts`'s `ownerPluginRootName`), so one un-filtered call per kind,
 * scoped to `skillsRoot`, symlinks every module's content into its own root
 * in one pass — no per-module loop needed.
 */
function materializeModuleContent(
  flowSource: string,
  skillsRoot: string,
  /** Restricts symlinking to roots actually materialized under
   * `skillsRoot` (the Phase-3 `--plugin-dir` probe only ever
   * `ensurePluginRoot`s the first two module ids there) — without this, an
   * unfiltered call would `mkdirSync` an ownerless, never-`ensurePluginRoot`'d
   * directory for every OTHER module id under the same parent. */
  onlyIds?: readonly ModuleId[],
): void {
  const targets: InstallTargets = {
    skillsDir: skillsRoot,
    agentsDir: skillsRoot, // unused by discoverSkills/discoverAgents post-retarget
    binDir: skillsRoot, // unused by either discover function
    completionsDir: skillsRoot, // unused by either discover function
  };
  const allowedRootDirs = onlyIds
    ? new Set(onlyIds.map((id) => path.join(skillsRoot, pluginRootName(id))))
    : undefined;
  for (const entry of [
    ...discoverSkills(flowSource, targets),
    ...discoverAgents(flowSource, targets),
  ]) {
    if (
      allowedRootDirs &&
      !allowedRootDirs.has(path.dirname(path.dirname(entry.target)))
    ) {
      continue;
    }
    ensureSymlink(entry.target, entry.source, false);
  }
}

export type ContractLintResult = {
  status: "ok" | "drifted" | "skipped";
  reason?: string;
  failures: { root: string; detail: string }[];
  /** The Phase-3 `--plugin-dir` probe roots `claude plugin list --json`
   * actually confirmed loaded (matching `installPath`, `enabled:true`) —
   * a positive observable so a deleted/no-op Phase 3 shows up as an
   * empty array here rather than merely an empty `failures`. Populated
   * only past the D4 short-circuit. */
  probedPluginDirRoots: string[];
};

const DEFAULT_TIMEOUT_MS = 20_000;

/** `node:child_process`, not `Bun.spawnSync` — this must also run correctly
 * inside `npm run test`'s Node-hosted vitest process, where the global
 * `Bun` object does not exist (only the shipped CLI runs on Bun). */
function commandOnPath(cmd: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${cmd}`], {
    stdio: "pipe",
  });
  return result.status === 0;
}

type ClaudeResult = { stdout: string; exitCode: number; timedOut: boolean };

/** Same in-process hard-timeout discipline as flow-plugin-probe.ts's
 * runClaude — stdout captured alone, CI=1 in the child env, never a
 * shelled-out `timeout`/`gtimeout` (verified absent on PATH on macOS).
 * `node:child_process.spawn`, not `Bun.spawn` — same Node-hosted-vitest
 * reason as `commandOnPath` above. */
function runClaude(
  args: string[],
  opts: { home?: string; timeoutMs?: number } = {},
): Promise<ClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawnAsync("claude", args, {
      env: {
        ...process.env,
        CI: "1",
        ...(opts.home ? { HOME: opts.home } : {}),
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      resolve({ stdout, exitCode, timedOut });
    };
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", () => finish(-1));
  });
}

export async function checkPluginContract(
  opts: {
    claudeOnPath?: (cmd: string) => boolean;
    tmpRoot?: string;
    runClaude?: typeof runClaude;
  } = {},
): Promise<ContractLintResult> {
  const claudeOnPath = opts.claudeOnPath ?? commandOnPath;
  const runClaudeFn = opts.runClaude ?? runClaude;
  if (!claudeOnPath("claude")) {
    return {
      status: "skipped",
      reason: "claude is not on PATH",
      failures: [],
      probedPluginDirRoots: [],
    };
  }

  const ownsTmpRoot = opts.tmpRoot === undefined;
  const tmpRoot =
    opts.tmpRoot ??
    fs.mkdtempSync(path.join(os.tmpdir(), "flow-plugin-contract-lint-"));
  try {
    const fixtureHome = path.join(tmpRoot, "home");
    const skillsDir = path.join(fixtureHome, ".claude", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    const flowSource = resolveFlowSource();
    const failures: { root: string; detail: string }[] = [];
    const roots: { id: ModuleId; root: string }[] = [];

    for (const id of moduleIds()) {
      const root = path.join(skillsDir, pluginRootName(id));
      const result = ensurePluginRoot({
        root,
        moduleId: id,
        flowSource,
        version: "1.0.0",
        includeSkills: true,
        force: false,
      });
      if (result === "blocked") {
        failures.push({ root, detail: "ensurePluginRoot returned 'blocked'" });
        continue;
      }
      roots.push({ id, root });
    }
    materializeModuleContent(flowSource, skillsDir);

    // claude plugin validate --strict, all roots concurrently — they are
    // read-only, target distinct roots, and share no state, so this is
    // roughly one wall-clock cold start instead of `roots.length` serial
    // ones. Each invocation is sandboxed to `fixtureHome` — the real
    // `~/.claude` must never be touched, same as the `plugin list` call
    // below.
    const validateResults = await Promise.all(
      roots.map(({ root }) =>
        runClaudeFn(["plugin", "validate", "--strict", root], {
          home: fixtureHome,
        }).then((result) => ({ root, result })),
      ),
    );
    for (const { root, result } of validateResults) {
      if (result.timedOut) {
        failures.push({
          root,
          detail: `claude plugin validate --strict timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        });
        continue;
      }
      if (result.exitCode !== 0) {
        failures.push({
          root,
          detail: `claude plugin validate --strict exited ${result.exitCode}`,
        });
      }
    }

    // claude plugin list --json, once, HOME pointed at the fixture — every
    // materialized root must report enabled:true with no errors[].
    const listResult = await runClaudeFn(["plugin", "list", "--json"], {
      home: fixtureHome,
    });
    if (listResult.timedOut) {
      failures.push({
        root: skillsDir,
        detail: `claude plugin list --json timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      });
    } else {
      let parsed: Array<{ id: string; enabled: boolean; errors?: unknown[] }> =
        [];
      try {
        parsed = JSON.parse(listResult.stdout) as typeof parsed;
      } catch (err) {
        failures.push({
          root: skillsDir,
          detail: `could not parse claude plugin list --json output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      for (const { id, root } of roots) {
        const entry = parsed.find(
          (p) => p.id === `${pluginRootName(id)}@skills-dir`,
        );
        if (!entry) {
          failures.push({
            root,
            detail: "not reported by claude plugin list --json",
          });
        } else if (entry.enabled !== true) {
          failures.push({
            root,
            detail: `enabled:${entry.enabled}, expected true`,
          });
        } else if (entry.errors && entry.errors.length > 0) {
          failures.push({
            root,
            detail: `errors: ${JSON.stringify(entry.errors)}`,
          });
        }
      }
    }

    // Phase 3: does `claude` actually LOAD roots passed via repeated
    // `--plugin-dir`, not merely accept the flag? Two dedicated fixture
    // roots, materialized OUTSIDE fixtureHome/.claude/skills so the
    // skills-dir discovery phase above can never also pick them up.
    // EMPIRICAL ANCHOR (verified at plan time): `--plugin-dir <root>`
    // ahead of `plugin list` reports one entry per root, id
    // `<name>@inline`, `installPath === root` — not the `@skills-dir`
    // suffix the phase above matches on.
    const probeIds = moduleIds().slice(0, 2);
    const probeRoots: string[] = [];
    for (const id of probeIds) {
      const root = path.join(tmpRoot, "plugin-dir-probe", pluginRootName(id));
      // A blocked fixture is a LOCAL materialization failure, not Claude
      // Code drift — record it as such and drop the root, so it can never
      // resurface below as a misleading "not reported by claude plugin
      // list --json" (which would read as a mechanism regression).
      if (
        ensurePluginRoot({
          root,
          moduleId: id,
          flowSource,
          version: "1.0.0",
          includeSkills: true,
          force: false,
        }) === "blocked"
      ) {
        failures.push({
          root,
          detail:
            "ensurePluginRoot returned 'blocked' materializing the --plugin-dir probe fixture",
        });
        continue;
      }
      probeRoots.push(root);
    }
    materializeModuleContent(
      flowSource,
      path.join(tmpRoot, "plugin-dir-probe"),
      probeIds,
    );
    const probeArgv = [
      ...pluginDirArgs(probeRoots),
      "plugin",
      "list",
      "--json",
    ];
    const probeLabel = `claude ${probeArgv.join(" ")}`;
    // Deliberately sequential with the Phase-2 `plugin list` call above,
    // not `Promise.all`-batched with it, unlike Phase 1's read-only
    // `plugin validate` calls: two concurrent `plugin list` invocations
    // against the same `fixtureHome` aren't obviously safe together, so
    // this stays serial rather than risk a flake to save one cold start.
    const probeResult =
      probeRoots.length > 0
        ? // Every probe fixture blocked — the `failures` entries above
          // already make this run red, so spending a `claude` cold start
          // on a flagless `plugin list` that can prove nothing would only
          // add a confusing second failure.
          await runClaudeFn(probeArgv, { home: fixtureHome })
        : { stdout: "[]", exitCode: 0, timedOut: false };
    const probedPluginDirRoots: string[] = [];
    if (probeResult.timedOut) {
      failures.push({
        root: probeLabel,
        detail: `timed out after ${DEFAULT_TIMEOUT_MS}ms, via ${probeLabel}`,
      });
    } else if (probeResult.exitCode !== 0) {
      failures.push({
        root: probeLabel,
        detail: `exited ${probeResult.exitCode}, via ${probeLabel}`,
      });
    } else {
      let probeParsed: Array<{
        id: string;
        enabled: boolean;
        installPath?: string;
        errors?: unknown[];
      }> = [];
      let probeParseOk = false;
      try {
        const parsed = JSON.parse(probeResult.stdout);
        if (!Array.isArray(parsed)) {
          throw new Error("output is not an array");
        }
        probeParsed = parsed as typeof probeParsed;
        probeParseOk = true;
      } catch (err) {
        failures.push({
          root: probeLabel,
          detail: `could not parse output: ${err instanceof Error ? err.message : String(err)}, via ${probeLabel}`,
        });
      }
      // Only walk probeRoots on a successful array parse — otherwise
      // probeParsed stays [] and this loop would push one redundant "not
      // reported" failure per root on top of the parse failure above.
      if (probeParseOk) {
        for (const root of probeRoots) {
          const entry = probeParsed.find((p) => p.installPath === root);
          if (!entry) {
            failures.push({
              root,
              detail: `not reported by claude plugin list --json, via ${probeLabel}`,
            });
          } else if (entry.enabled !== true) {
            failures.push({
              root,
              detail: `enabled:${entry.enabled}, expected true, via ${probeLabel}`,
            });
          } else if (entry.errors && entry.errors.length > 0) {
            failures.push({
              root,
              detail: `errors: ${JSON.stringify(entry.errors)}, via ${probeLabel}`,
            });
          } else {
            probedPluginDirRoots.push(root);
          }
        }
      }
    }

    return failures.length > 0
      ? { status: "drifted", failures, probedPluginDirRoots }
      : { status: "ok", failures: [], probedPluginDirRoots };
  } finally {
    if (ownsTmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

export function exitCodeFor(result: ContractLintResult): number {
  return result.status === "drifted" ? 1 : 0;
}

async function main(): Promise<void> {
  const result = await checkPluginContract();
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCodeFor(result));
}

if (import.meta.main) {
  main();
}
