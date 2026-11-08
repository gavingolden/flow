/**
 * Plain-words text report for `flow reap --worktrees`, plus the one-phrase
 * explanation of each reason a folder was kept (shared with `flow doctor`).
 */

import { isFlowWorktreePath } from "./worktree-slot";
import type { HoldReason, HuskCause } from "./worktree-sweep-rules";
import type { SweepItem, SweepResult } from "./worktree-sweep-state";

export function holdReasonText(reason: HoldReason, detail?: string): string {
  switch (reason) {
    case "locked":
      return "is locked in git";
    case "flow-source":
      return "holds the copy of flow that is running right now";
    case "contains-launch-dir":
      return "is the folder this command was started from";
    case "no-branch":
      return "has no branch checked out";
    case "live-session":
      return `a pipeline session is still running in it${detail ? ` (${detail})` : ""}`;
    case "session-unknown":
      return `a pipeline may still be using it${detail ? ` (${detail})` : ""}`;
    case "in-use-process":
      return detail === "could not read running processes"
        ? "flow could not check what is running in it"
        : `a program is still running in it${detail ? ` (${detail})` : ""}`;
    case "in-use-container":
      return detail === "could not check Docker"
        ? "flow could not check whether a Docker container is using it"
        : `a Docker container is using it${detail ? ` (${detail})` : ""}`;
    case "gh-unreachable":
      return "GitHub could not be reached to check its pull request";
    case "no-pr":
      return "its branch has no pull request on GitHub";
    case "pr-open":
      return `PR ${detail ?? ""} is still open`.replace("  ", " ");
    case "uncommitted-changes":
      return "has changes that are not committed";
    case "local-config-differs":
      return "has a local .env or settings file that differs from the main checkout";
    case "head-not-on-github":
      return "has commits that are not on GitHub";
    case "deadline-reached":
      return "the sweep ran out of time; it will be retried";
    case "registered-worktree":
      return "is still registered with git";
    case "reserved-by-pipeline":
      return "is reserved by a pipeline that may still be running";
    case "too-recent":
      return "was created less than an hour ago";
    case "too-large-to-scan":
      return "has too many files to check safely";
    case "unrecognized-contents":
      return `holds files flow does not recognize${detail ? ` (${detail})` : ""}`;
  }
}

const CAUSE_TEXT: Record<HuskCause, string> = {
  "unused-launch-folder":
    "an empty folder reserved by a launch that never filled it",
  "supabase-container-mounts":
    "an empty Supabase folder that a Docker container re-creates",
  "dev-server-cache": "only dev-server cache files",
  "ide-project-files": "IDE project files",
  "mixed-caches": "only cache folders",
};

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

function keepReason(i: SweepItem): string {
  return holdReasonText(i.reason as HoldReason, i.detail);
}

function mainCheckoutFor(
  result: SweepResult,
  source: string,
): string | undefined {
  return [...new Set(result.items.map((i) => i.repo))].find((repo) =>
    isFlowWorktreePath(repo, source),
  );
}

function summary(result: SweepResult): string {
  const wts = result.items.filter(
    (i) =>
      i.kind === "worktree" &&
      (i.outcome === "removed" || i.outcome === "would-remove"),
  );
  const husks = result.items.filter(
    (i) =>
      i.kind === "husk" &&
      (i.outcome === "removed" || i.outcome === "would-remove"),
  );
  const kept = result.items.filter((i) => i.outcome === "held").length;
  const verb = result.acted ? "removed" : "would remove";
  const bytes = wts.reduce((n, i) => n + (i.bytes ?? 0), 0);
  const parts: string[] = [];
  if (wts.length > 0)
    parts.push(
      `${plural(wts.length, "folder", "folders")} (${formatBytes(bytes)})`,
    );
  if (husks.length > 0)
    parts.push(
      `${plural(husks.length, "leftover folder", "leftover folders")}`,
    );
  const head =
    parts.length > 0 ? `${verb} ${parts.join(" and ")}` : "nothing to remove";
  return `Summary: ${head}${kept > 0 ? `; kept ${kept} for safety` : ""}`;
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0
    ? []
    : ["", `${title}:`, ...lines.map((l) => `  ${l}`)];
}

export function renderWorktreeSweepText(result: SweepResult): string {
  if (result.skipped === "disabled") {
    return "Automatic cleanup is turned off (cleanup.worktrees is false). Run `flow reap --worktrees` to preview a manual cleanup.";
  }
  if (result.skipped === "throttled")
    return "Skipped: a cleanup ran less than an hour ago.";
  if (result.skipped === "locked")
    return "Skipped: another cleanup is already running.";

  const done = (i: SweepItem) =>
    i.outcome === "removed" || i.outcome === "would-remove";
  const lines = [summary(result)];
  lines.push(
    ...section(
      result.acted ? "Removed folders" : "Folders to remove",
      result.items
        .filter((i) => i.kind === "worktree" && done(i))
        .map(
          (i) =>
            `${i.path} — PR #${i.pr} ${i.reason === "pr-merged" ? "merged" : "closed"} (${formatBytes(i.bytes ?? 0)})`,
        ),
    ),
  );
  lines.push(
    ...section(
      result.acted ? "Removed leftover folders" : "Leftover folders to remove",
      result.items
        .filter((i) => i.kind === "husk" && done(i))
        .map((i) => `${i.path} — ${CAUSE_TEXT[i.cause ?? "mixed-caches"]}`),
    ),
  );
  lines.push(
    ...section(
      "Could not remove",
      result.items
        .filter((i) => i.outcome === "failed")
        .map((i) => `${i.path} — ${i.detail ?? "unknown error"}`),
    ),
  );
  lines.push(
    ...section(
      "Kept for safety",
      result.items
        .filter((i) => i.outcome === "held")
        .map((i) => `${i.path} — ${keepReason(i)}`),
    ),
  );
  lines.push(
    ...section(
      "Containers that will re-create a deleted folder",
      result.danglingMounts.flatMap((m) => {
        const repo = mainCheckoutFor(result, m.source);
        return [
          `${m.container} mounts ${m.source}`,
          `  fix: run \`supabase stop\` then \`supabase start\`${repo ? ` from ${repo}` : " from your main checkout"}`,
        ];
      }),
    ),
  );
  const notes = [
    result.dockerSkipped
      ? `Docker was not checked (${result.dockerSkipped.replace("docker-", "").replace("-", " ")})${result.dockerSkipped === "docker-unresponsive" ? ", so folders were kept" : ""}.`
      : "",
    result.processesSkipped
      ? "Running programs could not be checked, so folders were kept."
      : "",
    result.ghUnreachable
      ? "GitHub could not be reached; affected folders were kept and will be retried."
      : "",
    result.deadlineHit
      ? "The sweep ran out of time; the rest will be retried."
      : "",
  ].filter(Boolean);
  lines.push(...section("Notes", notes));
  if (!result.acted) {
    lines.push(
      "",
      "Preview only — nothing was removed. Add `--yes` to remove these.",
    );
  }
  return lines.join("\n");
}
