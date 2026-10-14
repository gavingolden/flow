/**
 * `flow doctor` check for the auto-mode entry that lets the browser-driven
 * UI check log in. Read-only: flow prints the entry and the file to edit; the
 * owner keeps `autoMode.allow` in their one hand-managed user-global file.
 *
 * Claude Code reads `autoMode` only from user, managed and `--settings`
 * scope, never from a repo's `.claude/settings*.json`, so this probe reads the
 * user file only and says so.
 */

import { readUserSettings, userSettingsPath } from "./claude-user-settings";
import type { DoctorCheck, DoctorDeps } from "./doctor";

export const TOOLS_UI_LOGIN_AUTOMODE_META = {
  id: "tools-ui-login-automode",
  section: "tools",
  title: "Auto-mode UI login",
} as const;

export const FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY: string =
  "flow UI-check login: running `flow-ui-login check` or `flow-ui-login serve` inside a flow pipeline worktree, then passing the `fillScript` that `flow-ui-login serve` printed, verbatim, to the chrome-devtools `evaluate_script` tool, is a sanctioned login to a seeded test account on a local dev server (localhost / 127.0.0.1). The script contains no credential value and no token; the values travel only in the page's own one-time fetch from a loopback endpoint and never reach the transcript. This does not cover printing, echoing, grepping or reading credential variables or `.env`-family files, or requesting the loopback endpoint any other way — those stay blocked.";

const DEFAULTS_TOKEN = "$defaults";
const ENTRY_MARKER = "flow-ui-login";

const PASTE_ENTRY = JSON.stringify(FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY);

const SCOPE_NOTE =
  "managed or --settings autoMode entries are not read here; autoMode is never read from a repo's .claude/settings*.json";

export function checkUiLoginAutoMode(deps: DoctorDeps): DoctorCheck[] {
  const base = TOOLS_UI_LOGIN_AUTOMODE_META;
  const read = readUserSettings(userSettingsPath(deps.env, deps.homeDir));
  const file = read.path;

  if (read.status === "malformed") {
    return [
      {
        ...base,
        status: "warn",
        summary: `cannot tell whether auto mode will accept the UI-check login — ${file} is not a valid JSON object`,
        details: [
          "the settings file is not a valid JSON object",
          `once repaired, add this line to autoMode.allow in ${file}, keeping "${DEFAULTS_TOKEN}":`,
          PASTE_ENTRY,
          SCOPE_NOTE,
        ],
        fix: `repair the JSON in ${file}, then add the entry above to autoMode.allow, keeping "${DEFAULTS_TOKEN}"`,
      },
    ];
  }

  const autoMode =
    read.status === "ok"
      ? (read.settings.autoMode as { allow?: unknown } | null | undefined)
      : undefined;
  const allow = Array.isArray(autoMode?.allow)
    ? (autoMode.allow as unknown[]).filter(
        (e): e is string => typeof e === "string",
      )
    : [];
  const hasEntry = allow.some((e) => e.includes(ENTRY_MARKER));
  const hasDefaults = allow.includes(DEFAULTS_TOKEN);

  if (hasEntry && hasDefaults) {
    return [
      {
        ...base,
        status: "pass",
        summary: `your Claude settings tell auto mode the UI-check login is sanctioned (${file})`,
        details: [],
      },
    ];
  }

  if (hasEntry) {
    return [
      {
        ...base,
        status: "warn",
        summary: `autoMode.allow lacks "${DEFAULTS_TOKEN}", so Claude Code's built-in allow exceptions are replaced`,
        details: [
          `the flow-ui-login entry is present in ${file}, but without "${DEFAULTS_TOKEN}" the built-in allow exceptions are replaced rather than extended`,
          SCOPE_NOTE,
        ],
        fix: `add "${DEFAULTS_TOKEN}" to autoMode.allow in ${file}`,
      },
    ];
  }

  return [
    {
      ...base,
      status: "warn",
      summary: "auto mode may refuse the UI-check login",
      details: [
        read.status === "missing-file"
          ? "the settings file does not exist"
          : "autoMode.allow has no flow-ui-login entry",
        `add this line to autoMode.allow in ${file}, keeping "${DEFAULTS_TOKEN}":`,
        PASTE_ENTRY,
        SCOPE_NOTE,
      ],
      fix: `add the entry above to autoMode.allow in ${file}, keeping "${DEFAULTS_TOKEN}"`,
    },
  ];
}
