import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  batchImages,
  classifyExternalImages,
  collectLocalImages,
  harvestTokenUrls,
  hasLocalImageRefs,
  needsAttach,
  pushBodyWithScreenshots,
  renderHostedBody,
  stripLocalImageRefs,
  uploadToken,
  type ExecResult,
} from "./review-screenshots";

const WT = "/w/repo";
const REAL = "![real](.flow-tmp/ui-evidence/a.png)";
const QUOTED = "![q](.flow-tmp/ui-evidence/q.png)";
const base = (p: string) => p.split("/").pop() as string;
const hashFile = (p: string) =>
  createHash("sha256").update(base(p)).digest("hex");
const tokenOf = (name: string) => uploadToken(hashFile(name));
const urlOf = (name: string) =>
  `https://github.com/user-attachments/assets/u-${tokenOf(name).slice(9)}`;
const HOSTED = "https://github.com/user-attachments/assets/";
const SHA40 = "a".repeat(40);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d]);

const placeholderFor = (name: string) => `_(screenshot not uploaded: ${name})_`;

describe("image syntax quoted in inline code", () => {
  const body = `Use \`${QUOTED}\` to embed.\n`;

  it("is not a local image ref, and nothing is collected", () => {
    expect(hasLocalImageRefs(body)).toBe(false);
    expect(collectLocalImages(body, WT, hashFile).images).toEqual([]);
  });

  it("is left byte-identical by strip and render", () => {
    expect(stripLocalImageRefs(body)).toBe(body);
    const urls = new Map([[".flow-tmp/ui-evidence/q.png", "https://x/y"]]);
    expect(renderHostedBody(body, urls)).toBe(body);
  });

  it("handles a double-backtick span containing image syntax", () => {
    const b = "Write ``a ` ![q](.flow-tmp/x.png) b`` here\n";
    expect(hasLocalImageRefs(b)).toBe(false);
    expect(stripLocalImageRefs(b)).toBe(b);
  });

  it("raises no outside-worktree finding when only quoted paths escape", () => {
    const b = "Quoted `![q](../../etc/x.png)` only\n";
    expect(collectLocalImages(b, WT, hashFile).outside).toEqual([]);
  });
});

describe("image syntax inside fenced blocks", () => {
  it.each([
    ["backtick", "```", "```"],
    ["tilde", "~~~", "~~~"],
    ["widened", "````", "````"],
  ])("leaves a %s fence byte-identical, <img> included", (_n, open, close) => {
    const img = '<img src="x/q.png" width="9">';
    const body = `a\n${open}md\n${QUOTED}\ntext ${QUOTED} ${img}\n${close}\nb\n`;
    expect(stripLocalImageRefs(body)).toBe(body);
    expect(hasLocalImageRefs(body)).toBe(false);
    expect(collectLocalImages(body, WT, hashFile).images).toEqual([]);
    const urls = new Map([["x/q.png", "https://h/1"]]);
    expect(renderHostedBody(body, urls)).toBe(body);
  });

  it("an unclosed fence protects its content to EOF", () => {
    const body = `a\n\`\`\`\n${QUOTED}\n`;
    expect(stripLocalImageRefs(body)).toBe(body);
  });
});

describe("real image beside a code span", () => {
  it("collects and strips only the real image", () => {
    const body = `${REAL} see \`${QUOTED}\`\n`;
    const { images } = collectLocalImages(body, WT, hashFile);
    expect(images.map((i) => i.targets)).toEqual([
      [".flow-tmp/ui-evidence/a.png"],
    ]);
    expect(stripLocalImageRefs(body)).toBe(
      `${placeholderFor("a.png")} see \`${QUOTED}\`\n`,
    );
  });

  it("renders only the real image when the same path is also quoted", () => {
    const body = `${REAL}\nQuote: \`${REAL}\`\n`;
    const urls = new Map([[".flow-tmp/ui-evidence/a.png", "https://h/1"]]);
    expect(renderHostedBody(body, urls)).toBe(
      `![real](https://h/1)\nQuote: \`${REAL}\`\n`,
    );
  });
});

describe("<img> detection and rewriting", () => {
  const TABLE = [
    "<details open>",
    "<summary>Before / after</summary>",
    "",
    "<table><tr>",
    '<td><img src="img/a.png" width="260"></td>',
    "<td><img src='./img/a.png' width='260' alt='a again'></td>",
    '<td><img\n  alt="b"\n  src=img/b.png\n  width="260"\n/></td>',
    '<td><img width="90" src="img/c.png"/></td>',
    "</tr></table>",
    "</details>",
    "",
  ].join("\n");

  it("sees single-quoted, multi-line and unquoted src as local refs", () => {
    expect(hasLocalImageRefs(TABLE)).toBe(true);
    expect(hasLocalImageRefs('<img src="https://h/x.png">')).toBe(false);
    expect(needsAttach('<img src="img/a.png">')).toBe(true);
  });

  it("shares one upload between ./img/a.png and img/a.png", () => {
    const { images } = collectLocalImages(TABLE, WT, hashFile);
    expect(images.map((i) => i.targets)).toEqual([
      ["img/a.png", "./img/a.png"],
      ["img/b.png"],
      ["img/c.png"],
    ]);
  });

  it("swaps only the src value so every width survives", () => {
    const urls = new Map([
      ["img/a.png", "https://h/a"],
      ["./img/a.png", "https://h/a"],
      ["img/b.png", "https://h/b"],
      ["img/c.png", "https://h/c"],
    ]);
    const out = renderHostedBody(TABLE, urls);
    expect(out).toContain('<img src="https://h/a" width="260">');
    expect(out).toContain("<img src='https://h/a' width='260' alt='a again'>");
    expect(out).toContain('alt="b"\n  src=https://h/b\n  width="260"\n/>');
    expect(out).toContain('<img width="90" src="https://h/c"/>');
    expect(out).not.toMatch(/img\/[abc]\.png/);
  });

  it("strips a tag to a visible placeholder", () => {
    expect(stripLocalImageRefs('x <img src="img/a_1.png" width="9"> y')).toBe(
      "x _(screenshot not uploaded: a\\_1.png)_ y",
    );
  });
});

describe("collectLocalImages", () => {
  it("reports outside, missing and '#' paths without collecting them", () => {
    const body = "![o](../x.png) ![m](m.png) ![h](dir#1/h.png) ![n](n.svg)";
    const found = collectLocalImages(body, WT, (p) =>
      p.endsWith("m.png") ? null : hashFile(p),
    );
    expect(found.images).toEqual([]);
    expect(found.outside).toEqual(["../x.png"]);
    expect(found.missing).toEqual(["m.png"]);
    expect(found.unattachable).toEqual(["dir#1/h.png"]);
  });
});

describe("batchImages / uploadToken / harvestTokenUrls", () => {
  it("splits 55 items into batches of 50 and 5", () => {
    const items = Array.from({ length: 55 }, (_, i) => i);
    expect(batchImages(items).map((b) => b.length)).toEqual([50, 5]);
    expect(batchImages([])).toEqual([]);
  });

  it("builds a 16-hex token", () => {
    expect(uploadToken("0123456789abcdef0123")).toBe(
      "flow-img-0123456789abcdef",
    );
  });

  it("harvests both embed shapes and ignores unrelated or non-https images", () => {
    const remote = [
      "body ![other](https://h/other)",
      "![flow-img-aaaa](https://github.com/user-attachments/assets/1)",
      '<img width="400" alt="flow-img-bbbb" src="https://github.com/user-attachments/assets/2" />',
      "![flow-img-cccc](http://insecure/3)",
    ].join("\n");
    const got = harvestTokenUrls(remote, [
      "flow-img-aaaa",
      "flow-img-bbbb",
      "flow-img-cccc",
    ]);
    expect([...got]).toEqual([
      ["flow-img-aaaa", "https://github.com/user-attachments/assets/1"],
      ["flow-img-bbbb", "https://github.com/user-attachments/assets/2"],
    ]);
  });
});

describe("classifyExternalImages", () => {
  const body = [
    "![a](https://github.com/me/repo/blob/" + SHA40 + "/static/x.png?raw=true)",
    "![b](https://raw.githubusercontent.com/me/repo/main/docs/y.png)",
    "![c](https://github.com/other/repo/blob/main/z.png?raw=true)",
    "![d](https://gist.githubusercontent.com/u/1/raw/g.png)",
    "![e](https://i.imgur.com/q.png)",
    "![f](https://github.com/user-attachments/assets/ok)",
    "![g](https://img.shields.io/badge/x-y-green)",
  ].join("\n");

  it("re-hosts own-repo links and flags the other outside hosts", () => {
    const got = classifyExternalImages(body, "Me/Repo");
    expect(got.rehostable.map((r) => [r.ref, r.path])).toEqual([
      [SHA40, "static/x.png"],
      ["main", "docs/y.png"],
    ]);
    expect(got.flagged).toEqual([
      "https://github.com/other/repo/blob/main/z.png?raw=true",
      "https://gist.githubusercontent.com/u/1/raw/g.png",
      "https://i.imgur.com/q.png",
    ]);
  });

  it("flags everything repo-hosted when the PR repo is unknown", () => {
    expect(classifyExternalImages(body, "").rehostable).toEqual([]);
  });
});

type Gh = {
  calls: string[][];
  pushed: string[];
  files: Map<string, string>;
  written: Map<string, Buffer>;
  io: Parameters<typeof pushBodyWithScreenshots>[0];
  remote: () => string;
};

/** In-memory gh: `--attach` appends `![token](url)` embeds; `--body-file` replaces the body. */
function makeGh(
  body: string,
  o: {
    version?: string;
    remote?: string;
    landBeforeFail?: number;
    failView?: boolean;
    noWriteBytes?: boolean;
  } = {},
): Gh {
  const files = new Map<string, string>([[`${WT}/body.md`, body]]);
  const written = new Map<string, Buffer>();
  const calls: string[][] = [];
  const pushed: string[] = [];
  let remote = o.remote ?? "";
  const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
  const exec = (argv: string[]): ExecResult => {
    calls.push(argv);
    if (argv[1] === "--version") {
      return ok(`gh version ${o.version ?? "2.101.0"} (2026-09-15)\n`);
    }
    if (argv[1] === "api") {
      if (argv[2].includes("/contents/")) return ok(`${SHA40}\n`);
      return ok(PNG_BYTES.toString("base64").replace(/(.{4})/g, "$1\n"));
    }
    if (argv[2] === "view") {
      if (o.failView) return { stdout: "", stderr: "view down", exitCode: 1 };
      return ok(
        argv.includes("url") ? "https://github.com/me/repo/pull/7\n" : remote,
      );
    }
    const bodyFile = argv[argv.indexOf("--body-file") + 1];
    if (argv.includes("--body-file")) {
      remote = files.get(bodyFile) ?? "";
      pushed.push(remote);
      return ok();
    }
    const attach = argv.filter((_, i) => argv[i - 1] === "--attach");
    attach.forEach((arg, i) => {
      if (o.landBeforeFail !== undefined && i >= o.landBeforeFail) return;
      const token = arg.slice(arg.indexOf("#") + 1);
      remote += `\n![${token}](${HOSTED}u-${token.slice(9)})\n`;
    });
    return o.landBeforeFail !== undefined
      ? { stdout: "", stderr: "upload failed", exitCode: 1 }
      : ok();
  };
  return {
    calls,
    pushed,
    files,
    written,
    remote: () => remote,
    io: {
      exec,
      readFile: (p) => files.get(p) ?? null,
      writeFile: (p, c) => void files.set(p, c),
      hashFile,
      writeBytes: o.noWriteBytes
        ? undefined
        : (p, b) => void written.set(p, Buffer.from(b)),
    },
  };
}

const run = (gh: Gh, attachSupported?: boolean) =>
  pushBodyWithScreenshots(gh.io, {
    prStr: "7",
    bodyFile: `${WT}/body.md`,
    worktree: WT,
    attachSupported,
  });
const attachEdits = (gh: Gh) => gh.calls.filter((c) => c.includes("--attach"));
const bodyAfter = (gh: Gh) => gh.files.get(`${WT}/body.md`) as string;

describe("pushBodyWithScreenshots", () => {
  it("uploads a <details> table of <img width> cells in one batch and rewrites by token", () => {
    const cells = ["a", "b", "c", "d"].map(
      (n) => `<td><img src="img/${n}.png" width="260"></td>`,
    );
    const body = `<details open>\n<summary>S</summary>\n\n<table><tr>\n${cells.join("\n")}\n</tr></table>\n</details>\n\n![m1](img/m1.png)\n\n![m2](img/m2.png)\n`;
    const gh = makeGh(body);
    const result = run(gh);
    expect(attachEdits(gh)).toHaveLength(1);
    expect(attachEdits(gh)[0].filter((a) => a === "--attach")).toHaveLength(6);
    expect(attachEdits(gh)[0]).not.toContain("--body-file");
    expect(result).toMatchObject({ uploaded: 6, reused: 0, batches: 1 });
    const final = bodyAfter(gh);
    expect(final.match(/user-attachments\/assets\//g)).toHaveLength(6);
    expect(final.match(/width="260"/g)).toHaveLength(4);
    expect(final).not.toMatch(/img\/\w+\.png/);
    expect(gh.remote()).toBe(final);
    expect(result.skips).toEqual([]);
    expect(result.edit.exitCode).toBe(0);
  });

  it("uploads 55 images as batches of 50 then 5", () => {
    const names = Array.from({ length: 55 }, (_, i) => `i${i}.png`);
    const gh = makeGh(names.map((n) => `![${n}](img/${n})`).join("\n\n"));
    const result = run(gh);
    expect(
      attachEdits(gh).map((c) => c.filter((a) => a === "--attach").length),
    ).toEqual([50, 5]);
    expect(result).toMatchObject({ uploaded: 55, batches: 2 });
    expect(bodyAfter(gh).match(/user-attachments/g)).toHaveLength(55);
  });

  it("reuses the ledger instead of uploading again", () => {
    const gh = makeGh(`![a](img/a.png)\n`);
    run(gh);
    gh.files.set(`${WT}/body.md`, `![a](img/a.png)\n`);
    gh.calls.length = 0;
    const second = run(gh);
    expect(attachEdits(gh)).toEqual([]);
    expect(second).toMatchObject({ uploaded: 0, reused: 1, batches: 0 });
    expect(bodyAfter(gh)).toContain(`${urlOf("a.png")}`);
  });

  it("a failed batch keeps harvested URLs, pushes placeholders, and leaves local refs in the body file", () => {
    const names = ["a", "b", "c", "d", "e"];
    const gh = makeGh(names.map((n) => `![${n}](img/${n}.png)`).join("\n"), {
      landBeforeFail: 2,
    });
    const result = run(gh);
    const final = bodyAfter(gh);
    expect(final).toContain(`![a](${urlOf("a.png")})`);
    expect(final).toContain(`![b](${urlOf("b.png")})`);
    expect(final).toContain("![c](img/c.png)");
    const live = gh.remote();
    expect(live).not.toContain("img/c.png");
    expect(live).toContain(placeholderFor("c.png"));
    expect(live).not.toContain("flow-img-");
    expect(result.uploaded).toBe(2);
    expect(
      result.skips.find((s) => s.step === "screenshots_upload_failed")?.reason,
    ).toContain("3 screenshot(s)");
    expect(result.edit.exitCode).toBe(0);
  });

  it("still pushes when the read-back fails, with every image a placeholder", () => {
    const gh = makeGh("![a](img/a.png)\n", { failView: true });
    const result = run(gh);
    expect(gh.remote()).toContain(placeholderFor("a.png"));
    expect(result.uploaded).toBe(0);
    expect(result.skips.map((s) => s.step)).toContain(
      "screenshots_upload_failed",
    );
  });

  it("resets a live body that still holds local refs before the first batch", () => {
    const body = "![a](img/a.png)\n";
    const gh = makeGh(body, { remote: body });
    run(gh);
    const firstAttach = gh.calls.findIndex((c) => c.includes("--attach"));
    const reset = gh.calls.findIndex((c) => c.includes("--body-file"));
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(firstAttach);
    expect(gh.pushed[0]).toBe(placeholderFor("a.png") + "\n");
    expect(gh.pushed.at(-1)).toContain(HOSTED);
  });

  it("re-hosts a same-repo blob/<sha>/x.png?raw=true image with its bytes intact", () => {
    const src = `https://github.com/me/repo/blob/${SHA40}/static/x.png?raw=true`;
    const gh = makeGh(`![shot](${src})\n`);
    const result = run(gh);
    const [[abs, bytes]] = [...gh.written];
    expect(abs).toContain("/.flow-tmp/pr-images/rehosted/");
    expect(bytes.equals(PNG_BYTES)).toBe(true);
    expect(result).toMatchObject({ uploaded: 1, rehosted: 1 });
    expect(attachEdits(gh)[0]).toContain(
      `${abs}#${uploadToken(createHash("sha256").update(PNG_BYTES).digest("hex"))}`,
    );
    expect(bodyAfter(gh)).toMatch(
      /!\[shot\]\(https:\/\/github.com\/user-attachments\/assets\//,
    );
    expect(bodyAfter(gh)).not.toContain("raw=true");
    expect(result.skips.map((s) => s.step)).not.toContain(
      "screenshots_external_host",
    );
  });

  it("flags a gist image and still pushes the body", () => {
    const src = "https://gist.githubusercontent.com/u/1/raw/g.png";
    const gh = makeGh(`![g](${src})\n`);
    const result = run(gh);
    expect(result.edit.exitCode).toBe(0);
    expect(gh.remote()).toContain(src);
    expect(result.skips).toEqual([
      expect.objectContaining({ step: "screenshots_external_host" }),
    ]);
    expect(attachEdits(gh)).toEqual([]);
  });

  it("flags a same-repo link when no binary writer is available", () => {
    const src = `https://raw.githubusercontent.com/me/repo/main/x.png`;
    const gh = makeGh(`![x](${src})\n`, { noWriteBytes: true });
    const result = run(gh);
    expect(result.skips.map((s) => s.step)).toEqual([
      "screenshots_external_host",
    ]);
    expect(gh.remote()).toContain(src);
  });

  it("probes gh itself and degrades on an old CLI", () => {
    const gh = makeGh('<img src="img/a.png" width="9">\n', {
      version: "2.93.0",
    });
    const result = run(gh);
    expect(gh.calls[0]).toEqual(["gh", "--version"]);
    expect(result.skips.map((s) => s.step)).toEqual(["screenshots_gh_too_old"]);
    expect(gh.remote()).toBe(`${placeholderFor("a.png")}\n`);
    expect(bodyAfter(gh)).toContain("img/a.png");
  });

  it("trusts attachSupported=true without probing", () => {
    const gh = makeGh("![a](img/a.png)\n");
    run(gh, true);
    expect(gh.calls.some((c) => c[1] === "--version")).toBe(false);
  });

  it("makes no extra gh calls for a body without images", () => {
    const gh = makeGh("plain\n");
    const result = run(gh);
    expect(gh.calls).toEqual([
      ["gh", "pr", "edit", "7", "--body-file", `${WT}/body.md`],
    ]);
    expect(result).toMatchObject({ uploaded: 0, batches: 0, skips: [] });
  });

  it("stops batching with a named skip when the live body has no room", () => {
    const gh = makeGh("![a](img/a.png)\n", { remote: "x".repeat(65500) });
    const result = run(gh);
    expect(attachEdits(gh)).toEqual([]);
    expect(result.skips.map((s) => s.step)).toEqual([
      "screenshots_body_too_large",
    ]);
  });

  it("names screenshots outside the worktree and keeps the push going", () => {
    const gh = makeGh("![shot](../elsewhere/shot.png)\n");
    const result = run(gh);
    expect(result.skips).toEqual([
      {
        step: "screenshots_outside_worktree",
        reason:
          "1 screenshot(s) outside the worktree were not uploaded: ../elsewhere/shot.png",
      },
    ]);
    expect(gh.remote()).toContain(placeholderFor("shot.png"));
  });
});
