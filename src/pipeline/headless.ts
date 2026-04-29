import { execa } from "execa";
import type { Logger } from "../util/logger.js";

export interface HeadlessOptions {
  cwd: string;
  prompt: string;
  allowedTools?: string[];
  timeoutMs?: number;
  logger?: Logger;
  // Label used in heartbeat / event lines. Defaults to "claude" since this
  // wraps the Claude CLI; phases can pass a more specific label
  // (e.g. "claude (plan)") if useful.
  label?: string;
}

export interface HeadlessResult {
  ok: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

export async function runHeadless(
  opts: HeadlessOptions,
): Promise<HeadlessResult> {
  const args: string[] = ["-p", opts.prompt];
  if (opts.allowedTools?.length) {
    args.push("--allowed-tools", opts.allowedTools.join(","));
  }

  const label = opts.label ?? "claude";
  const logger = opts.logger;
  logger?.event("subprocess.spawn", `${label} (cwd=${opts.cwd})`);

  const start = Date.now();
  const run = async () => {
    // When a logger is wired up we tee stderr ourselves and only retain a
    // bounded tail (see below). Disable execa's internal stderr buffering
    // in that case so a chatty multi-minute Claude run can't balloon
    // memory through double-buffering. Without a logger, leave the
    // default (full buffering) so the failure path still has stderr to
    // report.
    const subprocess = execa("claude", args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 15 * 60 * 1000,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
      buffer: logger ? { stdout: true, stderr: false } : true,
    });

    // Tee stderr to logger.warn line-by-line as it arrives. Today this is
    // swallowed unless the subprocess exits non-zero, so the user sees
    // nothing while a multi-minute Claude session emits warnings.
    //
    // We keep only a bounded tail of stderr for the failure-path error
    // message — execa is *also* buffering full stderr internally, and a
    // chatty 30-min Claude run could double-buffer hundreds of MB
    // otherwise. The tail is purely diagnostic; the live tee'd lines are
    // already in the logger.
    let stderrTail = "";
    const STDERR_TAIL_MAX = 64 * 1024;
    if (logger && subprocess.stderr) {
      let pending = "";
      subprocess.stderr.setEncoding("utf8");
      subprocess.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX);
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length > 0) logger.warn(`${label} stderr: ${line}`);
        }
      });
      subprocess.stderr.on("end", () => {
        if (pending.trim().length > 0) logger.warn(`${label} stderr: ${pending}`);
      });
    }

    const result = await subprocess;
    return { result, stderrBuf: stderrTail };
  };

  const { result, stderrBuf } = logger
    ? await logger.withHeartbeat(label, run)
    : await run();

  const durationMs = Date.now() - start;
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;
  const output = result.stdout ?? "";
  // When stderr was tee'd, prefer the bounded tail we accumulated (execa
  // may not populate result.stderr in streaming mode); fall back to
  // result.stderr.
  const stderr = stderrBuf || result.stderr || "";

  logger?.event(
    "subprocess.exit",
    `${label} exit=${exitCode} dur=${Math.round(durationMs / 1000)}s`,
  );

  return {
    ok: exitCode === 0,
    output,
    error: exitCode !== 0 ? (stderr || output || `exit ${exitCode}`) : undefined,
    exitCode,
  };
}
