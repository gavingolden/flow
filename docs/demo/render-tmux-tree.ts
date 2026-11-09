#!/usr/bin/env bun
// Rebuilds docs/demo/tmux-tree.svg: renders docs/demo/tmux.tape with VHS, then
// wraps the screenshot with numbered markers. Run from the repo root.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const RENDER_DIR = "docs/demo/.render";
const PNG = `${RENDER_DIR}/tmux-tree.png`;
const OUT = "docs/demo/tmux-tree.svg";

// Marker coordinates (PNG pixels) match the tape's Width 1100 / FontSize 16 and
// the column widths in docs/tmux-tree.conf; the six seeded windows set the rows.
const TOP = 48;
const RIGHT = 72;
const BG = "#1e1e2e";
const MARK = "#89b4fa";
const COLUMNS: [x: number, n: number][] = [
  [159, 1], // "!" column
  [740, 2], // PR
  [830, 3], // phase
  [960, 4], // title
];
const GROUPS: [first: number, last: number, n: number][] = [
  [0, 3, 5], // started earlier
  [4, 5, 6], // just created
];
const rowY = (i: number) => TOP + 53 + i * 19.6;

const circle = (x: number, y: number, n: number) =>
  `<circle cx="${x}" cy="${y}" r="13" fill="${MARK}"/><text x="${x}" y="${y + 5.5}" text-anchor="middle" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif" font-size="15" font-weight="700" fill="${BG}">${n}</text>`;
const column = (x: number, n: number) =>
  circle(x, 22, n) +
  `<path d="M${x} 36 V${TOP + 16}" stroke="${MARK}" stroke-width="2"/>`;
const bracket = (w: number, r0: number, r1: number, n: number) => {
  const x = w + 14;
  const y0 = rowY(r0) - 9 + (r0 > 0 ? 3 : 0);
  const y1 = rowY(r1) + 9 - (r1 < 5 ? 3 : 0);
  return (
    `<path d="M${x - 6} ${y0} H${x} V${y1} H${x - 6}" fill="none" stroke="${MARK}" stroke-width="2"/>` +
    circle(x + 30, (y0 + y1) / 2, n)
  );
};

function render(): void {
  const env = { ...process.env };
  for (const k of ["TMUX", "TMUX_PANE", "FLOW_SLUG"]) delete env[k];
  const r = spawnSync("vhs", ["docs/demo/tmux.tape"], {
    env,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`vhs exited with ${r.status}`);
  if (!existsSync(PNG)) throw new Error(`vhs did not produce ${PNG}`);
  const buf = readFileSync(PNG);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const marks =
    GROUPS.map(([a, b, n]) => bracket(w, a, b, n)).join("") +
    COLUMNS.map(([x, n]) => column(x, n)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + RIGHT}" height="${h + TOP}" viewBox="0 0 ${w + RIGHT} ${h + TOP}" role="img">
<title>The tmux tree view listing six flow pipelines, numbered 1 to 6 to match the legend</title>
<rect width="100%" height="100%" fill="${BG}"/>
<image x="0" y="${TOP}" width="${w}" height="${h}" href="data:image/png;base64,${buf.toString("base64")}"/>
${marks}
</svg>
`;
  writeFileSync(OUT, svg);
}

for (const [bin, arg] of [
  ["vhs", "--version"],
  ["tmux", "-V"],
] as const) {
  if (spawnSync(bin, [arg], { stdio: "ignore" }).error)
    throw new Error(`${bin} is not on PATH (brew install ${bin})`);
}

let failed = false;
try {
  render();
} catch (e) {
  failed = true;
  throw e;
} finally {
  rmSync(RENDER_DIR, { recursive: true, force: true });
  const env = { ...process.env };
  for (const k of ["TMUX", "TMUX_PANE", "FLOW_SLUG"]) delete env[k];
  const left = spawnSync("tmux", ["-L", "flow-demo", "has-session"], {
    env,
    stdio: "ignore",
  });
  if (left.status === 0) {
    spawnSync("tmux", ["-L", "flow-demo", "kill-server"], {
      env,
      stdio: "ignore",
    });
    if (!failed) throw new Error("a tmux -L flow-demo server was left running");
    console.error("also killed a leftover tmux -L flow-demo server");
  }
}
