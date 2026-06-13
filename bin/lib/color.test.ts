/**
 * Tests for the TTY-gated color helper. Covers the Story 7 helper portion:
 * dim/green/red return the bare input when color is disabled (non-TTY or
 * NO_COLOR set) and wrap with the expected SGR codes when FORCE_COLOR forces
 * it on. Each test restores process.stdout.isTTY and the relevant env vars.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { colorEnabled, dim, green, red } from "./color";

let origIsTTY: boolean | undefined;
let origForceColor: string | undefined;
let origNoColor: string | undefined;

beforeEach(() => {
  origIsTTY = process.stdout.isTTY;
  origForceColor = process.env.FORCE_COLOR;
  origNoColor = process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
});

afterEach(() => {
  setIsTTY(origIsTTY);
  restoreEnv("FORCE_COLOR", origForceColor);
  restoreEnv("NO_COLOR", origNoColor);
});

function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("color helpers", () => {
  it("returns the bare string when stdout is not a TTY", () => {
    setIsTTY(false);
    expect(colorEnabled()).toBe(false);
    expect(dim("x")).toBe("x");
    expect(green("ok")).toBe("ok");
    expect(red("bad")).toBe("bad");
  });

  it("returns the bare string when NO_COLOR is set, even on a TTY", () => {
    setIsTTY(true);
    process.env.NO_COLOR = "1";
    expect(colorEnabled()).toBe(false);
    expect(dim("x")).toBe("x");
    expect(green("ok")).toBe("ok");
    expect(red("bad")).toBe("bad");
  });

  it("disables color when NO_COLOR is set to an empty string (no-color.org spec)", () => {
    setIsTTY(true);
    process.env.NO_COLOR = "";
    expect(colorEnabled()).toBe(false);
    expect(dim("x")).toBe("x");
  });

  it("wraps with the expected SGR codes when FORCE_COLOR forces it on", () => {
    // FORCE_COLOR wins even when isTTY is false — the test/CI demo path.
    setIsTTY(false);
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(true);
    expect(dim("x")).toBe("\x1b[2mx\x1b[0m");
    expect(green("ok")).toBe("\x1b[32mok\x1b[0m");
    expect(red("bad")).toBe("\x1b[31mbad\x1b[0m");
  });

  it("FORCE_COLOR overrides NO_COLOR", () => {
    setIsTTY(false);
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(true);
    expect(green("ok")).toBe("\x1b[32mok\x1b[0m");
  });
});
