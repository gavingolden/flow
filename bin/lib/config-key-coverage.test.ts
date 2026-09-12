/**
 * Pins the rendered config-key set against `docs/configuration.md`'s
 * `## config.json reference` table in BOTH directions, so a config key can
 * no longer ship documented-but-invisible (a doc row with no view) or
 * visible-but-undocumented (a rendered row with no doc row).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFlowSource } from "./paths";
import { SETTINGS_KEYS } from "./config-settings";
import { CONFIG_KEYS } from "./model-routing-table";
import { LAUNCH_CONFIG_KEYS } from "./launch-config";

function parseDocKeys(md: string): Set<string> {
  const inRefSection = md
    .split(/^## /m)
    .find((section) => section.startsWith("config.json reference"));
  if (!inRefSection)
    throw new Error("could not find '## config.json reference' section");

  const keys = new Set<string>();
  for (const raw of inRefSection.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^key$/i.test(cells[0])) continue; // header
    if (/^-+$/.test(cells[0].replace(/\s/g, ""))) continue; // separator
    const match = cells[0].match(/`([^`]+)`/);
    if (!match) continue;
    let key = match[1];
    // Normalise a trailing `.*` group to its group prefix.
    if (key.endsWith(".*")) key = key.slice(0, -2) + ".*";
    keys.add(key);
  }
  return keys;
}

function renderedKeys(): Set<string> {
  const keys = new Set<string>(SETTINGS_KEYS);
  // CONFIG_KEYS holds bare grains (default, planning, implement, ...)
  // against the SINGLE doc row `models.*` — collapse to one entry.
  if (CONFIG_KEYS.length > 0) keys.add("models.*");
  // LAUNCH_CONFIG_KEYS holds bare effort/autoMerge/... against FIVE
  // separate `launch.<key>` doc rows — one entry each.
  for (const entry of LAUNCH_CONFIG_KEYS) keys.add(`launch.${entry.key}`);
  keys.add("launcher");
  return keys;
}

describe("config-key coverage: docs/configuration.md agrees with the rendered views", () => {
  const md = fs.readFileSync(
    path.join(resolveFlowSource(), "docs/configuration.md"),
    "utf8",
  );
  const docKeys = parseDocKeys(md);
  const rendered = renderedKeys();

  // A handful of doc rows describe nested grains under a `.*` umbrella that
  // isn't itself a SETTINGS_KEYS/CONFIG_KEYS/LAUNCH_CONFIG_KEYS entry.
  const DOC_ONLY_UMBRELLAS = new Set([
    "models.reviewLenses.*",
    "delegate.models.*",
    "delegate.timeouts.*",
  ]);

  it("every documented key has a rendered view", () => {
    for (const key of docKeys) {
      if (DOC_ONLY_UMBRELLAS.has(key)) continue;
      expect(
        rendered.has(key),
        `documented key '${key}' has no rendered view`,
      ).toBe(true);
    }
  });

  it("every rendered key has a doc row", () => {
    for (const key of rendered) {
      expect(docKeys.has(key), `rendered key '${key}' has no doc row`).toBe(
        true,
      );
    }
  });
});
