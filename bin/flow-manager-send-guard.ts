#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook (matcher `SendMessage`) for the global manager's
 * settings: the manager may message only a pipeline whose slug its scope
 * covers. The peer name is the slug (pipelines launch with `--name <slug>`),
 * optionally followed by a ` [ref]` suffix that is stripped first.
 *
 * Fails CLOSED, unlike `flow-bg-loop-guard`: a malformed payload, an unknown
 * tool, a name that is not a slug, or a pipeline outside the scope all deny.
 * `scopeCovers` is the predicate, so a finished pipeline is not messageable.
 *
 *   flow-manager-send-guard            hook mode: payload on stdin; a deny is
 *                                      printed as PreToolUse JSON, an allow
 *                                      logs `manager-send` and prints nothing
 *   flow-manager-send-guard --to NAME  prints the same verdict as one JSON
 *                                      line; exit 0 allow, 2 deny
 */

import { appendManagerLog } from "./lib/manager-log";
import {
  identityForState,
  scopeCovers,
  ALLOWED_SCOPE_KINDS,
} from "./lib/manager-scope";
import { readHookStdin } from "./lib/hook-stdin";
import { isValidSlug } from "./lib/slug";
import { readState } from "./lib/state";

export type SendDeps = { home?: string; stateDir?: string };
export type SendVerdict =
  | { allow: true; slug: string }
  | { allow: false; reason: string };

const deny = (reason: string): SendVerdict => ({ allow: false, reason });

/** `my-slug [ref]` -> `my-slug`. */
export function peerSlug(name: string): string {
  return name.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
}

export function verdictForName(
  name: unknown,
  deps: SendDeps = {},
): SendVerdict {
  if (typeof name !== "string")
    return deny("the SendMessage target is missing");
  const slug = peerSlug(name);
  if (!isValidSlug(slug)) {
    return deny(
      `'${name}' is not a pipeline slug, so the manager may not message it`,
    );
  }
  if (!scopeCovers(slug, deps)) {
    return deny(
      `pipeline '${slug}' is outside the manager's scope (${ALLOWED_SCOPE_KINDS}) or already finished; ask the owner to widen the scope`,
    );
  }
  return { allow: true, slug };
}

export function decideSend(input: unknown, deps: SendDeps = {}): SendVerdict {
  try {
    if (input === null || typeof input !== "object") {
      return deny("malformed SendMessage payload");
    }
    const obj = input as { tool_name?: unknown; tool_input?: unknown };
    if (obj.tool_name !== "SendMessage") {
      return deny("this guard only judges SendMessage calls");
    }
    const ti = obj.tool_input;
    if (ti === null || typeof ti !== "object") {
      return deny("malformed SendMessage payload");
    }
    return verdictForName((ti as { to?: unknown }).to, deps);
  } catch {
    return deny("could not judge the SendMessage call");
  }
}

function logAllowed(slug: string, deps: SendDeps): void {
  try {
    const state = readState(slug, deps.stateDir);
    appendManagerLog(
      {
        ts: new Date().toISOString(),
        kind: "manager-send",
        repo: state ? identityForState(state).repo : "unknown",
        slug,
      },
      { home: deps.home },
    );
  } catch {
    // the verdict never depends on the log
  }
}

export function denyOutput(reason: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`;
}

/** The CLI body, with the I/O injected so it is testable. Returns the exit code. */
export async function main(
  argv: string[],
  io: {
    readStdin: () => Promise<string>;
    out: (s: string) => void;
    err: (s: string) => void;
  },
  deps: SendDeps = {},
): Promise<number> {
  if (argv[0] === "--to") {
    if (argv.length !== 2) {
      io.err("usage: flow-manager-send-guard [--to <name>]\n");
      return 2;
    }
    const v = verdictForName(argv[1], deps);
    io.out(`${JSON.stringify(v)}\n`);
    return v.allow ? 0 : 2;
  }
  if (argv.length > 0) {
    io.err("usage: flow-manager-send-guard [--to <name>]\n");
    return 2;
  }
  let verdict: SendVerdict;
  try {
    verdict = decideSend(JSON.parse(await io.readStdin()), deps);
  } catch {
    verdict = deny("malformed SendMessage payload");
  }
  if (verdict.allow) logAllowed(verdict.slug, deps);
  else io.out(denyOutput(verdict.reason));
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2), {
    readStdin: () => readHookStdin(),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then((code) => process.exit(code));
}
