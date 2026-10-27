/**
 * Observation probes for `flow epic manage`: repo-scoped pipeline states, one
 * batched GitHub GraphQL snapshot, and local git refs. Every subprocess goes
 * through the injected async `ExecFn` with a timeout, so a hung `gh` / `git`
 * can neither stall a tick nor swallow Ctrl-C. Nothing here writes anything.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { withoutGitLocalEnv } from "./git-local-env";
import { makeSameRepository, resolveGitCommonDir } from "./repo-root";
import { listStates, type PipelineState } from "./state";

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};
export type ExecFn = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<ExecResult>;

export const GH_TIMEOUT_MS = 30_000;
export const GIT_TIMEOUT_MS = 10_000;

/** Production `ExecFn`: async spawn, SIGKILL on timeout, never rejects. */
export const defaultExec: ExecFn = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, {
      cwd,
      env: withoutGitLocalEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ exitCode: -1, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) =>
      done({ exitCode: -1, stdout, stderr: stderr || e.message }),
    );
    child.on("close", (code) => done({ exitCode: code ?? -1, stdout, stderr }));
  });

export type GithubPr = {
  number: number;
  headRefName: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt?: string;
  ci: "pass" | "fail" | "pending" | "none";
};
export type GithubSnapshot =
  | { ok: true; at: number; prs: GithubPr[] }
  | { ok: false; at: number; error: string };

const PR_FIELDS = `fragment PrFields on PullRequest { number headRefName state mergedAt commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;

/** One aliased request: first 100 open PRs, each watched PR number, each unbound feature branch. */
export function buildGithubQuery(input: {
  owner: string;
  name: string;
  watchedPrs: number[];
  branches: string[];
}): string {
  const lines = [
    `open: pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PrFields } }`,
  ];
  for (const n of new Set(input.watchedPrs)) {
    lines.push(`pr${n}: pullRequest(number: ${Math.trunc(n)}) { ...PrFields }`);
  }
  [...new Set(input.branches)].forEach((b, i) => {
    lines.push(
      `br${i}: pullRequests(headRefName: ${JSON.stringify(b)}, states: [OPEN, MERGED, CLOSED], first: 10) { nodes { ...PrFields } }`,
    );
  });
  const repo = `repository(owner: ${JSON.stringify(input.owner)}, name: ${JSON.stringify(input.name)})`;
  return `query { ${repo} { ${lines.join(" ")} } } ${PR_FIELDS}`;
}

const CI_BY_ROLLUP: Record<string, GithubPr["ci"]> = {
  SUCCESS: "pass",
  FAILURE: "fail",
  ERROR: "fail",
  PENDING: "pending",
  EXPECTED: "pending",
};

function toPr(v: unknown): GithubPr | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.number !== "number" || typeof o.headRefName !== "string") {
    return null;
  }
  if (o.state !== "OPEN" && o.state !== "MERGED" && o.state !== "CLOSED") {
    return null;
  }
  const rollup = (
    o.commits as {
      nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[];
    }
  )?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    number: o.number,
    headRefName: o.headRefName,
    state: o.state,
    ...(typeof o.mergedAt === "string" ? { mergedAt: o.mergedAt } : {}),
    ci: (rollup && CI_BY_ROLLUP[rollup]) || "none",
  };
}

/**
 * Parses `data` even when `gh` exited non-zero: one unresolvable watched PR
 * number yields GraphQL `errors` plus a `null` alias, not an unusable
 * snapshot. `null` only when `data.repository` is absent or the body is not JSON.
 */
export function parseGithubResponse(stdout: string): GithubPr[] | null {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  const repo = (body as { data?: { repository?: unknown } } | null)?.data
    ?.repository;
  if (typeof repo !== "object" || repo === null) return null;
  const byNumber = new Map<number, GithubPr>();
  for (const alias of Object.values(repo)) {
    const nodes =
      (alias as { nodes?: unknown[] } | null)?.nodes ??
      (alias === null ? [] : [alias]);
    for (const node of nodes) {
      const pr = toPr(node);
      if (pr) byNumber.set(pr.number, pr);
    }
  }
  return [...byNumber.values()];
}

export async function resolveGithubRepo(
  repo: string,
  exec: ExecFn,
): Promise<{ owner: string; name: string } | null> {
  const r = await exec(
    "gh",
    ["repo", "view", "--json", "owner,name"],
    repo,
    GH_TIMEOUT_MS,
  );
  if (r.exitCode !== 0 || r.timedOut) return null;
  try {
    const v = JSON.parse(r.stdout) as {
      owner?: { login?: string };
      name?: string;
    };
    return v.owner?.login && v.name
      ? { owner: v.owner.login, name: v.name }
      : null;
  } catch {
    return null;
  }
}

export async function fetchGithubSnapshot(input: {
  repo: string;
  owner: string;
  name: string;
  watchedPrs: number[];
  branches: string[];
  exec: ExecFn;
  now: () => number;
}): Promise<GithubSnapshot> {
  const r = await input.exec(
    "gh",
    ["api", "graphql", "-f", `query=${buildGithubQuery(input)}`],
    input.repo,
    GH_TIMEOUT_MS,
  );
  const at = input.now();
  if (r.timedOut) {
    return {
      ok: false,
      at,
      error: `gh timed out after ${GH_TIMEOUT_MS / 1000}s`,
    };
  }
  const prs = parseGithubResponse(r.stdout);
  if (prs) return { ok: true, at, prs };
  const firstLine = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
  return { ok: false, at, error: firstLine || `gh exited ${r.exitCode}` };
}

/** Pipeline states belonging to the epic's repository. */
export function listRepoStates(
  sameRepo: (repoPath: string) => boolean,
  stateDir?: string,
): PipelineState[] {
  return listStates(stateDir).filter((s) => sameRepo(s.repo));
}

/**
 * `makeSameRepository` fails OPEN when the caller's own git common dir cannot
 * be resolved (right for `flow ls` display). A duplicate/sibling guard must
 * not borrow another repo's pipelines on a transient git failure, so here an
 * unresolvable caller matches nothing.
 */
export function makeStrictSameRepository(
  cwd: string,
): (repoPath: string) => boolean {
  if (resolveGitCommonDir(cwd) === null) return () => false;
  return makeSameRepository(cwd);
}

export type GitRefs = {
  branches: Set<string>;
  worktreeBranches: Set<string>;
  worktreePaths: Set<string>;
  branchByWorktree: Map<string, string>;
};

/** Both the path as git prints it and its realpath, so a /tmp vs /private/tmp spelling still matches. */
function pathSpellings(p: string): string[] {
  try {
    const real = fs.realpathSync(p);
    return real === p ? [p] : [p, real];
  } catch {
    return [p];
  }
}

export function parseWorktreeList(
  porcelain: string,
): { path: string; branch?: string }[] {
  const out: { path: string; branch?: string }[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    let wt: { path: string; branch?: string } | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt = { path: line.slice(9) };
      else if (wt && line.startsWith("branch ")) {
        wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
      }
    }
    if (wt) out.push(wt);
  }
  return out;
}

export async function probeGitRefs(
  repo: string,
  exec: ExecFn,
): Promise<GitRefs | null> {
  const [refs, trees] = await Promise.all([
    exec(
      "git",
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
      repo,
      GIT_TIMEOUT_MS,
    ),
    exec("git", ["worktree", "list", "--porcelain"], repo, GIT_TIMEOUT_MS),
  ]);
  if (refs.exitCode !== 0 || trees.exitCode !== 0) return null;
  const out: GitRefs = {
    branches: new Set(),
    worktreeBranches: new Set(),
    worktreePaths: new Set(),
    branchByWorktree: new Map(),
  };
  for (const ref of refs.stdout.split("\n")) {
    const local = ref.match(/^refs\/heads\/(.+)$/);
    const remote = ref.match(/^refs\/remotes\/[^/]+\/(.+)$/);
    const name = local?.[1] ?? remote?.[1];
    if (name && name !== "HEAD") out.branches.add(name);
  }
  for (const wt of parseWorktreeList(trees.stdout)) {
    for (const p of pathSpellings(wt.path)) {
      out.worktreePaths.add(p);
      if (wt.branch) out.branchByWorktree.set(p, wt.branch);
    }
    if (wt.branch) out.worktreeBranches.add(wt.branch);
  }
  return out;
}
