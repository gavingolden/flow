/**
 * Writes ONE row — the pipeline's own — onto the committed epic status board
 * from the pipeline's feature branch. Every other row is carried through
 * byte-identically, so two sibling epic PRs that each flip a different row
 * merge cleanly (`serializeEpicStatus` sorts keys; adjacent-row edits do not
 * conflict). The whole-board derive in `flow-epic-sync` stays base-branch
 * only: it re-queries GitHub for sibling rows and would commit them from the
 * branch's point-in-time view.
 *
 * Never writes on the base branch, never forces a push, never commits in
 * conflict mode. The one-way latch is `advanceStatus` — this module adds no
 * downgrade path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveEpicBinding } from "./epic-binding";
import {
  commitEpicStatus,
  currentBranch,
  epicStatusRelPath,
  resolveDefaultBranch,
} from "./epic-metadata-commit";
import {
  EPIC_MANIFEST_FILENAME,
  epicDirRelative,
  validateEpicManifest,
  type EpicManifest,
} from "./epic-manifest-schema";
import {
  advanceStatus,
  serializeEpicStatus,
  validateEpicStatus,
  type CommittedFeatureRow,
  type EpicStatusFile,
} from "./epic-status-schema";
import { resolveRepoRoot } from "./repo-root";
import {
  defaultGh,
  defaultGit,
  type GhRunner,
  type GitRunner,
} from "./resume-probes";

export type SelfMarkRefusal =
  | "binding-conflict"
  | "on-base-branch"
  | "detached-head"
  | "no-pr"
  | "pr-not-merged"
  | "unknown-feature"
  | "manifest-unreadable"
  | "board-unreadable"
  | "epic-id-mismatch"
  | "not-conflicted"
  | "commit-failed"
  | "push-failed";

export type SelfMarkResult = {
  outcome: "not-bound" | "unchanged" | "written" | "refused";
  reason?: SelfMarkRefusal;
  detail?: string;
  epicSlug?: string;
  featureId?: string;
  pr?: number;
  committed: boolean;
  pushed: boolean;
};

const PUSH_TIMEOUT_MS = 120_000;

export function applySelfRow(
  existing: EpicStatusFile | null,
  epicId: string,
  featureId: string,
  pr: number,
  manifestFeatureIds: string[] = [],
): { file: EpicStatusFile; changed: boolean } {
  const base: EpicStatusFile = existing ?? {
    version: 1,
    epicId,
    features: Object.fromEntries(
      manifestFeatureIds.map((id) => [id, { status: "not-started" as const }]),
    ),
  };
  const prev = base.features[featureId];
  const next = advanceStatus(prev, { status: "merged", pr });
  const changed =
    existing === null ||
    prev === undefined ||
    prev.status !== next.status ||
    prev.pr !== next.pr;
  return {
    file: { ...base, features: { ...base.features, [featureId]: next } },
    changed,
  };
}

function refuse(
  reason: SelfMarkRefusal,
  detail: string,
  rest: Partial<SelfMarkResult> = {},
): SelfMarkResult {
  return {
    outcome: "refused",
    reason,
    detail,
    committed: false,
    pushed: false,
    ...rest,
  };
}

const pushGit: GitRunner = (argv, cwd) => {
  const r = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    timeout: PUSH_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").slice(0, 200);
}

function loadManifest(
  repoRoot: string,
  epicSlug: string,
): EpicManifest | string {
  const file = path.join(
    repoRoot,
    epicDirRelative(epicSlug),
    EPIC_MANIFEST_FILENAME,
  );
  try {
    const shape = validateEpicManifest(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    return shape.ok ? shape.value : `${file}: ${shape.reason}`;
  } catch (err) {
    return `${file}: ${firstLine(String(err))}`;
  }
}

function parseBoard(raw: string): EpicStatusFile | string {
  try {
    const shape = validateEpicStatus(JSON.parse(raw));
    return shape.ok ? shape.value : shape.reason;
  } catch (err) {
    return firstLine(String(err));
  }
}

type Guarded = { repoRoot: string; branch: string } | SelfMarkResult;

function guardBranch(cwd: string, git: GitRunner): Guarded {
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) {
    return refuse(
      "manifest-unreadable",
      `${cwd} is not inside a git repository`,
    );
  }
  const branch = currentBranch(repoRoot, git);
  if (!branch) {
    return refuse(
      "detached-head",
      "HEAD is detached; check out the pipeline branch",
    );
  }
  if (branch === resolveDefaultBranch(repoRoot, git)) {
    return refuse(
      "on-base-branch",
      `${branch} is the base branch; the board row is written from the feature branch`,
    );
  }
  return { repoRoot, branch };
}

function verifyPr(
  gh: GhRunner,
  pr: number,
  branch: string,
): SelfMarkResult | null {
  const r = gh(["pr", "view", String(pr), "--json", "state,headRefName"]);
  if (r.exitCode !== 0) {
    return refuse(
      "pr-not-merged",
      `gh pr view ${pr} failed: ${firstLine(r.stderr)}`,
    );
  }
  try {
    const v = JSON.parse(r.stdout) as { state?: string; headRefName?: string };
    if (v.state === "MERGED") return null;
    if (v.state === "OPEN" && v.headRefName === branch) return null;
    return refuse(
      "pr-not-merged",
      `PR #${pr} is ${v.state ?? "unknown"} on ${v.headRefName ?? "?"}; need MERGED or this branch's own open PR`,
    );
  } catch {
    return refuse(
      "pr-not-merged",
      `gh pr view ${pr} returned unparseable output`,
    );
  }
}

function pushHead(
  repoRoot: string,
  git: GitRunner,
): { ok: boolean; upToDate: boolean; detail: string } {
  const r = git(["push", "origin", "HEAD"], repoRoot);
  return {
    ok: r.exitCode === 0,
    upToDate: /up-to-date/i.test(r.stderr + r.stdout),
    detail: firstLine(r.stderr || r.stdout),
  };
}

function resolveConflictRow(
  repoRoot: string,
  rel: string,
  git: GitRunner,
  apply: (base: EpicStatusFile) => EpicStatusFile | SelfMarkResult,
): SelfMarkResult | null {
  const unmerged = git(["ls-files", "-u", "--", rel], repoRoot);
  if (unmerged.exitCode !== 0 || !unmerged.stdout.trim()) {
    return refuse("not-conflicted", `${rel} has no merge conflict to resolve`);
  }
  const theirs = git(["show", `:3:${rel}`], repoRoot);
  if (theirs.exitCode !== 0) {
    return refuse(
      "board-unreadable",
      `no incoming side of ${rel}: ${firstLine(theirs.stderr)}`,
    );
  }
  const base = parseBoard(theirs.stdout);
  if (typeof base === "string")
    return refuse("board-unreadable", `incoming ${rel}: ${base}`);
  const next = apply(base);
  if ("outcome" in next) return next;
  fs.writeFileSync(path.join(repoRoot, rel), serializeEpicStatus(next));
  const added = git(["add", "--", rel], repoRoot);
  if (added.exitCode !== 0) {
    return refuse(
      "board-unreadable",
      `git add ${rel} failed: ${firstLine(added.stderr)}`,
    );
  }
  return null;
}

export function selfMarkEpicRow(opts: {
  cwd: string;
  slug?: string;
  explicit?: { epicSlug: string; featureId: string; pr: number };
  pr?: number;
  commit?: boolean;
  push?: boolean;
  resolveConflict?: boolean;
  gh?: GhRunner;
  git?: GitRunner;
  stateDir?: string;
  epicsDir?: string;
}): SelfMarkResult {
  const git = opts.git ?? defaultGit;
  let epicSlug: string;
  let featureId: string;
  if (opts.explicit) {
    ({ epicSlug, featureId } = opts.explicit);
  } else {
    if (!opts.slug) {
      return { outcome: "not-bound", committed: false, pushed: false };
    }
    const binding = resolveEpicBinding({
      slug: opts.slug,
      stateDir: opts.stateDir,
      epicsDir: opts.epicsDir,
    });
    if (binding.kind === "none") {
      return { outcome: "not-bound", committed: false, pushed: false };
    }
    if (binding.kind === "conflict") {
      return refuse("binding-conflict", binding.detail);
    }
    ({ epicSlug, featureId } = binding);
  }
  const who = { epicSlug, featureId };

  const guarded = guardBranch(opts.cwd, git);
  if ("outcome" in guarded) return { ...guarded, ...who };
  const { repoRoot, branch } = guarded;

  const pr = opts.explicit?.pr ?? opts.pr;
  if (pr === undefined) {
    return refuse("no-pr", "no PR number: pass --pr or open the PR first", who);
  }
  if (opts.explicit) {
    const bad = verifyPr(opts.gh ?? defaultGh, pr, branch);
    if (bad) return { ...bad, ...who, pr };
  }
  const withIds = { ...who, pr };

  const manifest = loadManifest(repoRoot, epicSlug);
  if (typeof manifest === "string") {
    return refuse("manifest-unreadable", manifest, withIds);
  }
  const ids = manifest.features.map((f) => f.id);
  if (!ids.includes(featureId)) {
    return refuse(
      "unknown-feature",
      `${featureId} is not a feature of ${epicSlug} (${ids.join(", ")})`,
      withIds,
    );
  }

  const rel = epicStatusRelPath(epicSlug);
  const boardPath = path.join(repoRoot, rel);
  const fail = (r: SelfMarkResult) => ({ ...r, ...withIds });

  if (opts.resolveConflict) {
    const bad = resolveConflictRow(repoRoot, rel, git, (base) =>
      base.epicId !== manifest.epicId
        ? refuse(
            "epic-id-mismatch",
            `${rel} epicId ${base.epicId} != manifest ${manifest.epicId}`,
          )
        : applySelfRow(base, manifest.epicId, featureId, pr, ids).file,
    );
    if (bad) return fail(bad);
    return { outcome: "written", ...withIds, committed: false, pushed: false };
  }

  let existing: EpicStatusFile | null = null;
  if (fs.existsSync(boardPath)) {
    const parsed = parseBoard(fs.readFileSync(boardPath, "utf8"));
    if (typeof parsed === "string") {
      return refuse("board-unreadable", `${rel}: ${parsed}`, withIds);
    }
    existing = parsed;
  }
  if (existing && existing.epicId !== manifest.epicId) {
    return refuse(
      "epic-id-mismatch",
      `${rel} epicId ${existing.epicId} != manifest ${manifest.epicId}`,
      withIds,
    );
  }

  const { file, changed } = applySelfRow(
    existing,
    manifest.epicId,
    featureId,
    pr,
    ids,
  );
  if (changed) {
    fs.mkdirSync(path.dirname(boardPath), { recursive: true });
    fs.writeFileSync(boardPath, serializeEpicStatus(file));
  }

  const wantCommit = opts.commit === true || opts.push === true;
  let committed = false;
  if (wantCommit) {
    const c = commitEpicStatus({
      writtenPath: boardPath,
      epicSlug,
      message: `chore(epic): mark ${featureId} merged on the ${epicSlug} board (#${pr})`,
      cwd: opts.cwd,
      git,
    });
    committed = c.committed;
    if (!c.committed && c.reason !== "nothing-staged") {
      return refuse(
        "commit-failed",
        `${c.reason ?? "git-error"}${c.detail ? `: ${c.detail}` : ""}`,
        withIds,
      );
    }
  }

  let pushed = false;
  let pushedNew = false;
  if (opts.push) {
    const p = pushHead(repoRoot, opts.git ?? pushGit);
    if (!p.ok) {
      return refuse("push-failed", p.detail, { ...withIds, committed });
    }
    pushed = true;
    pushedNew = !p.upToDate;
  }

  return {
    outcome: changed || committed || pushedNew ? "written" : "unchanged",
    ...withIds,
    committed,
    pushed,
  };
}

export function seedEpicBoard(opts: {
  cwd: string;
  epicSlug: string;
  git?: GitRunner;
}): SelfMarkResult {
  const git = opts.git ?? defaultGit;
  const guarded = guardBranch(opts.cwd, git);
  if ("outcome" in guarded) return { ...guarded, epicSlug: opts.epicSlug };
  const { repoRoot } = guarded;
  const who = { epicSlug: opts.epicSlug };

  const manifest = loadManifest(repoRoot, opts.epicSlug);
  if (typeof manifest === "string") {
    return refuse("manifest-unreadable", manifest, who);
  }
  const rel = epicStatusRelPath(opts.epicSlug);
  const boardPath = path.join(repoRoot, rel);
  if (fs.existsSync(boardPath)) {
    const parsed = parseBoard(fs.readFileSync(boardPath, "utf8"));
    if (typeof parsed === "string") {
      return refuse("board-unreadable", `${rel}: ${parsed}`, who);
    }
    return { outcome: "unchanged", ...who, committed: false, pushed: false };
  }
  const features: Record<string, CommittedFeatureRow> = Object.fromEntries(
    manifest.features.map((f) => [f.id, { status: "not-started" as const }]),
  );
  fs.mkdirSync(path.dirname(boardPath), { recursive: true });
  fs.writeFileSync(
    boardPath,
    serializeEpicStatus({ version: 1, epicId: manifest.epicId, features }),
  );
  return { outcome: "written", ...who, committed: false, pushed: false };
}
