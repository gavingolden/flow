/**
 * Pure renderer for the `flow prompt` verb's stdout block — the verbatim
 * echo of a pipeline's originating request text.
 *
 * Modeled on `bin/lib/echo-recap.ts`: a pure function (never reads files
 * itself), bounded by an HTML-comment marker pair so a caller can grep/sed
 * it out reliably, with its own marker literals — never
 * `ECHO_RECAP_START`/`ECHO_RECAP_END`, which are already grepped/sed'd by
 * the gate-stage recap path and would make both extractions ambiguous.
 *
 * The body is a raw pass-through of the caller-supplied request text: no
 * trim, no fence, no indent, no wrapping, no link rewriting, no escaping.
 * Byte-identity is the whole point of this renderer — the body must survive
 * containing triple backticks or the marker strings themselves. Only the
 * header's `repo` value is routed through `bin/lib/link.ts` (markdown mode,
 * per AGENTS.md's emitted-path rule); the body is never touched by it.
 *
 * Because the body can itself contain the marker strings, a caller
 * extracting this block back out of stdout MUST scan from the FIRST start
 * marker to the LAST end marker — not the first end marker, which would
 * truncate a body that quotes `REQUEST_ECHO_END` verbatim.
 */

import { linkPath } from "./link";
import type { PipelineState } from "./state";

export const REQUEST_ECHO_START = "<!-- flow-request-echo:start -->";
export const REQUEST_ECHO_END = "<!-- flow-request-echo:end -->";

/**
 * The run-shaping `PipelineState` fields `flow feature create` can set,
 * rendered as the flags that would reproduce them. Per-phase model
 * overrides (`modelPlanning`/`modelImplement`/`modelMergeResolver`/etc) and
 * `interviewMode` are deliberately OMITTED — they shape sub-agent/interview
 * behaviour, not what the user asked for.
 *
 * `launcher` is deliberately NOT rendered as a `--tmux`/`--no-tmux` flag
 * here: per `bin/lib/state.ts`, an absent `launcher` means "legacy tmux-era
 * pipeline" (not "the user typed nothing"), and `bin/lib/feature.ts` stores
 * the RESOLVED backend after config-default fallback, not literally what
 * the user passed on the command line. Rendering it as a flag would print
 * `--tmux` for a config default the user never typed, and could never print
 * `--no-tmux` at all (there is no `launcher: "plain-explicit"` state to
 * distinguish it from a config-resolved default). It is instead surfaced as
 * an informational `launcher: <value>` header field the caller appends
 * itself when present — never as one of the reproducing flags below.
 */
export function runShapingFlags(state: PipelineState): string[] {
  const flags: string[] = [];
  if (state.autoMerge === false) flags.push("--no-auto-merge");
  if (state.waitForCopilot === true) flags.push("--wait-for-copilot");
  if (state.forceResearch === true) flags.push("--research");
  if (state.copilotReview !== undefined && state.copilotReview !== "auto") {
    flags.push(`--copilot-review ${state.copilotReview}`);
  }
  if (state.model !== undefined) flags.push(`--model ${state.model}`);
  if (state.effort !== undefined) flags.push(`--effort ${state.effort}`);
  if (state.epic !== undefined) {
    flags.push(`--epic ${state.epic.slug}/${state.epic.featureId}`);
  }
  return flags;
}

export function renderRequestEcho(
  state: PipelineState,
  requestText: string,
): string {
  const flags = runShapingFlags(state);
  const flagsText =
    flags.length > 0 ? `flags: ${flags.join(" ")}` : "flags: none";
  const repoText = linkPath(state.repo, "markdown");
  const launcherText =
    state.launcher !== undefined ? ` | launcher: ${state.launcher}` : "";
  const header = `slug: ${state.slug} | repo: ${repoText} | ${flagsText}${launcherText}`;
  return [REQUEST_ECHO_START, header, "", requestText, REQUEST_ECHO_END].join(
    "\n",
  );
}
