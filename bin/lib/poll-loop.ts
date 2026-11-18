/**
 * Detectors for waits with no deadline: a `while`/`until` loop that sleeps and
 * shows no bound, and an unbounded watch (`gh pr checks --watch`, `gh run
 * watch`, `tail -f`). Both run on the quote-blanked view from `shell-scan.ts`,
 * so quoted text never matches; `sh|bash|zsh -c '<script>'` arguments are
 * scanned as their own command. A bound is `flow-wait`/`flow-ci-wait`, a
 * `timeout <n>` wrapper, a `SECONDS`/`date +%s` deadline compare, or a counter
 * the body changes. A literal deadline above the `flow-wait` cap is refused
 * too, so the hand-rolled path is never looser than the sanctioned one.
 */

import { views } from "./shell-scan";
import { WAIT_MAX_SEC_CAP } from "./wait-loop";

const COUNTER_CMP =
  /\$\{?(\w+)\}?"?\s+-(?:lt|le|gt|ge|eq|ne)\b|-(?:lt|le|gt|ge|eq|ne)\s+"?\$\{?(\w+)\}?|\(\(\s*\$?(\w+)\s*(?:<=?|>=?|!=|==)|\(\([^)]*(?:<=?|>=?|!=|==)\s*\$?(\w+)\s*\)\)/g;
const NUM_CMP = /\s-(?:lt|le|gt|ge|eq|ne)\s|\(\([^)]*(?:<=?|>=?|!=|==)/;

type Loop = {
  start: number;
  end: number;
  kind: string;
  cond: string;
  body: string;
};

function atStatementStart(code: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (code[j] === " " || code[j] === "\t")) j--;
  if (j < 0) return true;
  if (/[;&|(){}\n]/.test(code[j]!)) return true;
  const kw = /(?:then|do|else|elif|!)$/.exec(
    code.slice(Math.max(0, j - 3), j + 1),
  );
  if (!kw) return false;
  const before = j - kw[0].length;
  return before < 0 || /[\s;&|(){}]/.test(code[before]!);
}

function findLoops(code: string): Loop[] {
  const loops: Loop[] = [];
  const re = /\b(while|until|for)\b/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (!atStatementStart(code, m.index)) continue;
    const words = /\b(while|until|for|select|do|done)\b/g;
    words.lastIndex = m.index + m[0].length;
    let depth = 1;
    let doAt = -1;
    for (let w = words.exec(code); w; w = words.exec(code)) {
      if (w[1] === "done") {
        if (!atStatementStart(code, w.index)) continue;
        depth--;
        if (depth === 0) {
          if (doAt === -1) break;
          loops.push({
            start: m.index,
            end: w.index + 4,
            kind: m[1]!,
            cond: code.slice(m.index + m[0].length, doAt),
            body: code.slice(doAt + 2, w.index),
          });
          break;
        }
      } else if (w[1] === "do") {
        if (depth === 1 && doAt === -1 && atStatementStart(code, w.index)) {
          doAt = w.index;
        }
      } else if (atStatementStart(code, w.index)) {
        depth++;
      }
    }
  }
  return loops;
}

function toSeconds(n: string, unit: string): number {
  const mult =
    unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 1;
  return Number(n) * mult;
}

type Wrapper = { bounded: boolean; overCap: boolean };

/** What wraps the command starting at `idx`: a `timeout <n>` or a flow waiter. */
function wrapperBefore(code: string, idx: number): Wrapper {
  let segStart = idx;
  while (segStart > 0 && !/[;&|\n(){}]/.test(code[segStart - 1]!)) segStart--;
  const prefix = code.slice(segStart, idx);
  if (/(?:^|\s)flow-(?:ci-)?wait\b/.test(prefix)) {
    return { bounded: true, overCap: false };
  }
  const t =
    /(?:^|\s)g?timeout\s+(?:(?:-[ks]|--kill-after|--signal)\s+\S+\s+|-\S+\s+)*(\d+(?:\.\d+)?)([smhd]?)\s+(?:\S+=\S+\s+|env\s+|nohup\s+)*$/.exec(
      prefix,
    );
  if (!t) return { bounded: false, overCap: false };
  return { bounded: true, overCap: toSeconds(t[1]!, t[2]!) > WAIT_MAX_SEC_CAP };
}

function sleeps(code: string, original: string): boolean {
  return (
    /(?<![\w./-])(?:\/bin\/)?sleep\b/.test(code) ||
    /select\s*\(\s*undef/.test(original)
  );
}

function assignedIn(body: string, name: string): boolean {
  return new RegExp(
    `(?:^|[\\s;&|(])${name}(?:=|\\+=|\\+\\+|--)|(?:\\+\\+|--)${name}\\b|\\(\\(\\s*${name}\\b[^)]*(?:=|\\+\\+)`,
  ).test(body);
}

function compareVars(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(COUNTER_CMP)) {
    const v = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (v) out.push(v);
  }
  return out;
}

function seqLoopOverCap(l: Loop): boolean {
  if (l.kind !== "for") return false;
  const seq = /\bseq\s+(?:(\d+)\s+)?(\d+)\b/.exec(l.cond);
  const brace = /\{(\d+)\.\.(\d+)\}/.exec(l.cond);
  const count = seq
    ? Number(seq[2]) - Number(seq[1] ?? 1) + 1
    : brace
      ? Math.abs(Number(brace[2]) - Number(brace[1])) + 1
      : null;
  const nap = /\bsleep\s+(\d+(?:\.\d+)?)/.exec(l.body);
  return (
    count !== null && nap !== null && count * Number(nap[1]) > WAIT_MAX_SEC_CAP
  );
}

/** `code` blanks `$(date +%s)` inside double quotes, so the deadline test reads the original text. */
function loopBounded(l: Loop, originalSpan: string): boolean {
  const span = `${l.cond} ${l.body}`;
  if (/\bflow-(?:ci-)?wait\b/.test(span)) return true;
  if (l.kind === "for") {
    if (/^\s*\(\(\s*[^;]*;\s*;/.test(l.cond)) return false;
    return true;
  }
  if (
    /\bSECONDS\b|\bdate\s+\+%s\b/.test(originalSpan) &&
    NUM_CMP.test(originalSpan)
  )
    return true;
  if (compareVars(l.cond).some((v) => assignedIn(l.body, v))) return true;
  const exits = /\b(?:break|exit|return)\b/.test(l.body);
  if (exits && compareVars(l.body).some((v) => assignedIn(l.body, v))) {
    return true;
  }
  return false;
}

function pipedOrRedirected(code: string, l: Loop): boolean {
  if (!/\bread\b/.test(l.cond)) return false;
  let b = l.start - 1;
  while (b >= 0 && /\s/.test(code[b]!)) b--;
  let a = l.end;
  while (a < code.length && /[ \t]/.test(code[a]!)) a++;
  return code[b] === "|" || code[a] === "<";
}

const SHELL_OWNER = /(?:^|[\s;&|(])(?:\S*\/)?(?:sh|bash|zsh)\b/;

/** Heredoc bodies nothing runs (fed to `cat`/`tee`, not to a shell). */
function inertHeredocs(original: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g;
  for (let m = re.exec(original); m; m = re.exec(original)) {
    const lineStart = original.lastIndexOf("\n", m.index) + 1;
    let segStart = m.index;
    while (segStart > lineStart && !/[;&|(]/.test(original[segStart - 1]!))
      segStart--;
    if (SHELL_OWNER.test(original.slice(segStart, m.index))) continue;
    const bodyStart = original.indexOf("\n", m.index);
    if (bodyStart === -1) continue;
    const close = new RegExp(`^${m[1] ? "\\t*" : ""}${m[3]}[ \\t]*$`, "m").exec(
      original.slice(bodyStart + 1),
    );
    const end = close
      ? bodyStart + 1 + close.index + close[0].length
      : original.length;
    ranges.push([bodyStart + 1, end]);
  }
  return ranges;
}

const WRAPPED_SCRIPT =
  /(?:^|[\s;&|(])(?:\S*\/)?(?:sh|bash|zsh)\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c\s+'([^']*)'/g;

export function unboundedPollLoop(command: string, depth = 0): boolean {
  const { code } = views(command);
  const loops = findLoops(code);
  const original = command;
  const literalDeadline = [...code.matchAll(/\bSECONDS\s*\+\s*(\d+)/g)].some(
    (m) => Number(m[1]) > WAIT_MAX_SEC_CAP,
  );
  const inert = inertHeredocs(original);
  for (const l of loops) {
    if (inert.some(([a, b]) => l.start >= a && l.start < b)) continue;
    if (!sleeps(code.slice(l.start, l.end), original.slice(l.start, l.end)))
      continue;
    if (pipedOrRedirected(code, l)) continue;
    const wrap = wrapperBefore(code, l.start);
    if (wrap.overCap || seqLoopOverCap(l) || literalDeadline) return true;
    if (wrap.bounded || loopBounded(l, original.slice(l.start, l.end)))
      continue;
    return true;
  }
  if (depth >= 2) return false;
  for (const m of command.matchAll(WRAPPED_SCRIPT)) {
    const shIdx = m.index! + (/^[\s;&|(]/.test(m[0]) ? 1 : 0);
    if (code[shIdx] !== command[shIdx]) continue;
    if (inert.some(([a, b]) => shIdx >= a && shIdx < b)) continue;
    const wrap = wrapperBefore(code, shIdx);
    if (wrap.overCap) return true;
    if (wrap.bounded) continue;
    if (unboundedPollLoop(m[1]!, depth + 1)) {
      return true;
    }
  }
  return false;
}

const WATCHES: RegExp[] = [
  /\bgh\s+pr\s+checks\b[^;&|\n]*--watch\b/g,
  /\bgh\s+run\s+watch\b/g,
  /\btail\b[^;&|\n]*\s(?:-[A-Za-z]*[fF][A-Za-z0-9]*|--follow)\b/g,
];

const LAUNCHERS = new Set(["nohup", "env", "time", "exec", "command", "sudo"]);

/** True when the watch at `idx` is the command being run, not an argument or text. */
function atCommandPosition(code: string, idx: number): boolean {
  if (atStatementStart(code, idx)) return true;
  let segStart = idx;
  while (segStart > 0 && !/[;&|\n(){}`]/.test(code[segStart - 1]!)) segStart--;
  return code
    .slice(segStart, idx)
    .trim()
    .split(/\s+/)
    .every((t) => t === "" || LAUNCHERS.has(t) || /^[A-Za-z_]\w*=/.test(t));
}

export function unboundedWatch(command: string): boolean {
  const { code } = views(command);
  const inert = inertHeredocs(command);
  for (const re of WATCHES) {
    for (const m of code.matchAll(re)) {
      const idx = m.index!;
      if (inert.some(([a, b]) => idx >= a && idx < b)) continue;
      const wrap = wrapperBefore(code, idx);
      if (wrap.overCap) return true;
      if (wrap.bounded) continue;
      if (atCommandPosition(code, idx)) return true;
    }
  }
  return false;
}
