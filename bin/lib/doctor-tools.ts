/**
 * `flow doctor` tool checks: gh, tmux, claude and agy. Every subprocess goes
 * through `deps.run`, and no tool's output is ever echoed — only exit status,
 * a version line, a model count, or the first line of claude's own error.
 */

import type { DoctorCheck, DoctorDeps } from "./doctor";
import { installCommand } from "./doctor-util";
import { looksUnauthenticated } from "./agy-output";
import { readLauncherConfig } from "./launcher-config";
import { readManifest } from "./manifest";
import { isModuleActive } from "./module-status";
import {
  deriveSelectionFromManifest,
  readConfigFileAt,
  readModuleSelection,
} from "./modules-config";
import {
  checkClaudeRunnable,
  type ClaudeProbeRunner,
} from "./setup-claude-check";

const GH_TIMEOUT_MS = 10_000;
const AGY_TIMEOUT_MS = 15_000;

export const TOOLS_GH_META = {
  id: "tools-gh",
  section: "tools",
  title: "gh",
} as const;

export const TOOLS_TMUX_META = {
  id: "tools-tmux",
  section: "tools",
  title: "tmux",
} as const;

export const TOOLS_CLAUDE_META = {
  id: "tools-claude",
  section: "tools",
  title: "claude",
} as const;

export const TOOLS_AGY_META = {
  id: "tools-agy",
  section: "tools",
  title: "agy",
} as const;

export function checkGh(deps: DoctorDeps): DoctorCheck[] {
  const base = TOOLS_GH_META;
  const r = deps.run("gh", ["auth", "status"], { timeoutMs: GH_TIMEOUT_MS });
  if (r.notFound) {
    return [
      {
        ...base,
        status: "fail",
        summary: "gh is not on PATH; PR steps cannot run",
        details: ["other install routes: https://cli.github.com"],
        fix: installCommand("gh", deps.platform),
      },
    ];
  }
  if (r.timedOut) {
    return [
      {
        ...base,
        status: "warn",
        summary: "gh auth status timed out, so sign-in was not confirmed",
        details: [],
        fix: "gh auth status",
      },
    ];
  }
  if (r.status !== 0) {
    return [
      {
        ...base,
        status: "fail",
        summary: "gh is not signed in",
        details: [],
        fix: "gh auth login",
      },
    ];
  }
  return [{ ...base, status: "pass", summary: "gh is signed in", details: [] }];
}

export function checkTmux(deps: DoctorDeps): DoctorCheck[] {
  const base = TOOLS_TMUX_META;
  const launcher = readLauncherConfig(() => readConfigFileAt(deps.configPath));
  const r = deps.run("tmux", ["-V"]);
  if (!r.notFound && r.status === 0) {
    return [
      {
        ...base,
        status: "pass",
        summary: r.stdout.trim() || "tmux is installed",
        details: [],
      },
    ];
  }
  if (launcher === "tmux") {
    return [
      {
        ...base,
        status: "fail",
        summary: "your recorded launcher is tmux, but tmux is not runnable",
        details: ["pipelines fall back to the plain launcher until it is"],
        fix: installCommand("tmux", deps.platform),
      },
    ];
  }
  return [
    {
      ...base,
      status: "skip",
      summary: "not needed by the plain launcher",
      details: [],
    },
  ];
}

export function checkClaude(
  deps: DoctorDeps,
  probe?: ClaudeProbeRunner,
): DoctorCheck[] {
  const base = TOOLS_CLAUDE_META;
  let timedOut = false;
  const run: ClaudeProbeRunner =
    probe ??
    ((cmd) => {
      const r = deps.run(cmd[0], cmd.slice(1), { timeoutMs: 5000 });
      if (r.notFound)
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      timedOut = r.timedOut;
      return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
    });
  const res = checkClaudeRunnable(run);
  if (res.ok) {
    return [{ ...base, status: "pass", summary: "claude runs", details: [] }];
  }
  if (timedOut) {
    return [
      {
        ...base,
        status: "warn",
        summary: "claude --version timed out, so it was not confirmed",
        details: [],
        fix: "claude --version",
      },
    ];
  }
  const notOnPath = res.reason === "not-on-path";
  const firstLine = (res.reason ?? "")
    .replace(/^probe-failed: /, "")
    .split("\n")[0]
    .trim();
  return [
    {
      ...base,
      status: "fail",
      summary: notOnPath ? "claude is not on PATH" : "claude --version failed",
      details: [
        "flow launches pipelines through Claude Code; launches will fail until it runs",
        notOnPath
          ? "install it (https://code.claude.com/docs) or fix your PATH"
          : firstLine,
      ],
      fix: notOnPath
        ? "npm install -g @anthropic-ai/claude-code"
        : "claude --version",
    },
  ];
}

// `agy models` prints a progress line, then one `<slug>\t<Display Name>` row
// per model; only tab-separated rows count as models.
function countModelRows(stdout: string): number {
  return stdout.split("\n").filter((l) => /^[\w.-]+\t\S/.test(l)).length;
}

export function checkAgy(
  deps: DoctorDeps,
  io: { researchActive?: () => boolean } = {},
): DoctorCheck[] {
  const base = TOOLS_AGY_META;
  const readSelection = () =>
    readModuleSelection(() => readConfigFileAt(deps.configPath));
  const researchActive =
    io.researchActive ??
    (() =>
      isModuleActive("research", {
        readManifest: () => readManifest(deps.manifestPath),
        readSelection,
      }));
  if (!researchActive()) {
    return [
      {
        ...base,
        status: "skip",
        summary: "the research module is not installed",
        details: [],
      },
    ];
  }
  const r = deps.run("agy", ["models"], { timeoutMs: AGY_TIMEOUT_MS });
  if (r.notFound) {
    const current =
      readSelection() ??
      deriveSelectionFromManifest(readManifest(deps.manifestPath));
    const without = current.filter((id) => id !== "research");
    return [
      {
        ...base,
        status: "warn",
        summary: "agy is not on PATH; research steps will be skipped",
        details: ["install agy, or drop the research module"],
        fix: `flow install --modules ${without.join(",")}`,
      },
    ];
  }
  if (r.status === 0 && countModelRows(r.stdout) >= 1) {
    return [
      {
        ...base,
        status: "pass",
        summary: "agy responds and lists models; quota not checked",
        details: [],
      },
    ];
  }
  const signedOut = looksUnauthenticated(`${r.stdout}\n${r.stderr}`);
  return [
    {
      ...base,
      status: "warn",
      summary: signedOut
        ? "agy is not signed in; research steps will be skipped"
        : "could not confirm agy works; research steps may be skipped",
      details: ["run it in a terminal and sign in if prompted"],
      fix: "agy models",
    },
  ];
}
