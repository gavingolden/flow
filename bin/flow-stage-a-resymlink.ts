#!/usr/bin/env bun
/**
 * `flow-stage-a-resymlink --worktree <path> --slug <slug>` — stage A's step
 * 5.5 (`skills/pipeline/flow-pipeline/SKILL.md` "Step 5.5 — Re-symlink if
 * worktree adds skills/agents"), as a tested binary rather than a block of
 * shell inlined in an LLM-interpreted agent prompt.
 *
 * What it does, in order:
 *   1. Detects files ADDED on this branch under `skills/`, `agents/`, or
 *      `workflows/` (`git diff --name-only --diff-filter=A
 *      origin/<default>...HEAD`) — the same check the inline block ran.
 *   2. No-ops when there are none: prints `{"added":false,...}`, exits 0.
 *   3. Otherwise runs `flow install --upgrade --source <worktree>`, retrying
 *      ONCE on a non-zero exit, then registers the post-merge
 *      `flow install --upgrade` follow-up.
 *
 * Why a helper and not inline shell: a swallowed non-zero install leaves
 * branch-added helpers off PATH for the rest of the run, so verify and
 * review can then fail for a reason the transcript never explains. The
 * retry-and-report contract is what lets stage A escalate
 * `flow-setup-upgrade-failed` instead — and a tested binary is the only
 * place that contract can be pinned.
 *
 * Output: ONE JSON envelope on stdout, `{ added, installOk, attempts }`.
 * `attempts` counts `flow install` invocations (0 when nothing was added).
 *
 * Exit codes:
 *   0 — nothing to install, or the install succeeded.
 *   1 — the install failed on both attempts (`installOk: false`).
 *   2 — bad CLI args.
 */

export type ParsedArgs = { worktree: string; slug: string } | { error: string };

const USAGE = "usage: flow-stage-a-resymlink --worktree <path> --slug <slug>";

export function parseArgs(argv: string[]): ParsedArgs {
  const out: Partial<{ worktree: string; slug: string }> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--worktree":
        out.worktree = value;
        break;
      case "--slug":
        out.slug = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!out.worktree) return { error: "--worktree is required" };
  if (!out.slug) return { error: "--slug is required" };
  return out as { worktree: string; slug: string };
}

export type RunResult = { stdout: string; stderr: string; exitCode: number };
export type Runner = (
  argv: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => RunResult;

/** The three top-level directories `flow install` links from a worktree. */
const INSTALLED_DIRS = ["skills", "agents", "workflows"] as const;

/**
 * `refs/remotes/origin/<branch>` → `<branch>`. Falls back to `main` when
 * `git symbolic-ref` failed or printed something unexpected — same default
 * the inline shell block carried (`${DEFAULT_BRANCH:-main}`).
 */
export function parseDefaultBranch(result: RunResult): string {
  if (result.exitCode !== 0) return "main";
  const line = result.stdout.trim().split("\n")[0] ?? "";
  const m = line.match(/^refs\/remotes\/origin\/(.+)$/);
  return m ? m[1] : "main";
}

/** The `--diff-filter=A` paths that live under an installed directory. */
export function addedInstallPaths(diffStdout: string): string[] {
  return diffStdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => INSTALLED_DIRS.some((d) => l.startsWith(`${d}/`)));
}

export type Envelope = {
  added: boolean;
  installOk: boolean;
  attempts: number;
};

export const FOLLOWUP_REASON =
  "new skills/agents/workflows added on this branch — re-symlink home install post-merge";

/**
 * The whole step, with every subprocess injected so the decision table is
 * unit-testable without a git checkout or a real `flow install`.
 *
 * A failing `git diff` is treated as "nothing added" (matching the inline
 * block's `|| true`), with a NOTICE on stderr rather than a silent skip —
 * escalating a whole pipeline on a transient git failure would be a worse
 * trade than the pre-existing behaviour this helper preserves.
 */
export function resymlink(
  worktree: string,
  slug: string,
  run: Runner,
  warn: (line: string) => void = () => {},
): Envelope {
  const cwd = worktree;
  const branch = parseDefaultBranch(
    run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], { cwd }),
  );
  const diff = run(
    [
      "git",
      "diff",
      "--name-only",
      "--diff-filter=A",
      `origin/${branch}...HEAD`,
    ],
    { cwd },
  );
  if (diff.exitCode !== 0) {
    warn(
      `NOTICE — flow-stage-a-resymlink: git diff against origin/${branch} exited ` +
        `${diff.exitCode}; treating the branch as adding no skills/agents/workflows.`,
    );
    return { added: false, installOk: true, attempts: 0 };
  }
  if (addedInstallPaths(diff.stdout).length === 0) {
    return { added: false, installOk: true, attempts: 0 };
  }

  const env = { FLOW_SLUG: slug };
  let attempts = 1;
  let install = run(["flow", "install", "--upgrade", "--source", worktree], {
    cwd,
    env,
  });
  if (install.exitCode !== 0) {
    warn(
      `NOTICE — flow-stage-a-resymlink: flow install --upgrade --source exited ` +
        `${install.exitCode}; retrying once.`,
    );
    attempts = 2;
    install = run(["flow", "install", "--upgrade", "--source", worktree], {
      cwd,
      env,
    });
  }

  // Registered whether or not the install succeeded: the post-merge home
  // install still needs the re-symlink, and a failed --source install is
  // exactly when the user is most likely to need the reminder.
  run(
    [
      "flow-followups",
      "add",
      "--command",
      "flow install --upgrade",
      "--reason",
      FOLLOWUP_REASON,
      "--auto",
      "--registered-by",
      "flow-stage-a:step-5.5",
    ],
    { cwd, env },
  );

  return { added: true, installOk: install.exitCode === 0, attempts };
}

function spawn(
  argv: string[],
  opts: { cwd: string; env?: Record<string, string> },
): RunResult {
  const result = Bun.spawnSync(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`flow-stage-a-resymlink: ${parsed.error}\n${USAGE}\n`);
    process.exit(2);
    return;
  }
  const envelope = resymlink(parsed.worktree, parsed.slug, spawn, (line) =>
    process.stderr.write(`${line}\n`),
  );
  console.log(JSON.stringify(envelope));
  process.exit(envelope.installOk ? 0 : 1);
}

if (import.meta.main) {
  main();
}
