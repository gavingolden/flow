import { loadTodos } from "../store";

export const load = () => ({ todos: loadTodos() });
