import { loadTodos } from "../store";
import { todayISO } from "../todo";

export function list(opts: { overdue?: boolean } = {}): string[] {
  const today = todayISO();
  return loadTodos()
    .filter((t) => !opts.overdue || (!t.done && t.due !== undefined && t.due < today))
    .map((t) => `${t.done ? "[x]" : "[ ]"} ${t.id} ${t.title}${t.due ? ` (due ${t.due})` : ""}`);
}
