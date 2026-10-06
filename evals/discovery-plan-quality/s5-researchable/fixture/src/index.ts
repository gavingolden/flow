#!/usr/bin/env bun
import { add } from "./commands/add";
import { done } from "./commands/done";
import { list } from "./commands/list";
import { summary } from "./commands/summary";
import { loadTodos } from "./store";
import { todayISO } from "./todo";

const [cmd, ...args] = process.argv.slice(2);
const overdue = loadTodos().filter((t) => !t.done && t.due !== undefined && t.due < todayISO());
if (overdue.length > 0) console.log(`! ${overdue.length} overdue`);

if (cmd === "add") {
  const due = args.includes("--due") ? args[args.indexOf("--due") + 1] : undefined;
  console.log(`added #${add(args[0], due).id}`);
} else if (cmd === "list") {
  console.log(list({ overdue: args.includes("--overdue") }).join("\n"));
} else if (cmd === "done") {
  console.log(done(Number(args[0])) ? "ok" : "no such todo");
} else if (cmd === "summary") {
  console.log(summary());
} else {
  console.log("usage: todo <add|list|done|summary>");
}
