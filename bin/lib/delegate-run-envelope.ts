import { redactForPublish } from "./redact-secrets";

// Exit 2 with empty stdout means flow-delegate rejected its own argv/inputs:
// every `return 2` in flow-delegate precedes the agy spawn, so no model call
// ran and no quota was spent.
export type DelegateEnvelope = {
  ran?: boolean;
  skipReason?: string;
  artifactPath?: string;
  exitCode?: number;
  stderrTail?: string;
  agyStatus?: string;
  agyError?: string;
  deniedActions?: string[];
  usage?: Record<string, number>;
};

export function parseDelegateRun(
  stdout: string,
  exitCode: number | null,
  stderr: string,
): DelegateEnvelope {
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  if (line === undefined) {
    if (exitCode === 2) {
      const tail = stderr.trim().slice(-500);
      return {
        ran: false,
        skipReason: "delegate-usage-error",
        exitCode: 2,
        ...(tail ? { stderrTail: redactForPublish(tail) } : {}),
      };
    }
    return {};
  }
  try {
    return JSON.parse(line) as DelegateEnvelope;
  } catch {
    return { ran: false, skipReason: "delegate-envelope-unparseable" };
  }
}
