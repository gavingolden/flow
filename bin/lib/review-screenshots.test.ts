import { describe, expect, it } from "vitest";
import {
  applyHostedUrls,
  hasLocalImageRefs,
  hostedUrls,
  planScreenshots,
  stripLocalImageRefs,
} from "./review-screenshots";

const WT = "/w/repo";
const REAL = "![real](.flow-tmp/ui-evidence/a.png)";
const QUOTED = "![q](.flow-tmp/ui-evidence/q.png)";
const hashFile = (p: string) => `sha:${path(p)}`;
const path = (p: string) => p.split("/").pop();

function plan(body: string, ledger: Record<string, string> = {}) {
  return planScreenshots({
    body,
    worktree: WT,
    attachSupported: true,
    ledger,
    hashFile,
  });
}

describe("image syntax quoted in inline code", () => {
  const body = `Use \`${QUOTED}\` to embed.\n`;

  it("is not a local image ref", () => {
    expect(hasLocalImageRefs(body)).toBe(false);
  });

  it("is left byte-identical by strip and plan, with nothing attached", () => {
    expect(stripLocalImageRefs(body)).toBe(body);
    const p = plan(body, { "sha:q.png": "https://x/y" });
    expect(p.attach).toEqual([]);
    expect(p.body).toBe(body);
    expect(p.bodyWithoutImages).toBe(body);
    expect(p.skip).toBeUndefined();
  });

  it("handles a double-backtick span containing image syntax", () => {
    const b = "Write ``a ` ![q](.flow-tmp/x.png) b`` here\n";
    expect(hasLocalImageRefs(b)).toBe(false);
    expect(stripLocalImageRefs(b)).toBe(b);
  });

  it("raises no outside-worktree note when only quoted paths escape", () => {
    const b = "Quoted `![q](../../etc/x.png)` only\n";
    const p = plan(b);
    expect(p.skip).toBeUndefined();
    expect(p.notes).toBeUndefined();
  });
});

describe("image syntax inside fenced blocks", () => {
  it.each([
    ["backtick", "```", "```"],
    ["tilde", "~~~", "~~~"],
    ["widened", "````", "````"],
  ])("strip leaves a %s fence byte-identical", (_n, open, close) => {
    const body = `a\n${open}md\n${QUOTED}\ntext ${QUOTED} more\n${close}\nb\n`;
    expect(stripLocalImageRefs(body)).toBe(body);
    expect(hasLocalImageRefs(body)).toBe(false);
    expect(plan(body).attach).toEqual([]);
  });

  it("an unclosed fence protects its content to EOF", () => {
    const body = `a\n\`\`\`\n${QUOTED}\n`;
    expect(stripLocalImageRefs(body)).toBe(body);
  });
});

describe("real image beside a code span", () => {
  it("attaches and strips only the real image", () => {
    const body = `${REAL} see \`${QUOTED}\`\n`;
    const p = plan(body);
    expect(p.attach.map((a) => a.target)).toEqual([
      ".flow-tmp/ui-evidence/a.png",
    ]);
    expect(stripLocalImageRefs(body)).toBe(` see \`${QUOTED}\`\n`);
  });

  it("an image-only line is dropped while a quoted one survives", () => {
    const body = `${REAL}\n\`${QUOTED}\`\n`;
    expect(stripLocalImageRefs(body)).toBe(`\`${QUOTED}\`\n`);
  });
});

describe("hostedUrls pairing", () => {
  it("pairs the n-th real image with the n-th hosted URL despite quoted images", () => {
    const pushed = `\`${QUOTED}\`\n${REAL}\n\`${QUOTED}\`\n`;
    const remote = `\`${QUOTED}\`\n![real](https://h/1)\n\`${QUOTED}\`\n`;
    const attach = [
      { target: ".flow-tmp/ui-evidence/a.png", arg: "", sha: "s" },
    ];
    const urls = hostedUrls(pushed, remote, attach);
    expect([...urls]).toEqual([[".flow-tmp/ui-evidence/a.png", "https://h/1"]]);
    expect(applyHostedUrls(pushed, urls)).toBe(
      `\`${QUOTED}\`\n![real](https://h/1)\n\`${QUOTED}\`\n`,
    );
  });

  it("does not count quoted images, so differing quoted counts still pair", () => {
    const pushed = `${REAL}\n\`${QUOTED}\`\n`;
    const remote = `![real](https://h/1)\n`;
    const attach = [
      { target: ".flow-tmp/ui-evidence/a.png", arg: "", sha: "s" },
    ];
    expect(hostedUrls(pushed, remote, attach).size).toBe(1);
    const remote2 = `![real](https://h/1)\n\`${QUOTED}\`\n`;
    expect(hostedUrls(pushed, remote2, attach).size).toBe(1);
  });
});

describe("same path as real image and quoted copy", () => {
  const body = `${REAL}\nQuote: \`${REAL}\`\n`;

  it("applyHostedUrls rewrites only the real image", () => {
    const urls = new Map([[".flow-tmp/ui-evidence/a.png", "https://h/1"]]);
    expect(applyHostedUrls(body, urls)).toBe(
      `![real](https://h/1)\nQuote: \`${REAL}\`\n`,
    );
  });

  it("the planScreenshots ledger swap leaves the quoted copy byte-identical", () => {
    const p = plan(body, { "sha:a.png": "https://h/1" });
    expect(p.body).toBe(`![real](https://h/1)\nQuote: \`${REAL}\`\n`);
  });
});
