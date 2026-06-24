/**
 * Tolerant boundary reader for `~/.flow/config.json` `research.discovery`.
 *
 * `research` is an OBJECT with one `discovery` boolean (default `false`) —
 * object-shaped from day one so `research.maxCalls` / `research.model` can be
 * added later without a schema break, mirroring `bots.copilot` / `update`.
 * This is validate-at-boundaries: anything unreadable, malformed, or
 * wrong-typed collapses to the default `{ discovery: false }`, and only a
 * strict boolean `true` enables it.
 *
 * Consumed by the `/product-planning` discovery subagent (via a Bash call in
 * its research pre-check step) to decide whether the optional web-grounded
 * research pass is opted in.
 */

import * as fs from "node:fs";
import { FLOW_CONFIG } from "./paths";

export type ResearchConfig = { discovery: boolean };

const DEFAULT_RESEARCH_CONFIG: ResearchConfig = { discovery: false };

/**
 * Config-read seam. Returns the raw parsed JSON, or `undefined` when the
 * file is absent/unreadable/non-JSON. Tests override this so the real
 * `~/.flow/config.json` is never touched.
 */
export type ReadConfigFile = () => unknown;

const defaultReadConfigFile: ReadConfigFile = () => {
  try {
    return JSON.parse(fs.readFileSync(FLOW_CONFIG, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Defaults `{ discovery: false }` on absent/non-object/wrong-typed `research`
 * or `research.discovery`; only a strict boolean `true` flips `discovery` on.
 */
export function extractResearchConfig(raw: unknown): ResearchConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_RESEARCH_CONFIG;
  const research = (raw as Record<string, unknown>).research;
  if (typeof research !== "object" || research === null) {
    return DEFAULT_RESEARCH_CONFIG;
  }
  const discovery = (research as Record<string, unknown>).discovery;
  return { discovery: discovery === true };
}

/** Reader for the `research.discovery` opt-in: `{ discovery: boolean }`. */
export function readResearchConfig(
  read: ReadConfigFile = defaultReadConfigFile,
): ResearchConfig {
  return extractResearchConfig(read());
}
