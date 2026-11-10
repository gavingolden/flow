/**
 * Parse a Claude Code "safeguards stopped this agent" failure, validate the
 * retry record the wrapper appends, and render the PR-body note.
 */

export type SafeguardsStop =
  | { stopped: true; model: string | null; requestId: string | null }
  | { stopped: false };

const ANCHORS = [
  /safeguards flagged this message/i,
  /Safeguards stopped this agent/i,
  /automatic model switching is off/i,
];

export function parseSafeguardsStop(text: string): SafeguardsStop {
  if (!ANCHORS.some((a) => a.test(text))) return { stopped: false };
  return {
    stopped: true,
    model: /API Error: (.+?)'s safeguards flagged/.exec(text)?.[1] ?? null,
    requestId: /Request ID: (req_[A-Za-z0-9]+)/.exec(text)?.[1] ?? null,
  };
}

export type RetryRecord = {
  site: "coder" | `lens:${string}`;
  firstRequestId: string | null;
  retryRequestId: string | null;
  model: string | null;
  shape: "stripped" | "collapsed" | "delegated" | "none";
  paddedFiles: string[];
  droppedGuidance: string[];
  outcome: "recovered" | "stopped-again" | "skipped" | "proactive-collapse";
  at: string;
};

const SHAPES = ["stripped", "collapsed", "delegated", "none"];
const OUTCOMES = [
  "recovered",
  "stopped-again",
  "skipped",
  "proactive-collapse",
];

const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");
const isStrOrNull = (v: unknown): boolean =>
  v === null || typeof v === "string";

export function validateRetryRecord(
  x: unknown,
): { ok: true; record: RetryRecord } | { ok: false; error: string } {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    return { ok: false, error: "record must be an object" };
  }
  const r = x as Record<string, unknown>;
  const site = r.site;
  if (
    typeof site !== "string" ||
    !(site === "coder" || (site.startsWith("lens:") && site.length > 5))
  ) {
    return { ok: false, error: 'site must be "coder" or "lens:<name>"' };
  }
  for (const k of ["firstRequestId", "retryRequestId", "model"]) {
    if (!isStrOrNull(r[k]))
      return { ok: false, error: `${k} must be string|null` };
  }
  if (typeof r.shape !== "string" || !SHAPES.includes(r.shape)) {
    return { ok: false, error: `shape must be one of ${SHAPES.join(", ")}` };
  }
  if (typeof r.outcome !== "string" || !OUTCOMES.includes(r.outcome)) {
    return {
      ok: false,
      error: `outcome must be one of ${OUTCOMES.join(", ")}`,
    };
  }
  for (const k of ["paddedFiles", "droppedGuidance"]) {
    if (!isStrArray(r[k])) return { ok: false, error: `${k} must be string[]` };
  }
  if (typeof r.at !== "string" || r.at === "") {
    return { ok: false, error: "at must be a non-empty string" };
  }
  return { ok: true, record: r as unknown as RetryRecord };
}

export function parseRetryLog(jsonl: string): RetryRecord[] {
  const records: RetryRecord[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = validateRetryRecord(JSON.parse(line));
      if (v.ok) records.push(v.record);
    } catch {
      // invalid line: skipped by contract
    }
  }
  return records;
}

const OUTCOME_TEXT: Record<RetryRecord["outcome"], string> = {
  recovered: "recovered on one automatic retry",
  "stopped-again": "stopped again — escalated",
  skipped: "skipped — see the DECISION item",
  "proactive-collapse": "padded input collapsed before the run",
};

function agentName(site: RetryRecord["site"]): string {
  return site === "coder"
    ? "The code-edit agent"
    : `The ${site.slice("lens:".length)} review lens`;
}

function bullet(r: RetryRecord): string {
  const ids = [r.firstRequestId, r.retryRequestId].filter(
    (s): s is string => s !== null,
  );
  let line = `- ${agentName(r.site)}: ${OUTCOME_TEXT[r.outcome]}`;
  if (ids.length > 0) line += ` (request ${ids.join(", ")})`;
  if (r.droppedGuidance.length > 0) {
    line += `; dropped guidance: ${r.droppedGuidance.join(", ")}`;
  }
  if (r.paddedFiles.length > 0) {
    line += `; padded files: ${r.paddedFiles.join(", ")}`;
  }
  return line;
}

export function renderSafeguardsNote(records: RetryRecord[]): string {
  const seen = new Set<string>();
  const unique = records.filter((r) => {
    const key = JSON.stringify(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return "";
  const lines = ["[!NOTE]", "**Safeguards stops in this run**", ""];
  lines.push(...unique.map(bullet));
  const padded = [...new Set(unique.flatMap((r) => r.paddedFiles))];
  if (padded.length > 0) {
    lines.push(
      "",
      "Fix the source once: run `flow-safeguards compact --in-place <file>` in that repository and commit.",
    );
  }
  return lines.map((l) => (l === "" ? ">" : `> ${l}`)).join("\n");
}
