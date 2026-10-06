<script lang="ts">
  import TodoList from "../ui/TodoList.svelte";
  import type { Todo } from "../todo";

  export let data: { todos: Todo[] };
</script>

<h1>Todos</h1>
<TodoList todos={data.todos} />
