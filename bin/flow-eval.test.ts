import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFixtures, parseArgs } from "./flow-eval";

let scratch!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-eval-"));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("defaults to both configs and no fixture filter", () => {
    expect(parseArgs([])).toEqual({
      configs: ["defaults", "pr7"],
      keepTmpdir: false,
      help: false,
    });
  });

  it("--fixture sets the filter", () => {
    expect(parseArgs(["--fixture", "01-foo"]).fixture).toBe("01-foo");
  });

  it("--config restricts to one config", () => {
    expect(parseArgs(["--config", "pr7"]).configs).toEqual(["pr7"]);
    expect(parseArgs(["--config", "defaults"]).configs).toEqual(["defaults"]);
  });

  it("--keep-tmpdir is a boolean flag", () => {
    expect(parseArgs(["--keep-tmpdir"]).keepTmpdir).toBe(true);
  });

  it("--help sets the help flag", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
  });

  it("rejects --config values other than defaults/pr7", () => {
    expect(() => parseArgs(["--config", "auto"])).toThrow(/must be 'defaults' or 'pr7'/);
  });

  it("rejects --fixture without a value", () => {
    expect(() => parseArgs(["--fixture"])).toThrow(/requires a value/);
  });
});

describe("discoverFixtures", () => {
  function mkFixture(name: string): void {
    const d = path.join(scratch, "fixtures", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "prompt.md"), "x\n");
  }

  it("returns directory names with a prompt.md, sorted", () => {
    mkFixture("02-b");
    mkFixture("01-a");
    expect(discoverFixtures(scratch)).toEqual(["01-a", "02-b"]);
  });

  it("ignores directories that lack prompt.md", () => {
    fs.mkdirSync(path.join(scratch, "fixtures", "broken"), { recursive: true });
    mkFixture("ok");
    expect(discoverFixtures(scratch)).toEqual(["ok"]);
  });

  it("returns the single fixture when --fixture matches", () => {
    mkFixture("01-foo");
    mkFixture("02-bar");
    expect(discoverFixtures(scratch, "01-foo")).toEqual(["01-foo"]);
  });

  it("throws when --fixture does not match any fixture", () => {
    mkFixture("01-foo");
    expect(() => discoverFixtures(scratch, "ghost")).toThrow(/fixture not found/);
  });

  it("returns an empty list when no fixtures dir exists", () => {
    expect(discoverFixtures(scratch)).toEqual([]);
  });
});
