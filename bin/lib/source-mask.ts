// Offset-preserving TypeScript source masker shared by the repo-scan lint tests.

const REGEX_PRECEDERS = "(,=:[!&|?{};>";
const REGEX_KEYWORD_RE =
  /(?:^|[^\w$.])(?:return|case|throw|typeof|void|delete|yield|await)\s*$/;

/** Blanks comments and string/template/regex contents; keeps `${...}` code and offsets. */
export function maskLiterals(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src[k] !== "\n") out[k] = " ";
  };
  const template = () => {
    const start = ++i;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        blank(start, i);
        i += 2;
        code(true);
        return template2(i);
      } else i++;
    }
    blank(start, i);
    i++;
  };
  const template2 = (from: number) => {
    const start = from;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        blank(start, i);
        i += 2;
        code(true);
        return template2(i);
      } else i++;
    }
    blank(start, i);
    i++;
  };
  let prev = "";
  const code = (untilCloseBrace: boolean) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        const end = nl < 0 ? src.length : nl;
        blank(i, end);
        i = end;
      } else if (c === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i + 2);
        const end = close < 0 ? src.length : close + 2;
        blank(i, end);
        i = end;
      } else if (c === '"' || c === "'") {
        const start = ++i;
        while (i < src.length && src[i] !== c && src[i] !== "\n") {
          i += src[i] === "\\" ? 2 : 1;
        }
        blank(start, i);
        i++;
        prev = c;
      } else if (c === "`") {
        template();
        prev = "`";
      } else if (
        c === "/" &&
        (prev === "" ||
          REGEX_PRECEDERS.includes(prev) ||
          REGEX_KEYWORD_RE.test(src.slice(Math.max(0, i - 12), i)))
      ) {
        const start = ++i;
        let inClass = false;
        while (i < src.length && src[i] !== "\n") {
          if (src[i] === "\\") i++;
          else if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          else if (src[i] === "/" && !inClass) break;
          i++;
        }
        blank(start, i);
        i++;
        prev = "/";
      } else {
        if (untilCloseBrace) {
          if (c === "{") depth++;
          else if (c === "}" && depth-- === 0) {
            i++;
            return;
          }
        }
        if (!/\s/.test(c)) prev = c;
        i++;
      }
    }
  };
  code(false);
  return out.join("");
}
