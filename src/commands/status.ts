import type { Writable } from "node:stream";
import pc from "picocolors";
import { findGitRoot, findTaskFile } from "../util/git.js";
import { readTask } from "../state/task-file.js";
import {
  buildRowForId,
  buildStatusRows,
  type StatusRow,
} from "../status/rows.js";
import {
  renderStatusDetail,
  renderStatusTable,
} from "../status/render.js";

export interface StatusOptions {
  all?: boolean;
  json?: boolean;
}

export interface StatusIo {
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
}

export async function statusCommand(
  taskId: string | undefined,
  opts: StatusOptions = {},
  io: StatusIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  const repoRoot = await findGitRoot(io.cwd);
  if (!repoRoot) {
    stderr.write(
      `${pc.red("error: flow status must be executed inside a git repository")}\n`,
    );
    return 1;
  }

  const colorEnabled = stdoutColorEnabled(stdout);

  if (taskId) {
    const filePath = await findTaskFile(taskId, repoRoot);
    if (!filePath) {
      stderr.write(`${pc.red(`error: task '${taskId}' not found`)}\n`);
      return 1;
    }
    const row = await buildRowForId(repoRoot, filePath);
    if (opts.json) {
      stdout.write(`${JSON.stringify({ tasks: [serializeRow(row)] }, null, 2)}\n`);
      return 0;
    }
    const task = await readTask(filePath);
    stdout.write(
      renderStatusDetail(row, task.body, { color: colorEnabled }),
    );
    return 0;
  }

  const rows = await buildStatusRows(repoRoot, {
    includeArchived: opts.all === true,
  });
  if (opts.json) {
    stdout.write(
      `${JSON.stringify({ tasks: rows.map(serializeRow) }, null, 2)}\n`,
    );
    return 0;
  }
  stdout.write(renderStatusTable(rows, { color: colorEnabled }));
  return 0;
}

// JSON shape lifted from the PRD. Stable, documented contract — consumers
// rely on it so adding fields is fine but renaming is a breaking change.
function serializeRow(row: StatusRow): Record<string, unknown> {
  return {
    id: row.id,
    path: row.path,
    archived: row.archived,
    status: row.status,
    phase: row.phase,
    pr: row.pr,
    branch: row.branch,
    worktree: row.worktree,
    created: row.created,
    updated: row.updated,
    cost_total_usd: roundUsd(row.cost_total_usd),
    cost_partial: row.cost_partial,
    phases: row.phases.map((p) => ({
      name: p.name,
      attempts: p.attempts,
      cost_usd: roundUsd(p.usd),
      cost_partial: p.partial,
    })),
  };
}

function roundUsd(v: number): number {
  // Round to 4 decimals so JSON output isn't littered with float-noise
  // tails like 2.8905407500000004 from the underlying CLI numbers.
  return Math.round(v * 10000) / 10000;
}

function stdoutColorEnabled(stdout: Writable): boolean {
  // Honour NO_COLOR universally, then defer to the actual stream's
  // TTY-ness (process.stdout has `isTTY`; injected sinks won't).
  if (process.env["NO_COLOR"]) return false;
  const isTty = (stdout as { isTTY?: boolean }).isTTY === true;
  return isTty && pc.isColorSupported;
}
