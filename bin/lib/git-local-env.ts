/**
 * Git's repo-pointing environment variables — the names
 * `git rev-parse --local-env-vars` prints. A process that inherits any of
 * them (a check launched from a git hook, say) makes every git command it
 * runs act on the hook's repository instead of the one it was pointed at.
 * An enumerated list, not a `GIT_*` prefix strip, so `GIT_SSH_COMMAND`,
 * `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT` and `GIT_AUTHOR_*` stay intact.
 * Mirrors econ-data PR 990; `git-local-env.test.ts` pins it against the
 * running git.
 */
export const GIT_LOCAL_ENV_VARS: readonly string[] = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** Copy of `env` without git's repo-pointing variables; never mutates `env`. */
export function withoutGitLocalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of GIT_LOCAL_ENV_VARS) delete copy[name];
  return copy;
}
