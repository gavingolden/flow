import { describe, expect, it } from "vitest";
import { resolveSlugAmbient, resolveSlugFromEnv } from "./session-identity";
import type { SpawnResult } from "./tmux";

const ok = (stdout: string): SpawnResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

describe("resolveSlugFromEnv", () => {
  it("returns a valid FLOW_SLUG", () => {
    expect(resolveSlugFromEnv({ FLOW_SLUG: "my-feature" })).toBe("my-feature");
  });

  it("returns null when FLOW_SLUG is absent", () => {
    expect(resolveSlugFromEnv({})).toBeNull();
  });

  it("returns null for a shape-invalid FLOW_SLUG", () => {
    expect(resolveSlugFromEnv({ FLOW_SLUG: "" })).toBeNull();
    expect(resolveSlugFromEnv({ FLOW_SLUG: "Bad Slug" })).toBeNull();
    expect(resolveSlugFromEnv({ FLOW_SLUG: "../etc/passwd" })).toBeNull();
    expect(resolveSlugFromEnv({ FLOW_SLUG: "-leading" })).toBeNull();
  });
});

describe("resolveSlugAmbient", () => {
  it("env wins when both FLOW_SLUG and a pane slug are available", () => {
    const slug = resolveSlugAmbient({
      env: { FLOW_SLUG: "env-slug", TMUX_PANE: "%1" },
      spawnTmux: () => ok("pane-slug"),
      listWindowsFn: () => [],
    });
    expect(slug).toBe("env-slug");
  });

  it("falls back to the pane when FLOW_SLUG is absent", () => {
    const slug = resolveSlugAmbient({
      env: { TMUX_PANE: "%1" },
      spawnTmux: (args) =>
        args[0] === "show-options" ? ok("pane-slug") : ok("@1"),
      listWindowsFn: () => [],
    });
    expect(slug).toBe("pane-slug");
  });

  it("falls back to the pane when FLOW_SLUG is shape-invalid", () => {
    const slug = resolveSlugAmbient({
      env: { FLOW_SLUG: "NOT VALID", TMUX_PANE: "%1" },
      spawnTmux: (args) =>
        args[0] === "show-options" ? ok("pane-slug") : ok("@1"),
      listWindowsFn: () => [],
    });
    expect(slug).toBe("pane-slug");
  });

  it("returns null when neither source resolves (parity with today)", () => {
    expect(resolveSlugAmbient({ env: {} })).toBeNull();
  });
});
