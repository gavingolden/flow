import { execa } from "execa";

export interface HeadlessOptions {
  cwd: string;
  prompt: string;
  allowedTools?: string[];
  timeoutMs?: number;
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

  const result = await execa("claude", args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 15 * 60 * 1000,
    reject: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;
  const output = result.stdout ?? "";
  return {
    ok: exitCode === 0,
    output,
    error: exitCode !== 0 ? (result.stderr || output || `exit ${exitCode}`) : undefined,
    exitCode,
  };
}
