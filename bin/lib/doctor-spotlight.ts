/**
 * `flow doctor` row: is Spotlight indexing flow's worktree folder? New
 * worktrees live in `<repo-parent>/flow-worktrees.noindex/`, a name macOS
 * normally skips; this catches a release that stops honouring that. It also
 * counts older worktrees still beside the main checkouts (from the last
 * sweep), which stay indexed until cleaned up. Makes no git call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DoctorCheck, DoctorDeps } from "./doctor";
import { listStates, type PipelineState } from "./state";
import { plural } from "./worktree-sweep-render";
import { readLastSweep, type SweepResult } from "./worktree-sweep-state";
import { worktreeContainerDir } from "./worktree-slot";

export const WORKTREE_INDEXING_META = {
  id: "leftovers-worktree-indexing",
  section: "leftovers",
  title: "Worktree search indexing",
} as const;

// `kMDItemFSName == "*"` reports 0 even for indexed folders on current macOS.
const QUERY = 'kMDItemContentTypeTree == "public.item"';

type Count = { container: string; count: number } | { error: string };

function countIndexed(container: string, deps: DoctorDeps): Count {
  const r = deps.run("mdfind", ["-count", "-onlyin", container, QUERY], {
    timeoutMs: 5000,
  });
  if (r.notFound) return { error: "mdfind is not installed" };
  if (r.timedOut) return { error: "mdfind timed out" };
  if (r.status !== 0) return { error: `mdfind exited ${r.status}` };
  const count = Number.parseInt(r.stdout.trim(), 10);
  if (!Number.isFinite(count))
    return { error: "mdfind printed an unreadable count" };
  return { container, count };
}

function underContainer(repo: string, p: string): boolean {
  const rel = path.relative(worktreeContainerDir(repo), p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function checkWorktreeIndexing(
  deps: DoctorDeps,
  io: {
    listStates?: () => PipelineState[];
    lastSweep?: () => SweepResult | null;
  } = {},
): DoctorCheck[] {
  const done = (
    status: DoctorCheck["status"],
    summary: string,
    details: string[] = [],
    fix?: string,
  ): DoctorCheck[] => [
    {
      ...WORKTREE_INDEXING_META,
      status,
      summary,
      details,
      ...(fix && { fix }),
    },
  ];
  if ((deps.platform ?? process.platform) !== "darwin") {
    return done("pass", "not macOS — nothing to check");
  }

  const last = (io.lastSweep ?? (() => readLastSweep(deps.stateDir)))();
  const states = (io.listStates ?? (() => listStates(deps.stateDir)))();
  const repos = [
    ...new Set([
      ...states.map((s) => s.repo),
      ...(last?.items ?? []).map((i) => i.repo),
    ]),
  ].filter((r): r is string => Boolean(r));
  const containers = [
    ...new Set(repos.map(worktreeContainerDir).filter((c) => fs.existsSync(c))),
  ];

  const older = (last?.items ?? []).filter(
    (i) =>
      i.kind === "worktree" &&
      i.outcome !== "removed" &&
      !underContainer(i.repo, i.path),
  ).length;
  const olderNote =
    older > 0
      ? [
          `${plural(older, "older worktree", "older worktrees")} beside your checkouts ${older === 1 ? "is" : "are"} still indexed until cleaned up`,
        ]
      : [];

  const counts = containers.map((c) => countIndexed(c, deps));
  const failed = counts.find((c): c is { error: string } => "error" in c);
  const indexed = counts.filter(
    (c): c is { container: string; count: number } =>
      "count" in c && c.count > 0,
  );
  if (failed) {
    return done(
      "warn",
      `could not check Spotlight: ${failed.error}`,
      olderNote,
    );
  }
  if (indexed.length > 0) {
    const where = indexed.map((c) => `${c.count} files in ${c.container}`);
    return done(
      "warn",
      `Spotlight is indexing ${where.join(", ")}`,
      olderNote,
      `add ${indexed[0].container} to System Settings → Spotlight → Search Privacy`,
    );
  }
  const summary =
    containers.length === 0
      ? "no worktree folder yet"
      : `Spotlight reports 0 indexed files in ${containers.join(", ")}`;
  return done(
    "pass",
    summary,
    olderNote,
    older > 0 ? "flow reap --worktrees" : undefined,
  );
}
