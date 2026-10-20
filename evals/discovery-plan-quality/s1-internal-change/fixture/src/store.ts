import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Todo } from "./todo";

export const todoFile = (): string =>
  process.env.TODO_FILE ?? join(homedir(), ".todo-cli.json");

export function loadTodos(): Todo[] {
  const file = todoFile();
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Todo[];
  } catch {
    return [];
  }
}

export function saveTodos(todos: Todo[]): void {
  writeFileSync(todoFile(), JSON.stringify(todos, null, 2));
}
