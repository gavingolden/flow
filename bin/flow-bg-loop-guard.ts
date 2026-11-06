#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook (matcher `Bash`) that DENIES a command which
 * backgrounds an endless loop, or backgrounds a job and then cleans up with
 * `$(jobs -p)`. In the Bash tool's non-interactive zsh, `$(jobs -p)` runs in
 * a subshell with an empty job table, so `kill $(jobs -p)` kills nothing and
 * the backgrounded loops are orphaned and burn CPU for hours.
 *
 * Deny-only and fail-open: it never emits allow/ask, and any error, malformed
 * payload, non-Bash tool, or missing command exits 0 with no output.
 *
 * Quote handling is a small purpose-built scanner (the sibling guard's
 * segment splitter conflates `&` with `&&`/`;`/`|`, losing exactly the
 * single-`&` distinction needed here).
 */

const STDIN_TIMEOUT_MS = 250;

export type Decision = {
  permissionDecision: "deny";
  permissionDecisionReason: string;
};

const REASON =
  "This command backgrounds an endless loop, or backgrounds a job and cleans up with $(jobs -p). In the Bash tool's non-interactive zsh, $(jobs -p) is empty (command substitution runs in a subshell with no job table), so `kill $(jobs -p)` kills nothing and the loops outlive the command, pinning CPU after the work moves on. Use instead: `flow-stress --cpu <n> --max-sec <s> -- <cmd>` for CPU contention; the Bash tool's run_in_background for pollers; `flow-spawn --detach` for servers; and `kill %1` or `p=$!; kill $p` to stop a job you started.";

type Views = { code: string; sub: string };

/**
 * `code`: every quoted span blanked, so quoted text never matches. `sub`:
 * only single-quoted spans blanked (double quotes still run `$(…)`).
 * Both keep the original length.
 */
function views(command: string): Views {
  let code = "";
  let sub = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      code += " ";
      sub += " ";
    } else if (quote === '"') {
      if (c === "\\") {
        code += "  ";
        sub += c + (command[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === '"') quote = null;
      code += " ";
      sub += c;
    } else if (c === "\\") {
      const next = command[i + 1] ?? "";
      code += c + next;
      sub += c + next;
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
      code += " ";
      sub += c === '"' ? c : " ";
    } else {
      code += c;
      sub += c;
    }
  }
  return { code, sub };
}

/** Indexes of `&` that start a background job (not `&&`, `2>&1`, `&>`, `|&`). */
function backgroundOps(code: string): number[] {
  const ops: number[] = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c !== "&") continue;
    const prev = code[i - 1] ?? "";
    const next = code[i + 1] ?? "";
    if (next === "&") {
      i++;
      continue;
    }
    if (prev === "&" || prev === ">" || prev === "<" || prev === "|") continue;
    if (next === ">") continue;
    ops.push(i);
  }
  return ops;
}

const ENDLESS_WHILE =
  /^(?:while\s+(?::|true|\[\s*1\s*\]|\[\[\s*1\s*\]\]|\(\(\s*1\s*\)\))|until\s+(?:false|\[\s*0\s*\]|\(\(\s*0\s*\)\)))$/;

function endlessLoopSpans(code: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const starts = /\b(while|until)\b([^;\n]*)/g;
  for (let m = starts.exec(code); m; m = starts.exec(code)) {
    const head = `${m[1]}${m[2]}`.replace(/\s+do\b.*$/s, "").trim();
    if (!ENDLESS_WHILE.test(head)) continue;
    const words = /\b(while|until|for|select|done)\b/g;
    words.lastIndex = m.index;
    let depth = 0;
    for (let w = words.exec(code); w; w = words.exec(code)) {
      depth += w[1] === "done" ? -1 : 1;
      if (depth === 0) {
        spans.push({ start: m.index, end: w.index + w[0].length });
        break;
      }
    }
  }
  return spans;
}

/** True when a single-`&` background operator follows `from` (past closers/redirects). */
function backgroundedAfter(
  code: string,
  from: number,
  ops: Set<number>,
): boolean {
  let i = from;
  for (;;) {
    while (i < code.length && /[\s)}]/.test(code[i]!)) i++;
    const redirect = /^(?:\d*(?:>>?|<)&?\s*\S+|&>>?\s*\S+)/.exec(code.slice(i));
    if (!redirect) break;
    i += redirect[0].length;
  }
  return ops.has(i);
}

/** First word of a job, ignoring `VAR=x` prefixes and nohup/exec/time/nice. */
function firstWord(job: string): string {
  for (const t of job.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (["nohup", "exec", "time", "nice", "command"].includes(t)) continue;
    return t.split("/").pop() ?? t;
  }
  return "";
}

function backgroundedYes(code: string, ops: number[]): boolean {
  const seps = /;|\n|\(|\{|\)|\}|&&|\|\|/g;
  return ops.some((op) => {
    let jobStart = 0;
    for (let m = seps.exec(code); m && m.index < op; m = seps.exec(code)) {
      jobStart = m.index + m[0].length;
    }
    seps.lastIndex = 0;
    const prevOp = ops.filter((o) => o < op).pop();
    if (prevOp !== undefined && prevOp + 1 > jobStart) jobStart = prevOp + 1;
    const job = code.slice(jobStart, op);
    return !job.includes("|") && firstWord(job) === "yes";
  });
}

export function backgroundsEndlessLoop(command: string): boolean {
  const { code } = views(command);
  const ops = backgroundOps(code);
  if (ops.length === 0) return false;
  const opSet = new Set(ops);
  return (
    endlessLoopSpans(code).some((s) => backgroundedAfter(code, s.end, opSet)) ||
    backgroundedYes(code, ops)
  );
}

export function backgroundsJob(command: string): boolean {
  return backgroundOps(views(command).code).length > 0;
}

export function usesJobsPSubstitution(command: string): boolean {
  return /\$\(\s*jobs\s+-p\b|`\s*jobs\s+-p\b/.test(views(command).sub);
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
    const deny =
      backgroundsEndlessLoop(command) ||
      (usesJobsPSubstitution(command) && backgroundsJob(command));
    return deny
      ? { permissionDecision: "deny", permissionDecisionReason: REASON }
      : null;
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
