import { loadTodos, saveTodos } from "../store";
import { nextId, type Todo } from "../todo";

export function add(title: string, due?: string): Todo {
  const todos = loadTodos();
  const todo: Todo = { id: nextId(todos), title, done: false, due, priority: "normal" };
  saveTodos([...todos, todo]);
  return todo;
}
