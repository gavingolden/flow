import { loadTodos } from "../store";
import { todayISO } from "../todo";

export function summary(): string {
  const todos = loadTodos();
  const overdue = todos.filter((t) => !t.done && t.due !== undefined && t.due < todayISO());
  const open = todos.filter((t) => !t.done);
  return `${open.length} open, ${overdue.length} overdue`;
}
