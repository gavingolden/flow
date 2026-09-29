import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandOnPath, pathContains } from "./path-probe";

describe("commandOnPath", () => {
  it("is true when the runner exits 0 and passes the command to `command -v`", () => {
    const seen: string[][] = [];
    const ok = commandOnPath("tmux", (argv) => {
      seen.push(argv);
      return { status: 0 };
    });
    expect(ok).toBe(true);
    expect(seen).toEqual([["sh", "-c", "command -v tmux"]]);
  });

  it("is false on a non-zero or null status", () => {
    expect(commandOnPath("nope", () => ({ status: 1 }))).toBe(false);
    expect(commandOnPath("nope", () => ({ status: null }))).toBe(false);
  });

  it("finds a real command with the default runner", () => {
    expect(commandOnPath("sh")).toBe(true);
    expect(commandOnPath("flow-definitely-not-a-real-command-xyz")).toBe(false);
  });
});

describe("pathContains", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "path-probe-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("matches an exact PATH segment", () => {
    expect(pathContains("/opt/x/bin", "/usr/bin:/opt/x/bin:/bin")).toBe(true);
  });

  it("does not match a prefix of a segment or an empty PATH", () => {
    expect(pathContains("/opt/x", "/usr/bin:/opt/x/bin")).toBe(false);
    expect(pathContains("/opt/x", "")).toBe(false);
  });

  it("matches a segment that resolves to the same real directory", () => {
    const real = path.join(tmp, "real");
    const link = path.join(tmp, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(pathContains(real, `/usr/bin:${link}`)).toBe(true);
    expect(pathContains(link, `/usr/bin:${real}`)).toBe(true);
  });

  it("ignores non-existent segments without throwing", () => {
    expect(pathContains(tmp, "/no/such/dir:/also/missing")).toBe(false);
  });
});
