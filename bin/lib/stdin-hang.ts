/**
 * Detector for commands that can wait on stdin forever. Claude Code runs each
 * call as `eval '<command>' < /dev/null` unless the command text holds a `<`
 * it reads as a redirect (some quoted ones too); then the shell keeps a socket
 * stdin that never reaches EOF. A stdin reader whose only file operands are
 * `$(…)` substitutions hangs when they expand to nothing, and a foreground
 * call that times out keeps waiting in the background.
 *
 * The predicate matches the 60-day transcript census exactly: at least one
 * substitution operand, no `/dev/null` operand, no `<` redirect on the stage
 * or its enclosing group, and the reader not fed by a pipe.
 */

export const STDIN_READERS: ReadonlySet<string> = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "cat",
  "head",
  "tail",
  "wc",
  "sed",
  "awk",
  "sort",
  "uniq",
  "cut",
]);

const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk"]);
const VALUE_OPTS: Record<string, string[]> = {
  grep: ["-A", "-B", "-C", "-m", "-e", "-f"],
  egrep: ["-A", "-B", "-C", "-m", "-e", "-f"],
  fgrep: ["-A", "-B", "-C", "-m", "-e", "-f"],
  rg: ["-A", "-B", "-C", "-m", "-e", "-f", "-g", "-t", "-T"],
  head: ["-n", "-c"],
  tail: ["-n", "-c"],
  cut: ["-d", "-f", "-c", "-b"],
  sort: ["-k", "-t", "-o", "-S"],
  uniq: ["-f", "-s", "-w"],
  sed: ["-e", "-f"],
  awk: ["-F", "-v", "-f"],
};
const PATTERN_OPTS = new Set(["-e", "-f"]);
const SKIP_WORDS = new Set([
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "time",
  "command",
  "env",
  "nice",
  "exec",
]);

type Stage = {
  words: string[];
  fed: boolean;
  redirected: boolean;
  frames: number[];
};

/** Drops heredoc bodies (the line after `<<[-]WORD` through the closing WORD). */
function stripHeredocBodies(command: string): string {
  const out: string[] = [];
  let pending: Array<{ word: string; dash: boolean }> = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      const head = pending[0]!;
      if ((head.dash ? line.trim() : line.trimEnd()) === head.word) {
        pending = pending.slice(1);
      }
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(
      /(?<!<)<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?(\w+))(?!<)/g,
    )) {
      pending.push({ word: m[2] ?? m[3] ?? m[4] ?? "", dash: m[1] === "-" });
    }
  }
  return out.join("\n");
}

/** Index just past the `)` that balances the `(` at `open`. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") i++;
    else if (c === "'") i = (text.indexOf("'", i + 1) + 1 || text.length) - 1;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** One shell word starting at `i`; single-quoted text is masked, not dropped. */
function readWord(text: string, start: number): { word: string; end: number } {
  let i = start;
  let word = "";
  while (i < text.length) {
    const c = text[i]!;
    if (/[\s;|&()<>]/.test(c)) break;
    if (c === "\\") {
      word += c + (text[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      word += `'${"x".repeat(end - i - 1)}'`;
      i = end + 1;
    } else if (c === "$" && text[i + 1] === "(") {
      const end = closeParen(text, i + 1);
      word += text.slice(i, end);
      i = end;
    } else if (c === "`") {
      const close = text.indexOf("`", i + 1);
      const end = close === -1 ? text.length : close + 1;
      word += text.slice(i, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        else if (text[j] === "$" && text[j + 1] === "(")
          j = closeParen(text, j + 1) - 1;
        j++;
      }
      word += text.slice(i, j + 1);
      i = j + 1;
    } else {
      word += c;
      i++;
    }
  }
  return { word, end: i };
}

const REDIRECT = /^\d*(<<<|<<-?|<&?|>>|>&|>\||>|&>>|&>)/;

function substitutionsIn(word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "'") {
      i = (word.indexOf("'", i + 1) + 1 || word.length) - 1;
    } else if (word[i] === "$" && word[i + 1] === "(") {
      const end = closeParen(word, i + 1);
      out.push(word.slice(i + 2, end - 1));
      i = end - 1;
    } else if (word[i] === "`") {
      const close = word.indexOf("`", i + 1);
      const end = close === -1 ? word.length : close;
      out.push(word.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

function scan(text: string, out: Stage[]): void {
  const stages: Stage[] = [];
  const frameStack: number[] = [];
  const redirectedFrames = new Set<number>();
  let nextFrame = 0;
  let lastClosed: number | null = null;
  let fed = false;
  let cur: Stage = { words: [], fed, redirected: false, frames: [] };
  const endStage = (nextFed: boolean): void => {
    if (cur.words.length > 0) stages.push(cur);
    fed = nextFed;
    cur = { words: [], fed, redirected: false, frames: [...frameStack] };
  };
  const open = (): void => {
    endStage(false);
    frameStack.push(nextFrame++);
    cur.frames = [...frameStack];
    lastClosed = null;
  };
  const close = (): void => {
    endStage(false);
    lastClosed = frameStack.pop() ?? null;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t") {
      i++;
    } else if (c === "\n" || c === ";") {
      endStage(false);
      lastClosed = null;
      i++;
    } else if (c === "|") {
      endStage(text[i + 1] !== "|");
      lastClosed = null;
      i += text[i + 1] === "|" || text[i + 1] === "&" ? 2 : 1;
    } else if (c === "&" && text[i + 1] === "&") {
      endStage(false);
      lastClosed = null;
      i += 2;
    } else if (c === "(") {
      open();
      i++;
    } else if (c === ")") {
      close();
      i++;
    } else {
      const rest = text.slice(i);
      const redirect =
        c === "<" && text[i + 1] === "(" ? null : REDIRECT.exec(rest);
      if (redirect) {
        i += redirect[0].length;
        while (text[i] === " " || text[i] === "\t") i++;
        const target = readWord(text, i);
        i = target.end;
        if (redirect[1]!.startsWith("<")) {
          if (lastClosed !== null) redirectedFrames.add(lastClosed);
          else cur.redirected = true;
        }
      } else if (c === "&") {
        endStage(false);
        i++;
      } else {
        const w = c === "<" ? readProcessSub(text, i) : readWord(text, i);
        i = w.end > i ? w.end : i + 1;
        if (w.word === "{") open();
        else if (w.word === "}") close();
        else {
          cur.words.push(w.word);
          lastClosed = null;
        }
      }
    }
  }
  endStage(false);
  for (const s of stages) {
    s.redirected ||= s.frames.some((f) => redirectedFrames.has(f));
    out.push(s);
    for (const w of s.words)
      for (const inner of substitutionsIn(w)) scan(inner, out);
  }
}

function readProcessSub(
  text: string,
  i: number,
): { word: string; end: number } {
  const end = closeParen(text, i + 1);
  return { word: text.slice(i, end), end };
}

const isSubstitution = (w: string): boolean =>
  /^"?(?:\$\(|`)/.test(w) && /(?:\)|`)"?$/.test(w);

function commandWords(words: string[]): string[] {
  let i = 0;
  while (
    i < words.length &&
    (SKIP_WORDS.has(words[i]!) || /^[A-Za-z_]\w*=/.test(words[i]!))
  ) {
    i++;
  }
  return words.slice(i);
}

function hangsOnSubstitutions(words: string[]): boolean {
  const [cmd, ...args] = commandWords(words);
  const name = cmd?.slice(cmd.lastIndexOf("/") + 1) ?? "";
  if (!STDIN_READERS.has(name)) return false;
  const valueOpts = new Set(VALUE_OPTS[name] ?? []);
  const operands: string[] = [];
  let patternGiven = false;
  let afterDashes = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (!afterDashes && a === "--") afterDashes = true;
    else if (!afterDashes && a.startsWith("-") && a.length > 1) {
      if (PATTERN_OPTS.has(a) && PATTERN_FIRST.has(name)) patternGiven = true;
      if (valueOpts.has(a)) k++;
    } else {
      operands.push(a);
    }
  }
  const files =
    PATTERN_FIRST.has(name) && !patternGiven ? operands.slice(1) : operands;
  return files.length > 0 && files.every(isSubstitution);
}

export function stdinHang(command: string): boolean {
  const text = stripHeredocBodies(command);
  if (!text.includes("<")) return false;
  const stages: Stage[] = [];
  scan(text, stages);
  return stages.some(
    (s) => !s.fed && !s.redirected && hangsOnSubstitutions(s.words),
  );
}
