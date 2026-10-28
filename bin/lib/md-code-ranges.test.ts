import { describe, expect, it } from "vitest";
import { codeRanges, inCode } from "./md-code-ranges";

const spans = (body: string) =>
  codeRanges(body).map((r) => body.slice(r.start, r.end));

describe("codeRanges inline spans", () => {
  it("finds single and double backtick spans", () => {
    expect(spans("a `b` c ``d`` e")).toEqual(["`b`", "``d``"]);
  });

  it("allows a single backtick inside double-backtick delimiters", () => {
    expect(spans("x ``a ` b`` y")).toEqual(["``a ` b``"]);
  });

  it("treats an unmatched backtick run as literal text", () => {
    expect(spans("a ` b")).toEqual([]);
    expect(spans("a ``b` c")).toEqual([]);
  });

  it("does not let a shorter later run close a longer opener but pairs later runs", () => {
    expect(spans("``a` `b`")).toEqual(["` `"]);
  });

  it("treats a backslash-escaped backtick outside code as literal", () => {
    expect(spans("a \\`b` c")).toEqual([]);
    expect(spans("a \\\\`b` c")).toEqual(["`b`"]);
  });

  it("lets a span cross a single newline but not a blank line", () => {
    expect(spans("a `b\nc` d")).toEqual(["`b\nc`"]);
    expect(spans("a `b\n\nc` d")).toEqual([]);
  });
});

describe("codeRanges fences", () => {
  it("covers backtick and tilde fences including fence lines", () => {
    const body = "a\n```\nx\n```\nb\n~~~\ny\n~~~\nc";
    expect(spans(body)).toEqual(["```\nx\n```", "~~~\ny\n~~~"]);
  });

  it("keeps a widened fence open across an inner ``` line", () => {
    const body = "````\n```\nx\n````\nafter `s`";
    expect(spans(body)).toEqual(["````\n```\nx\n````", "`s`"]);
  });

  it("runs an unclosed fence to EOF", () => {
    const body = "a `b`\n```\nx `y`\nz";
    expect(spans(body)).toEqual(["`b`", "```\nx `y`\nz"]);
  });

  it("treats a line starting with ```x``` as an inline span", () => {
    const body = "```x``` tail\nnext";
    expect(spans(body)).toEqual(["```x```"]);
  });

  it("never lets an inline span cross into a fenced block", () => {
    const body = "a `b\n```\nc`\n```\nd";
    expect(spans(body)).toEqual(["```\nc`\n```"]);
  });
});

describe("inCode", () => {
  it("reports membership by index with exclusive end", () => {
    const body = "ab `cd` ef";
    const r = codeRanges(body);
    expect(inCode(r, 2)).toBe(false);
    expect(inCode(r, 3)).toBe(true);
    expect(inCode(r, 6)).toBe(true);
    expect(inCode(r, 7)).toBe(false);
    expect(inCode([], 0)).toBe(false);
  });
});
