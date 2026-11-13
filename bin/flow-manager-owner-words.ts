#!/usr/bin/env bun
/**
 * Claude Code UserPromptSubmit hook for the global manager's settings: appends
 * each prompt the owner typed to `~/.flow/manager/owner-words.jsonl` (id, time,
 * text hash, text). That ledger is what proves an approval came from the owner,
 * so a prompt that did not come from the keyboard is never recorded:
 *   - a peer's `<cross-session-message …>` delivery and the waiter's own
 *     `<task-notification>` wake reach the same prompt stream and read like
 *     user input, even batched after owner text, so either wrapper anywhere
 *     disqualifies the prompt;
 *   - flow's own seeds (`/flow-manage` on the launch line,
 *     `/flow-manage --resume` typed after `/clear`, `[flow-…` system seeds)
 *     come from flow, not the owner.
 * Only runs when `FLOW_MANAGER=1`; always exits 0 and prints nothing.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { readHookStdin } from "./lib/hook-stdin";
import { withFileLockSync } from "./lib/lock";
import { managerFile, managerHome, managerLockPath } from "./lib/manager-home";

const NOT_OWNER = [
  /<cross-session-message/i,
  /<task-notification/i,
  /^\/flow-manage(\s|$)/,
  /^\[flow-/i,
];

/** True when `prompt` could have been typed by the owner. */
export function isOwnerPrompt(prompt: string): boolean {
  const text = prompt.trimStart();
  return text.trim() !== "" && !NOT_OWNER.some((re) => re.test(text));
}

export function recordOwnerWords(
  prompt: string,
  now: Date,
  home: string = managerHome(),
): boolean {
  if (!isOwnerPrompt(prompt)) return false;
  const line = JSON.stringify({
    id: `w-${randomBytes(4).toString("hex")}`,
    ts: now.toISOString(),
    hash: createHash("sha256").update(prompt).digest("hex").slice(0, 16),
    text: prompt,
  });
  fs.mkdirSync(home, { recursive: true });
  withFileLockSync(managerLockPath("owner-words.jsonl", home), () =>
    fs.appendFileSync(managerFile("owner-words.jsonl", home), `${line}\n`),
  );
  return true;
}

export async function main(
  stdin: () => Promise<string>,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): Promise<number> {
  if (env.FLOW_MANAGER !== "1") return 0;
  try {
    const payload = JSON.parse(await stdin()) as { prompt?: unknown };
    if (typeof payload.prompt === "string") {
      recordOwnerWords(payload.prompt, new Date(), home);
    }
  } catch {
    // a hook never breaks the owner's prompt
  }
  return 0;
}

if (import.meta.main) {
  main(() => readHookStdin()).then((code) => process.exit(code));
}
