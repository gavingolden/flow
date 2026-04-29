import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { Logger } from "../../util/logger.js";

export interface VerifyGateResult {
  ok: boolean;
  output: string;
}

export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

export async function runVerifyGate(
  cwd: string,
  logger?: Logger,
): Promise<VerifyGateResult> {
  return runVerifyGateWithTimeout(cwd, VERIFY_TIMEOUT_MS, logger);
}

// Exposed so tests can exercise the timeout branch without sleeping for 10
// minutes. `runVerifyGate` is the only production caller.
export async function runVerifyGateWithTimeout(
  cwd: string,
  timeoutMs: number,
  logger?: Logger,
): Promise<VerifyGateResult> {
  const scriptPath = path.join(cwd, ".flow", "verify");
  // Stat first so a directory at `.flow/verify` collapses to the same
  // diagnostic as missing/non-executable. `fs.access(X_OK)` alone would
  // succeed on a directory with search permission and the spawn would
  // then throw with a platform-dependent message instead of the canonical
  // contract diagnostic.
  try {
    const stat = await fs.stat(scriptPath);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    await fs.access(scriptPath, fs.constants.X_OK);
  } catch {
    return {
      ok: false,
      output: `.flow/verify is missing or not executable in ${cwd}; create an executable script that runs this repository's required pre-PR validation checks`,
    };
  }

  logger?.event("verify-gate.start", `.flow/verify (cwd=${cwd})`);
  const start = Date.now();

  const exec = () =>
    execa(scriptPath, [], {
      cwd,
      reject: false,
      all: true,
      timeout: timeoutMs,
    });

  // execa 9.x throws on timeout and spawn failure (e.g. bad shebang).
  // Convert those into the deterministic { ok, output } contract — the
  // orchestrator relies on a non-throwing return for retry/surface logic.
  try {
    const result = logger ? await logger.withHeartbeat("verify", exec) : await exec();
    const durSec = Math.round((Date.now() - start) / 1000);
    const ok = result.exitCode === 0;
    logger?.event(
      "verify-gate.exit",
      `exit=${result.exitCode} dur=${durSec}s ok=${ok}`,
    );
    return {
      ok,
      output: result.all ?? result.stdout ?? "",
    };
  } catch (err) {
    const e = err as {
      all?: string;
      stdout?: string;
      stderr?: string;
      shortMessage?: string;
      message?: string;
    };
    const durSec = Math.round((Date.now() - start) / 1000);
    logger?.event("verify-gate.exit", `threw dur=${durSec}s ok=false`);
    return {
      ok: false,
      output:
        e.all ?? e.stdout ?? e.stderr ?? e.shortMessage ?? e.message ?? String(err),
    };
  }
}

const CAUTION_HEADER = "Pre-PR verify failed against pushed SHA — needs human review";

export async function surfaceVerifyFailureOnPr(
  prNumber: number,
  worktreePath: string,
  failureLog: string,
  logger?: Logger,
): Promise<void> {
  // This is best-effort surfacing — invoked only on the verify-failure path
  // where the *real* error has already been captured in `failureLog`. A
  // throw here (gh missing from PATH, worktree deleted, etc.) must not
  // mask the original failure or crash the orchestrator. `reject: false`
  // suppresses non-zero exits but does NOT suppress spawn-time errors, so
  // each execa call needs an explicit try/catch.
  let body: string;
  try {
    const view = await execa(
      "gh",
      ["pr", "view", String(prNumber), "--json", "body", "--jq", ".body"],
      { cwd: worktreePath, reject: false },
    );
    if (view.exitCode !== 0) {
      logger?.warn(
        `gh pr view #${prNumber} exit ${view.exitCode}; cannot surface verify failure`,
      );
      return;
    }
    body = view.stdout ?? "";
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    logger?.warn(
      `gh pr view #${prNumber} threw (${e.shortMessage ?? e.message ?? String(err)}); cannot surface verify failure`,
    );
    return;
  }

  const updated = upsertCautionBlock(body, failureLog);
  try {
    const edit = await execa(
      "gh",
      ["pr", "edit", String(prNumber), "--body-file", "-"],
      { cwd: worktreePath, input: updated, reject: false },
    );
    if (edit.exitCode !== 0) {
      logger?.warn(
        `gh pr edit #${prNumber} exit ${edit.exitCode}; verify-failure caution block may not be present`,
      );
    } else {
      logger?.info(`verify failure surfaced on PR #${prNumber}`);
    }
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    logger?.warn(
      `gh pr edit #${prNumber} threw (${e.shortMessage ?? e.message ?? String(err)}); verify-failure caution block not posted`,
    );
  }
}

// Exported for unit-test reach (PR 8). Keep behaviour idempotent: a prior
// caution block produced by this helper is replaced, never stacked.
export function upsertCautionBlock(body: string, failureLog: string): string {
  const block = [
    "> [!CAUTION]",
    `> ${CAUTION_HEADER}`,
    "",
    "```text",
    failureLog,
    "```",
  ].join("\n");

  const sectionRe = /^## Manual validation\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m;
  const match = body.match(sectionRe);
  if (!match) {
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}\n\n## Manual validation\n\n${block}\n`;
  }
  const matched = match[0];
  // Strip any prior caution block we wrote (idempotency). Match the exact
  // shape emitted in `block` above — the opening ` ```text ` fence is
  // anchored explicitly so removal runs through the closing fence rather
  // than stopping at the opening one.
  const priorRe = new RegExp(
    `\\n*> \\[!CAUTION\\]\\n> ${escapeRegex(CAUTION_HEADER)}\\n\\n\`\`\`text\\n[\\s\\S]*?\\n\`\`\`(?=\\n|$)`,
  );
  const cleaned = matched.replace(priorRe, "\n").replace(/\s+$/, "");
  return body.replace(matched, `${cleaned}\n\n${block}\n`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
