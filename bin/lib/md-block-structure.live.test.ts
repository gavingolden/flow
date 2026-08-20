import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { normalizeDetailsBlocks } from "./md-block-structure";

/**
 * Pins the two GFM `<details>` blank-line rules encoded in
 * `md-block-structure.ts` against GitHub's REAL renderer (`POST
 * /markdown`, `mode: gfm`), so silent drift from a future GFM change is
 * impossible to miss. `bin/vitest.config.ts`'s `include` glob
 * (`bin/**\/*.test.ts`) matches `*.live.test.ts` — there is no separate
 * live-test script — so this file runs inside the DEFAULT `npm run test`
 * and CI unless it self-skips. Probe BOTH `gh` presence AND `gh auth
 * status`, same guard shape as `bin/flow-pre-commit.live.test.ts`'s
 * `describeOnPosix` + spawnSync probe, so an unauthenticated/offline
 * machine never makes `npm run verify` network-dependent.
 *
 * Placed in `bin/lib/` next to its subject (the other three
 * `*.live.test.ts` files live in `bin/`) — the guard shape is copied
 * unchanged regardless of directory.
 */
// Captured at module-eval time, BEFORE `vitest.setup.ts`'s global
// `beforeAll` sandboxes `$HOME` for the whole suite (that hook only runs
// right before the first test in this file, not during collection).
// `gh`'s config/keyring lookup resolves through `$HOME`, so every gh
// call below must pin this real value explicitly rather than inheriting
// the process env at call time — otherwise both the auth probe (fine,
// it also runs at module-eval time) and the actual render calls (not
// fine — they run inside `it()`, after the sandbox is live) would
// disagree on whether `gh` is authenticated.
const REAL_HOME = process.env.HOME;
const ghEnv = { ...process.env, HOME: REAL_HOME };

const ghOnPath = spawnSync("gh", ["--version"], { env: ghEnv }).status === 0;
const ghAuthed =
  ghOnPath && spawnSync("gh", ["auth", "status"], { env: ghEnv }).status === 0;
// A transient api.github.com failure (rate limit, network blip) is not
// "gh absent/unauthenticated" — probe the actual endpoint this file
// calls so that class of failure also self-skips instead of turning
// `npm run verify` red.
const ghApiReachable =
  ghAuthed &&
  spawnSync("gh", ["api", "markdown", "-f", "text=x", "-f", "mode=gfm"], {
    env: ghEnv,
  }).status === 0;

const describeIfGhAuthed = ghApiReachable ? describe : describe.skip;

function renderGfm(text: string): string {
  const r = spawnSync(
    "gh",
    ["api", "markdown", "-f", `text=${text}`, "-f", "mode=gfm"],
    { encoding: "utf8", env: ghEnv },
  );
  if (r.status !== 0) {
    throw new Error(`gh api markdown failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

describeIfGhAuthed(
  "md-block-structure rules vs. GitHub's real GFM renderer (live)",
  () => {
    it("checkbox rule: missing blank after </summary> swallows the checkbox as literal text; normalizing renders it as a real task-list item", () => {
      const before = "<details><summary>x</summary>\n- [ ] item\n</details>\n";
      const after = normalizeDetailsBlocks(before).body;
      expect(after).not.toBe(before);

      const beforeHtml = renderGfm(before);
      expect(beforeHtml).not.toContain('class="contains-task-list"');

      const afterHtml = renderGfm(after);
      expect(afterHtml).toContain('class="contains-task-list"');
    });

    it("fence rule: missing blank after </summary> swallows a code fence as literal text; normalizing renders it as a real <pre> block", () => {
      const before =
        "<details><summary>x</summary>\n```text\ncode line\n```\n</details>\n";
      const after = normalizeDetailsBlocks(before).body;
      expect(after).not.toBe(before);

      const beforeHtml = renderGfm(before);
      expect(beforeHtml).not.toContain("<pre");

      const afterHtml = renderGfm(after);
      expect(afterHtml).toContain("<pre");
    });

    it("</details> rule: missing blank after </details> swallows the next checkbox as literal text; normalizing renders it as a real task-list item", () => {
      const before =
        "<details><summary>x</summary>\ncontent\n</details>\n- [ ] item\n";
      const after = normalizeDetailsBlocks(before).body;
      expect(after).not.toBe(before);

      const beforeHtml = renderGfm(before);
      expect(beforeHtml).not.toContain('class="contains-task-list"');

      const afterHtml = renderGfm(after);
      expect(afterHtml).toContain('class="contains-task-list"');
    });
  },
);
