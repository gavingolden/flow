import type { Colors, RenderResult } from "./render.js";
import {
  TRUNCATE_AT,
  firstLine,
  formatDuration,
  splitParagraphs,
  stringField,
  stringifyInput,
  stringifyRest,
  truncate,
} from "./render-utils.js";

export function renderStreamJson(
  event: Record<string, unknown>,
  colors: Colors,
): RenderResult {
  const type = event["type"] as string;
  switch (type) {
    case "assistant":
      return renderAssistant(event, colors);
    case "user":
      return renderUser(event, colors);
    case "result":
      return renderResult(event, colors);
    case "system":
    case "rate_limit_event":
      // Noisy infra-level events with no debugging value for the
      // line-per-event view. Skip silently.
      return { lines: [] };
    default:
      return {
        lines: [colors.dim(`${type} ${stringifyRest(event, ["type"])}`)],
      };
  }
}

function renderAssistant(
  event: Record<string, unknown>,
  colors: Colors,
): RenderResult {
  const lines: string[] = [];
  for (const block of contentBlocks(event)) {
    const blockType = (block as Record<string, unknown>)["type"];
    if (blockType === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      for (const para of splitParagraphs(text)) lines.push(`  ${para}`);
    } else if (blockType === "thinking") {
      const text = (block as { thinking?: unknown }).thinking;
      if (typeof text !== "string") continue;
      for (const para of splitParagraphs(text)) {
        lines.push(colors.dim(`  ${para}`));
      }
    } else if (blockType === "tool_use") {
      lines.push(renderToolUse(block as Record<string, unknown>, colors));
    }
  }
  return { lines };
}

function renderUser(
  event: Record<string, unknown>,
  colors: Colors,
): RenderResult {
  // user events from the Claude CLI carry tool_result blocks back in.
  const lines: string[] = [];
  for (const block of contentBlocks(event)) {
    if ((block as Record<string, unknown>)["type"] === "tool_result") {
      lines.push(renderToolResult(block as Record<string, unknown>, colors));
    }
  }
  return { lines };
}

function renderToolUse(
  block: Record<string, unknown>,
  colors: Colors,
): string {
  const name = typeof block["name"] === "string" ? block["name"] : "tool";
  const input = (block["input"] ?? {}) as Record<string, unknown>;
  const short = shortToolArgs(name, input);
  return `${colors.cyan(`${name}(`)}${short}${colors.cyan(")")}`;
}

function shortToolArgs(name: string, input: Record<string, unknown>): string {
  let raw: string;
  switch (name) {
    case "Bash":
      raw = stringField(input, "command") ?? stringifyInput(input);
      break;
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit":
      raw = stringField(input, "file_path") ?? stringifyInput(input);
      break;
    case "Glob":
    case "Grep":
      raw = stringField(input, "pattern") ?? stringifyInput(input);
      break;
    default:
      raw = stringifyInput(input);
  }
  return truncate(raw, TRUNCATE_AT);
}

function renderToolResult(
  block: Record<string, unknown>,
  colors: Colors,
): string {
  const isError = block["is_error"] === true;
  const content = block["content"];
  let summary = "";
  if (typeof content === "string") {
    summary = firstLine(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>)["type"] === "text"
      ) {
        const t = (part as { text?: unknown }).text;
        if (typeof t === "string") {
          summary = firstLine(t);
          break;
        }
      }
    }
  }
  const head = isError ? colors.red("← error") : colors.dim("←");
  const body = truncate(summary || (isError ? "(error)" : "(ok)"), TRUNCATE_AT);
  return `${head} ${colors.dim(body)}`;
}

function renderResult(
  event: Record<string, unknown>,
  colors: Colors,
): RenderResult {
  const subtype = typeof event["subtype"] === "string" ? event["subtype"] : "";
  const isError = event["is_error"] === true;
  const status = isError ? "error" : subtype || "ok";
  const durationMs =
    typeof event["duration_ms"] === "number" ? event["duration_ms"] : null;
  const cost =
    typeof event["total_cost_usd"] === "number"
      ? event["total_cost_usd"]
      : null;
  const parts: string[] = [`status=${status}`];
  if (durationMs !== null) parts.push(`duration=${formatDuration(durationMs)}`);
  if (cost !== null) parts.push(`cost=$${cost.toFixed(4)}`);
  const styled = isError
    ? colors.red(parts.join(" "))
    : colors.green(parts.join(" "));
  return { lines: [`result ${styled}`] };
}

function contentBlocks(event: Record<string, unknown>): unknown[] {
  const message = event["message"];
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>)["content"];
  return Array.isArray(content) ? content : [];
}
