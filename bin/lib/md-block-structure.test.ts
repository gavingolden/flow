import { describe, expect, it } from "vitest";
import {
  findDetailsBlockDefects,
  findUnterminatedHtmlBlockLines,
  normalizeDetailsBlocks,
} from "./md-block-structure";

describe("normalizeDetailsBlocks", () => {
  it("inserts a blank line after a line ending in </summary>", () => {
    const body = "<details><summary>x</summary>\ncontent\n</details>\n";
    const { body: out, insertions } = normalizeDetailsBlocks(body);
    // </details> is the document's last content line — no following
    // content exists for an unterminated block to swallow, so no
    // insertion happens there (matches the "last line" idempotence
    // clause). Only the </summary> mid-document line is fixed.
    expect(out).toBe("<details><summary>x</summary>\n\ncontent\n</details>\n");
    expect(insertions).toBe(1);
  });

  it("inserts a blank line after a line ending in </details>", () => {
    const body = "before\n</details>\nafter\n";
    const { body: out, insertions } = normalizeDetailsBlocks(body);
    expect(out).toBe("before\n</details>\n\nafter\n");
    expect(insertions).toBe(1);
  });

  it("leaves fenced content untouched, including a four-backtick fence", () => {
    const body = "````text\n<summary>fake</summary>\n</details>\n````\nafter\n";
    const { body: out, insertions } = normalizeDetailsBlocks(body);
    expect(out).toBe(body);
    expect(insertions).toBe(0);
  });

  it("does not close a four-backtick fence on a shorter three-backtick line", () => {
    const body = "````text\n```\nstill fenced </details>\n````\nafter\n";
    const { body: out, insertions } = normalizeDetailsBlocks(body);
    expect(out).toBe(body);
    expect(insertions).toBe(0);
  });

  it("is depth-independent: unbalanced/nested </details> spliced mid-body normalizes flatly", () => {
    const body =
      "<details><summary>a</summary>\n</details>\nextra </details>\nmore </details>\ntail\n";
    const { body: out, insertions } = normalizeDetailsBlocks(body);
    // Every qualifying line gets exactly one blank line after it,
    // regardless of the unbalanced </details> count.
    expect(out).toBe(
      "<details><summary>a</summary>\n\n</details>\n\nextra </details>\n\nmore </details>\n\ntail\n",
    );
    expect(insertions).toBe(4);
  });

  it("is idempotent: normalizing twice equals normalizing once", () => {
    const body =
      "<details><summary>a</summary>\ncontent\n</details>\nnext </details>\ntail";
    const once = normalizeDetailsBlocks(body);
    const twice = normalizeDetailsBlocks(once.body);
    expect(twice.body).toBe(once.body);
    expect(twice.insertions).toBe(0);
  });

  it("is insert-only: never removes or reorders existing lines", () => {
    const body = "a\n</details>\nb\nc\n";
    const { body: out } = normalizeDetailsBlocks(body);
    const outLines = out.split("\n").filter((l) => l !== "");
    expect(outLines).toEqual(["a", "</details>", "b", "c"]);
  });

  it("preserves CRLF terminators", () => {
    const body = "a\r\n</details>\r\nb\r\n";
    const { body: out, insertions } = normalizeDetailsBlocks(body);
    expect(out).toBe("a\r\n</details>\r\n\r\nb\r\n");
    expect(insertions).toBe(1);
  });

  it("preserves trailing-newline state: present stays present", () => {
    const body = "</details>\nafter\n";
    const { body: out } = normalizeDetailsBlocks(body);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("preserves trailing-newline state: absent stays absent, and no insertion after the final line", () => {
    const body = "text\n</details>";
    const { body: out, insertions } = normalizeDetailsBlocks(body);
    expect(out).toBe(body);
    expect(out.endsWith("\n")).toBe(false);
    expect(insertions).toBe(0);
  });

  it("does not insert when the next line is already blank", () => {
    const body = "</summary>\n\ncontent\n";
    const { body: out, insertions } = normalizeDetailsBlocks(body);
    expect(out).toBe(body);
    expect(insertions).toBe(0);
  });

  it("reports an accurate insertions count across a mixed body", () => {
    const body =
      "<summary>a</summary>\nx\n</details>\n<summary>b</summary>\n\n</details>\ntail\n";
    const { insertions } = normalizeDetailsBlocks(body);
    // Two missing (first </summary>, first </details>); the second
    // </summary> already has a blank line after it; the second
    // </details> is the last non-empty content and needs one.
    expect(insertions).toBe(3);
  });
});

describe("findDetailsBlockDefects", () => {
  it("reports the right line numbers and kinds, and does not mutate", () => {
    const body = "<summary>a</summary>\nx\n</details>\ntail\n";
    const defects = findDetailsBlockDefects(body);
    expect(defects).toEqual([
      { line: 0, kind: "missing-blank-after-summary" },
      { line: 2, kind: "missing-blank-after-details-close" },
    ]);
    // detect-only: the input body is untouched (no mutation possible —
    // the function returns a fresh array and takes body by value, but
    // assert the original string reference is unaffected as a guard
    // against a future accidental in-place edit).
    expect(body).toBe("<summary>a</summary>\nx\n</details>\ntail\n");
  });

  it("reports nothing for an already-normalized body", () => {
    const body = "<summary>a</summary>\n\n</details>\n\ntail\n";
    expect(findDetailsBlockDefects(body)).toEqual([]);
  });

  it("skips fenced content", () => {
    const body = "```text\n</details>\n```\nafter\n";
    expect(findDetailsBlockDefects(body)).toEqual([]);
  });
});

describe("findUnterminatedHtmlBlockLines", () => {
  it("marks every line from an open <details> to EOF when no blank line ever closes it", () => {
    const body = "intro\n<details>\n- [ ] a\n- [ ] b\n";
    const trapped = findUnterminatedHtmlBlockLines(body);
    expect(trapped).toEqual(new Set([1, 2, 3]));
  });

  it("does not mark lines inside a block that IS closed by a later blank line", () => {
    const body = "<details>\n- [ ] a\n\n- [ ] b\n";
    const trapped = findUnterminatedHtmlBlockLines(body);
    expect(trapped).toEqual(new Set());
  });

  it("re-opens tracking after a properly closed block", () => {
    const body = "<details>\nclosed\n\n<details>\nunclosed\n";
    const trapped = findUnterminatedHtmlBlockLines(body);
    expect(trapped).toEqual(new Set([3, 4]));
  });
});
