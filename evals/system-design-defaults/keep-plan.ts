#!/usr/bin/env bun
// Usage: bun keep-plan.ts <plan.md> <assistant-text-path>
// Copies the plan next to assistant-text so each run keeps what the graders read.
// Observational: a missing plan exits 0; missing args exit 2.
import fs from "node:fs";
import path from "node:path";

export function keepPlan(
  planPath: string,
  assistantTextPath: string,
): string | null {
  if (!fs.existsSync(planPath)) return null;
  const dest = path.join(path.dirname(assistantTextPath), "plan.md");
  fs.copyFileSync(planPath, dest);
  return dest;
}

if (import.meta.main) {
  const [planPath, assistantText] = process.argv.slice(2);
  if (!planPath || !assistantText) {
    console.log("usage: keep-plan.ts <plan.md> <assistant-text-path>");
    process.exit(2);
  }
  const dest = keepPlan(planPath, assistantText);
  console.log(dest ? `kept plan: ${dest}` : `no plan to keep: ${planPath}`);
  process.exit(0);
}
