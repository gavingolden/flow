import pc from "picocolors";
import { renderStreamJson } from "./render-stream.js";
import { renderFlowEvent } from "./render-flow.js";

export interface RenderOptions {
  // Force ANSI on/off; default = picocolors' auto-detection. Tests force-on
  // because vitest runs under a non-TTY where picocolors strips colors.
  forceColor?: boolean;
}

export interface RenderResult {
  // Lines to write to stdout, already styled. Empty array means the event
  // produced no visible output (e.g. a system/init we choose not to render).
  lines: string[];
}

export type Colors = ReturnType<typeof pc.createColors>;

export function colorsFor(opts: RenderOptions): Colors {
  return opts.forceColor !== undefined
    ? pc.createColors(opts.forceColor)
    : pc;
}

export function renderLine(
  rawLine: string,
  opts: RenderOptions = {},
): RenderResult | { malformed: true } {
  const trimmed = rawLine.replace(/\r?\n$/, "");
  if (trimmed.length === 0) return { lines: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { malformed: true };
  }
  if (!parsed || typeof parsed !== "object") return { lines: [] };
  return renderEvent(parsed as Record<string, unknown>, opts);
}

export function renderEvent(
  event: Record<string, unknown>,
  opts: RenderOptions = {},
): RenderResult {
  const colors = colorsFor(opts);

  // Stream-json events use `type` (assistant/user/result/system); flow
  // script-phase events use `kind`. Dispatch on whichever is present.
  if (typeof event["type"] === "string") {
    return renderStreamJson(event, colors);
  }
  if (typeof event["kind"] === "string") {
    return renderFlowEvent(event, colors);
  }
  return { lines: [colors.dim(JSON.stringify(event))] };
}
