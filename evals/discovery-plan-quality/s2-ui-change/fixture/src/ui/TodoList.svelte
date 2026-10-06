<script lang="ts">
  import type { Todo } from "../todo";

  export let todos: Todo[] = [];
</script>

<ul class="todo-list">
  {#each todos as todo (todo.id)}
    <li class:done={todo.done}>
      <span class="title">{todo.title}</span>
      {#if todo.due}<span class="due">due {todo.due}</span>{/if}
      <span class="priority priority-{todo.priority}">{todo.priority}</span>
    </li>
  {/each}
</ul>

<style>
  .todo-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .todo-list li {
    display: flex;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid #ddd;
  }
  .done .title {
    text-decoration: line-through;
    color: #888;
  }
  .priority-high {
    color: #b00020;
  }
</style>
