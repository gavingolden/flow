import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALWAYS_REVIEW_GLOBS,
  DEFAULT_COPILOT_LOGIN,
  DEFAULT_NEVER_ALONE_GLOBS,
  readCopilotClaimDeadlineSec,
  readCopilotConfig,
  readCopilotLogin,
  type ReadConfigFile,
} from "./copilot-config";

// Inject the config-read seam so the real ~/.flow/config.json is never touched.
const reader = (raw: unknown): ReadConfigFile => () => raw;

describe("readCopilotLogin", () => {
  it("returns the bare-string login (legacy form)", () => {
    expect(readCopilotLogin(reader({ bots: { copilot: "my-bot" } }))).toBe("my-bot");
  });

  it("returns object.login when present", () => {
    expect(readCopilotLogin(reader({ bots: { copilot: { login: "obj-bot" } } }))).toBe("obj-bot");
  });

  it("returns the default login when bots.copilot is absent", () => {
    expect(readCopilotLogin(reader({ bots: {} }))).toBe(DEFAULT_COPILOT_LOGIN);
  });

  it("returns the default login when the config is unreadable (undefined)", () => {
    expect(readCopilotLogin(reader(undefined))).toBe(DEFAULT_COPILOT_LOGIN);
  });
});

describe("readCopilotClaimDeadlineSec", () => {
  it("returns the configured positive integer", () => {
    expect(readCopilotClaimDeadlineSec(reader({ bots: { copilotClaimDeadlineSec: 180 } }))).toBe(
      180,
    );
  });

  it("returns undefined when bots is absent", () => {
    expect(readCopilotClaimDeadlineSec(reader({}))).toBeUndefined();
  });

  it("returns undefined when the copilotClaimDeadlineSec key is absent", () => {
    expect(readCopilotClaimDeadlineSec(reader({ bots: {} }))).toBeUndefined();
  });

  it("returns undefined for a string value", () => {
    expect(
      readCopilotClaimDeadlineSec(reader({ bots: { copilotClaimDeadlineSec: "soon" } })),
    ).toBeUndefined();
  });

  it("returns undefined for 0", () => {
    expect(
      readCopilotClaimDeadlineSec(reader({ bots: { copilotClaimDeadlineSec: 0 } })),
    ).toBeUndefined();
  });

  it("returns undefined for a negative value", () => {
    expect(
      readCopilotClaimDeadlineSec(reader({ bots: { copilotClaimDeadlineSec: -5 } })),
    ).toBeUndefined();
  });

  it("returns undefined for a float", () => {
    expect(
      readCopilotClaimDeadlineSec(reader({ bots: { copilotClaimDeadlineSec: 1.5 } })),
    ).toBeUndefined();
  });

  it("returns undefined when the config is unreadable (undefined)", () => {
    expect(readCopilotClaimDeadlineSec(reader(undefined))).toBeUndefined();
  });
});

describe("readCopilotConfig", () => {
  it("string form → that login + default globs", () => {
    const cfg = readCopilotConfig(reader({ bots: { copilot: "my-bot" } }));
    expect(cfg.login).toBe("my-bot");
    expect(cfg.globs.alwaysReview).toEqual(DEFAULT_ALWAYS_REVIEW_GLOBS);
    expect(cfg.globs.neverAlone).toEqual(DEFAULT_NEVER_ALONE_GLOBS);
  });

  it("object form with globs → merges configured arrays OVER the defaults (union, additive)", () => {
    const cfg = readCopilotConfig(
      reader({
        bots: {
          copilot: {
            login: "obj-bot",
            globs: { alwaysReview: ["custom/**"], neverAlone: ["**/*.lock"] },
          },
        },
      }),
    );
    expect(cfg.login).toBe("obj-bot");
    // Defaults preserved AND the configured extras appended (not replaced).
    expect(cfg.globs.alwaysReview).toEqual([...DEFAULT_ALWAYS_REVIEW_GLOBS, "custom/**"]);
    expect(cfg.globs.neverAlone).toEqual([...DEFAULT_NEVER_ALONE_GLOBS, "**/*.lock"]);
  });

  it("object form without globs → defaults", () => {
    const cfg = readCopilotConfig(reader({ bots: { copilot: { login: "obj-bot" } } }));
    expect(cfg.globs.alwaysReview).toEqual(DEFAULT_ALWAYS_REVIEW_GLOBS);
    expect(cfg.globs.neverAlone).toEqual(DEFAULT_NEVER_ALONE_GLOBS);
  });

  it("object form without login → default login", () => {
    const cfg = readCopilotConfig(reader({ bots: { copilot: { globs: {} } } }));
    expect(cfg.login).toBe(DEFAULT_COPILOT_LOGIN);
  });

  it("absent bots.copilot → default login + default globs", () => {
    const cfg = readCopilotConfig(reader({ bots: {} }));
    expect(cfg.login).toBe(DEFAULT_COPILOT_LOGIN);
    expect(cfg.globs.alwaysReview).toEqual(DEFAULT_ALWAYS_REVIEW_GLOBS);
  });

  it("malformed / unreadable file (undefined) → default login + default globs", () => {
    const cfg = readCopilotConfig(reader(undefined));
    expect(cfg.login).toBe(DEFAULT_COPILOT_LOGIN);
    expect(cfg.globs.neverAlone).toEqual(DEFAULT_NEVER_ALONE_GLOBS);
  });

  it("wrong-typed bots.copilot (array) → defaults", () => {
    const cfg = readCopilotConfig(reader({ bots: { copilot: ["nope"] } }));
    expect(cfg.login).toBe(DEFAULT_COPILOT_LOGIN);
    expect(cfg.globs.alwaysReview).toEqual(DEFAULT_ALWAYS_REVIEW_GLOBS);
  });

  it("wrong-typed glob entries (non-string) → falls back to defaults for that set", () => {
    const cfg = readCopilotConfig(
      reader({ bots: { copilot: { globs: { alwaysReview: [1, 2] } } } }),
    );
    expect(cfg.globs.alwaysReview).toEqual(DEFAULT_ALWAYS_REVIEW_GLOBS);
  });
});
