export const EXPECTED_PNG = { w: 1100, h: 300 } as const;
export const COLUMN_OFFSETS = { pr: 56, phase: 63, title: 72 } as const;

const SEPARATOR = "─".repeat(80);
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ROW = /^\(\d+\) [├└]─> \+ \d+: /;
const HINT =
  "if the change is intended, update together: docs/demo/tmux.tape seeded rows, docs/tmux-tree.conf column widths, the marker coordinates in docs/demo/render-tmux-tree.ts, and the expectations in docs/demo/tmux-tree-check.ts";

const EXPECTED_ROWS = [
  {
    slug: "new-logo",
    flag: " ",
    pr: "#11",
    phase: "merged",
    title: "New logo",
  },
  { slug: "fix-typo", flag: "!", pr: "#12", phase: "gated", title: "Typo fix" },
  {
    slug: "add-csv-export",
    flag: "!",
    pr: "—",
    phase: "plan?",
    title: "CSV export",
  },
  { slug: "add-search", flag: " ", pr: "—", phase: "impl", title: "Search" },
  {
    slug: "add-dark-mode",
    flag: " ",
    pr: "—",
    phase: "start",
    title: "add-dark-mode",
  },
  {
    slug: "fix-login-bug",
    flag: " ",
    pr: "—",
    phase: "start",
    title: "fix-login-bug",
  },
];

export function lastTreeFrame(log: string): string[] {
  const clean = log.replace(ANSI, "");
  let found: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.some((l) => /- flow: \d+ windows/.test(l))) {
      const lines = [...current];
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      found = lines;
    }
    current = [];
  };
  for (const line of clean.split("\n")) {
    if (line === SEPARATOR) flush();
    else current.push(line);
  }
  flush();
  return found;
}

const cell = (cps: string[], at: number, want: string): string =>
  cps.slice(at, at + want.length).join("");

export function checkTreeFrame(log: string): string[] {
  const frame = lastTreeFrame(log);
  if (frame.length === 0)
    return [`no tree frame ("- flow: N windows") in the vhs text log; ${HINT}`];
  const rows = frame.filter((l) => ROW.test(l));
  const problems: string[] = [];
  if (rows.length !== EXPECTED_ROWS.length)
    problems.push(
      `expected ${EXPECTED_ROWS.length} window rows, found ${rows.length}`,
    );
  EXPECTED_ROWS.forEach((exp, i) => {
    const line = rows[i];
    if (line === undefined) return;
    const cps = [...line];
    if (!line.includes(exp.slug))
      problems.push(
        `row ${i + 1}: expected slug ${exp.slug} in seeded order, found "${line}"`,
      );
    const m = /\d+: /.exec(line);
    if (!m) return;
    const flagAt = [...line.slice(0, m.index + m[0].length)].length;
    const found = cps[flagAt] ?? "";
    if (found !== exp.flag)
      problems.push(
        `row ${exp.slug}: flag column expected "${exp.flag}", found "${found}"`,
      );
    for (const [col, want] of [
      ["pr", exp.pr],
      ["phase", exp.phase],
      ["title", exp.title],
    ] as const) {
      const got = cell(cps, flagAt + COLUMN_OFFSETS[col], want);
      if (got !== want)
        problems.push(
          `row ${exp.slug}: ${col} column at +${COLUMN_OFFSETS[col]} expected "${want}", found "${got}"`,
        );
    }
  });
  if (problems.length) problems.push(HINT);
  return problems;
}

export function pngSize(buf: Uint8Array): { w: number; h: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b))
    throw new Error("not a PNG (bad signature)");
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

export function svgShell(svg: string): string {
  return svg.replace(
    /data:image\/png;base64,[A-Za-z0-9+/=]+/g,
    "data:image/png;base64,<masked>",
  );
}
