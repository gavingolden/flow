import { loadTodos, saveTodos } from "../store";

export function done(id: number): boolean {
  const todos = loadTodos();
  const hit = todos.find((t) => t.id === id);
  if (!hit) return false;
  hit.done = true;
  saveTodos(todos);
  return true;
}
