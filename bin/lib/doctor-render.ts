import { dim, green, red, sgr, yellow } from "./color";
import { linkPath, resolveLinkMode, type LinkMode } from "./link";
import type {
  DoctorCheck,
  DoctorReport,
  DoctorSection,
  DoctorStatus,
} from "./doctor";

const SECTIONS: { id: DoctorSection; heading: string }[] = [
  { id: "install", heading: "Install" },
  { id: "shell", heading: "Shell" },
  { id: "tools", heading: "Tools" },
  { id: "leftovers", heading: "Leftovers" },
];

const SYMBOL: Record<DoctorStatus, string> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
  skip: "-",
};

const SGR_CODE: Record<DoctorStatus, number> = {
  pass: 32,
  warn: 33,
  fail: 31,
  skip: 2,
};

function paint(status: DoctorStatus, s: string, color?: boolean): string {
  if (color === undefined) {
    const helper = { pass: green, warn: yellow, fail: red, skip: dim }[status];
    return helper(s);
  }
  return color ? sgr(SGR_CODE[status], s) : s;
}

// Absolute path tokens inside a detail line become click targets in a TTY;
// the JSON report always carries the raw text.
const PATH_TOKEN_RE = /(^|[\s(])(\/[^\s'")]+\/[^\s'")]*[^\s'")\].,;:])/g;

function linkifyPaths(line: string, mode: LinkMode): string {
  if (mode === "plain") return line;
  return line.replace(PATH_TOKEN_RE, (_m, lead: string, p: string) => {
    return `${lead}${linkPath(p, mode)}`;
  });
}

function renderCheck(
  c: DoctorCheck,
  color: boolean | undefined,
  mode: LinkMode,
): string[] {
  const lines = [
    `  ${paint(c.status, SYMBOL[c.status], color)} ${c.title}: ${c.summary}`,
  ];
  for (const d of c.details) lines.push(`      ${linkifyPaths(d, mode)}`);
  if (c.fix && (c.status === "warn" || c.status === "fail")) {
    lines.push(`      fix: ${c.fix}`);
  }
  return lines;
}

export function renderDoctorText(
  report: DoctorReport,
  opts: { color?: boolean; linkMode?: LinkMode } = {},
): string {
  const color = opts.color;
  const mode = opts.linkMode ?? resolveLinkMode();
  const lines: string[] = ["flow doctor", ""];
  for (const section of SECTIONS) {
    const checks = report.checks.filter((c) => c.section === section.id);
    if (checks.length === 0) continue;
    lines.push(section.heading);
    for (const c of checks) lines.push(...renderCheck(c, color, mode));
    lines.push("");
  }
  const { pass, warn, fail, skip } = report.counts;
  lines.push(
    `${pass} passed, ${warn} warnings, ${fail} failed, ${skip} skipped`,
  );
  return lines.join("\n");
}
