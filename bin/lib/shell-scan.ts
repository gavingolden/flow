/**
 * Quote-aware command scanner shared by `flow-bg-loop-guard` and its poll
 * detectors. A small purpose-built scanner: a general shell parser is
 * overkill, and the splitter in the sibling guard conflates `&` with
 * `&&`/`;`/`|`.
 */

export type Views = { code: string; sub: string };

const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/y;

/** Index just past the closing tag of a heredoc opened at `i`, or -1. */
function heredocEnd(command: string, i: number): number {
  if (command[i] !== "<" || command[i + 1] !== "<" || command[i + 2] === "<") {
    return -1;
  }
  HEREDOC_OPEN.lastIndex = i;
  const m = HEREDOC_OPEN.exec(command);
  if (!m) return -1;
  const rest = command.slice(i + m[0].length);
  const close = new RegExp(`\\n[ \\t]*${m[2]}[ \\t]*(?=\\n|\\)|$)`).exec(rest);
  return close ? i + m[0].length + close.index + close[0].length : -1;
}

/**
 * `code`: every quoted span and `#` comment blanked, so quoted text never
 * matches. `sub`: only single-quoted spans and comments blanked (double
 * quotes still run `$(…)`). Both keep the original length. A `"$(…)"` span
 * is tracked as a unit, so quotes and heredocs inside it cannot close the
 * outer double quote early.
 */
export function views(command: string): Views {
  let code = "";
  let sub = "";
  let quote: string | null = null;
  let subDepth = 0;
  let inner: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      code += " ";
      sub += " ";
    } else if (quote === '"' && subDepth > 0) {
      let take = 1;
      if (c === "\\") take = 2;
      else if (inner) {
        if (c === inner) inner = null;
      } else if (c === "'" || c === '"') inner = c;
      else if (c === "(") subDepth++;
      else if (c === ")") subDepth--;
      else {
        const end = heredocEnd(command, i);
        if (end > i) take = end - i;
      }
      const chunk = command.slice(i, i + take);
      code += " ".repeat(chunk.length);
      sub += chunk;
      i += chunk.length - 1;
    } else if (quote === '"') {
      if (c === "\\") {
        code += "  ";
        sub += c + (command[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === '"') quote = null;
      if (c === "$" && command[i + 1] === "(") {
        subDepth = 1;
        code += "  ";
        sub += "$(";
        i++;
        continue;
      }
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
    } else if (c === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      let end = command.indexOf("\n", i);
      if (end === -1) end = command.length;
      code += " ".repeat(end - i);
      sub += " ".repeat(end - i);
      i = end - 1;
    } else {
      code += c;
      sub += c;
    }
  }
  return { code, sub };
}
