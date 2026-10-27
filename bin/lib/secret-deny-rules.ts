/**
 * Secret-file read guard: the deny rules `bin/lib/feature.ts`'s
 * `ensureLaunchSettings` writes into flow's own launch-settings file, and
 * `bin/lib/claude-headless.ts`'s `buildChildArgv` folds onto
 * `--disallowedTools`. Both surfaces are flow-launched sessions only — see
 * `references/consumer-repo-contract.md` `## Secret-file read guard` for why
 * these never ship into a consumer repo's `.claude/settings.json` or the
 * user's global settings.
 *
 * A named list, not an `.env*` glob: a glob deny can't be carved back out,
 * and `flow-ui-validate`'s bootstrap inference (`bin/flow-ui-validate.ts`'s
 * `inferAuth`) deliberately still reads `.env.example` for credential NAMES.
 */

export const SECRET_FILE_DENY_RULES: readonly string[] = [
  "Read(//**/.env)",
  "Read(//**/.env.local)",
  "Read(//**/.env.*.local)",
  "Read(//**/.env.development)",
  "Read(//**/.env.production)",
  "Read(//**/.env.test)",
  "Read(//**/.env.staging)",
  "Read(//**/.env.prod)",
  "Read(//**/.env.dev)",
  "Read(//**/.env.stage)",
  "Read(//**/.env.preview)",
  "Read(//**/.env.ci)",
  "Read(//**/.env.qa)",
  "Read(//**/.env.vault)",
  "Read(//**/.env.keys)",
  "Read(//**/.dev.vars)",
  "Read(//**/.envrc)",
];

/**
 * Pre-approves `flow-ui-login check`/`test-account` only — one rule per
 * subcommand, never a blanket `flow-ui-login *`, so a future subcommand is
 * never silently pre-approved. The auto-mode classifier still sees, and can
 * still deny, every other `flow-ui-login` invocation.
 */
export const FLOW_UI_LOGIN_ALLOW_RULES: readonly string[] = [
  "Bash(flow-ui-login check *)",
  "Bash(flow-ui-login test-account *)",
];

/**
 * Blanket `flow-create-issue *`: the helper has no hidden subcommand, files
 * only to the current repo (it also provisions its labels via `gh label
 * create --force`), and is idempotent on title. Only effective on a
 * standalone call — a `$(…)`-wrapped call is approved against the whole
 * subcommand and never matches.
 *
 * Accepted risk: the rubric check on the body (exit 3) is structure-only —
 * it requires the value-block labels and constrains no other content — and
 * `--title` / `--body-file` are free. So a flow-launched session (including a
 * fix-applier reading untrusted PR text) can publish arbitrary text to the
 * current repo's issue tracker without an auto-mode classifier review. The
 * payload is limited to data already in the agent's context (the credential
 * deny rules still block reading `.env`-family files) — which now includes
 * the two test-account values `flow-ui-login test-account` prints. That
 * helper reads only the two variable names in the COMMITTED
 * `.flow/ui-validation.json` and refuses non-localhost targets, so a steered
 * agent cannot point it at real secrets without a visible commit; we accept
 * the remaining narrow path (seeded local test-account values reaching an
 * issue body) in exchange for review deferrals not being refused.
 */
export const FLOW_CREATE_ISSUE_ALLOW_RULES: readonly string[] = [
  "Bash(flow-create-issue *)",
];

/**
 * Keeps a flow-launched session from granting the epic executive autonomy:
 * denies the high-autonomy grant command (space and `=` forms, and an `env`
 * launderer) and any write to `~/.flow/state/managers/**`, where `grant.json`
 * lives. A guard, not a proof — the CLI itself also refuses a non-TTY or
 * `CLAUDECODE` caller; a forged grant still shows on first use in the PR stamp
 * and the log line.
 */
export const EPIC_GRANT_DENY_RULES: readonly string[] = [
  "Bash(*flow epic grant * --autonomy high*)",
  "Bash(*flow epic grant * --autonomy=high*)",
  "Bash(*flow epic grant --autonomy high*)",
  "Bash(*flow epic grant --autonomy=high*)",
  "Bash(env * flow epic grant *)",
  "Bash(*managers/*grant.json*)",
  "Write(~/.flow/state/managers/**)",
  "Edit(~/.flow/state/managers/**)",
];
