#!/usr/bin/env bun
/**
 * Claude Code SessionStart hook that shows a flow pipeline's originating
 * request under the Claude banner, un-collapsed, with no model turn.
 *
 * Registered only in flow's launch settings (`ensureLaunchSettings`), as two
 * matcher-scoped entries: `startup|compact` runs this bare, `clear` runs it
 * with `--on-clear`. The matchers do the source filtering, so this hook
 * reads no stdin. The slug comes from `FLOW_SLUG`; the state and request
 * files are the only inputs.
 *
 * Output is exactly one JSON object `{"systemMessage": ...}` or nothing —
 * never plain text and never `additionalContext`, both of which Claude Code
 * feeds to the model. It writes no state and always exits 0, so a failure
 * can never block a session start.
 */

import fs from "node:fs";
import { renderRequestEchoMessage } from "./lib/request-echo";
import { resolveSlugFromEnv } from "./lib/session-identity";
import {
  FINISHED_PHASE_SET,
  readState,
  requestFilePath,
  resolveStateKind,
  type PipelineState,
} from "./lib/state";

export type EchoInput = {
  onClear: boolean;
  slug: string | null;
  state: PipelineState | null;
  requestText: string | null;
};

export function decideEcho(input: EchoInput): { systemMessage: string } | null {
  const { onClear, slug, state, requestText } = input;
  if (slug === null || state === null) return null;
  if (resolveStateKind(state) === "epic-run") return null;
  if (onClear && FINISHED_PHASE_SET.has(state.phase)) return null;
  if (requestText === null || requestText === "") {
    return { systemMessage: `flow: could not read the request for ${slug}` };
  }
  return { systemMessage: renderRequestEchoMessage(state, requestText) };
}

export type Deps = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  write: (s: string) => void;
};

function readRequest(slug: string, stateDir?: string): string | null {
  try {
    return fs.readFileSync(requestFilePath(slug, stateDir), "utf8");
  } catch {
    return null;
  }
}

export function run(deps: Deps): number {
  try {
    const slug = resolveSlugFromEnv(deps.env);
    const state = slug === null ? null : readState(slug, deps.stateDir);
    const decision = decideEcho({
      onClear: deps.argv.includes("--on-clear"),
      slug,
      state,
      requestText:
        slug === null || state === null
          ? null
          : readRequest(slug, deps.stateDir),
    });
    if (decision !== null) deps.write(JSON.stringify(decision));
  } catch {
    // A display hook must never break a session start.
  }
  return 0;
}

if (import.meta.main) {
  process.exit(
    run({
      argv: process.argv.slice(2),
      env: process.env,
      write: (s) => process.stdout.write(s),
    }),
  );
}
