/**
 * Quote-aware command scanner shared by `flow-bg-loop-guard` and its poll
 * detectors. A small purpose-built scanner: a general shell parser is
 * overkill, and the splitter in the sibling guard conflates `&` with
 * `&&`/`;`/`|`.
 */

export type Views = { code: string; sub: string };

/**
 * `code`: every quoted span blanked, so quoted text never matches. `sub`:
 * only single-quoted spans blanked (double quotes still run `$(…)`).
 * Both keep the original length.
 */
export function views(command: string): Views {
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
