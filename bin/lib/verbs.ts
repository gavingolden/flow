/**
 * Single source of truth for the verbs dispatched by `bin/flow`. Imported by
 * the wrapper (for unknown-verb detection) and by the completion-script tests
 * (to assert the scripts list every shipped verb so a future verb addition
 * fails the build until both completion files are updated).
 */

export const VERBS = [
  "setup",
  "new",
  "ls",
  "attach",
  "a",
  "done",
  "migrate",
  "completion",
  "version",
  "help",
  "--version",
  "-v",
  "--help",
  "-h",
] as const;

export type Verb = (typeof VERBS)[number];

const VERBS_SET = new Set<string>(VERBS);

export function isVerb(verb: string): boolean {
  return VERBS_SET.has(verb);
}
