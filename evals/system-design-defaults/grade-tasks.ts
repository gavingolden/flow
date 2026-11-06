#!/usr/bin/env bun
// Usage: bun grade-tasks.ts <plan.md> <regex> [--absent]
// Exit 0 on a match (or, with --absent, on no match), 1 otherwise,
// 2 on usage error / unreadable file / no Task breakdown section.
import fs from "node:fs";

const NEGATION =
  /\b(no|not|never|without|rather than|instead of|avoid|don't|do not)\b/i;

export function extractTaskBreakdown(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#\s+Task breakdown\s*$/i.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

export function gradeTasks(
  text: string,
  pattern: string,
  absent: boolean,
): boolean {
  const section = extractTaskBreakdown(text);
  if (section === null) throw new Error("no Task breakdown section");
  const re = new RegExp(pattern, "i");
  // Presence mode is deliberately negation-blind: only --absent discounts negated matches.
  if (!absent) return re.test(section);
  const global = new RegExp(pattern, "gi");
  const affirmativeHit = section.split("\n").some((line) => {
    for (const m of line.matchAll(global)) {
      const clause =
        line
          .slice(0, m.index)
          .split(/[.;:,\u2014]|\b(?:so|because|but|and)\b/i)
          .pop() ?? "";
      if (!NEGATION.test(clause)) return true;
    }
    return false;
  });
  return !affirmativeHit;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const absent = args.includes("--absent");
  const [planPath, pattern] = args.filter((a) => a !== "--absent");
  if (!planPath || !pattern) {
    console.log("usage: grade-tasks.ts <plan.md> <regex> [--absent]");
    process.exit(2);
  }
  let text: string;
  try {
    text = fs.readFileSync(planPath, "utf8");
  } catch (e) {
    console.log(`cannot read ${planPath}: ${(e as Error).message}`);
    process.exit(2);
  }
  try {
    const ok = gradeTasks(text, pattern, absent);
    console.log(
      `${ok ? "pass" : "fail"}: /${pattern}/i ${absent ? "absent from" : "found in"} Task breakdown`,
    );
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.log((e as Error).message);
    process.exit(2);
  }
}
