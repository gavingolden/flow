import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run, type Deps } from "./flow-pr-attach";
import type { ExecResult } from "./lib/review-screenshots";

const HOSTED = "https://github.com/user-attachments/assets/";

let worktree!: string;
let bodyFile!: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "flow-pr-attach-test-"));
  bodyFile = path.join(worktree, ".flow-tmp", "pr-body.md");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(worktree, { recursive: true, force: true });
});

function seedImages(names: string[]): void {
  const dir = path.join(worktree, ".flow-tmp", "pr-images");
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), `png:${n}`);
}

const img = (n: string) => `.flow-tmp/pr-images/${n}`;

/** Six images: four `<img width>` table cells plus two markdown images. */
const GALLERY = () =>
  [
    "## Screenshots",
    "",
    "<details open>",
    "<summary>Before / after</summary>",
    "",
    "<table><tr>",
    ...["a", "b", "c", "d"].map(
      (n) => `<td><img src="${img(`${n}.png`)}" width="260"></td>`,
    ),
    "</tr></table>",
    "</details>",
    "",
    `![m1](${img("m1.png")})`,
    "",
    `![m2](${img("m2.png")})`,
    "",
    "Screenshot: `m1.png` and `m2.png`",
    "",
  ].join("\n");
const NAMES = ["a", "b", "c", "d", "m1", "m2"].map((n) => `${n}.png`);

/** In-memory gh: `--attach` appends an embed per file, `--body-file` replaces the body. */
function fakeExec(
  o: { version?: string; editFails?: boolean; toplevel?: string } = {},
) {
  const calls: string[][] = [];
  let remote = "";
  const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
  const exec = (argv: string[]): ExecResult => {
    calls.push(argv);
    if (argv[0] === "flow-md-validate") return ok();
    if (argv[0] === "git") return ok(`${o.toplevel ?? worktree}\n`);
    if (argv[1] === "--version") {
      return ok(`gh version ${o.version ?? "2.101.0"} (2026-09-15)\n`);
    }
    if (argv[2] === "view") return ok(remote);
    if (o.editFails) return { stdout: "", stderr: "HTTP 500", exitCode: 1 };
    const file = argv[argv.indexOf("--body-file") + 1];
    if (argv.includes("--body-file")) remote = fs.readFileSync(file, "utf8");
    for (const arg of argv.filter((_, i) => argv[i - 1] === "--attach")) {
      const token = arg.slice(arg.indexOf("#") + 1);
      remote += `\n![${token}](${HOSTED}${token.slice(9)})\n`;
    }
    return ok();
  };
  return { exec, calls, remote: () => remote };
}

async function attach(
  argv: string[],
  deps: Deps,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation(
    (...a) => void out.push(a.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a) => void err.push(a.join(" ")),
  );
  const code = await run(argv, { ensureExcludes: () => {}, ...deps });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const argvFor = (extra: string[] = [], pr = "7") => [
  "--pr",
  pr,
  "--body-file",
  bodyFile,
  "--worktree",
  worktree,
  ...extra,
];
const attachCalls = (calls: string[][]) =>
  calls.filter((c) => c.includes("--attach"));

describe("parseArgs", () => {
  it("parses the required flags", () => {
    expect(parseArgs(["--pr", "7", "--body-file", "b.md"])).toEqual({
      pr: 7,
      bodyFile: "b.md",
      worktree: undefined,
      json: false,
    });
    expect(
      parseArgs([
        "--pr",
        "7",
        "--body-file",
        "b.md",
        "--worktree",
        "/w",
        "--json",
      ]),
    ).toMatchObject({ worktree: "/w", json: true });
  });

  it.each([
    [[], "--pr is required"],
    [["--pr", "7"], "--body-file is required"],
    [["--pr", "x", "--body-file", "b"], "invalid --pr value: x"],
    [["--pr", "7", "--body-file"], "--body-file requires a value"],
    [["--pr", "7", "--body-file", "b", "--nope"], "unknown argument: --nope"],
  ])("rejects %j", (argv, error) => {
    expect(parseArgs(argv)).toEqual({ error });
  });
});

describe("run", () => {
  it("uploads a six-image <img> table in one call and rewrites every reference", async () => {
    seedImages(NAMES);
    fs.writeFileSync(bodyFile, GALLERY());
    const gh = fakeExec();
    const { code, out } = await attach(argvFor(["--json"]), { exec: gh.exec });
    expect(code).toBe(0);
    expect(attachCalls(gh.calls)).toHaveLength(1);
    expect(
      attachCalls(gh.calls)[0].filter((a) => a === "--attach"),
    ).toHaveLength(6);
    const live = gh.remote();
    expect(live.match(/user-attachments\/assets\//g)).toHaveLength(6);
    expect(live.match(/width="260"/g)).toHaveLength(4);
    expect(live).not.toContain(".flow-tmp/pr-images");
    expect(live).toContain("Screenshot: `m1.png`");
    expect(JSON.parse(out)).toMatchObject({
      bodyPushed: true,
      uploaded: 6,
      reused: 0,
      batches: 1,
      skips: [],
    });
    expect(fs.readFileSync(bodyFile, "utf8")).toContain('width="260"');
    expect(fs.readFileSync(bodyFile, "utf8")).toContain(HOSTED);
    expect(
      fs.existsSync(path.join(worktree, ".flow-tmp", "pr-attach-body.md")),
    ).toBe(false);
  });

  it("runs flow-md-validate --fix-pr-body before the push", async () => {
    seedImages(NAMES);
    fs.writeFileSync(bodyFile, GALLERY());
    const gh = fakeExec();
    await attach(argvFor(), { exec: gh.exec });
    const names = gh.calls.map((c) => c[0]);
    expect(gh.calls[names.indexOf("flow-md-validate")].slice(0, 2)).toEqual([
      "flow-md-validate",
      "--fix-pr-body",
    ]);
    expect(names.indexOf("flow-md-validate")).toBeLessThan(
      gh.calls.findIndex((c) => c.includes("--attach")),
    );
  });

  it("re-running with the ledger uploads nothing and pushes the ledger URLs", async () => {
    seedImages(NAMES);
    fs.writeFileSync(bodyFile, GALLERY());
    await attach(argvFor(), { exec: fakeExec().exec });
    fs.writeFileSync(bodyFile, GALLERY());
    const second = fakeExec();
    const { code, out } = await attach(argvFor(["--json"]), {
      exec: second.exec,
    });
    expect(code).toBe(0);
    expect(attachCalls(second.calls)).toEqual([]);
    expect(JSON.parse(out)).toMatchObject({
      uploaded: 0,
      reused: 6,
      batches: 0,
    });
    expect(second.remote().match(/user-attachments\/assets\//g)).toHaveLength(
      6,
    );
    expect(second.remote()).not.toContain(".flow-tmp/pr-images");
  });

  it("exits 3 on an old gh, names brew upgrade gh, keeps captions, and leaves the input untouched", async () => {
    seedImages(NAMES);
    fs.writeFileSync(bodyFile, GALLERY());
    const gh = fakeExec({ version: "2.93.0" });
    const { code, err } = await attach(argvFor(), { exec: gh.exec });
    expect(code).toBe(3);
    expect(err).toContain("brew upgrade gh");
    expect(attachCalls(gh.calls)).toEqual([]);
    expect(gh.remote()).toContain("Screenshot: `m1.png` and `m2.png`");
    expect(gh.remote()).not.toContain(".flow-tmp/pr-images");
    expect(gh.remote()).toContain("_(screenshot not uploaded: a.png)_");
    expect(fs.readFileSync(bodyFile, "utf8")).toBe(GALLERY());
  });

  it("reports an outside-host image on stderr and in the envelope but still exits 0", async () => {
    seedImages(["a.png"]);
    const gist = "https://gist.githubusercontent.com/u/1/raw/g.png";
    fs.writeFileSync(bodyFile, `![a](${img("a.png")})\n\n![g](${gist})\n`);
    const gh = fakeExec();
    const { code, out, err } = await attach(argvFor(["--json"]), {
      exec: gh.exec,
    });
    expect(code).toBe(0);
    expect(err).toContain("screenshots_external_host");
    expect(JSON.parse(out).skips.map((s: { step: string }) => s.step)).toEqual([
      "screenshots_external_host",
    ]);
    expect(gh.remote()).toContain(gist);
  });

  it("exits 1 when the body cannot be pushed", async () => {
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
    fs.writeFileSync(bodyFile, "no images\n");
    const { code, err } = await attach(argvFor(), {
      exec: fakeExec({ editFails: true }).exec,
    });
    expect(code).toBe(1);
    expect(err).toContain("gh pr edit failed: HTTP 500");
  });

  it("defaults the worktree to the git top-level of the body file's directory", async () => {
    seedImages(["a.png"]);
    fs.writeFileSync(bodyFile, `![a](${img("a.png")})\n`);
    const gh = fakeExec({ toplevel: worktree });
    const argv = ["--pr", "7", "--body-file", bodyFile];
    const { code } = await attach(argv, { exec: gh.exec });
    expect(code).toBe(0);
    expect(gh.calls[0]).toEqual([
      "git",
      "-C",
      path.dirname(bodyFile),
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(attachCalls(gh.calls)).toHaveLength(1);
  });

  it("refuses a PR that is not the pipeline's own, touching nothing", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fpa-own-"));
    fs.writeFileSync(
      path.join(stateDir, "slug-a.json"),
      JSON.stringify({
        slug: "slug-a",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-22T11:00:00Z",
        pr: 5,
      }),
    );
    seedImages(["a.png"]);
    fs.writeFileSync(bodyFile, `![a](${img("a.png")})\n`);
    const env = { FLOW_SLUG: "slug-a" };
    const foreign = fakeExec();
    const refused = await attach(argvFor([], "6"), {
      exec: foreign.exec,
      env,
      stateDir,
    });
    const mine = fakeExec();
    const own = await attach(argvFor([], "5"), {
      exec: mine.exec,
      env,
      stateDir,
    });
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("pr-not-owned");
    expect(foreign.calls).toEqual([]);
    expect(own.code).toBe(0);
    expect(attachCalls(mine.calls)).toHaveLength(1);
  });

  it("exits 2 on bad arguments or an unreadable body file", async () => {
    const gh = fakeExec();
    expect((await attach([], { exec: gh.exec })).code).toBe(2);
    expect((await attach(["--pr", "7"], { exec: gh.exec })).code).toBe(2);
    const missing = await attach(
      [
        "--pr",
        "7",
        "--body-file",
        path.join(worktree, "nope.md"),
        "--worktree",
        worktree,
      ],
      { exec: gh.exec },
    );
    expect(missing.code).toBe(2);
    expect(gh.calls).toEqual([]);
  });
});

describe("safety guards", () => {
  it("has the exec bit set", () => {
    const file = path.join(import.meta.dirname, "flow-pr-attach.ts");
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
  });

  it("git-ignores .flow-tmp before the first scratch write", async () => {
    seedImages(["a.png"]);
    fs.writeFileSync(bodyFile, `![a](${img("a.png")})\n`);
    const order: string[] = [];
    const gh = fakeExec();
    await attach(argvFor(), {
      exec: gh.exec,
      ensureExcludes: (w) => void order.push(`excl:${w}`),
      writeFile: (p, c) => {
        order.push(`write:${p}`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, c);
      },
    });
    expect(order[0]).toBe(`excl:${worktree}`);
    expect(order.length).toBeGreaterThan(1);
  });

  it("exits 2 without calling gh when the worktree is not a git checkout", async () => {
    seedImages(["a.png"]);
    fs.writeFileSync(bodyFile, `![a](${img("a.png")})\n`);
    const gh = fakeExec();
    const { code, err } = await attach(argvFor(), {
      exec: gh.exec,
      ensureExcludes: () => {
        throw new Error("not a repo");
      },
    });
    expect(code).toBe(2);
    expect(err).toContain("is not a git checkout");
    expect(gh.calls).toEqual([]);
  });

  it("refuses a --worktree that is not the pipeline's own worktree", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fpa-wt-"));
    fs.writeFileSync(
      path.join(stateDir, "slug-a.json"),
      JSON.stringify({
        slug: "slug-a",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-22T11:00:00Z",
        pr: 5,
        worktree: path.join(os.tmpdir(), "some-other-worktree"),
      }),
    );
    seedImages(["a.png"]);
    fs.writeFileSync(bodyFile, `![a](${img("a.png")})\n`);
    const gh = fakeExec();
    const refused = await attach(argvFor([], "5"), {
      exec: gh.exec,
      env: { FLOW_SLUG: "slug-a" },
      stateDir,
    });
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("worktree-not-owned");
    expect(gh.calls).toEqual([]);
  });
});

describe("hosted URL write-back", () => {
  it("uses the content hash, so two copies of one image share a single upload", async () => {
    seedImages(["a.png"]);
    const dir = path.join(worktree, ".flow-tmp", "pr-images");
    fs.copyFileSync(path.join(dir, "a.png"), path.join(dir, "copy.png"));
    fs.writeFileSync(
      bodyFile,
      `![a](${img("a.png")})\n![b](${img("copy.png")})\n`,
    );
    const gh = fakeExec();
    const { code } = await attach(argvFor(), { exec: gh.exec });
    expect(code).toBe(0);
    expect(
      attachCalls(gh.calls)[0].filter((a) => a === "--attach"),
    ).toHaveLength(1);
    const sha = createHash("sha256").update("png:a.png").digest("hex");
    expect(attachCalls(gh.calls)[0].join(" ")).toContain(
      `#flow-img-${sha.slice(0, 16)}`,
    );
    expect(gh.remote().match(/user-attachments/g)).toHaveLength(2);
  });

  it("writes a re-hosted same-repo link's hosted URL back to the body file", async () => {
    const src = "https://raw.githubusercontent.com/me/repo/main/x.png";
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
    fs.writeFileSync(bodyFile, `![s](${src})\n`);
    const gh = fakeExec();
    const exec = (argv: string[]) => {
      if (argv[1] === "api") {
        return {
          stdout: argv[2].includes("/contents/")
            ? `${"a".repeat(40)}\n`
            : Buffer.from("png").toString("base64"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (argv.includes("url")) {
        return {
          stdout: "https://github.com/me/repo/pull/7\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return gh.exec(argv);
    };
    const { code } = await attach(argvFor(), { exec });
    expect(code).toBe(0);
    const after = fs.readFileSync(bodyFile, "utf8");
    expect(after).toContain(HOSTED);
    expect(after).not.toContain("raw.githubusercontent.com");
  });
});
