/**
 * Tiny dependency-free clickable-target helper for flow's CLI output.
 *
 * Gating contract: OSC 8 hyperlink escapes are emitted ONLY when stdout is
 * an interactive terminal and the user has not opted out via NO_COLOR or
 * FLOW_NO_HYPERLINKS. In every other context — piped, redirected, parsed by
 * another process, either opt-out set, or any non-TTY — `linkUrl`/`linkPath`
 * return their label byte-for-byte unchanged, so captured output is
 * identical to the no-link path.
 *
 * `hyperlinksEnabled` deliberately does NOT check FORCE_COLOR the way
 * `bin/lib/color.ts:19`'s `colorEnabled` does. `colorEnabled()` returns
 * `true` on FORCE_COLOR even when stdout is a pipe, which would inject OSC 8
 * escapes into machine-read contract lines (e.g. `flow-open-pr`'s bare-URL
 * stdout). There is no hyperlink equivalent of FORCE_COLOR's
 * deterministic-test-demo use case, so the check is dropped entirely rather
 * than carried over.
 *
 * Because of that, machine-read contract lines (e.g. `flow feature create`'s
 * first stdout line, the `GATED:`/`MERGED`/`NEEDS HUMAN:` sentinels in
 * `bin/flow-gate-summary.ts`) MUST NOT be passed through these helpers at
 * all. Keep contract tokens as raw strings.
 *
 * INVARIANT: the visible label passed to `linkUrl`/`linkPath` is ALWAYS the
 * raw target verbatim — never a prettified or truncated name. A caller that
 * needs a narrower label (e.g. `flow ls`'s PR column, which must stay
 * narrow enough not to blow the table's column-width math) uses the
 * explicit `linkLabel` escape hatch below and documents the exception
 * locally at its call site — never a silent divergence from the
 * `linkUrl`/`linkPath` default.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type LinkMode = "terminal" | "markdown" | "plain";

export function hyperlinksEnabled(): boolean {
  return (
    process.stdout.isTTY === true &&
    !("NO_COLOR" in process.env) &&
    !("FLOW_NO_HYPERLINKS" in process.env)
  );
}

export function resolveLinkMode(): LinkMode {
  return hyperlinksEnabled() ? "terminal" : "plain";
}

/**
 * Resolves a filesystem path to a `file://` URI via `node:url`'s
 * `pathToFileURL`. NEVER hand-roll per-segment percent-encoding — that's
 * exactly the class of bug `pathToFileURL` exists to avoid (spaces, unicode,
 * reserved characters).
 */
export function fileUri(p: string): string | null {
  if (!p || !p.trim()) return null;
  return pathToFileURL(path.resolve(p)).href;
}

// A third, narrower ANSI-stripping regex, deliberately distinct from the two
// existing `stripAnsi` definitions at `bin/flow-followups.ts:205` and
// `bin/flow-pre-commit.ts:1422`: this one also strips OSC 8 hyperlink
// sequences (`\x1b]8;;...\x1b\\`), which the other two never emit, and
// narrows the SGR match to the `m`-terminated form only. Not triplication —
// each regex matches a different escape vocabulary its own module emits.
const VISIBLE_LENGTH_RE = /\x1b\]8;;.*?\x1b\\|\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(VISIBLE_LENGTH_RE, "").length;
}

function wrap(label: string, uri: string | null, mode: LinkMode): string {
  if (!uri || label.includes("\x1b")) return label;
  if (mode === "terminal") return `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
  if (mode === "markdown") return `[${label}](${uri})`;
  return label;
}

export function linkUrl(url: string, mode: LinkMode): string {
  return wrap(url, url || null, mode);
}

export function linkPath(p: string, mode: LinkMode): string {
  return wrap(p, fileUri(p), mode);
}

/**
 * NAMED EXCEPTION to the label-equals-raw-target invariant above: wraps an
 * explicit `label` as a click target pointing at `url`, for the one caller
 * (`flow ls`'s PR column) where the full URL as a label would blow the
 * very column width the click target exists to fix. Every other call site
 * uses `linkUrl`/`linkPath`, whose label is always the verbatim target.
 * Same falsy/already-escaped-label passthrough as `linkUrl`/`linkPath`.
 */
export function linkLabel(label: string, url: string, mode: LinkMode): string {
  return wrap(label, url || null, mode);
}
