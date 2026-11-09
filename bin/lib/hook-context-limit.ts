/**
 * 500 under Claude Code's 10,000-character cap on one hook `additionalContext`
 * string (https://code.claude.com/docs/en/hooks); anything longer is replaced
 * by a file path and a 2,000-character preview. Its own tiny module so the
 * `SessionStart:clear` hook can import the limit without loading the history
 * renderer's module graph on every `/clear` on the machine.
 */
export const HOOK_CONTEXT_MAX_CHARS = 9_500;
