import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMergeArgs } from "../flow-merge-guard";
import {
  FLOW_MERGE_ALLOW_RULE,
  FLOW_OVERRIDE_ASK_RULES,
  classifyAllShellOn,
  findMergeCoveringAskEntry,
} from "./merge-allow-rule";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "merge-allow-rule-")),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, body);
  return file;
}

describe("FLOW_MERGE_ALLOW_RULE", () => {
  it("is the exact rule text flow ships", () => {
    expect(FLOW_MERGE_ALLOW_RULE).toBe("Bash(flow-merge-guard merge *)");
  });

  it("is a prefix match for the merge mode's invocation shape, and not for --record-override", () => {
    const prefix = FLOW_MERGE_ALLOW_RULE.slice("Bash(".length, -" *)".length);
    expect(prefix).toBe("flow-merge-guard merge");
    expect("flow-merge-guard merge 1 --slug x".startsWith(`${prefix} `)).toBe(
      true,
    );
    expect(
      "flow-merge-guard 1 --record-override".startsWith(`${prefix} `),
    ).toBe(false);
    // The helper accepts exactly that invocation, and nothing wider.
    expect(parseMergeArgs(["merge", "1", "--slug", "x"])).toEqual({
      pr: 1,
      slug: "x",
    });
    expect(parseMergeArgs(["merge", "1", "--record-override"])).toHaveProperty(
      "error",
    );
  });
});

const askSettings = (ask: unknown) => JSON.stringify({ permissions: { ask } });
const [ASK_BARE, ASK_ARGS] = FLOW_OVERRIDE_ASK_RULES;

describe("FLOW_OVERRIDE_ASK_RULES", () => {
  it("names the two override rules exactly", () => {
    expect([...FLOW_OVERRIDE_ASK_RULES]).toEqual([
      "Bash(flow-merge-guard * --record-override)",
      "Bash(flow-merge-guard * --record-override *)",
    ]);
  });
});

describe("findMergeCoveringAskEntry", () => {
  it("returns no entry for a missing file, naming the path", () => {
    const missing = path.join(root, "nope.json");
    expect(findMergeCoveringAskEntry(missing)).toEqual({
      resolvedPath: missing,
    });
  });

  it("returns no entry for malformed JSON without throwing", () => {
    const file = write("bad.json", "{not json");
    expect(findMergeCoveringAskEntry(file)).toEqual({ resolvedPath: file });
  });

  it("returns no entry when only the two override ask rules are present", () => {
    const file = write("ok.json", askSettings([ASK_BARE, ASK_ARGS]));
    expect(findMergeCoveringAskEntry(file)).toEqual({ resolvedPath: file });
  });

  it("returns no entry when permissions.ask is not a list", () => {
    const file = write("nl.json", askSettings("nope"));
    expect(findMergeCoveringAskEntry(file).entry).toBeUndefined();
  });

  it("returns the ask entry that would make every merge prompt", () => {
    const file = write(
      "m.json",
      askSettings([ASK_BARE, "Bash(flow-merge-guard *)", ASK_ARGS]),
    );
    expect(findMergeCoveringAskEntry(file)).toEqual({
      entry: "Bash(flow-merge-guard *)",
      resolvedPath: file,
    });
  });

  it("ignores allow entries", () => {
    const file = write(
      "a.json",
      JSON.stringify({ permissions: { allow: ["Bash(flow-merge-guard *)"] } }),
    );
    expect(findMergeCoveringAskEntry(file).entry).toBeUndefined();
  });

  it("reports the real file for a symlinked settings file", () => {
    const real = write(
      "dotfiles.json",
      askSettings(["Bash(flow-merge-guard *)"]),
    );
    const link = path.join(root, "settings.json");
    fs.symlinkSync(real, link);
    expect(findMergeCoveringAskEntry(link)).toEqual({
      entry: "Bash(flow-merge-guard *)",
      resolvedPath: real,
    });
  });

  it("never writes: bytes and mtime of the settings file are unchanged by a read", () => {
    const file = write("f.json", askSettings(["Bash(flow-merge-guard *)"]));
    const stat = () => {
      const st = fs.statSync(file);
      return `${createHash("sha1").update(fs.readFileSync(file)).digest("hex")}@${st.mtimeMs}`;
    };
    const before = stat();
    findMergeCoveringAskEntry(file);
    expect(stat()).toBe(before);
  });
});

describe("classifyAllShellOn", () => {
  const auto = (v: unknown) =>
    JSON.stringify({ autoMode: { classifyAllShell: v } });

  it("is true only when autoMode.classifyAllShell is exactly true", () => {
    expect(classifyAllShellOn(write("t.json", auto(true)))).toBe(true);
    expect(classifyAllShellOn(write("f.json", auto(false)))).toBe(false);
    expect(classifyAllShellOn(write("s.json", auto("true")))).toBe(false);
    expect(classifyAllShellOn(write("n.json", "{}"))).toBe(false);
  });

  it("is false for a missing or malformed file without throwing", () => {
    expect(classifyAllShellOn(path.join(root, "nope.json"))).toBe(false);
    expect(classifyAllShellOn(write("bad.json", "{not json"))).toBe(false);
  });
});
