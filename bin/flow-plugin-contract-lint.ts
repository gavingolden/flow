#!/usr/bin/env bun
/**
 * CI-runnable drift lint: materializes one plugin root per module (via the
 * REAL `ensurePluginRoot` primitive) into a temp fixture and asserts, via
 * the first-party `claude` CLI, that every emitted manifest is
 * contract-clean. VERIFIED on Claude Code 2.1.239: `claude plugin validate`
 * reads component directories WITHOUT following symlinks, so a root built
 * from symlinked `bin/`/`skills`/`agents` entries — exactly how
 * `flow install` ships them (AGENTS.md's "distributed via symlinks") —
 * cannot itself pass `--strict`. Phase 1 is split in two: 1a
 * dereferences each root into a real-file `cp -RL` twin and validates
 * THAT `--strict` (the CLI's own escape hatch for validating the real
 * paths separately); 1b validates the actual shipped symlinked root,
 * non-strict. Before this split the strict pass inspected ZERO of flow's
 * skills and agents. Phase 2 asserts `claude plugin list --json`
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
import {
  ensurePluginRoot,
  materializeModuleContent,
  pluginDirArgs,
} from "./lib/plugin-root";
import { moduleIds, type ModuleId } from "./lib/modules";
import { pluginRootName } from "./lib/plugin-manifest";

export type ContractLintPhase =
  | "materialize"
  | "validate-strict-deref"
  | "validate-shipped-root"
  | "list-skills-dir"
  | "plugin-dir-probe"
  | "skills-resolve";

export type ContractLintFailure = {
  root: string;
  phase: ContractLintPhase;
  detail: string;
};

export type ContractLintResult = {
  status: "ok" | "drifted" | "skipped";
  reason?: string;
  failures: ContractLintFailure[];
  /** The shipped root path (not the dereferenced twin, which is deleted with
   * `tmpRoot` in the `finally`) for every root that passed Phase 1a's `claude
   * plugin validate --strict` against its twin — a positive observable so a
   * vacuous strict pass (e.g. every root silently dropped by a Phase-1a
   * materialize failure) shows up as a short array here rather than merely an
   * empty `failures`. Populated only past the D4 short-circuit. */
  derefValidatedRoots: string[];
  /** The shipped symlinked root paths that passed Phase 1b's non-strict
   * `claude plugin validate` — same pass-only positive-observable semantics
   * as `derefValidatedRoots`, so a deleted/no-op Phase 1b shows up as an
   * empty array here rather than merely an empty `failures`. Populated only
   * past the D4 short-circuit. */
  shippedValidatedRoots: string[];
  /** The Phase-3 `--plugin-dir` probe roots `claude plugin list --json`
   * actually confirmed loaded (matching `installPath`, `enabled:true`) —
   * a positive observable so a deleted/no-op Phase 3 shows up as an
   * empty array here rather than merely an empty `failures`. Populated
   * only past the D4 short-circuit. */
  probedPluginDirRoots: string[];
  /** Every `skills:` entry (bare or plugin-qualified) declared by an
   * agents/core/*.md definition that resolved to a real SKILL.md under the
   * materialized plugin root — a positive observable so a collapsed glob
   * (every agent silently dropped) shows up as an empty array here rather
   * than merely an empty `failures`. Populated only past the D4
   * short-circuit. */
  resolvedPreloadSkills: string[];
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

/** Copies `root` to `dest` (the FULL target path, not a containing
 * directory — `cp -RL /a/src /existing/dest` yields `/existing/dest/src`)
 * with `-L` so every symlinked component (bin/skills/agents entries) lands
 * as a real file/dir in the twin, which is what makes `--strict` validation
 * of the twin meaningful. On a dangling component symlink `cp -RL` exits
 * non-zero — the realistic symlink-specific regression this guards
 * against — so the returned detail includes the trimmed stderr; without it
 * a materialize failure here is unactionable. `node:child_process`, not
 * `Bun.spawnSync` — same Node-hosted-vitest reason as `commandOnPath` /
 * `runClaude` above. `spawnSync` RETURNS (never throws) on both a missing
 * binary and a signal kill — in both cases `status` is `null` and `stderr`
 * is `null` — so those two cases are branched on explicitly rather than
 * falling into the generic non-zero-exit branch, where they'd read as the
 * unactionable `cp -RL exited null: `. */
export function dereferenceRoot(
  root: string,
  dest: string,
): { ok: true; path: string } | { ok: false; detail: string } {
  try {
    const result = spawnSync("cp", ["-RL", root, dest], {
      encoding: "utf8",
      timeout: DEFAULT_TIMEOUT_MS,
    });
    if (result.error) {
      return {
        ok: false,
        detail: `cp -RL failed to spawn: ${result.error.message}`,
      };
    }
    if (result.signal) {
      const timeoutNote =
        result.signal === "SIGTERM"
          ? ` (likely the ${DEFAULT_TIMEOUT_MS}ms spawnSync timeout — -L follows symlinks unboundedly)`
          : "";
      return {
        ok: false,
        detail: `cp -RL was killed by signal ${result.signal}${timeoutNote}`,
      };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        detail: `cp -RL exited ${result.status}: ${(result.stderr ?? "").trim()}`,
      };
    }
    return { ok: true, path: dest };
  } catch (err) {
    return {
      ok: false,
      detail: `cp -RL threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** For every `agents/*.md` definition under `root`, resolves each
 * frontmatter `skills:` entry (bare or plugin-qualified, block-list form)
 * against `root/skills/<bareName>/SKILL.md`. Exported standalone (not
 * inlined into `checkPluginContract`) so a fixture root can be unit-tested
 * without a real `claude` invocation — a wrong `skills:` name silently
 * no-ops the preload at runtime rather than erroring, so this filesystem
 * check is the only signal. */
export function resolveAgentPreloadSkills(root: string): {
  resolved: string[];
  failures: ContractLintFailure[];
} {
  const resolved: string[] = [];
  const failures: ContractLintFailure[] = [];
  const agentsDir = path.join(root, "agents");
  let agentFiles: string[] = [];
  try {
    agentFiles = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return { resolved, failures }; // no agents/ dir for this module
  }
  for (const agentFile of agentFiles) {
    const agentPath = path.join(agentsDir, agentFile);
    const frontmatter =
      fs.readFileSync(agentPath, "utf8").split("---")[1] ?? "";
    const skillsMatch = frontmatter.match(
      /^skills:\s*\n((?:\s+-\s+\S+\s*\n?)+)/m,
    );
    if (!skillsMatch) continue;
    const skillNames = [...skillsMatch[1].matchAll(/-\s+(\S+)/g)].map(
      (m) => m[1],
    );
    for (const rawName of skillNames) {
      const bareName = rawName.includes(":")
        ? rawName.split(":").slice(1).join(":")
        : rawName;
      const skillMdPath = path.join(root, "skills", bareName, "SKILL.md");
      if (fs.existsSync(skillMdPath)) {
        resolved.push(`${agentFile}:${rawName}`);
      } else {
        failures.push({
          root: agentPath,
          phase: "skills-resolve",
          detail: `skills: entry '${rawName}' does not resolve to ${skillMdPath}`,
        });
      }
    }
  }
  return { resolved, failures };
}

export async function checkPluginContract(
  opts: {
    claudeOnPath?: (cmd: string) => boolean;
    tmpRoot?: string;
    runClaude?: typeof runClaude;
    /** Narrow injection seam so a spec can force a Phase-1a materialize
     * failure for a specific root deterministically, without needing a real
     * `cp -RL`-hostile fixture (e.g. a dangling component symlink) on CI.
     * Defaults to the real `dereferenceRoot`. */
    dereference?: typeof dereferenceRoot;
  } = {},
): Promise<ContractLintResult> {
  const claudeOnPath = opts.claudeOnPath ?? commandOnPath;
  const runClaudeFn = opts.runClaude ?? runClaude;
  const dereferenceFn = opts.dereference ?? dereferenceRoot;
  if (!claudeOnPath("claude")) {
    return {
      status: "skipped",
      reason: "claude is not on PATH",
      failures: [],
      derefValidatedRoots: [],
      shippedValidatedRoots: [],
      probedPluginDirRoots: [],
      resolvedPreloadSkills: [],
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
    const failures: ContractLintFailure[] = [];
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
        failures.push({
          root,
          phase: "materialize",
          detail: "ensurePluginRoot returned 'blocked'",
        });
        continue;
      }
      roots.push({ id, root });
    }
    materializeModuleContent(flowSource, skillsDir);

    // Phase skills-resolve: every `skills:` entry an agents/core/*.md
    // definition declares must resolve to a real SKILL.md under the
    // materialized root — a wrong name silently no-ops the preload at
    // runtime rather than erroring, so this is a filesystem-only check
    // (no `claude` invocation needed) run against each materialized root.
    const resolvedPreloadSkills: string[] = [];
    for (const { root } of roots) {
      const { resolved, failures: skillsResolveFailures } =
        resolveAgentPreloadSkills(root);
      resolvedPreloadSkills.push(...resolved);
      failures.push(...skillsResolveFailures);
    }

    // Phase 1a: dereference each root into a real-file `cp -RL` twin under
    // <tmpRoot>/deref and validate THAT --strict. A failed copy is a LOCAL
    // materialize failure, not Claude Code drift — the root is dropped from
    // the strict pass entirely rather than recorded as validation drift.
    const derefRoot = path.join(tmpRoot, "deref");
    fs.mkdirSync(derefRoot, { recursive: true });
    const derefTwins: { root: string; twin: string }[] = [];
    for (const { id, root } of roots) {
      const dest = path.join(derefRoot, pluginRootName(id));
      const deref = dereferenceFn(root, dest);
      if (!deref.ok) {
        failures.push({ root, phase: "materialize", detail: deref.detail });
        continue;
      }
      derefTwins.push({ root, twin: deref.path });
    }

    // claude plugin validate --strict, all twins concurrently — they are
    // read-only, target distinct roots, and share no state, so this is
    // roughly one wall-clock cold start instead of `roots.length` serial
    // ones. Each invocation is sandboxed to `fixtureHome` — the real
    // `~/.claude` must never be touched, same as the `plugin list` call
    // below.
    const derefValidatedRoots: string[] = [];
    const strictDerefResults = await Promise.all(
      derefTwins.map(({ root, twin }) =>
        runClaudeFn(["plugin", "validate", "--strict", twin], {
          home: fixtureHome,
        }).then((result) => ({ root, result })),
      ),
    );
    for (const { root, result } of strictDerefResults) {
      if (result.timedOut) {
        failures.push({
          root,
          phase: "validate-strict-deref",
          detail: `claude plugin validate --strict timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        });
        continue;
      }
      if (result.exitCode !== 0) {
        failures.push({
          root,
          phase: "validate-strict-deref",
          detail: `claude plugin validate --strict exited ${result.exitCode}`,
        });
        continue;
      }
      derefValidatedRoots.push(root);
    }

    // Phase 1b: validate the actual shipped symlinked root, non-strict —
    // this is the shape `flow install` really produces. Same concurrency/
    // sandboxing rationale as Phase 1a above: read-only, distinct roots, no
    // shared state, one wall-clock cold start instead of `roots.length`
    // serial ones, each sandboxed to `fixtureHome`.
    const shippedValidatedRoots: string[] = [];
    const shippedResults = await Promise.all(
      roots.map(({ root }) =>
        runClaudeFn(["plugin", "validate", root], {
          home: fixtureHome,
        }).then((result) => ({ root, result })),
      ),
    );
    for (const { root, result } of shippedResults) {
      if (result.timedOut) {
        failures.push({
          root,
          phase: "validate-shipped-root",
          detail: `claude plugin validate timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        });
        continue;
      }
      if (result.exitCode !== 0) {
        failures.push({
          root,
          phase: "validate-shipped-root",
          detail: `claude plugin validate exited ${result.exitCode}`,
        });
        continue;
      }
      shippedValidatedRoots.push(root);
    }

    // claude plugin list --json, once, HOME pointed at the fixture — every
    // materialized root must report enabled:true with no errors[].
    const listResult = await runClaudeFn(["plugin", "list", "--json"], {
      home: fixtureHome,
    });
    if (listResult.timedOut) {
      failures.push({
        root: skillsDir,
        phase: "list-skills-dir",
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
          phase: "list-skills-dir",
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
            phase: "list-skills-dir",
            detail: "not reported by claude plugin list --json",
          });
        } else if (entry.enabled !== true) {
          failures.push({
            root,
            phase: "list-skills-dir",
            detail: `enabled:${entry.enabled}, expected true`,
          });
        } else if (entry.errors && entry.errors.length > 0) {
          failures.push({
            root,
            phase: "list-skills-dir",
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
          phase: "materialize",
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
        phase: "plugin-dir-probe",
        detail: `timed out after ${DEFAULT_TIMEOUT_MS}ms, via ${probeLabel}`,
      });
    } else if (probeResult.exitCode !== 0) {
      failures.push({
        root: probeLabel,
        phase: "plugin-dir-probe",
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
          phase: "plugin-dir-probe",
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
              phase: "plugin-dir-probe",
              detail: `not reported by claude plugin list --json, via ${probeLabel}`,
            });
          } else if (entry.enabled !== true) {
            failures.push({
              root,
              phase: "plugin-dir-probe",
              detail: `enabled:${entry.enabled}, expected true, via ${probeLabel}`,
            });
          } else if (entry.errors && entry.errors.length > 0) {
            failures.push({
              root,
              phase: "plugin-dir-probe",
              detail: `errors: ${JSON.stringify(entry.errors)}, via ${probeLabel}`,
            });
          } else {
            probedPluginDirRoots.push(root);
          }
        }
      }
    }

    return failures.length > 0
      ? {
          status: "drifted",
          failures,
          derefValidatedRoots,
          shippedValidatedRoots,
          probedPluginDirRoots,
          resolvedPreloadSkills,
        }
      : {
          status: "ok",
          failures: [],
          derefValidatedRoots,
          shippedValidatedRoots,
          probedPluginDirRoots,
          resolvedPreloadSkills,
        };
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
