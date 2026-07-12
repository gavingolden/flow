import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readDefaultModel,
  readPhaseModel,
  type ReadConfigFile,
} from "./models-config";

// Inject the config-read seam so the real ~/.flow/config.json is never touched.
// Mirrors copilot-config.test.ts / epic-config.test.ts's `reader` helper.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("readPhaseModel", () => {
  it("returns undefined when the config is unreadable (undefined)", () => {
    expect(readPhaseModel("planning", reader(undefined))).toBeUndefined();
  });

  it("returns undefined when models is absent", () => {
    expect(readPhaseModel("planning", reader({}))).toBeUndefined();
  });

  it("returns undefined when models is not an object", () => {
    expect(
      readPhaseModel("planning", reader({ models: "fable" })),
    ).toBeUndefined();
    expect(
      readPhaseModel("planning", reader({ models: null })),
    ).toBeUndefined();
    expect(readPhaseModel("planning", reader({ models: 42 }))).toBeUndefined();
  });

  it("returns undefined when the phase key is absent", () => {
    expect(
      readPhaseModel("planning", reader({ models: { verify: "haiku" } })),
    ).toBeUndefined();
  });

  it("returns undefined when the phase key is the wrong type", () => {
    expect(
      readPhaseModel("planning", reader({ models: { planning: 123 } })),
    ).toBeUndefined();
  });

  it("returns undefined when the phase value is out of enum", () => {
    expect(
      readPhaseModel("planning", reader({ models: { planning: "gpt4" } })),
    ).toBeUndefined();
  });

  it.each(["opus", "haiku", "sonnet", "fable"] as const)(
    "returns the valid alias %s",
    (alias) => {
      expect(
        readPhaseModel("planning", reader({ models: { planning: alias } })),
      ).toBe(alias);
    },
  );

  it("reads arbitrary phase keys (verify, fixApplier, mergeResolver, scout, coder)", () => {
    const cfg = reader({
      models: {
        verify: "sonnet",
        fixApplier: "haiku",
        mergeResolver: "opus",
        scout: "fable",
        coder: "sonnet",
      },
    });
    expect(readPhaseModel("verify", cfg)).toBe("sonnet");
    expect(readPhaseModel("fixApplier", cfg)).toBe("haiku");
    expect(readPhaseModel("mergeResolver", cfg)).toBe("opus");
    expect(readPhaseModel("scout", cfg)).toBe("fable");
    expect(readPhaseModel("coder", cfg)).toBe("sonnet");
  });
});

describe("readDefaultModel", () => {
  it("returns undefined when the config is unreadable (undefined)", () => {
    expect(readDefaultModel(reader(undefined))).toBeUndefined();
  });

  it("returns undefined when models.default is absent", () => {
    expect(
      readDefaultModel(reader({ models: { planning: "fable" } })),
    ).toBeUndefined();
  });

  it("returns undefined when models.default is out of enum", () => {
    expect(
      readDefaultModel(reader({ models: { default: "gpt4" } })),
    ).toBeUndefined();
  });

  it.each(["opus", "haiku", "sonnet", "fable"] as const)(
    "returns the valid default alias %s",
    (alias) => {
      expect(readDefaultModel(reader({ models: { default: alias } }))).toBe(
        alias,
      );
    },
  );
});

// Guards the hermeticity fix directly: readDefaultModel's DEFAULT reader
// (defaultReadConfigFile, the only caller of paths.ts's flowConfigPath())
// must resolve $HOME at CALL time, not import time. Every other spec in this
// file injects the `read` seam and would stay green even if a reader
// regressed to an import-time-captured path constant — this is the one spec
// that actually exercises the default (unseeded) path.
describe("readDefaultModel — hermeticity (no injected seam)", () => {
  it("reads the sandboxed $HOME's real config.json when no reader is injected", () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-hermetic-"));
    try {
      process.env.HOME = tmp;
      fs.mkdirSync(path.join(tmp, ".flow"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".flow", "config.json"),
        JSON.stringify({ models: { default: "haiku" } }),
      );
      expect(readDefaultModel()).toBe("haiku");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns undefined when the sandboxed $HOME has no config.json", () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-hermetic-empty-"));
    try {
      process.env.HOME = tmp;
      expect(readDefaultModel()).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
