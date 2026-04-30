import pc from "picocolors";
import type { StatusRow } from "./rows.js";

export interface RenderOptions {
  // Force-disable colour. When undefined, defer to picocolors'
  // built-in `isColorSupported` (honours NO_COLOR / non-TTY).
  color?: boolean;
  // Test injection — pin "now" so relative-age strings are deterministic.
  now?: () => Date;
}

const ALERT_STATUSES: ReadonlySet<string> = new Set([
  "needs-human",
  "gated",
  "aborted",
]);

const HEADERS = ["ID", "STATUS", "PHASE", "PR", "UPDATED", "COST"] as const;

export function renderStatusTable(
  rows: StatusRow[],
  opts: RenderOptions = {},
): string {
  if (rows.length === 0) return "no tasks found\n";

  const colorize = pickColorFn(opts);
  const now = (opts.now ?? (() => new Date()))();

  const data = rows.map((r) => [
    r.id,
    r.status,
    r.phase,
    r.pr === null ? "-" : `#${r.pr}`,
    relativeAge(r.updated, now),
    formatUsd(r.cost_total_usd),
  ]);

  // Pad against raw text widths so colour-applied cells (which carry ANSI
  // escapes that don't take screen columns) still align with the rest.
  const widths = HEADERS.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  );

  const lines: string[] = [];
  lines.push(formatRow(HEADERS as readonly string[], widths, []));
  for (const row of data) {
    const status = row[1]!;
    const preformatted: Array<string | undefined> = [];
    if (ALERT_STATUSES.has(status)) {
      preformatted[1] = padRightVisible(
        colorize(status, statusTone(status)),
        status,
        widths[1]!,
      );
    }
    lines.push(formatRow(row, widths, preformatted));
  }
  return `${lines.join("\n")}\n`;
}

export function renderStatusDetail(
  row: StatusRow,
  taskBody: string,
  opts: RenderOptions = {},
): string {
  const colorize = pickColorFn(opts);
  const dim = pickDimFn(opts);
  const out: string[] = [];
  out.push(`# ${row.id}`);
  if (row.archived) out.push(dim("(archived)"));
  out.push("");
  const statusLabel = ALERT_STATUSES.has(row.status)
    ? colorize(row.status, statusTone(row.status))
    : row.status;
  out.push(`status:    ${statusLabel}`);
  out.push(`phase:     ${row.phase}`);
  out.push(`pr:        ${row.pr === null ? "-" : `#${row.pr}`}`);
  out.push(`branch:    ${row.branch ?? "-"}`);
  out.push(`worktree:  ${row.worktree ?? "-"}`);
  out.push(`created:   ${row.created}`);
  out.push(`updated:   ${row.updated}`);
  out.push("");

  const phaseLog = extractPhaseLog(taskBody);
  out.push("## Phase log");
  out.push("");
  out.push(phaseLog || "(no phase log)");
  out.push("");

  out.push("## Cost");
  out.push("");
  if (row.phases.length === 0) {
    out.push("(no logs yet)");
  } else {
    const labelWidth = Math.max(...row.phases.map((p) => p.name.length)) + 1;
    for (const p of row.phases) {
      const label = `${p.name}:`.padEnd(labelWidth);
      const annotations: string[] = [];
      if (p.attempts > 1) annotations.push(`${p.attempts} attempts`);
      if (p.partial) annotations.push("partial");
      const suffix = annotations.length ? ` (${annotations.join(", ")})` : "";
      out.push(`${label} ${formatUsd(p.usd)}${suffix}`);
    }
    const totalLabel = "total:".padEnd(labelWidth);
    out.push(`${totalLabel} ${formatUsd(row.cost_total_usd)}`);
  }
  out.push("");
  return `${out.join("\n")}`;
}

function pickColorFn(opts: RenderOptions): (s: string, tone: "red" | "yellow") => string {
  const enabled = opts.color === undefined ? pc.isColorSupported : opts.color;
  if (!enabled) return (s) => s;
  // `pc.createColors(true)` bypasses picocolors' env detection (TTY,
  // NO_COLOR) — needed when the caller has already decided colour is
  // wanted (e.g. an explicit --color flag, or a test that pins colour).
  const colors = pc.createColors(true);
  return (s, tone) => (tone === "red" ? colors.red(s) : colors.yellow(s));
}

// Mirror of pickColorFn for the `dim` style used by `(archived)`. Routing
// through the same opts.color decision keeps a caller passing `color: false`
// from receiving ANSI escapes via `pc.dim` (which honours picocolors' own
// env detection but ignores our explicit override).
function pickDimFn(opts: RenderOptions): (s: string) => string {
  const enabled = opts.color === undefined ? pc.isColorSupported : opts.color;
  if (!enabled) return (s) => s;
  const colors = pc.createColors(true);
  return (s) => colors.dim(s);
}

function statusTone(status: string): "red" | "yellow" {
  // `aborted` and `needs-human` are blocking; `gated` is "waiting on
  // human review" — yellow so the eye distinguishes "you must look" from
  // "this is wedged."
  if (status === "gated") return "yellow";
  return "red";
}

function formatRow(
  cells: readonly string[],
  widths: number[],
  preformatted: Array<string | undefined>,
): string {
  return cells
    .map((c, i) => {
      if (preformatted[i] !== undefined) return preformatted[i]!;
      // Trailing column doesn't need padding.
      if (i === cells.length - 1) return c;
      return c.padEnd(widths[i]!);
    })
    .join("  ");
}

function padRightVisible(coloured: string, raw: string, width: number): string {
  const pad = width - raw.length;
  return pad > 0 ? coloured + " ".repeat(pad) : coloured;
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

const AGE_UNITS = [
  { ms: 7 * 24 * 60 * 60 * 1000, suffix: "w" },
  { ms: 24 * 60 * 60 * 1000, suffix: "d" },
  { ms: 60 * 60 * 1000, suffix: "h" },
  { ms: 60 * 1000, suffix: "m" },
  { ms: 1000, suffix: "s" },
] as const;

function relativeAge(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const delta = Math.max(0, now.getTime() - t);
  for (const u of AGE_UNITS) {
    if (delta >= u.ms) {
      return `${Math.floor(delta / u.ms)}${u.suffix}`;
    }
  }
  return "0s";
}

function extractPhaseLog(body: string): string {
  const m = body.match(/^## Phase log\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m);
  if (!m) return "";
  return (m[1] ?? "").trim();
}
