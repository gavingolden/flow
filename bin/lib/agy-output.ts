/** Classifiers over agy's raw output text, shared by `flow-delegate` and `flow doctor`. */

// An auth failure is downgraded to a quieter, more actionable skipReason
// than a generic error so a caller can tell "log in to agy" apart from
// "the model run failed".
export function looksUnauthenticated(text: string): boolean {
  return /unauthenticat|not authenticated|not logged in|please log\s?in|sign in|auth(?:entication)? (?:required|failed)|reauthenticate/i.test(
    text,
  );
}

// A `--print-timeout` kill is distinguishable from a genuine model error.
// Three verified agy 1.1.25 timeout signatures, none of which overlap the
// auth patterns below (checked BEFORE looksUnauthenticated so a future
// widening of the auth regex can never shadow a timeout):
// - text mode: agy's stderr reads "Error: timeout waiting for response".
// - json mode: stderr is EMPTY (the process still exits 1); the same
//   "timeout waiting for response" string instead lands in the json
//   envelope's `error` field, fed through this same regex by the
//   classifyAgyOutcome caller below.
// - log-file-only: "Print mode: timed out after N polls (printed=M)" is
//   written to agy's own log under ~/.gemini/antigravity-cli/log/, never to
//   stdout/stderr — this alternation can never match live input today, but
//   is kept cheap insurance against a future agy version routing it there.
export function looksTimedOut(text: string): boolean {
  return /timeout waiting for response|print[- ]timeout|deadline exceeded|context deadline|timed out after \d+ polls|print mode: timed out/i.test(
    text,
  );
}
