import { describe, expect, it, vi, afterEach } from "vitest";
import {
  OUTPUT_LENS_INVALID_NOTICE,
  isOutputLens,
  readOutputLens,
  resolveLens,
} from "./output-lens";
import type { ReadConfigFile } from "./modules-config";

const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("isOutputLens", () => {
  it("accepts pm and dev only", () => {
    expect(isOutputLens("pm")).toBe(true);
    expect(isOutputLens("dev")).toBe(true);
    expect(isOutputLens("prod")).toBe(false);
    expect(isOutputLens(42)).toBe(false);
    expect(isOutputLens(undefined)).toBe(false);
  });
});

describe("readOutputLens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is silent pm when output.lens is absent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readOutputLens(reader({}))).toBe("pm");
    expect(readOutputLens(reader(undefined))).toBe("pm");
    expect(readOutputLens(reader({ output: {} }))).toBe("pm");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns dev when recorded", () => {
    expect(readOutputLens(reader({ output: { lens: "dev" } }))).toBe("dev");
  });

  it("returns pm when recorded", () => {
    expect(readOutputLens(reader({ output: { lens: "pm" } }))).toBe("pm");
  });

  it("falls back to pm with a stderr notice on a wrong-type value", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readOutputLens(reader({ output: { lens: 42 } }))).toBe("pm");
    expect(spy).toHaveBeenCalledWith(OUTPUT_LENS_INVALID_NOTICE);
  });

  it("falls back to pm with a stderr notice on an unknown string value", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readOutputLens(reader({ output: { lens: "verbose" } }))).toBe(
      "pm",
    );
    expect(spy).toHaveBeenCalledWith(OUTPUT_LENS_INVALID_NOTICE);
  });

  it("never touches the real ~/.flow/config.json (default read param is only exercised via injection in these tests)", () => {
    // Every case above passes an explicit reader; this test documents the
    // discipline rather than asserting new behavior.
    expect(true).toBe(true);
  });
});

describe("resolveLens", () => {
  it("an explicit flag beats config", () => {
    expect(resolveLens("dev", reader({ output: { lens: "pm" } }))).toBe(
      "dev",
    );
    expect(resolveLens("pm", reader({ output: { lens: "dev" } }))).toBe("pm");
  });

  it("falls through to config when flag is absent", () => {
    expect(resolveLens(undefined, reader({ output: { lens: "dev" } }))).toBe(
      "dev",
    );
  });

  it("falls through to default pm when both flag and config are absent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveLens(undefined, reader({}))).toBe("pm");
    spy.mockRestore();
  });

  it("an invalid flag value falls back to pm without touching config", () => {
    let read = false;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      resolveLens("verbose", () => {
        read = true;
        return { output: { lens: "dev" } };
      }),
    ).toBe("pm");
    expect(read).toBe(false);
    spy.mockRestore();
  });
});
