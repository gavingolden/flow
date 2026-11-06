/**
 * Advisory flow-plan-lint check: a cut-over or destructive change (schema
 * alter/rename/drop, backfill, expand/contract, dual-write, queue payload
 * change) must name a plan task whose body carries the rollback step or check.
 * An eval planner described a safe rollback in prose but never planned it.
 */
import { extractTaskBreakdownSection } from "./plan-runtime-companions";
import { findPrdSectionEnd } from "./plan-runtime-surface";

const TRIGGER_RES: RegExp[] = [
  /\b(?:alter|rename|drop)\b[^\n]{0,40}\b(?:table|column|schema|index|constraint)\b/i,
  /\bbackfill/i,
  /\bexpand[\s/-]+(?:and[\s]+)?contract\b/i,
  /\bdual[- ]writ/i,
  /\b(?:chang|modif|bump|renam|remov|reshap|migrat)\w*[^\n]{0,40}\b(?:queue|task|message|pub\/?sub)\s+payload/i,
  /\b(?:queue|task|message|pub\/?sub)\s+payload[^\n]{0,40}\b(?:chang|modif|bump|renam|remov|reshap|migrat)\w*/i,
];
const ROLLBACK_VERB_RE =
  /\brollback\b|\broll(?:ed|ing)? back\b|\brevert|\bdown migration\b|\brestore\b|\bshift(?:ing)? (?:traffic )?back\b/i;
const MECHANISM_RE =
  /\b(?:migration|script|sql|command|flag|traffic|revision|deploy|redeploy|test|check|drill|verify|runs?|apply|acceptance)\b/i;

function rollbackLineValue(planText: string): string | null {
  const prd = planText.match(/^# PRD\s*$/m);
  if (!prd) return null;
  const afterPrd = (prd.index ?? 0) + prd[0].length;
  const body = planText
    .slice(afterPrd, findPrdSectionEnd(planText, afterPrd))
    .replace(/<!--[\s\S]*?-->/g, "");
  const line = body.match(/^\*\*Rollback:\*\*/m);
  if (!line) return null;
  return body
    .slice((line.index ?? 0) + line[0].length)
    .split(/\n\s*\n|\n(?=\*\*|#)/)[0]
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function taskBody(tasks: string, n: string): string | null {
  const heading = new RegExp(`^###\\s+Task\\s+${n}\\b.*$`, "m").exec(tasks);
  if (!heading) return null;
  const rest = tasks.slice(heading.index + heading[0].length);
  const next = rest.search(/^#{1,3}\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function checkRollback(planText: string, misses: string[]): void {
  const tasks = extractTaskBreakdownSection(planText);
  if (tasks === null) return;
  const triggered = TRIGGER_RES.some((re) => re.test(tasks));
  const value = rollbackLineValue(planText);
  if (value === null) {
    if (triggered) {
      misses.push(
        "Task breakdown makes a cut-over or destructive change (schema change, backfill, expand/contract, dual-write or queue payload change) but the plan has no '**Rollback:**' line under '### Runtime design' — write '**Rollback:** Task <n>' naming the task that carries the rollback step or check",
      );
    }
    return;
  }
  if (/^none\b/i.test(value)) {
    if (triggered) {
      misses.push(
        "'**Rollback:**' says 'none' but the Task breakdown makes a cut-over or destructive change — name the task that carries the rollback step or check",
      );
    }
    return;
  }
  const named = value.match(/\bTask\s+(\d+)\b/i);
  if (!named) {
    misses.push(
      "'**Rollback:**' names no task — write 'Task <n>' for the task that carries the rollback step or check",
    );
    return;
  }
  const body = taskBody(tasks, named[1]);
  if (body === null) {
    misses.push(
      `'**Rollback:**' names Task ${named[1]} but the Task breakdown has no such task`,
    );
    return;
  }
  if (!ROLLBACK_VERB_RE.test(body) || !MECHANISM_RE.test(body)) {
    misses.push(
      `'**Rollback:**' names Task ${named[1]} but its body has no rollback step or check — add a step that reverts the change (down migration, traffic shift back, flag off) and a check that runs it`,
    );
  }
}
