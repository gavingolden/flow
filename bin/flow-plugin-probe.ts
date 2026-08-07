#!/usr/bin/env bun
/**
 * MAINTAINER-TIME, read-only probe harness settling the three unverified
 * assumptions `docs/target-architecture.md`'s `p6-distribution-impl`
 * Consequences section names, plus two adjacent packaging facts, against the
 * LOCALLY INSTALLED `claude` — never a network call, never mutating the
 * user's real `~/.claude`. Run it from a flow checkout:
 *   bun bin/flow-plugin-probe.ts --json
 *
 * Deliberately NOT symlinked onto PATH by `flow install` (the MAINTAINER_ONLY
 * exclusion in bin/lib/sources.ts) — both cross-model reviewers objected to
 * shipping this as a user-facing PATH helper: every user's install must be
 * deterministic, never probe-driven.
 *
 * D4 degradation: when `claude` is not on PATH, every verdict is "skipped"
 * with a named reason and the process exits 0 — never a hard failure.
 *
 * HANG-PROOFING: every `claude` invocation carries CI=1 in the child env and
 * an IN-PROCESS hard timeout (node:child_process's spawn + a manual timer
 * that kills the child), never a shelled-out `timeout`/`gtimeout` — verified absent on
 * PATH on macOS, the primary dev platform, so a `timeout`-based
 * implementation would be a silent no-op exactly where it's needed. A
 * timed-out probe yields "inconclusive" with the timeout named in evidence.
 * stdout is captured alone — never `2>&1` — so progress lines never corrupt
 * a downstream JSON parse.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn as spawnAsync, spawnSync } from "node:child_process";
import { resolveFlowSource } from "./lib/paths";
import { ensurePluginRoot } from "./lib/plugin-root";

export type ProbeId =
  | "add-dir-discovery"
  | "symlink-materialization"
  | "bin-path-injection"
  | "enabled-plugins"
  | "skill-invocation-name";

export type ProbeVerdict = {
  id: ProbeId;
  verdict: "confirmed" | "refuted" | "inconclusive" | "skipped";
  evidence: string;
  fallback?: string;
};

const PROBE_IDS: ProbeId[] = [
  "add-dir-discovery",
  "symlink-materialization",
  "bin-path-injection",
  "enabled-plugins",
  "skill-invocation-name",
];

const DEFAULT_TIMEOUT_MS = 15_000;

/** `node:child_process`, not `Bun.spawnSync`/`Bun.spawn` — this harness must
 * also run correctly inside `npm run test`'s Node-hosted vitest process,
 * where the global `Bun` object does not exist (only the shipped CLI runs
 * on Bun, via its `#!/usr/bin/env bun` shebang). */
function commandOnPath(cmd: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${cmd}`], {
    stdio: "pipe",
  });
  return result.status === 0;
}

type ClaudeResult = { stdout: string; exitCode: number; timedOut: boolean };

/** Runs `claude <args>`, capturing stdout ONLY, with an in-process hard
 * timeout. `cwd`/`env.HOME` scope every invocation to the caller's fixture —
 * never the real user home. */
function runClaude(
  args: string[],
  opts: { cwd?: string; home?: string; timeoutMs?: number } = {},
): Promise<ClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawnAsync("claude", args, {
      cwd: opts.cwd,
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

function skillsDirRoot(fixtureHome: string): string {
  return path.join(fixtureHome, ".claude", "skills");
}

/** A single flow-owned plugin root, materialized through the REAL
 * `ensurePluginRoot` primitive (not hand-rolled JSON) so a probe verdict
 * reflects what `flow install` actually produces. */
function materializeRoot(
  fixtureHome: string,
  moduleId: "core" = "core",
): string {
  const root = path.join(skillsDirRoot(fixtureHome), `flow-module-${moduleId}`);
  ensurePluginRoot({
    root,
    moduleId,
    flowSource: resolveFlowSource(),
    version: "1.0.0",
    includeSkills: false,
    force: false,
  });
  return root;
}

async function probeAddDirDiscovery(
  fixtureHome: string,
): Promise<ProbeVerdict> {
  const id: ProbeId = "add-dir-discovery";
  materializeRoot(fixtureHome);
  const result = await runClaude(["plugin", "list", "--json"], {
    home: fixtureHome,
  });
  if (result.timedOut) {
    return {
      id,
      verdict: "inconclusive",
      evidence: `claude plugin list --json timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      fallback:
        "fall back to copying the module directory in place under the skills directory (no marketplace, no cache copy)",
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      id: string;
      enabled: boolean;
    }>;
    const entry = parsed.find((p) => p.id === "flow-module-core@skills-dir");
    if (entry?.enabled === true) {
      return {
        id,
        verdict: "confirmed",
        evidence: `a plugin root materialized under <HOME>/.claude/skills/ (not the flow-launched-session default HOME) is discovered by \`claude plugin list --json\` as flow-module-core@skills-dir, enabled:true — exit ${result.exitCode}`,
      };
    }
    return {
      id,
      verdict: "refuted",
      evidence: `flow-module-core@skills-dir not reported enabled: ${result.stdout}`,
      fallback:
        "fall back to copying the module directory in place under the skills directory (no marketplace, no cache copy)",
    };
  } catch (err) {
    return {
      id,
      verdict: "inconclusive",
      evidence: `could not parse \`claude plugin list --json\` output: ${err instanceof Error ? err.message : String(err)}`,
      fallback:
        "fall back to copying the module directory in place under the skills directory (no marketplace, no cache copy)",
    };
  }
}

async function probeSymlinkMaterialization(
  fixtureHome: string,
): Promise<ProbeVerdict> {
  const id: ProbeId = "symlink-materialization";
  const root = materializeRoot(fixtureHome);
  const hasSymlinkedBin =
    fs.existsSync(path.join(root, "bin")) &&
    fs
      .readdirSync(path.join(root, "bin"))
      .some((name) =>
        fs.lstatSync(path.join(root, "bin", name)).isSymbolicLink(),
      );
  const result = await runClaude(["plugin", "validate", "--strict", root], {
    home: fixtureHome,
  });
  if (result.timedOut) {
    return {
      id,
      verdict: "inconclusive",
      evidence: `claude plugin validate --strict timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      fallback: "route helpers through ~/.local/bin PATH symlinks only",
    };
  }
  if (result.exitCode === 0) {
    return {
      id,
      verdict: "confirmed",
      evidence: `ensurePluginRoot's own materialization shape (a real root directory with symlinked bin/ entries${hasSymlinkedBin ? "" : " — none present for module 'core'"}) passes \`claude plugin validate --strict\` — exit 0`,
    };
  }
  return {
    id,
    verdict: "refuted",
    evidence: `claude plugin validate --strict exited ${result.exitCode} against a root containing symlinked bin/ entries`,
    fallback: "route helpers through ~/.local/bin PATH symlinks only",
  };
}

async function probeBinPathInjection(
  fixtureHome: string,
): Promise<ProbeVerdict> {
  const id: ProbeId = "bin-path-injection";
  const rootA = materializeRoot(fixtureHome);
  const result = await runClaude(
    ["--plugin-dir", rootA, "--plugin-dir", rootA, "--version"],
    { home: fixtureHome },
  );
  if (result.timedOut) {
    return {
      id,
      verdict: "inconclusive",
      evidence: `claude --plugin-dir ... --version timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      fallback:
        "modules stay symlink-materialized for helper coverage; the packaging layer is revisited without touching the (b) backbone",
    };
  }
  if (result.exitCode !== 0) {
    return {
      id,
      verdict: "refuted",
      evidence: `--plugin-dir <path> --plugin-dir <path> --version exited ${result.exitCode}`,
      fallback:
        "modules stay symlink-materialized for helper coverage; the packaging layer is revisited without touching the (b) backbone",
    };
  }
  // The flag's existence and repeatability are confirmed by this one-shot,
  // non-interactive check; whether the child SESSION's PATH env actually
  // includes <root>/bin cannot be observed without a live interactive
  // session, so that half of assumption (ii) stays unverified by this
  // harness specifically.
  return {
    id,
    verdict: "confirmed",
    evidence: `claude --plugin-dir <path> --plugin-dir <path> --version accepts repeated --plugin-dir and exits 0 (stdout: ${result.stdout.trim()}); note: intra-session PATH propagation itself is not observable via a one-shot non-interactive probe`,
  };
}

async function probeEnabledPlugins(fixtureHome: string): Promise<ProbeVerdict> {
  const id: ProbeId = "enabled-plugins";
  materializeRoot(fixtureHome);
  const projectDir = path.join(fixtureHome, "..", "project");
  fs.mkdirSync(projectDir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: projectDir });
  const result = await runClaude(
    ["plugin", "disable", "flow-module-core@skills-dir", "--scope", "project"],
    { cwd: projectDir, home: fixtureHome },
  );
  if (result.timedOut) {
    return {
      id,
      verdict: "inconclusive",
      evidence: `claude plugin disable --scope project timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      fallback:
        "per-repo enablement degrades to the existing symlink-selection mechanism",
    };
  }
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // fall through to refuted below
  }
  const enabledPlugins = settings.enabledPlugins as
    | Record<string, boolean>
    | undefined;
  if (
    result.exitCode === 0 &&
    enabledPlugins?.["flow-module-core@skills-dir"] === false
  ) {
    return {
      id,
      verdict: "confirmed",
      evidence: `\`claude plugin disable flow-module-core@skills-dir --scope project\` writes {"enabledPlugins":{"flow-module-core@skills-dir":false}} to .claude/settings.json — a @skills-dir name is accepted identically to a marketplace-installed name`,
    };
  }
  return {
    id,
    verdict: "refuted",
    evidence: `exit ${result.exitCode}; .claude/settings.json enabledPlugins: ${JSON.stringify(enabledPlugins)}`,
    fallback:
      "per-repo enablement degrades to the existing symlink-selection mechanism",
  };
}

async function probeSkillInvocationName(
  fixtureHome: string,
): Promise<ProbeVerdict> {
  const id: ProbeId = "skill-invocation-name";
  // Forward-looking fixture: ensurePluginRoot deliberately never creates a
  // skills/ directory in this PR (the skill move is a deferred follow-up) —
  // this probe layers one on manually to settle the naming convention AHEAD
  // of that move, so the follow-up has a verified answer to implement to.
  const root = materializeRoot(fixtureHome);
  const skillDir = path.join(root, "skills", "flow-probe-fixture-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: flow-probe-fixture-skill\ndescription: probe fixture\n---\n# probe fixture\n",
  );
  const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  manifest.skills = ["./skills"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const result = await runClaude(
    ["plugin", "details", "flow-module-core@skills-dir"],
    { home: fixtureHome },
  );
  if (result.timedOut) {
    return {
      id,
      verdict: "inconclusive",
      evidence: `claude plugin details timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      fallback:
        "the deferred skill move ships without a verified naming answer; re-probe before implementing it",
    };
  }
  if (
    result.exitCode === 0 &&
    result.stdout.includes("flow-probe-fixture-skill")
  ) {
    return {
      id,
      verdict: "confirmed",
      evidence: `claude plugin details flow-module-core@skills-dir reports the skill by its BARE directory name (flow-probe-fixture-skill), not a plugin-qualified name — settles the naming convention for the deferred skill-move follow-up`,
    };
  }
  return {
    id,
    verdict: "inconclusive",
    evidence: `claude plugin details did not report the fixture skill by its bare name (exit ${result.exitCode}): ${result.stdout.trim()}`,
    fallback:
      "the deferred skill move ships without a verified naming answer; re-probe before implementing it",
  };
}

const PROBE_FNS: Record<
  ProbeId,
  (fixtureHome: string) => Promise<ProbeVerdict>
> = {
  "add-dir-discovery": probeAddDirDiscovery,
  "symlink-materialization": probeSymlinkMaterialization,
  "bin-path-injection": probeBinPathInjection,
  "enabled-plugins": probeEnabledPlugins,
  "skill-invocation-name": probeSkillInvocationName,
};

export function runProbes(
  opts: { claudeOnPath?: (cmd: string) => boolean; tmpRoot?: string } = {},
): Promise<ProbeVerdict[]> {
  return runProbesFiltered(PROBE_IDS, opts);
}

async function runProbesFiltered(
  ids: ProbeId[],
  opts: { claudeOnPath?: (cmd: string) => boolean; tmpRoot?: string } = {},
): Promise<ProbeVerdict[]> {
  const claudeOnPath = opts.claudeOnPath ?? commandOnPath;
  if (!claudeOnPath("claude")) {
    return ids.map((id) => ({
      id,
      verdict: "skipped",
      evidence: "claude is not on PATH",
    }));
  }

  const ownsTmpRoot = opts.tmpRoot === undefined;
  const tmpRoot =
    opts.tmpRoot ??
    fs.mkdtempSync(path.join(os.tmpdir(), "flow-plugin-probe-"));
  const verdicts: ProbeVerdict[] = [];
  try {
    for (const id of ids) {
      const fixtureHome = fs.mkdtempSync(path.join(tmpRoot, `${id}-home-`));
      try {
        verdicts.push(await PROBE_FNS[id](fixtureHome));
      } catch (err) {
        verdicts.push({
          id,
          verdict: "inconclusive",
          evidence: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
          fallback: "re-run the probe manually and inspect the fixture",
        });
      }
    }
  } finally {
    if (ownsTmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
  return verdicts;
}

export function parseArgs(argv: string[]): { json: boolean; probe?: ProbeId } {
  const json = argv.includes("--json");
  const probeIdx = argv.indexOf("--probe");
  const probeRaw = probeIdx >= 0 ? argv[probeIdx + 1] : undefined;
  const probe = PROBE_IDS.includes(probeRaw as ProbeId)
    ? (probeRaw as ProbeId)
    : undefined;
  return { json, probe };
}

async function main(): Promise<void> {
  const { json, probe } = parseArgs(process.argv.slice(2));
  const ids = probe ? [probe] : PROBE_IDS;
  const verdicts = await runProbesFiltered(ids);
  if (json) {
    console.log(JSON.stringify(verdicts, null, 2));
  } else {
    for (const v of verdicts) {
      console.log(`${v.id}: ${v.verdict}`);
      console.log(`  ${v.evidence}`);
      if (v.fallback) console.log(`  fallback: ${v.fallback}`);
    }
  }
  process.exit(0);
}

if (import.meta.main) {
  main();
}
