import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  LAUNCH_SERVICES_OPT_OUT,
  NO_PROCTITLE_PRELOAD,
  withNoProctitlePreload,
} from "./no-proctitle-env";

const P = "/flow/bin/lib/no-proctitle.cjs";
const darwin = (env: NodeJS.ProcessEnv, extra = {}) =>
  withNoProctitlePreload(env, {
    platform: "darwin",
    preloadPath: P,
    exists: () => true,
    ...extra,
  });

describe("withNoProctitlePreload", () => {
  it("should append --require to empty NODE_OPTIONS when on darwin", () => {
    expect(darwin({}).NODE_OPTIONS).toBe(`--require=${P}`);
  });

  it("should keep existing NODE_OPTIONS and append after it when on darwin", () => {
    expect(
      darwin({ NODE_OPTIONS: "--max-old-space-size=4096" }).NODE_OPTIONS,
    ).toBe(`--max-old-space-size=4096 --require=${P}`);
  });

  it("should not duplicate when NODE_OPTIONS already names the path", () => {
    const opts = `--require=${P}`;
    expect(darwin({ NODE_OPTIONS: opts }).NODE_OPTIONS).toBe(opts);
  });

  it("should quote a preload path containing whitespace", () => {
    const sp = "/my flow/no-proctitle.cjs";
    expect(darwin({}, { preloadPath: sp }).NODE_OPTIONS).toBe(
      `--require "${sp}"`,
    );
  });

  it("should leave NODE_OPTIONS absent when the preload is missing", () => {
    const out = darwin({}, { exists: () => false });
    expect("NODE_OPTIONS" in out).toBe(false);
    const kept = darwin({ NODE_OPTIONS: "--a" }, { exists: () => false });
    expect(kept.NODE_OPTIONS).toBe("--a");
  });

  it("should set the libuv opt-out to 0 when unset, even with a missing preload", () => {
    expect(darwin({}).UV_PROCESS_TITLE_USE_LAUNCH_SERVICES).toBe("0");
    expect(
      darwin({}, { exists: () => false }).UV_PROCESS_TITLE_USE_LAUNCH_SERVICES,
    ).toBe("0");
  });

  it("should keep a caller-set libuv value including empty", () => {
    expect(
      darwin({ UV_PROCESS_TITLE_USE_LAUNCH_SERVICES: "1" })
        .UV_PROCESS_TITLE_USE_LAUNCH_SERVICES,
    ).toBe("1");
    expect(
      darwin({ UV_PROCESS_TITLE_USE_LAUNCH_SERVICES: "" })
        .UV_PROCESS_TITLE_USE_LAUNCH_SERVICES,
    ).toBe("");
  });

  it("should return an equal env unchanged when not on darwin", () => {
    const input = { PATH: "/bin", FOO: "bar" };
    const out = withNoProctitlePreload(input, {
      platform: "linux",
      preloadPath: P,
      exists: () => true,
    });
    expect(out).toEqual(input);
    expect("NODE_OPTIONS" in out).toBe(false);
    expect("UV_PROCESS_TITLE_USE_LAUNCH_SERVICES" in out).toBe(false);
  });

  it("should not mutate its input and never emit undefined values", () => {
    const input: NodeJS.ProcessEnv = { PATH: "/bin" };
    const out = darwin(input);
    expect(input).toEqual({ PATH: "/bin" });
    expect(out).not.toBe(input);
    for (const v of Object.values(out)) expect(v).not.toBeUndefined();
  });
});

describe("constants", () => {
  it("should point NO_PROCTITLE_PRELOAD at an existing absolute no-proctitle.cjs", () => {
    expect(isAbsolute(NO_PROCTITLE_PRELOAD)).toBe(true);
    expect(NO_PROCTITLE_PRELOAD.endsWith("no-proctitle.cjs")).toBe(true);
    expect(existsSync(NO_PROCTITLE_PRELOAD)).toBe(true);
  });

  it("should name the libuv opt-out variable", () => {
    expect(LAUNCH_SERVICES_OPT_OUT).toBe(
      "UV_PROCESS_TITLE_USE_LAUNCH_SERVICES",
    );
  });
});
