/**
 * Tiny dependency-free ANSI styling helper for flow's CLI output.
 *
 * Gating contract: color is emitted ONLY when stdout is an interactive
 * terminal and the user has not opted out via NO_COLOR. FORCE_COLOR
 * force-enables it (for deterministic tests and CI demos). In every other
 * context — piped, redirected, parsed by another process, NO_COLOR set, or
 * any non-TTY — `dim`/`green`/`red` return their input byte-for-byte
 * unchanged, so captured output is identical to the no-color path.
 *
 * Because of that, machine-read contract lines (e.g. `flow feature create`'s first
 * stdout line, `flow done`'s `closed:` token) MUST NOT be passed through
 * these helpers at all. The gating makes color absent when piped, but a
 * forced-color interactive run would still inject SGR bytes into a line a
 * downstream parser reads. Keep contract tokens as raw strings.
 */

export function colorEnabled(): boolean {
  if (process.env.FORCE_COLOR) return true;
  // no-color.org: NO_COLOR present with ANY value (including empty) disables
  // color. Gate on presence, not truthiness.
  return process.stdout.isTTY === true && !("NO_COLOR" in process.env);
}

/**
 * Like `colorEnabled` but gated on stderr's TTY rather than stdout's. The
 * update-staleness notice prints to stderr, so coloring it on stdout's TTY
 * leaks SGR bytes into `flow version 2>log` even when the log is a file.
 */
export function colorEnabledStderr(): boolean {
  if (process.env.FORCE_COLOR) return true;
  return process.stderr.isTTY === true && !("NO_COLOR" in process.env);
}

function wrap(code: number, s: string): string {
  return colorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export function dim(s: string): string {
  return wrap(2, s);
}

/** stderr-gated `dim` — see `colorEnabledStderr`. */
export function dimStderr(s: string): string {
  return colorEnabledStderr() ? `\x1b[2m${s}\x1b[0m` : s;
}

export function green(s: string): string {
  return wrap(32, s);
}

export function red(s: string): string {
  return wrap(31, s);
}
