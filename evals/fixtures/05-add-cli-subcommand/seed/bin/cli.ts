#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const itemsPath = join(here, "..", "items.json");

const subcommand = process.argv[2];

if (subcommand === "list") {
  const items = JSON.parse(readFileSync(itemsPath, "utf8")) as string[];
  for (const item of items) console.log(item);
  process.exit(0);
}

console.error(`unknown subcommand: ${subcommand ?? "(none)"}`);
console.error("usage: cli.ts <list>");
process.exit(1);
