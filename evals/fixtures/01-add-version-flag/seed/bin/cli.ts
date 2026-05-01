#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log("tinycli — a tiny example cli\n");
  console.log("Usage:");
  console.log("  tinycli --help     show this help");
  process.exit(0);
}

console.log("hello");
