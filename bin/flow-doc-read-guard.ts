#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook (matcher `Bash`) that DENIES awk, and sed with
 * anything other than a line-number print, aimed at flow's installed doc
 * homes. Claude Code can classify those forms as an edit of a protected
 * `.claude/` file and raise a permission prompt that stalls an unattended
 * run, even in auto mode. The Read tool and line-number `sed -n 'N,Mp'` are
 * unaffected.
 *
 * Deny-only and fail-open: it never emits allow/ask, and any error, malformed
 * payload, non-Bash tool, or missing command exits 0 with no output.
 */

const STDIN_TIMEOUT_MS = 250;
const FLOW_DOC_PATH = /\.flow\/(?:claude-home|overlays)/;
const AWK_NAMES = new Set(["awk", "gawk", "mawk", "nawk"]);
const WRAPPERS = new Set([
  "env",
  "sudo",
  "time",
  "command",
  "nice",
  "nohup",
  "exec",
  "xargs",
]);
const LINE_NUMBER_PRINT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;

export type Decision = {
  permissionDecision: "deny";
  permissionDecisionReason: string;
};

const REASON =
  "This sed/awk form on flow's installed docs can be flagged by Claude Code as an edit of a protected .claude/ file and stall an unattended run. Use the Read tool instead: grep -n the heading to find its line, then Read with offset/limit (or sed -n 'N,Mp').";

/** Quote-aware split on unquoted `|`, `||`, `&&`, `;` and newlines. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') cur += command[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      cur += c + (command[++i] ?? "");
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "|" || c === ";" || c === "\n") {
      segments.push(cur);
      cur = "";
    } else if (c === "&" && command[i + 1] === "&") {
      segments.push(cur);
      cur = "";
      i++;
    } else {
      cur += c;
    }
  }
  segments.push(cur);
  return segments;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') cur += segment[++i] ?? "";
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\") {
      cur += segment[++i] ?? "";
      has = true;
    } else if (/\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

function commandWord(
  tokens: string[],
): { word: string; rest: string[] } | null {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!.replace(/^[({`]+|^\$\(/, "");
    if (t === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    const base = t.split("/").pop() ?? t;
    if (WRAPPERS.has(base)) {
      i++;
      continue;
    }
    return { word: base, rest: tokens.slice(i + 1) };
  }
  return null;
}

function sedIsRisky(args: string[]): boolean {
  const scripts: string[] = [];
  let scriptViaE = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") continue;
    if (a === "--in-place" || a.startsWith("--in-place=")) return true;
    if (a.startsWith("--")) {
      if (a === "--file" || a.startsWith("--file=")) return true;
      if (a === "--expression") {
        scriptViaE = true;
        scripts.push(args[++i] ?? "");
      } else if (a.startsWith("--expression=")) {
        scriptViaE = true;
        scripts.push(a.slice("--expression=".length));
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const flags = a.slice(1);
      if (flags.includes("i") || flags.includes("f")) return true;
      if (flags.endsWith("e")) {
        scriptViaE = true;
        scripts.push(args[++i] ?? "");
      }
      continue;
    }
    if (!scriptViaE && scripts.length === 0) scripts.push(a);
  }
  if (scripts.length === 0) return false;
  return scripts.some((s) => !LINE_NUMBER_PRINT.test(s.trim()));
}

function segmentDenied(segment: string): boolean {
  if (!FLOW_DOC_PATH.test(segment)) return false;
  const cmd = commandWord(tokenize(segment));
  if (!cmd) return false;
  if (AWK_NAMES.has(cmd.word)) return true;
  if (cmd.word === "sed") return sedIsRisky(cmd.rest);
  return false;
}

export function decide(input: unknown): Decision | null {
  try {
    if (input === null || typeof input !== "object") return null;
    const obj = input as { tool_name?: unknown; tool_input?: unknown };
    if (obj.tool_name !== "Bash") return null;
    const ti = obj.tool_input;
    if (ti === null || typeof ti !== "object") return null;
    const command = (ti as { command?: unknown }).command;
    if (typeof command !== "string" || command === "") return null;
    if (!splitSegments(command).some(segmentDenied)) return null;
    return { permissionDecision: "deny", permissionDecisionReason: REASON };
  } catch {
    return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c) => chunks.push(c as Uint8Array));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

if (import.meta.main) {
  (async () => {
    try {
      const decision = decide(JSON.parse(await readStdin()));
      if (decision) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: { hookEventName: "PreToolUse", ...decision },
          }) + "\n",
        );
      }
    } catch {
      // fail open
    }
    process.exit(0);
  })();
}
