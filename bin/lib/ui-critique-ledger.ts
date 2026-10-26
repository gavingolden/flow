/**
 * Capped cross-pipeline record of how the UI critique rounds went, behind the
 * demotion that stops the loop from fixing when its rounds keep being
 * reverted. One JSON line per finished loop in ~/.flow/logs/ui-critique.jsonl,
 * global across repos with `repo` recorded so a per-repo reader needs no
 * migration. Fail-open like `launch-log.ts`: an I/O failure never fails a run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LedgerOutcome =
  | "kept"
  | "reverted"
  | "clean"
  | "list-only"
  | "skipped";

export type LedgerLine = {
  at: string;
  repo: string;
  slug: string;
  outcome: LedgerOutcome;
  costUsd: number;
};

export const LEDGER_MAX_LINES = 200;
export const DEMOTE_AFTER_REVERTS = 3;
export const PROBATION_AFTER_LIST_ONLY = 5;

const OUTCOMES: readonly string[] = [
  "kept",
  "reverted",
  "clean",
  "list-only",
  "skipped",
];

export function ledgerPath(home: string = os.homedir()): string {
  return path.join(home, ".flow", "logs", "ui-critique.jsonl");
}

export function readLedger(raw: string | null): LedgerLine[] {
  if (raw === null) return [];
  const out: LedgerLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof o.at === "string" &&
        typeof o.repo === "string" &&
        typeof o.slug === "string" &&
        typeof o.outcome === "string" &&
        OUTCOMES.includes(o.outcome) &&
        typeof o.costUsd === "number"
      ) {
        out.push(o as unknown as LedgerLine);
      }
    } catch {
      // a torn or foreign line is skipped, never fatal
    }
  }
  return out;
}

export type LedgerDeps = {
  path?: string;
  readFile?: (p: string) => string | null;
  writeFile?: (p: string, content: string) => void;
  mkdirp?: (dir: string) => void;
};

/**
 * Read-trim-rewrite to hold the last LEDGER_MAX_LINES lines. This is an
 * unlocked read-modify-write: two pipelines finishing at once can lose a
 * line, which is acceptable for a fail-open advisory ledger.
 */
export function appendLedger(line: LedgerLine, deps: LedgerDeps = {}): void {
  const target = deps.path ?? ledgerPath();
  const readFile =
    deps.readFile ??
    ((p: string) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const writeFile =
    deps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c));
  const mkdirp =
    deps.mkdirp ?? ((d: string) => void fs.mkdirSync(d, { recursive: true }));
  try {
    const kept = readLedger(readFile(target)).slice(-(LEDGER_MAX_LINES - 1));
    mkdirp(path.dirname(target));
    writeFile(
      target,
      [...kept, line].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
  } catch {
    // advisory only
  }
}

/**
 * Demoted (list-only) when the last DEMOTE_AFTER_REVERTS kept/reverted
 * outcomes were all reverted and fewer than PROBATION_AFTER_LIST_ONLY
 * list-only outcomes have followed them. A `kept` resets the streak.
 */
export function decideDemotion(lines: LedgerLine[]): {
  demoted: boolean;
  reason: string;
} {
  const decided = lines
    .map((l, i) => ({ outcome: l.outcome, i }))
    .filter((d) => d.outcome === "kept" || d.outcome === "reverted");
  const last = decided.slice(-DEMOTE_AFTER_REVERTS);
  if (
    last.length < DEMOTE_AFTER_REVERTS ||
    !last.every((d) => d.outcome === "reverted")
  ) {
    return { demoted: false, reason: "" };
  }
  const listOnlyAfter = lines
    .slice(last[last.length - 1].i + 1)
    .filter((l) => l.outcome === "list-only").length;
  if (listOnlyAfter >= PROBATION_AFTER_LIST_ONLY) {
    return { demoted: false, reason: "" };
  }
  return {
    demoted: true,
    reason: `the last ${DEMOTE_AFTER_REVERTS} critique rounds were all reverted; listing findings only for ${PROBATION_AFTER_LIST_ONLY - listOnlyAfter} more run(s)`,
  };
}
