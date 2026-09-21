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
  "Read(//**/.dev.vars)",
  "Read(//**/.envrc)",
];

/**
 * Pre-approves `flow-ui-login` so the auto-mode classifier doesn't itself
 * refuse the one sanctioned path to a credential value — the whole
 * stop-on-denial design (`<!-- flow-credential-denial-rule -->`) depends on
 * this helper never being the thing that gets denied.
 */
export const FLOW_UI_LOGIN_ALLOW_RULE = "Bash(flow-ui-login *)";
