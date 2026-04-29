import type { Colors, RenderResult } from "./render.js";
import {
  TRUNCATE_AT,
  formatDuration,
  stringField,
  stringifyRest,
  truncate,
} from "./render-utils.js";

export function renderFlowEvent(
  event: Record<string, unknown>,
  colors: Colors,
): RenderResult {
  const kind = event["kind"] as string;
  switch (kind) {
    case "exec": {
      const cmd = stringField(event, "cmd") ?? "";
      const args = Array.isArray(event["args"])
        ? (event["args"] as unknown[])
            .filter((x): x is string => typeof x === "string")
            .join(" ")
        : "";
      const body = truncate([cmd, args].filter(Boolean).join(" "), TRUNCATE_AT);
      return { lines: [`${colors.cyan("exec")} ${body}`] };
    }
    case "exec.exit": {
      const cmd = stringField(event, "cmd") ?? "";
      const exit =
        typeof event["exit"] === "number" ? (event["exit"] as number) : -1;
      const dur =
        typeof event["durationMs"] === "number"
          ? formatDuration(event["durationMs"] as number)
          : "?";
      const colored =
        exit === 0 ? colors.green(`exit=${exit}`) : colors.red(`exit=${exit}`);
      return {
        lines: [
          `${colors.dim("exec.exit")} ${cmd} ${colored} ${colors.dim(dur)}`,
        ],
      };
    }
    case "info":
      return {
        lines: [`${colors.gray("info")} ${stringField(event, "msg") ?? ""}`],
      };
    case "warn":
      return {
        lines: [`${colors.yellow("warn")} ${stringField(event, "msg") ?? ""}`],
      };
    case "error":
      return {
        lines: [`${colors.red("error")} ${stringField(event, "msg") ?? ""}`],
      };
    case "result": {
      const status = stringField(event, "status") ?? "?";
      const reason = stringField(event, "reason");
      const colored =
        status === "ok"
          ? colors.green(`result status=${status}`)
          : status === "failed"
            ? colors.red(`result status=${status}`)
            : colors.yellow(`result status=${status}`);
      const tail = reason ? ` ${colors.dim(reason)}` : "";
      return { lines: [`${colored}${tail}`] };
    }
    default:
      return {
        lines: [
          `${colors.dim(kind)} ${colors.dim(stringifyRest(event, ["ts", "kind"]))}`,
        ],
      };
  }
}
