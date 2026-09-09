import { describe, expect, it } from "vitest";
import { MODULES, moduleIds } from "./modules";
import {
  PLUGIN_ROOT_PREFIX,
  moduleIdFromPluginRootName,
  pluginManifestFor,
  pluginRootName,
} from "./plugin-manifest";

describe(pluginManifestFor, () => {
  it("emits exactly the five keys $schema,name,version,description,author when includeSkills is false", () => {
    const m = pluginManifestFor("core", {
      version: "1.0.0",
      includeSkills: false,
    });
    expect(Object.keys(m)).toEqual([
      "$schema",
      "name",
      "version",
      "description",
      "author",
    ]);
  });

  it("omits the `skills` key entirely when includeSkills is false", () => {
    const m = pluginManifestFor("core", {
      version: "1.0.0",
      includeSkills: false,
    });
    const roundTripped = JSON.parse(JSON.stringify(m)) as Record<
      string,
      unknown
    >;
    expect("skills" in roundTripped).toBe(false);
  });

  it('emits relative-only skills: ["./skills"] when includeSkills is true', () => {
    const m = pluginManifestFor("core", {
      version: "1.0.0",
      includeSkills: true,
    });
    expect(m.skills).toEqual(["./skills"]);
    for (const entry of m.skills ?? []) {
      expect(entry.startsWith("/")).toBe(false);
    }
  });

  it("carries the registry description verbatim for every id in moduleIds()", () => {
    for (const row of MODULES) {
      const m = pluginManifestFor(row.id, {
        version: "1.0.0",
        includeSkills: false,
      });
      expect(m.description).toBe(row.description);
    }
  });

  it("version is passed through verbatim", () => {
    const m = pluginManifestFor("core", {
      version: "9.9.9-test",
      includeSkills: false,
    });
    expect(m.version).toBe("9.9.9-test");
  });
});

describe(pluginRootName, () => {
  it("is `flow-module-<id>` for every id in moduleIds()", () => {
    for (const id of moduleIds()) {
      expect(pluginRootName(id)).toBe(`${PLUGIN_ROOT_PREFIX}${id}`);
    }
  });

  it("CONTRACT CORRECTION regression guard: no pluginRootName(id) collides with any installed skill display name", () => {
    const rootNames = new Set(moduleIds().map(pluginRootName));
    const skillNames = new Set(MODULES.flatMap((m) => m.skills));
    // The concrete collision this guards: module id `research`, under the
    // plan's original `flow-<id>` scheme, would have produced `flow-research`
    // — colliding with the real flow-research skill directory.
    for (const name of rootNames) {
      expect(skillNames.has(name)).toBe(false);
    }
  });
});

describe(moduleIdFromPluginRootName, () => {
  it("round-trips pluginRootName for every id in moduleIds(), and returns undefined for 'flow-research', 'flow-core-extra', and 'not-a-plugin'", () => {
    for (const id of moduleIds()) {
      expect(moduleIdFromPluginRootName(pluginRootName(id))).toBe(id);
    }
    expect(moduleIdFromPluginRootName("flow-research")).toBeUndefined();
    expect(moduleIdFromPluginRootName("flow-core-extra")).toBeUndefined();
    expect(moduleIdFromPluginRootName("not-a-plugin")).toBeUndefined();
  });
});
