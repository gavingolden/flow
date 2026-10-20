export type Todo = {
  id: number;
  title: string;
  done: boolean;
  due?: string;
  priority: "low" | "normal" | "high";
};

export const todayISO = (): string => new Date().toISOString().slice(0, 10);

export function nextId(todos: Todo[]): number {
  return todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
}
