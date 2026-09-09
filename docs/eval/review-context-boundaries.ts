// Variant of ~/.flow/audits/transcript-review-segment.ts: instead of summing the
// review segment, it records the CONTEXT SIZE at three phase boundaries per session.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
const ROOT = `${process.env.HOME}/.claude/projects`;
const ctxOf = (u: any) =>
  (u.cache_read_input_tokens || 0) +
  (u.cache_creation_input_tokens || 0) +
  (u.input_tokens || 0);
const atPipeline: number[] = [],
  atReview: number[] = [],
  maxPer: number[] = [];
const dirs = readdirSync(ROOT).filter(
  (d) =>
    /^-Users-gavingolden-code-me-(flow|pokemon|econ-data)/.test(d) &&
    !d.includes("scratchpad"),
);
for (const d of dirs)
  for (const f of readdirSync(join(ROOT, d)).filter((f) =>
    f.endsWith(".jsonl"),
  )) {
    let pipeSeen = false,
      revSeen = false,
      wantPipe = false,
      wantRev = false,
      mx = 0,
      any = false;
    for (const l of readFileSync(join(ROOT, d, f), "utf8").split("\n")) {
      if (!l) continue;
      let j: any;
      try {
        j = JSON.parse(l);
      } catch {
        continue;
      }
      const c = j.message?.content;
      if (j.type === "assistant" && j.message?.usage) {
        const v = ctxOf(j.message.usage);
        if (v > mx) mx = v;
        any = true;
        if (wantPipe) {
          atPipeline.push(v);
          wantPipe = false;
        }
        if (wantRev) {
          atReview.push(v);
          wantRev = false;
        }
      }
      if (j.type === "assistant" && Array.isArray(c))
        for (const b of c)
          if (b.type === "tool_use" && b.name === "Skill" && b.input?.skill) {
            const s = String(b.input.skill);
            if (!pipeSeen && s.includes("flow-pipeline")) {
              pipeSeen = true;
              wantPipe = true;
            }
            if (!revSeen && s.includes("pr-review")) {
              revSeen = true;
              wantRev = true;
            }
          }
    }
    if (any && revSeen) maxPer.push(mx);
  }
const q = (a: number[], p: number) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length * p)] ?? 0;
};
const k = (n: number) => `${Math.round(n / 1000)}K`;
for (const [name, arr] of [
  ["after /flow-pipeline loads", atPipeline],
  ["after /flow-pr-review loads", atReview],
  ["max per session (sessions w/ review)", maxPer],
] as [string, number[]][])
  console.log(
    `${name}: n=${arr.length} p25=${k(q(arr, 0.25))} median=${k(q(arr, 0.5))} p75=${k(q(arr, 0.75))}`,
  );
