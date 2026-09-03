import { describe, expect, it } from "vitest";
import {
  resolveKindAmbient,
  resolveSlugAmbient,
  resolveSlugFromEnv,
} from "./session-identity";
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
  it("resolves a valid FLOW_SLUG", () => {
    const slug = resolveSlugAmbient({ env: { FLOW_SLUG: "env-slug" } });
    expect(slug).toBe("env-slug");
  });

  it("returns null when FLOW_SLUG is absent or shape-invalid — env-only, no pane fallback", () => {
    expect(resolveSlugAmbient({ env: {} })).toBeNull();
    expect(resolveSlugAmbient({ env: { FLOW_SLUG: "NOT VALID" } })).toBeNull();
  });
});

describe("resolveKindAmbient", () => {
  it("passes through resolveKindFromPane's resolved kind", () => {
    const kind = resolveKindAmbient({
      env: { TMUX_PANE: "%1" },
      spawnTmux: () => ok("epic-run"),
    });
    expect(kind).toBe("epic-run");
  });

  it("returns null when the pane has no @flow-kind option (no env fallback)", () => {
    const kind = resolveKindAmbient({
      env: { TMUX_PANE: "%1", FLOW_KIND: "epic-run" },
      spawnTmux: () => ({ stdout: "", stderr: "invalid option", exitCode: 1 }),
    });
    expect(kind).toBeNull();
  });

  it("returns null when $TMUX_PANE is unset", () => {
    expect(resolveKindAmbient({ env: {} })).toBeNull();
  });
});
