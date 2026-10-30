#!/usr/bin/env bun
/**
 * Live end-to-end probe of the start-of-session request echo.
 *
 * Proves that the `SessionStart` hook flow registers in its launch settings
 * renders a near-cap pipeline request un-collapsed under the banner of a
 * REAL Claude Code window. It writes a fixture state file and a
 * ~8,700-serialized-character, 160-line request (quotes and backticks,
 * unique first/last sentinel lines) under the slug
 * `probe-request-echo-<pid>`, points `FLOW_REQUEST_ECHO_HOOK_COMMAND` at THIS
 * checkout's `bin/flow-request-echo-hook.ts` (so a stale installed copy is
 * never what gets tested), generates launch settings into a temp file via
 * `ensureLaunchSettings`, and starts a detached 200x120 tmux session running
 * `claude --settings <temp>` with `FLOW_SLUG` set to the fixture slug. No
 * prompt is ever sent, so no model turn runs.
 *
 * Isolation: `~/.flow/state` cannot be redirected (`bin/lib/paths.ts` fixes
 * it from `os.homedir()`, and the hook child resolves it independently), and
 * the nested `claude` needs the real `HOME` for its login. So the fixture
 * lives under the real state dir with a unique slug, is removed in `finally`,
 * and no other slug's state is ever touched. The tmux session runs on its own
 * private socket so it can never collide with the user's tmux server.
 *
 * Exit codes: 0 - both sentinels rendered and no `ctrl+o to expand`; 1 - the
 * sentinels never rendered or the output was folded; 2 - `tmux` or `claude`
 * is missing, or a workspace-trust prompt blocked startup (not a verdict on
 * the hook).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLaunchSettings } from "../bin/lib/feature";
import {
  renderRequestEchoMessage,
  REQUEST_ECHO_MESSAGE_MAX_CHARS,
} from "../bin/lib/request-echo";
import {
  requestFilePath,
  statePath,
  writeRequestFile,
  writeState,
  type PipelineState,
} from "../bin/lib/state";

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOK_SCRIPT = path.join(REPO_ROOT, "bin", "flow-request-echo-hook.ts");
const POLL_MS = 500;
const TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_500;
const COLUMNS = 200;
const ROWS = 120;
const LINE_COUNT = 160;

const slug = `probe-request-echo-${process.pid}`;
const FIRST = `PROBE-ECHO-FIRST-${process.pid}`;
const LAST = `PROBE-ECHO-LAST-${process.pid}`;

function buildRequest(): string {
  const lines = [`${FIRST} start of the probe request`];
  for (let i = 1; i < LINE_COUNT - 1; i++) {
    const n = String(i).padStart(3, "0");
    lines.push(`${n} "quoted ${n}" with \`code ${n}\` and padding text`);
  }
  lines.push(`${LAST} end of the probe request`);
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onPath(cmd: string, arg: string): boolean {
  return spawnSync(cmd, [arg], { stdio: "ignore" }).status === 0;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function main(): Promise<number> {
  if (!onPath("tmux", "-V") || !onPath("claude", "--version")) {
    console.log("probe-request-echo: not run (tmux or claude is missing)");
    return Promise.resolve(2);
  }
  return runProbe();
}

async function runProbe(): Promise<number> {
  // A real pipeline's slug must never leak into this probe's children.
  delete process.env.FLOW_SLUG;
  delete process.env.TMUX_PANE;
  delete process.env.TMUX;
  delete process.env.CLAUDECODE;

  const request = buildRequest();
  const message = renderRequestEchoMessage(fixtureState(), request);
  if (message.includes("[request truncated:")) {
    console.log(
      `probe-request-echo: FAIL (fixture request exceeds the ${REQUEST_ECHO_MESSAGE_MAX_CHARS}-character cap; probe bug)`,
    );
    return 1;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe-request-echo-"));
  const settingsPath = path.join(tmp, "launch-settings.json");
  const socket = `probe-request-echo-${process.pid}`;
  const tmuxArgs = (args: string[]): string[] => ["-L", socket, ...args];
  const capture = (): string =>
    spawnSync("tmux", tmuxArgs(["capture-pane", "-p", "-S", "-", "-t", slug]), {
      encoding: "utf8",
    }).stdout ?? "";

  try {
    writeState(fixtureState());
    writeRequestFile(slug, request);
    process.env.FLOW_REQUEST_ECHO_HOOK_COMMAND = HOOK_SCRIPT;
    ensureLaunchSettings(settingsPath);

    const started = spawnSync(
      "tmux",
      tmuxArgs([
        "new-session",
        "-d",
        "-s",
        slug,
        "-x",
        String(COLUMNS),
        "-y",
        String(ROWS),
        "-c",
        REPO_ROOT,
        `env -u TMUX_PANE -u CLAUDECODE FLOW_SLUG=${slug} claude --settings ${shellQuote(settingsPath)}`,
      ]),
      { encoding: "utf8" },
    );
    if (started.status !== 0) {
      console.log(
        `probe-request-echo: not run (tmux new-session failed: ${started.stderr.trim()})`,
      );
      return 2;
    }

    const deadline = Date.now() + TIMEOUT_MS;
    let pane = "";
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      pane = capture();
      if (pane.includes(FIRST) && pane.includes(LAST)) break;
      if (/do you trust the files|trust this (folder|workspace)/i.test(pane)) {
        console.log(
          "probe-request-echo: not run (a workspace-trust prompt blocked startup; trust the repo root in Claude Code and re-run)",
        );
        return 2;
      }
    }

    await sleep(SETTLE_MS);
    pane = capture();
    const sawFirst = pane.includes(FIRST);
    const sawLast = pane.includes(LAST);
    const folded = pane.includes("ctrl+o to expand");
    if (sawFirst && sawLast && !folded) {
      console.log(
        `probe-request-echo: PASS (${LINE_COUNT}-line request rendered, first and last lines visible, no fold)`,
      );
      return 0;
    }
    console.log(
      `probe-request-echo: FAIL (first line ${sawFirst ? "seen" : "missing"}, last line ${sawLast ? "seen" : "missing"}, ${folded ? "folded behind ctrl+o to expand" : "no fold marker"})`,
    );
    return 1;
  } finally {
    spawnSync("tmux", tmuxArgs(["kill-server"]), { stdio: "ignore" });
    fs.rmSync(statePath(slug), { force: true });
    fs.rmSync(requestFilePath(slug), { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function fixtureState(): PipelineState {
  return {
    slug,
    phase: "implementing",
    repo: REPO_ROOT,
    updatedAt: new Date().toISOString(),
  };
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
