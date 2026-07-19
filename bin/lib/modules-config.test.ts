import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectModuleConfigWarnings,
  deriveSelectionFromManifest,
  readModuleSelection,
  resolveModuleSelection,
  writeModuleSelection,
  type ReadConfigFile,
} from "./modules-config";
import type { SymlinkKind } from "./manifest";

// Inject the config-read seam so the real ~/.flow/config.json is never
// touched. Mirrors models-config.test.ts / copilot-config.test.ts's `reader`
// helper.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("readModuleSelection", () => {
  it("returns undefined when modules is absent", () => {
    expect(readModuleSelection(reader({}))).toBeUndefined();
  });

  it("returns undefined when the config is unreadable", () => {
    expect(readModuleSelection(reader(undefined))).toBeUndefined();
  });

  it("returns undefined when modules is the wrong type (string)", () => {
    expect(readModuleSelection(reader({ modules: "core" }))).toBeUndefined();
  });

  it("returns undefined when modules is the wrong type (number)", () => {
    expect(readModuleSelection(reader({ modules: 42 }))).toBeUndefined();
  });

  it("returns undefined when modules is the wrong type (object, not array)", () => {
    expect(
      readModuleSelection(reader({ modules: { core: true } })),
    ).toBeUndefined();
  });

  it("returns the stored ids when they are all known", () => {
    expect(
      readModuleSelection(reader({ modules: ["core", "research"] })),
    ).toEqual(["core", "research"]);
  });

  it("drops an unknown stored id but keeps known ones", () => {
    expect(
      readModuleSelection(reader({ modules: ["core", "bogus-module"] })),
    ).toEqual(["core"]);
  });

  it("returns an empty array (not undefined) when every stored id is unknown — a recorded-but-emptied selection", () => {
    expect(readModuleSelection(reader({ modules: ["bogus-module"] }))).toEqual(
      [],
    );
  });
});

describe("collectModuleConfigWarnings", () => {
  it("returns [] when modules is absent", () => {
    expect(collectModuleConfigWarnings(reader({}))).toEqual([]);
  });

  it("returns [] when the config is unreadable", () => {
    expect(collectModuleConfigWarnings(reader(undefined))).toEqual([]);
  });

  it("warns on the wrong type", () => {
    const warnings = collectModuleConfigWarnings(reader({ modules: "core" }));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/expected an array/);
  });

  it("warns on each unknown id, naming it", () => {
    const warnings = collectModuleConfigWarnings(
      reader({ modules: ["core", "bogus-module", "another-bogus"] }),
    );
    expect(warnings).toEqual([
      "modules: 'bogus-module' is not a known module id; dropping.",
      "modules: 'another-bogus' is not a known module id; dropping.",
    ]);
  });

  it("returns [] when every stored id is known", () => {
    expect(
      collectModuleConfigWarnings(reader({ modules: ["core", "research"] })),
    ).toEqual([]);
  });
});

describe("writeModuleSelection", () => {
  let scratch!: string;
  let configPath!: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-modules-config-"));
    configPath = path.join(scratch, ".flow", "config.json");
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("creates the parent dir and writes modules to a fresh file", () => {
    writeModuleSelection(["core", "research"], { configPath });
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(raw.modules).toEqual(["core", "research"]);
  });

  it("preserves sibling keys byte-for-byte while updating modules", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const seed = {
      models: { default: "sonnet", verify: "haiku" },
      research: { discovery: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(seed, null, 2) + "\n");

    writeModuleSelection(["core", "stack-svelte"], { configPath });

    const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(after.models).toEqual(seed.models);
    expect(after.research).toEqual(seed.research);
    expect(after.modules).toEqual(["core", "stack-svelte"]);
  });

  it("overwrites a previously-recorded modules selection", () => {
    writeModuleSelection(["core"], { configPath });
    writeModuleSelection(["core", "copilot"], { configPath });
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(raw.modules).toEqual(["core", "copilot"]);
  });

  it("writes 2-space-indented JSON with a trailing newline", () => {
    writeModuleSelection(["core"], { configPath });
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toBe(JSON.stringify({ modules: ["core"] }, null, 2) + "\n");
  });

  it("recovers from malformed existing JSON by treating it as empty (never throws)", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{not valid json");
    expect(() => writeModuleSelection(["core"], { configPath })).not.toThrow();
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(raw.modules).toEqual(["core"]);
  });

  it("an injected read seam overrides the configPath read (used to simulate unreadable content without touching disk)", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ models: { default: "opus" } }),
    );
    writeModuleSelection(["core"], { configPath, read: reader(undefined) });
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // The injected read (undefined) wins over the on-disk content, so the
    // sibling `models` key from disk is NOT carried through.
    expect(raw).toEqual({ modules: ["core"] });
  });
});

describe("resolveModuleSelection", () => {
  it("an explicit flag selection wins outright, folding in core", () => {
    const confirm = vi.fn(() => true);
    const result = resolveModuleSelection({
      flagIds: ["research"],
      isTTY: true,
      confirm,
      read: reader({ modules: ["core", "stack-svelte"] }),
    });
    expect(result.source).toBe("flag");
    expect(result.shouldPersist).toBe(true);
    expect(new Set(result.ids)).toEqual(new Set(["core", "research"]));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a recorded config selection wins over TTY Q&A and is not re-persisted", () => {
    const confirm = vi.fn(() => true);
    const result = resolveModuleSelection({
      isTTY: true,
      confirm,
      read: reader({ modules: ["core", "copilot"] }),
    });
    expect(result.source).toBe("config");
    expect(result.shouldPersist).toBe(false);
    expect(new Set(result.ids)).toEqual(new Set(["core", "copilot"]));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("TTY with no recorded config prompts once per optional module and persists the answers", () => {
    const asked: string[] = [];
    const confirm = (prompt: string): boolean => {
      asked.push(prompt);
      return prompt.startsWith("Install research");
    };
    const result = resolveModuleSelection({
      isTTY: true,
      confirm,
      read: reader(undefined),
    });
    expect(result.source).toBe("prompt");
    expect(result.shouldPersist).toBe(true);
    // 6 optional modules prompted (every MODULES row except core).
    expect(asked.length).toBe(6);
    expect(result.ids).toEqual(["core", "research"]);
  });

  it("non-TTY with no recorded config defaults to core only and does not persist", () => {
    const confirm = vi.fn(() => true);
    const result = resolveModuleSelection({
      isTTY: false,
      confirm,
      read: reader(undefined),
    });
    expect(result.source).toBe("default");
    expect(result.shouldPersist).toBe(false);
    expect(result.ids).toEqual(["core"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("non-TTY with manifest-derived breadth and nothing recorded preserves breadth, does not persist, does not prompt (gh#435)", () => {
    const confirm = vi.fn(() => true);
    const result = resolveModuleSelection({
      manifestIds: ["core", "stack-svelte", "research"],
      isTTY: false,
      confirm,
      read: reader(undefined),
    });
    expect(result.source).toBe("manifest");
    expect(result.shouldPersist).toBe(false);
    expect(new Set(result.ids)).toEqual(
      new Set(["core", "stack-svelte", "research"]),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a recorded config selection still wins over manifest-derived breadth", () => {
    const result = resolveModuleSelection({
      manifestIds: ["core", "stack-svelte", "research"],
      isTTY: false,
      confirm: vi.fn(() => true),
      read: reader({ modules: ["core", "copilot"] }),
    });
    expect(result.source).toBe("config");
    expect(new Set(result.ids)).toEqual(new Set(["core", "copilot"]));
  });

  it("an explicit flag still wins over manifest-derived breadth", () => {
    const result = resolveModuleSelection({
      flagIds: ["research"],
      manifestIds: ["core", "stack-svelte", "stack-supabase"],
      isTTY: false,
      confirm: vi.fn(() => true),
      read: reader(undefined),
    });
    expect(result.source).toBe("flag");
    expect(new Set(result.ids)).toEqual(new Set(["core", "research"]));
  });

  it("an empty manifestIds falls through to the non-TTY core default", () => {
    const result = resolveModuleSelection({
      manifestIds: [],
      isTTY: false,
      confirm: vi.fn(() => true),
      read: reader(undefined),
    });
    expect(result.source).toBe("default");
    expect(result.ids).toEqual(["core"]);
  });

  it("TTY still prompts when nothing is recorded and no manifest is passed", () => {
    const confirm = vi.fn(() => false);
    const result = resolveModuleSelection({
      isTTY: true,
      confirm,
      read: reader(undefined),
    });
    expect(result.source).toBe("prompt");
    expect(confirm).toHaveBeenCalled();
  });
});

describe("deriveSelectionFromManifest", () => {
  const record = (target: string, kind: SymlinkKind = "skill") => ({
    source: `/flow/${target}`,
    target,
    kind,
  });

  it("unions the owning modules of each recorded artifact, folding in core", () => {
    const ids = deriveSelectionFromManifest({
      version: 1,
      symlinks: [
        record("/home/.claude/skills/flow-svelte"),
        record("/home/.claude/skills/flow-research"),
        record("/home/.local/bin/flow-delegate", "bin"),
      ],
    });
    expect(new Set(ids)).toEqual(new Set(["core", "stack-svelte", "research"]));
  });

  it("derives breadth from a pre-retarget manifest by basename, location-independent", () => {
    const post = deriveSelectionFromManifest({
      version: 1,
      symlinks: [record("/home/.flow/claude-home/.claude/skills/flow-svelte")],
    });
    const pre = deriveSelectionFromManifest({
      version: 1,
      symlinks: [record("/home/.claude/skills/flow-svelte")],
    });
    expect(new Set(pre)).toEqual(new Set(post));
    expect(new Set(pre)).toEqual(new Set(["core", "stack-svelte"]));
  });

  it("ignores records that map to no module (wrapper, completions, registry-unknown)", () => {
    const ids = deriveSelectionFromManifest({
      version: 1,
      symlinks: [
        record("/home/.local/bin/flow", "bin"),
        record("/home/.flow/completions/flow.bash", "completion"),
        record("/home/.local/bin/flow-transcript-audit", "bin"),
      ],
    });
    expect(ids).toEqual(["core"]);
  });

  it("returns just core for an empty manifest", () => {
    expect(deriveSelectionFromManifest({ version: 1, symlinks: [] })).toEqual([
      "core",
    ]);
  });
});
