import { execa } from "execa";
import type { Logger } from "../util/logger.js";
import type { JsonlSink } from "../util/jsonl-sink.js";

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
  // When set, `claude -p` is invoked with `--output-format stream-json
  // --verbose` and its stdout is line-piped into the sink. The sink owns
  // the file lifecycle; we just write into it. Stderr handling is
  // unchanged regardless of `jsonl`.
  jsonl?: JsonlSink;
}

export interface HeadlessResult {
  ok: boolean;
  output: string;
  error?: string;
  exitCode: number;
  // True iff execa killed the subprocess because it exceeded `timeoutMs`.
  // Phases use this to distinguish "ran out of budget" from generic
  // failures so the retry prompt can nudge the model differently.
  timedOut?: boolean;
}

export async function runHeadless(
  opts: HeadlessOptions,
): Promise<HeadlessResult> {
  const args: string[] = ["-p", opts.prompt];
  if (opts.allowedTools?.length) {
    args.push("--allowed-tools", opts.allowedTools.join(","));
  }
  if (opts.jsonl) {
    // stream-json + --verbose is the per-event envelope PR 6's `flow log`
    // viewer will consume. Without `--verbose` the CLI emits a single
    // result-only line, which loses the per-tool-use detail we need for
    // observability and cost tally (PR 10).
    args.push("--output-format", "stream-json", "--verbose");
  }

  const label = opts.label ?? "claude";
  const logger = opts.logger;
  logger?.event("subprocess.spawn", `${label} (cwd=${opts.cwd})`);

  const start = Date.now();
  const run = async () => {
    // When a logger or jsonl sink is wired up we tee stdio ourselves and
    // only retain a bounded tail of stderr (see below). Disable execa's
    // internal stdio buffering in those cases so a chatty multi-minute
    // Claude run can't balloon memory through double-buffering. Without
    // either sink, leave the default (full buffering) so the failure path
    // still has stderr/stdout to report.
    const teeingStderr = !!logger;
    const teeingStdout = !!opts.jsonl;
    const subprocess = execa("claude", args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 15 * 60 * 1000,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
      buffer:
        teeingStderr || teeingStdout
          ? { stdout: !teeingStdout, stderr: !teeingStderr }
          : true,
    });

    // Tee stdout into the jsonl sink. We let pipeFrom do its own line
    // buffering (the sink's contract is "never write a partial line") so
    // stream-json invariants survive even if Anthropic's CLI flushes
    // mid-event.
    let stdoutPipePromise: Promise<void> | null = null;
    if (opts.jsonl && subprocess.stdout) {
      stdoutPipePromise = opts.jsonl.pipeFrom(subprocess.stdout);
    }

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
    if (stdoutPipePromise) {
      // Make sure every byte the child wrote landed in the sink before we
      // hand control back. Without this, a fast-exiting child can race the
      // sink's `end` listener and we'd close the file mid-buffer.
      await stdoutPipePromise;
    }
    return { result, stderrBuf: stderrTail };
  };

  const { result, stderrBuf } = logger
    ? await logger.withHeartbeat(label, run)
    : await run();

  const durationMs = Date.now() - start;
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;
  // When stdout is being piped to jsonl, execa won't have a buffered
  // stdout to return. The single caller of `output` (the failure-path
  // error message) falls back to stderr / exit code, so leaving it empty
  // is fine.
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
    timedOut: result.timedOut === true,
  };
}
