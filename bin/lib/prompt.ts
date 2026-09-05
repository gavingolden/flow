/**
 * `flow prompt [<slug>]` — print a pipeline's originating request, verbatim.
 *
 * Reads `~/.flow/state/<slug>.json` (via `readState`) and
 * `~/.flow/state/<slug>.request.md` (via `requestFilePath`) and renders them
 * through `bin/lib/request-echo.ts`'s pure `renderRequestEcho`. Never
 * escalates, never throws — every degraded path returns non-zero with a
 * named stderr reason and EMPTY stdout, so a caller (e.g. `/flow-pipeline`
 * Step 0) can safely treat any non-zero exit as "could not read the
 * request" and move on.
 *
 * Slug resolution: the first positional argument, else `resolveSlugAmbient`
 * (env-only — `FLOW_SLUG`, set by both launcher backends). Never widens the
 * request/state file permissions and never copies the request file
 * anywhere.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import { resolveSlugAmbient } from "./session-identity";
import { readState, requestFilePath, statePath } from "./state";
import * as fs from "node:fs";
import { renderRequestEcho } from "./request-echo";

export function runPromptCli(
  args: string[],
  options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): number {
  if (argsContainHelp(args)) {
    printVerbHelp("prompt");
    return 0;
  }

  const positional = args.find((a) => !a.startsWith("-"));
  const slug = positional ?? resolveSlugAmbient({ env: options.env });
  if (!slug) {
    console.error(
      "usage: flow prompt [<slug>]  (no slug given and FLOW_SLUG is not set)",
    );
    return 1;
  }

  const stPath = statePath(slug, options.stateDir);
  if (!fs.existsSync(stPath)) {
    console.error(`flow prompt: no state file at ${stPath}`);
    return 1;
  }
  const state = readState(slug, options.stateDir);
  if (!state) {
    console.error(`flow prompt: state file unreadable/invalid at ${stPath}`);
    return 1;
  }

  const reqPath = requestFilePath(slug, options.stateDir);
  let requestText: string;
  try {
    requestText = fs.readFileSync(reqPath, "utf8");
  } catch {
    console.error(`flow prompt: no request file at ${reqPath}`);
    return 1;
  }
  if (requestText.length === 0) {
    console.error(`flow prompt: request file is empty at ${reqPath}`);
    return 1;
  }

  console.log(renderRequestEcho(state, requestText));
  return 0;
}
