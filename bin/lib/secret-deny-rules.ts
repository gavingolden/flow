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
 * Pre-approves `flow-ui-login check`/`serve` only — never a blanket
 * `flow-ui-login *`, which would also pre-approve the hidden
 * `__serve-child` subcommand (arbitrary `--user-name`/`--pass-name` on
 * argv, no classifier check) and let an agent that improvises after a
 * denial reach it directly. The auto-mode classifier still sees, and can
 * still deny, every other `flow-ui-login` invocation.
 */
export const FLOW_UI_LOGIN_ALLOW_RULES: readonly string[] = [
  "Bash(flow-ui-login check *)",
  "Bash(flow-ui-login serve *)",
];
