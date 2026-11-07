/**
 * The owner's decision charter: the `## Deciding on my behalf` section of the
 * USER-LEVEL `~/.flow/product.md`. Read raw from that file and never through
 * `flow-product-brief` (which resolves a repo brief first and caps at 4000
 * chars, so in a repo with its own brief the charter would never be seen).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLockSync } from "./lock";

export const CHARTER_HEADING = "## Deciding on my behalf";
export const CHARTER_CHAR_LIMIT = 8000;
const CORRECTIONS_HEADING = "### Standing corrections";

export type Charter =
  | { found: true; path: string; text: string }
  | {
      found: false;
      path: string;
      reason: "missing" | "too-long" | "unreadable";
    };

/** [start, end) of the charter section: its heading line to the next `## ` heading or EOF. */
function sectionRange(text: string): [number, number] | null {
  const m = new RegExp(`^${CHARTER_HEADING}[ \\t]*$`, "m").exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /\n## /.exec(rest);
  const end = next ? m.index + m[0].length + next.index + 1 : text.length;
  return [m.index, end];
}

export function extractCharterSection(text: string): string | null {
  const r = sectionRange(text);
  return r ? text.slice(r[0], r[1]).trimEnd() : null;
}

/** Removes the charter section so brief readers never receive it, whole or truncated. */
export function stripCharterSection(text: string): string {
  const r = sectionRange(text);
  if (!r) return text;
  return `${text.slice(0, r[0])}${text.slice(r[1])}`.replace(/\n{3,}/g, "\n\n");
}

function briefPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".flow", "product.md");
}

export function readCharter(
  opts: { homeDir?: string; readFile?: (p: string) => string } = {},
): Charter {
  const p = briefPath(opts.homeDir);
  let raw: string;
  try {
    raw = (opts.readFile ?? ((f) => fs.readFileSync(f, "utf8")))(p);
  } catch {
    return { found: false, path: p, reason: "unreadable" };
  }
  const section = extractCharterSection(raw);
  if (section === null) return { found: false, path: p, reason: "missing" };
  if (section.length > CHARTER_CHAR_LIMIT) {
    return { found: false, path: p, reason: "too-long" };
  }
  return { found: true, path: p, text: section };
}

export function addCorrection(
  line: string,
  opts: {
    homeDir?: string;
    today?: () => string;
    decisionId?: string;
  } = {},
):
  | { ok: true; path: string }
  | { ok: false; reason: "section-missing" | "empty-line" | "write-failed" } {
  const clean = line.replace(/\s+/g, " ").trim();
  if (clean === "") return { ok: false, reason: "empty-line" };
  const p = briefPath(opts.homeDir);
  const date = (opts.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const suffix = opts.decisionId ? ` (decision ${opts.decisionId})` : "";
  const bullet = `- ${date}: ${clean}${suffix}`;
  try {
    return withFileLockSync(`${p}.lock`, () => {
      const text = fs.readFileSync(p, "utf8");
      const range = sectionRange(text);
      if (!range)
        return { ok: false as const, reason: "section-missing" as const };
      const [start, end] = range;
      const section = text.slice(start, end);
      const at = section.indexOf(CORRECTIONS_HEADING);
      let next: string;
      if (at === -1) {
        next = `${section.trimEnd()}\n\n${CORRECTIONS_HEADING}\n\n${bullet}\n`;
      } else {
        const afterHeading = at + CORRECTIONS_HEADING.length;
        const sub = /\n### /.exec(section.slice(afterHeading));
        const subEnd = sub ? afterHeading + sub.index : section.length;
        const body = section.slice(afterHeading, subEnd).trimEnd();
        next = `${section.slice(0, afterHeading)}${body}\n${body.trim() === "" ? "\n" : ""}${bullet}\n${sub ? `\n${section.slice(subEnd + 1)}` : ""}`;
      }
      const tmp = `${p}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        `${text.slice(0, start)}${next}${end < text.length ? `\n${text.slice(end)}` : ""}`,
      );
      fs.renameSync(tmp, p);
      return { ok: true as const, path: p };
    });
  } catch {
    return { ok: false, reason: "write-failed" };
  }
}
