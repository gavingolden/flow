import { describe, expect, it } from "vitest";
import {
  COPILOT_REQUEST_SLUG,
  DEFAULT_ALWAYS_REVIEW_GLOBS,
  DEFAULT_COPILOT_LOGIN,
  DEFAULT_NEVER_ALONE_GLOBS,
  copilotAuthorMatch,
  matchesCopilot,
  readCopilotClaimDeadlineSec,
  readCopilotAutoReview,
  readCopilotConfig,
  readCopilotLogin,
  readCopilotSkipWait,
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

describe("copilotAuthorMatch", () => {
  it("strips a trailing [bot] suffix", () => {
    expect(copilotAuthorMatch("copilot-pull-request-reviewer[bot]")).toBe(
      "copilot-pull-request-reviewer",
    );
  });

  it("lowercases a mixed-case login", () => {
    expect(copilotAuthorMatch("Copilot-Pull-Request-Reviewer")).toBe(
      "copilot-pull-request-reviewer",
    );
  });

  it("leaves an already-bare lowercase login unchanged (idempotent)", () => {
    expect(copilotAuthorMatch("copilot-pull-request-reviewer")).toBe(
      "copilot-pull-request-reviewer",
    );
  });
});

describe("COPILOT_REQUEST_SLUG", () => {
  it("is the gh-CLI native Copilot reviewer slug", () => {
    expect(COPILOT_REQUEST_SLUG).toBe("@copilot");
  });
});

describe("matchesCopilot", () => {
  const BASE = "copilot-pull-request-reviewer";

  it("matches the requested_reviewers entry `Copilot` against the base login", () => {
    expect(matchesCopilot("Copilot", BASE)).toBe(true);
  });

  it("matches the REST review author `…[bot]` form", () => {
    expect(matchesCopilot("copilot-pull-request-reviewer[bot]", BASE)).toBe(true);
  });

  it("matches the GraphQL review author (bare) form", () => {
    expect(matchesCopilot("copilot-pull-request-reviewer", BASE)).toBe(true);
  });

  it("matches the request slug `copilot` against the base login", () => {
    expect(matchesCopilot("copilot", BASE)).toBe(true);
  });

  it("matches a custom bot against itself", () => {
    expect(matchesCopilot("my-bot", "my-bot")).toBe(true);
  });

  it("does NOT spuriously alias-match a Copilot login against a custom base", () => {
    expect(matchesCopilot("Copilot", "my-bot")).toBe(false);
  });
});

describe("readCopilotSkipWait", () => {
  it("is true only for a strict boolean true", () => {
    expect(readCopilotSkipWait(reader({ bots: { copilotSkipWait: true } }))).toBe(true);
  });

  it("is false when absent", () => {
    expect(readCopilotSkipWait(reader({ bots: {} }))).toBe(false);
    expect(readCopilotSkipWait(reader(undefined))).toBe(false);
  });

  it("is false for a non-boolean value", () => {
    expect(readCopilotSkipWait(reader({ bots: { copilotSkipWait: "yes" } }))).toBe(false);
  });
});

describe("readCopilotAutoReview", () => {
  it("is true for a strict boolean true", () => {
    expect(readCopilotAutoReview(reader({ bots: { copilotAutoReview: true } }))).toBe(true);
  });

  it("is false for a strict boolean false", () => {
    expect(readCopilotAutoReview(reader({ bots: { copilotAutoReview: false } }))).toBe(false);
  });

  it("is undefined when absent", () => {
    expect(readCopilotAutoReview(reader({}))).toBeUndefined();
    expect(readCopilotAutoReview(reader({ bots: {} }))).toBeUndefined();
    expect(readCopilotAutoReview(reader(undefined))).toBeUndefined();
  });

  it("is undefined for a non-boolean value (string)", () => {
    expect(readCopilotAutoReview(reader({ bots: { copilotAutoReview: "yes" } }))).toBeUndefined();
  });
});
