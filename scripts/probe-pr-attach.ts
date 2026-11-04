#!/usr/bin/env bun
/**
 * End-to-end probe of `flow-pr-attach` against a real PRIVATE repo.
 *
 * Proves, with GitHub itself as the judge, that a gallery of 55 generated PNGs
 * (a `<details open>` before/after table of `<img width="260">` cells plus
 * markdown images) plus one same-repo `blob/<sha>/…?raw=true` image all land
 * as native attachments: 2 upload batches, 56 `user-attachments` URLs and every
 * `width="260"` in the live body, signed `private-user-images` srcs in the
 * rendered body that each return `200 image/*`, raw attachment URLs that 404
 * unauthenticated, and a second run that uploads nothing. The PR is created
 * with relative image refs already in its body (so the "reset before the first
 * batch" path runs too). The re-hosted image is one ALREADY tracked on the
 * default branch (`--tracked-image`, default `static/icon-192.png`); this
 * probe never commits an image. Teardown (in `finally`) closes the PR, deletes
 * the throwaway branch, and re-checks that the images still render.
 *
 * Usage: bun scripts/probe-pr-attach.ts --repo <owner/name> [--keep]
 *        [--tracked-image <path>]
 * `--keep` leaves the PR open and the branch in place for inspection.
 *
 * Needs an authenticated `gh` with push + PR rights on `--repo`, and
 * `flow-md-validate` on PATH (the helper warns and continues without it).
 * The throwaway commit is empty and tagged `[skip ci]`, so no CI runs.
 *
 * Exit codes: 0 - every assertion holds; 1 - an assertion failed or the run
 * could not complete; 2 - bad args, a public repo, or the tracked image is
 * missing on the default branch.
 */
import { crc32 } from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOCAL_COUNT = 55;
const TABLE_CELLS = 40;
const ASSET_RE = /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/g;
const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Sh = { stdout: string; stderr: string; code: number };

function sh(argv: string[], cwd?: string): Sh {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.FLOW_SLUG;
  delete env.TMUX_PANE;
  const r = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    code: r.exitCode ?? 1,
  };
}

function must(argv: string[], cwd?: string): string {
  const r = sh(argv, cwd);
  if (r.code !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${r.stderr.trim() || r.code}`);
  }
  return r.stdout.trim();
}

/** The 1x1 PNG plus a `tEXt` chunk unique to `n`, so every file hashes differently. */
function makePng(n: number): Buffer {
  const base = Buffer.from(ONE_PX_PNG, "base64");
  const iend = base.subarray(base.length - 12);
  const data = Buffer.from(`probe\0image ${n}`, "latin1");
  const type = Buffer.from("tEXt", "latin1");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([
    base.subarray(0, base.length - 12),
    head,
    type,
    data,
    crc,
    iend,
  ]);
}

function buildBody(trackedRaw: string): string {
  const cell = (i: number) =>
    `<td><img src=".flow-tmp/img/g${i}.png" width="260"></td>`;
  const rows: string[] = [];
  for (let i = 0; i < TABLE_CELLS; i += 4) {
    rows.push(`<tr>${[i, i + 1, i + 2, i + 3].map(cell).join("")}</tr>`);
  }
  const markdown = Array.from(
    { length: LOCAL_COUNT - TABLE_CELLS },
    (_, i) => `![shot ${i}](.flow-tmp/img/g${TABLE_CELLS + i}.png)`,
  );
  return [
    "## Probe gallery",
    "",
    "<details open>",
    "<summary>Before / after</summary>",
    "",
    `<table>${rows.join("\n")}</table>`,
    "</details>",
    "",
    ...markdown.flatMap((m) => [m, ""]),
    `![already tracked on the default branch](${trackedRaw})`,
    "",
  ].join("\n");
}

async function fetchStatus(
  url: string,
): Promise<{ status: number; type: string }> {
  const res = await fetch(url);
  await res.arrayBuffer();
  return { status: res.status, type: res.headers.get("content-type") ?? "" };
}

function renderedSrcs(repo: string, pr: number): string[] {
  const html = must([
    "gh",
    "api",
    `repos/${repo}/pulls/${pr}`,
    "-H",
    "Accept: application/vnd.github.html+json",
    "--jq",
    ".body_html",
  ]);
  return [...html.matchAll(/<img[^>]*?\ssrc="([^"]+)"/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
}

async function signedAllOk(srcs: string[]): Promise<string[]> {
  const bad: string[] = [];
  for (const src of srcs) {
    const r = await fetchStatus(src);
    if (r.status !== 200 || !r.type.startsWith("image/")) {
      bad.push(`${r.status} ${r.type} ${src.slice(0, 80)}`);
    }
  }
  return bad;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const repo = flag("--repo");
  const keep = argv.includes("--keep");
  const tracked = flag("--tracked-image") ?? "static/icon-192.png";
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error(
      "usage: bun scripts/probe-pr-attach.ts --repo <owner/name> [--keep] [--tracked-image <path>]",
    );
    return 2;
  }
  const info = JSON.parse(
    must(["gh", "repo", "view", repo, "--json", "isPrivate,defaultBranchRef"]),
  ) as { isPrivate: boolean; defaultBranchRef: { name: string } };
  if (!info.isPrivate) {
    console.error(
      `probe-pr-attach: ${repo} is public; the probe needs a private repo`,
    );
    return 2;
  }
  const base = info.defaultBranchRef.name;
  const baseSha = must([
    "gh",
    "api",
    `repos/${repo}/commits/${base}`,
    "--jq",
    ".sha",
  ]);
  if (
    sh([
      "gh",
      "api",
      `repos/${repo}/contents/${tracked}?ref=${baseSha}`,
      "--jq",
      ".sha",
    ]).code !== 0
  ) {
    console.error(
      `probe-pr-attach: ${tracked} is not tracked on ${repo}@${base}; pass --tracked-image <path>`,
    );
    return 2;
  }

  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`,
    );
    if (!ok) failures.push(name);
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-probe-pr-attach-"));
  const clone = path.join(tmp, "repo");
  const branch = `probe/pr-attach-${Date.now()}`;
  let pr = 0;
  let pushed = false;
  try {
    must(["gh", "repo", "clone", repo, clone, "--", "--depth", "1"]);
    must(["git", "checkout", "-b", branch], clone);
    must(
      [
        "git",
        "commit",
        "--allow-empty",
        "-m",
        "probe: flow-pr-attach [skip ci]",
      ],
      clone,
    );
    must(["git", "push", "-u", "origin", branch], clone);
    pushed = true;
    const imgDir = path.join(clone, ".flow-tmp", "img");
    fs.mkdirSync(imgDir, { recursive: true });
    for (let i = 0; i < LOCAL_COUNT; i++) {
      fs.writeFileSync(path.join(imgDir, `g${i}.png`), makePng(i));
    }
    const trackedRaw = `https://github.com/${repo}/blob/${baseSha}/${tracked}?raw=true`;
    const original = buildBody(trackedRaw);
    const bodyFile = path.join(clone, ".flow-tmp", "probe-body.md");
    fs.writeFileSync(bodyFile, original);
    const created = must(
      [
        "gh",
        "pr",
        "create",
        "--repo",
        repo,
        "--draft",
        "--head",
        branch,
        "--base",
        base,
        "--title",
        "probe: flow-pr-attach (safe to close)",
        "--body-file",
        bodyFile,
      ],
      clone,
    );
    pr = Number(created.match(/\/pull\/(\d+)/)?.[1]);
    console.log(`probe PR #${pr}: ${created}`);

    const attach = () =>
      sh(
        [
          "bun",
          path.resolve(import.meta.dir, "../bin/flow-pr-attach.ts"),
          "--pr",
          String(pr),
          "--body-file",
          bodyFile,
          "--worktree",
          clone,
          "--json",
        ],
        clone,
      );
    const first = attach();
    check("first run exits 0", first.code === 0, first.stderr.trim());
    const env = JSON.parse(first.stdout || "{}");
    check(
      "55 local + 1 re-hosted image upload in 2 batches",
      env.batches === 2 && env.uploaded === 56 && env.rehosted === 1,
      first.stdout.trim(),
    );

    const live = must([
      "gh",
      "pr",
      "view",
      String(pr),
      "--repo",
      repo,
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    const assets = live.match(ASSET_RE) ?? [];
    check(
      "56 user-attachments URLs in the live body",
      assets.length === 56,
      `got ${assets.length}`,
    );
    check(
      `all ${TABLE_CELLS} width="260" survive`,
      (live.match(/width="260"/g) ?? []).length === TABLE_CELLS,
    );
    check(
      "no local path, raw link or upload token left",
      !/\.flow-tmp\/img|raw=true|flow-img-/.test(live),
    );

    const srcs = renderedSrcs(repo, pr).filter((s) =>
      s.includes("private-user-images.githubusercontent.com"),
    );
    check(
      "56 signed private-user-images srcs in the rendered body",
      srcs.length === 56,
      `got ${srcs.length}`,
    );
    const bad = await signedAllOk(srcs);
    check(
      "every signed src returns 200 image/*",
      bad.length === 0,
      bad.slice(0, 3).join("; "),
    );

    const open: string[] = [];
    for (const url of assets) {
      const r = await fetchStatus(url);
      if (r.status !== 404) open.push(`${r.status} ${url}`);
    }
    check(
      "raw attachment URLs 404 unauthenticated",
      open.length === 0,
      open.slice(0, 3).join("; "),
    );

    fs.writeFileSync(bodyFile, original);
    const second = attach();
    const env2 = JSON.parse(second.stdout || "{}");
    check(
      "second run uploads nothing",
      second.code === 0 && env2.uploaded === 0 && env2.batches === 0,
      second.stdout.trim() || second.stderr.trim(),
    );
  } catch (err) {
    check(
      "probe completed",
      false,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (keep) {
      console.log(
        `--keep: PR #${pr} and branch ${branch} left in place on ${repo}`,
      );
    } else {
      const problems: string[] = [];
      if (
        pr > 0 &&
        sh(["gh", "pr", "close", String(pr), "--repo", repo]).code !== 0
      ) {
        problems.push(`close PR #${pr}`);
      }
      if (
        pushed &&
        sh(["git", "push", "origin", "--delete", branch], clone).code !== 0
      ) {
        problems.push(`delete branch ${branch}`);
      }
      if (pr > 0 && problems.length === 0) {
        try {
          const after = await signedAllOk(
            renderedSrcs(repo, pr).filter((s) =>
              s.includes("private-user-images.githubusercontent.com"),
            ),
          );
          check(
            "images still render after the PR is closed and its branch deleted",
            after.length === 0,
            after.slice(0, 3).join("; "),
          );
        } catch (err) {
          check(
            "post-teardown render re-check",
            false,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (problems.length > 0) {
        console.error(
          `\n!!! TEARDOWN INCOMPLETE on ${repo}: could not ${problems.join(" / ")}. Clean up PR #${pr} and branch ${branch} by hand. !!!\n`,
        );
        failures.push("teardown");
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(
    failures.length === 0
      ? "\nprobe-pr-attach: all assertions hold"
      : `\nprobe-pr-attach: ${failures.length} failed: ${failures.join(", ")}`,
  );
  return failures.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
