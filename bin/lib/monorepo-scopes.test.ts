import { describe, expect, it } from "vitest";
import {
  detectWorkspaceScopes,
  draftConfigEntryForOrphans,
  mergeScopeSources,
  readMonorepoConfig,
  workspacePrefixOf,
  type ConfigScope,
  type DynamicScope,
  type ReadConfigFile,
} from "./monorepo-scopes";
import { type ReadPackageJson } from "./stack-table";

// Inject seams so no real file is touched (copilot-config.test.ts idiom).
const cfg = (raw: unknown): ReadConfigFile => () => raw;
// A package-owner map: every listed path resolves to its package.json object;
// anything else is an absent owner (undefined).
const owners =
  (map: Record<string, unknown>): ReadPackageJson =>
  (p: string) =>
    p in map ? map[p] : undefined;

describe("workspacePrefixOf", () => {
  it("derives apps/<pkg>/ for a file two segments deep", () => {
    expect(workspacePrefixOf("apps/web/src/x.ts")).toBe("apps/web/");
  });

  it("derives packages/<pkg>/", () => {
    expect(workspacePrefixOf("packages/ui/src/Button.svelte")).toBe("packages/ui/");
  });

  it("returns undefined for a bare apps/x.ts with no package dir", () => {
    expect(workspacePrefixOf("apps/x.ts")).toBeUndefined();
  });

  it("returns undefined for a non-workspace path", () => {
    expect(workspacePrefixOf("vendor/legacy/z.js")).toBeUndefined();
  });
});

describe("detectWorkspaceScopes", () => {
  it("detects apps/ and packages/ scopes whose package.json owner exists", () => {
    const readPkg = owners({
      "apps/web/package.json": { scripts: { check: "x", test: "y" } },
      "packages/ui/package.json": { scripts: { lint: "z" } },
    });
    const scopes = detectWorkspaceScopes(
      ["apps/web/src/a.ts", "packages/ui/src/b.ts"],
      readPkg,
    );
    expect(scopes.map((s) => s.name).sort()).toEqual(["apps/web", "packages/ui"]);
    const web = scopes.find((s) => s.name === "apps/web")!;
    expect(web.prefixes).toEqual(["apps/web/"]);
    expect(web.checks.map((c) => c.name)).toEqual([
      "npm run check -w apps/web",
      "npm run test -w apps/web",
    ]);
  });

  it("returns no scope when the package.json owner is missing (orphan preserved)", () => {
    const readPkg = owners({}); // no owners on disk
    expect(detectWorkspaceScopes(["apps/web/src/a.ts"], readPkg)).toEqual([]);
  });

  it("deduplicates multiple files under the same package", () => {
    const readPkg = owners({ "apps/web/package.json": { scripts: { test: "y" } } });
    const scopes = detectWorkspaceScopes(
      ["apps/web/src/a.ts", "apps/web/src/b.ts"],
      readPkg,
    );
    expect(scopes).toHaveLength(1);
  });
});

describe("readMonorepoConfig", () => {
  it("returns undefined when the config is absent/unreadable", () => {
    expect(readMonorepoConfig(cfg(undefined))).toBeUndefined();
  });

  it("parses a top-level array of scope entries", () => {
    const scopes = readMonorepoConfig(
      cfg([{ name: "web", prefixes: ["apps/web/"], checks: ["npm run lint -w apps/web"] }]),
    );
    expect(scopes).toEqual<ConfigScope[]>([
      {
        name: "web",
        prefixes: ["apps/web/"],
        checks: [{ name: "npm run lint -w apps/web", argv: ["npm", "run", "lint", "-w", "apps/web"] }],
      },
    ]);
  });

  it("parses the { scopes: [...] } wrapper shape", () => {
    const scopes = readMonorepoConfig(
      cfg({ scopes: [{ name: "web", prefixes: ["apps/web/"], checks: ["x"] }] }),
    );
    expect(scopes?.map((s) => s.name)).toEqual(["web"]);
  });

  it("drops an entry whose name collides with a built-in scope", () => {
    const scopes = readMonorepoConfig(
      cfg([{ name: "src", prefixes: ["apps/web/"], checks: ["x"] }]),
    );
    expect(scopes).toEqual([]);
  });

  it("drops a wrong-shaped entry (checks not a string[], prefix not a string) but keeps well-formed siblings", () => {
    const scopes = readMonorepoConfig(
      cfg([
        { name: "bad1", prefixes: ["apps/web/"], checks: [1, 2] },
        { name: "bad2", prefixes: [42], checks: ["x"] },
        { name: "good", prefixes: ["apps/api/"], checks: ["npm run test -w apps/api"] },
      ]),
    );
    expect(scopes?.map((s) => s.name)).toEqual(["good"]);
  });

  it("returns undefined on a non-array, non-{scopes} JSON shape", () => {
    expect(readMonorepoConfig(cfg({ foo: "bar" }))).toBeUndefined();
  });
});

describe("mergeScopeSources — precedence config > auto-detect", () => {
  const auto: DynamicScope[] = [
    { name: "apps/web", prefixes: ["apps/web/"], checks: [{ name: "auto", argv: ["auto"] }] },
    { name: "apps/api", prefixes: ["apps/api/"], checks: [{ name: "a", argv: ["a"] }] },
  ];

  it("a configured scope sharing a prefix shadows the auto-detected one", () => {
    const configured: ConfigScope[] = [
      { name: "web", prefixes: ["apps/web/"], checks: [{ name: "cfg", argv: ["cfg"] }] },
    ];
    const merged = mergeScopeSources(auto, configured);
    expect(merged.map((s) => s.name).sort()).toEqual(["apps/api", "web"]);
    // The surviving apps/web is the configured one, not the auto-detected one.
    expect(merged.find((s) => s.prefixes.includes("apps/web/"))!.name).toBe("web");
  });

  it("keeps both when prefixes don't overlap", () => {
    const configured: ConfigScope[] = [
      { name: "svc", prefixes: ["services/api/"], checks: [{ name: "c", argv: ["c"] }] },
    ];
    const merged = mergeScopeSources(auto, configured);
    expect(merged).toHaveLength(3);
  });

  // The two cases above pass non-empty configured arrays, but loadDynamicScopes
  // passes mergeScopeSources(auto, []) on virtually every real invocation (no
  // .flow/pre-commit.json present) and mergeScopeSources([], []) on a clean
  // monorepo with nothing detected — the empty-config fast path was uncovered.
  it("with no configured scopes returns the auto-detected scopes unchanged", () => {
    expect(mergeScopeSources(auto, [])).toEqual(auto);
  });

  it("with both sources empty returns an empty array", () => {
    expect(mergeScopeSources([], [])).toEqual([]);
  });
});

describe("draftConfigEntryForOrphans — pure Layer-3 helper", () => {
  it("returns an entry for a recognizable apps/<pkg> orphan with an owner + scripts", () => {
    const readPkg = owners({ "apps/web/package.json": { scripts: { check: "x", test: "y" } } });
    const entry = draftConfigEntryForOrphans(["apps/web/src/a.ts"], readPkg);
    expect(entry).toEqual<ConfigScope>({
      name: "apps/web",
      prefixes: ["apps/web/"],
      checks: [
        { name: "npm run check -w apps/web", argv: ["npm", "run", "check", "-w", "apps/web"] },
        { name: "npm run test -w apps/web", argv: ["npm", "run", "test", "-w", "apps/web"] },
      ],
    });
  });

  it("returns null for a genuine orphan (vendor/legacy, no owner, no marker)", () => {
    const readPkg = owners({});
    expect(draftConfigEntryForOrphans(["vendor/legacy/z.js"], readPkg)).toBeNull();
  });

  it("returns null when a workspace owner exists but declares no verify-class script", () => {
    const readPkg = owners({ "apps/docs/package.json": { scripts: { start: "x" } } });
    expect(draftConfigEntryForOrphans(["apps/docs/src/a.ts"], readPkg)).toBeNull();
  });
});
