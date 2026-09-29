import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeSkillOverlay, syncSkillOverlay } from "./skill-overlay";

/**
 * Pins how a REAL Claude Code session reads a private skill copy, so the
 * step-5.5 prose is grounded in observed behavior rather than assumption.
 * Observed on Claude Code 2.1.284 (`claude -p`, and an interactive pane
 * checked by hand): plugin-root skill text is snapshotted when the session
 * starts. A file rewritten in place mid-session (temp file + rename, or an
 * in-place truncate) is NOT served to that session's first load of the skill,
 * even several seconds later; a typed `/reload-plugins` or a fresh session
 * does pick it up. Case (a) therefore asserts the session-start text; if a
 * future Claude Code starts serving the rewrite, that case fails and the
 * playbook's "what a running session does NOT pick up" list must be revisited.
 *
 * Gated on RUN_CLAUDE_LIVE=1 plus `claude` on PATH (`it.skipIf`, precedent
 * bin/flow-gemini-lens.live.test.ts) so a plain `npm run verify` skips it and
 * spends nothing. vitest.setup.ts sandboxes HOME, so a spawned claude would be
 * unauthenticated; the spawns opt back into the real home via
 * FLOW_TEST_REAL_HOME, and strip FLOW_SLUG/TMUX_PANE so the nested session
 * cannot trip flow-stop-guard against a parent pipeline.
 */
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const claudeOnPath = spawnSync("sh", ["-c", "command -v claude"]).status === 0;
const liveEnabled = process.env.RUN_CLAUDE_LIVE === "1" && claudeOnPath;

const PROBE_SKILL = (marker: string) =>
  `---\nname: overlay-probe\ndescription: Probe skill returning a marker string. Use when asked to load overlay-probe.\n---\n\nThe marker is: ${marker}\n`;

const LOAD_PROBE =
  "use the Skill tool to load the skill overlay-probe (namespaced flow-module-core:overlay-probe) and reply with exactly the marker string it defines, nothing else.";

function runClaude(prompt: string, pluginRoot: string, cwd: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.FLOW_TEST_REAL_HOME,
  };
  delete env.FLOW_SLUG;
  delete env.TMUX_PANE;
  const child = spawn(
    "claude",
    [
      "-p",
      prompt,
      "--model",
      "haiku",
      "--max-turns",
      "10",
      "--plugin-dir",
      pluginRoot,
      "--allowedTools",
      "Bash,Skill",
      "--output-format",
      "text",
    ],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise<string>((resolve) =>
    child.on("close", () => resolve(out)),
  );
  return { child, done };
}

async function waitFor(file: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

describeOnPosix("skill-overlay live (RUN_CLAUDE_LIVE=1)", () => {
  function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-overlay-live-"));
    const source = path.join(tmp, "source");
    const overlaysDir = path.join(tmp, "overlays");
    const probe = path.join(source, "skills", "pipeline", "overlay-probe");
    fs.mkdirSync(probe, { recursive: true });
    const write = (marker: string) =>
      fs.writeFileSync(path.join(probe, "SKILL.md"), PROBE_SKILL(marker));
    const build = (slug: string) =>
      materializeSkillOverlay({
        slug,
        contentSource: source,
        installRoot: repoRoot,
        moduleIds: ["core"],
        overlaysDir,
      })[0]!;
    return { tmp, source, overlaysDir, write, build };
  }

  it.skipIf(!liveEnabled)(
    "(a) a rewrite synced mid-session lands on disk but a running session serves its session-start text",
    async () => {
      const { tmp, source, overlaysDir, write, build } = fixture();
      const before = `MARKER-${randomBytes(4).toString("hex")}`;
      const after = `MARKER-${randomBytes(4).toString("hex")}`;
      try {
        write(before);
        const root = build("live-a");
        const ready = path.join(tmp, "ready");
        const go = path.join(tmp, "go");
        const { child, done } = runClaude(
          `Do these steps in order, using tools. 1) With Bash run: touch ${ready} . 2) With Bash run: until [ -f ${go} ]; do sleep 1; done . 3) Only after step 2 finishes, ${LOAD_PROBE}`,
          root,
          tmp,
        );
        try {
          expect(await waitFor(ready, 120_000), "session never signalled").toBe(
            true,
          );
          write(after);
          const sync = syncSkillOverlay({
            slug: "live-a",
            contentSource: source,
            overlaysDir,
          });
          expect(sync.written).toEqual([
            "flow-module-core/skills/overlay-probe/SKILL.md",
          ]);
          expect(
            fs.readFileSync(
              path.join(root, "skills", "overlay-probe", "SKILL.md"),
              "utf8",
            ),
          ).toContain(after);
          // Give any file watcher time to notice before the first load.
          await new Promise((r) => setTimeout(r, 5000));
          fs.writeFileSync(go, "");
          const out = await done;
          expect(out).toContain(before);
          expect(out).not.toContain(after);
        } finally {
          child.kill();
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    5 * 60 * 1000,
  );

  it.skipIf(!liveEnabled)(
    "(b) a fresh session on a copy updated by sync (the resume path) returns the synced text",
    async () => {
      const { tmp, source, overlaysDir, write, build } = fixture();
      const original = `MARKER-${randomBytes(4).toString("hex")}`;
      const edited = `MARKER-${randomBytes(4).toString("hex")}`;
      try {
        write(original);
        const root = build("live-b");
        write(edited);
        syncSkillOverlay({
          slug: "live-b",
          contentSource: source,
          overlaysDir,
        });
        const { child, done } = runClaude(`Please ${LOAD_PROBE}`, root, tmp);
        try {
          const out = await done;
          expect(out).toContain(edited);
          expect(out).not.toContain(original);
        } finally {
          child.kill();
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    5 * 60 * 1000,
  );
});
