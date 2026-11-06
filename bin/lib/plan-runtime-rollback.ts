/**
 * Advisory flow-plan-lint check: a cut-over or destructive change (schema
 * alter/rename/drop, backfill, expand/contract, dual-write, queue payload
 * change) must name a plan task whose body carries the rollback step or check.
 * An eval planner described a safe rollback in prose but never planned it.
 */
import {
  extractTaskBreakdownSection,
  prdLabelValue,
} from "./plan-runtime-companions";

const TRIGGER_RES: RegExp[] = [
  /\b(?:alter(?:s|ed|ing)?|renam(?:e|es|ed|ing)|drop(?:s|ped|ping)?)\b[^\n]{0,40}\b(?:tables?|columns?|schemas?|index(?:es)?|indices|constraints?)\b/i,
  /\bbackfill/i,
  /\bexpand[\s/-]+(?:and[\s]+)?contract\b/i,
  /\bdual[- ]writ/i,
  /\b(?:chang|modif|bump|renam|remov|reshap|migrat)\w*[^\n]{0,40}\b(?:queue|task|message|pub\/?sub)\s+payload/i,
  /\b(?:queue|task|message|pub\/?sub)\s+payload[^\n]{0,40}\b(?:chang|modif|bump|renam|remov|reshap|migrat)\w*/i,
];
const ROLLBACK_VERB_RE =
  /\brollback\b|\broll(?:s|ed|ing)? back\b|\brevert|\bdown migration\b|\brestore\b|\bshift(?:s|ed|ing)? (?:traffic )?back\b|\bflag off\b/i;
const MECHANISM_RE =
  /\b(?:migration|script|sql|command|flag|traffic|revision|deploy|redeploy|test|check|drill|verify|runs?|apply|acceptance)\b/i;

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
  const value = prdLabelValue(planText, "Rollback");
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
  const named = [...value.matchAll(/\bTasks?\s+(\d+)\b/gi)].map((m) => m[1]);
  if (named.length === 0) {
    misses.push(
      "'**Rollback:**' names no task — write 'Task <n>' for the task that carries the rollback step or check",
    );
    return;
  }
  const bodies: string[] = [];
  for (const id of named) {
    const body = taskBody(tasks, id);
    if (body === null) {
      misses.push(
        `'**Rollback:**' names Task ${id} but the Task breakdown has no such task`,
      );
      return;
    }
    bodies.push(body);
  }
  if (!bodies.some((b) => ROLLBACK_VERB_RE.test(b) && MECHANISM_RE.test(b))) {
    misses.push(
      `'**Rollback:**' names Task ${named.join(", ")} but its body has no rollback step or check — add a step that reverts the change (down migration, traffic shift back, flag off) and a check that runs it`,
    );
  }
}
