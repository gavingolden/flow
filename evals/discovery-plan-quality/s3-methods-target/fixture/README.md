# todo-cli

A tiny command-line todo list. Todos live in a JSON file (`~/.todo-cli.json`,
override with `TODO_FILE`).

```sh
bun src/index.ts add "write the report" --due 2026-10-01
bun src/index.ts list
bun src/index.ts list --overdue
bun src/index.ts done 1
```
