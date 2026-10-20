#!/usr/bin/env bun
/**
 * CLI over `bin/lib/skill-overlay.ts` — lets `/flow-pipeline` step 5.5 (and a
 * recovering user) sync or inspect a pipeline's private skill copy.
 *
 *   flow-skill-overlay sync --slug <slug> --from <checkout>
 *     One JSON line on stdout, exit 0:
 *       {"ran":true,"written":[…],"removed":[…],"notExercised":[…]}
 *       {"ran":false,"skipReason":"no-overlay"}   (the slug has no copy)
       {"ran":false,"skipReason":"pinned-source"} (a --skills-from copy stays
         the snapshot it was launched with; only a flow-self copy re-syncs)
       {"ran":false,"skipReason":"not-a-flow-checkout"} (--from lacks skills/
         + bin/lib/modules.ts; nothing is touched)
 *     `notExercised` = written paths a running session cannot pick up
 *     (agent definitions, skill directories new to the copy).
 *   flow-skill-overlay status --slug <slug>
 *     {"exists":<bool>,"roots":[…]}
 *
 * `--overlays-dir <dir>` overrides the copies root, so tests never touch
 * `~/.flow/overlays`. Bad arguments exit 2; JSON goes to
 * stdout only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isValidSlug } from "./lib/slug";
import {
  overlayPluginRoots,
  readOverlayOrigin,
  syncSkillOverlay,
} from "./lib/skill-overlay";
import { isFlowCheckout } from "./lib/skill-overlay-fs";

const USAGE =
  "usage: flow-skill-overlay sync --slug <slug> --from <checkout> [--overlays-dir <dir>]\n" +
  "       flow-skill-overlay status --slug <slug> [--overlays-dir <dir>]";

type Parsed =
  | { verb: "sync"; slug: string; from: string; overlaysDir?: string }
  | { verb: "status"; slug: string; overlaysDir?: string }
  | { error: string };

function parseArgs(argv: string[]): Parsed {
  const [verb, ...rest] = argv;
  if (verb !== "sync" && verb !== "status") {
    return { error: verb ? `unknown verb '${verb}'` : "a verb is required" };
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!["--slug", "--from", "--overlays-dir"].includes(flag)) {
      return { error: `unknown argument '${flag}'` };
    }
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    values[flag] = value;
  }
  const slug = values["--slug"];
  if (!slug || !isValidSlug(slug)) {
    return { error: "--slug <slug> is required (lowercase kebab-case)" };
  }
  const overlaysDir = values["--overlays-dir"];
  if (verb === "status") return { verb, slug, overlaysDir };
  const from = values["--from"];
  if (!from) return { error: "--from <checkout> is required for sync" };
  if (!fs.existsSync(from)) return { error: `--from '${from}' does not exist` };
  return { verb, slug, from: path.resolve(from), overlaysDir };
}

export function runSkillOverlay(argv: string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    return {
      code: 2,
      stdout: "",
      stderr: `flow-skill-overlay: ${parsed.error}\n${USAGE}\n`,
    };
  }
  const roots = overlayPluginRoots(parsed.slug, parsed.overlaysDir);
  const json = (payload: unknown) => ({
    code: 0,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: "",
  });
  if (parsed.verb === "status") {
    return json({ exists: roots !== null, roots: roots ?? [] });
  }
  if (roots === null) return json({ ran: false, skipReason: "no-overlay" });
  if (
    readOverlayOrigin(parsed.slug, parsed.overlaysDir)?.kind === "skills-from"
  ) {
    return json({ ran: false, skipReason: "pinned-source" });
  }
  if (!isFlowCheckout(parsed.from)) {
    return json({ ran: false, skipReason: "not-a-flow-checkout" });
  }
  const result = syncSkillOverlay({
    slug: parsed.slug,
    contentSource: parsed.from,
    overlaysDir: parsed.overlaysDir,
  });
  return json({ ran: true, ...result });
}

if (import.meta.main) {
  const result = runSkillOverlay(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
