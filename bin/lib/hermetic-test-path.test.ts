import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertHermeticTestPath,
  homeSandboxViolation,
  realAccountHome,
} from "./hermetic-test-path";

describe("assertHermeticTestPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-hermetic-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a symlink target and leaves its link target untouched", () => {
    const real = path.join(dir, "real.txt");
    fs.writeFileSync(real, "original");
    const link = path.join(dir, "link");
    fs.symlinkSync(real, link);
    expect(() => assertHermeticTestPath(link)).toThrow(/symlink/);
    expect(fs.readFileSync(real, "utf8")).toBe("original");
  });

  it("refuses a path under the real account home outside tmpdir", () => {
    const probe = path.join(
      realAccountHome(),
      `.flow-hermetic-probe-${Math.random().toString(36).slice(2)}`,
      "x",
    );
    expect(() => assertHermeticTestPath(probe)).toThrow(/inside-real-home/);
    expect(fs.existsSync(path.dirname(probe))).toBe(false);
  });

  it("accepts an existing temp file", () => {
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "x");
    expect(() => assertHermeticTestPath(f)).not.toThrow();
  });

  it("accepts a not-yet-created file under a temp dir", () => {
    expect(() =>
      assertHermeticTestPath(path.join(dir, "new", "deep", "f.txt")),
    ).not.toThrow();
  });
});

describe("homeSandboxViolation", () => {
  it("flags an env whose HOME differs from os.homedir()", () => {
    expect(
      homeSandboxViolation({ ...process.env, HOME: "/somewhere/else" }),
    ).not.toBeNull();
  });

  it("flags a plain-object copy of process.env", () => {
    expect(homeSandboxViolation({ ...process.env })).not.toBeNull();
  });

  it("is null for process.env in the normal sandbox", () => {
    expect(homeSandboxViolation(process.env)).toBeNull();
  });
});
