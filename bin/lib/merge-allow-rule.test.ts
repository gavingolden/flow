import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMergeArgs } from "../flow-merge-guard";
import { FLOW_MERGE_ALLOW_RULE, readMergeAllowRule } from "./merge-allow-rule";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "merge-allow-rule-")),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const settings = (allow: unknown) => JSON.stringify({ permissions: { allow } });

function write(name: string, body: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, body);
  return file;
}

describe("FLOW_MERGE_ALLOW_RULE", () => {
  it("equals the text the owner keeps in their dotfiles, exactly", () => {
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

describe("readMergeAllowRule", () => {
  it("reports present for the exact rule, reading through a symlinked settings file", () => {
    const real = write(
      "dotfiles-settings.json",
      settings([FLOW_MERGE_ALLOW_RULE]),
    );
    const link = path.join(root, "settings.json");
    fs.symlinkSync(real, link);
    expect(readMergeAllowRule(link)).toEqual({
      status: "present",
      resolvedPath: real,
    });
  });

  it("reports absent when permissions.allow lacks the rule or is not a list", () => {
    expect(
      readMergeAllowRule(write("a.json", settings(["Bash(ls)"]))).status,
    ).toBe("absent");
    expect(readMergeAllowRule(write("b.json", "{}")).status).toBe("absent");
    expect(readMergeAllowRule(write("c.json", settings("nope"))).status).toBe(
      "absent",
    );
  });

  it("reports broader for any other Bash(flow-merge-guard entry, which would also approve --record-override", () => {
    expect(
      readMergeAllowRule(
        write("d.json", settings(["Bash(flow-merge-guard *)"])),
      ).status,
    ).toBe("broader");
  });

  it("reports broader when a broader entry sits beside the exact rule, in either order", () => {
    for (const [i, allow] of [
      ["Bash(flow-merge-guard merge *)", "Bash(flow-merge-guard *)"],
      ["Bash(flow-merge-guard *)", "Bash(flow-merge-guard merge *)"],
    ].entries()) {
      expect(
        readMergeAllowRule(write(`both${i}.json`, settings(allow))),
      ).toMatchObject({ status: "broader", exactPresent: true });
    }
  });

  it("does not call a narrower merge-shaped entry broader", () => {
    expect(
      readMergeAllowRule(
        write("narrow.json", settings(["Bash(flow-merge-guard merge 5)"])),
      ).status,
    ).toBe("absent");
  });

  it("reports malformed JSON and a missing file without throwing", () => {
    expect(readMergeAllowRule(write("e.json", "{not json")).status).toBe(
      "malformed",
    );
    const missing = path.join(root, "nope.json");
    expect(readMergeAllowRule(missing)).toEqual({
      status: "missing-file",
      resolvedPath: missing,
    });
  });

  it("reports a dangling symlink as missing-file naming the link target", () => {
    const target = path.join(root, "dotfiles", "settings.json");
    const link = path.join(root, "settings.json");
    fs.symlinkSync(target, link);
    expect(readMergeAllowRule(link)).toEqual({
      status: "missing-file",
      resolvedPath: target,
    });
  });

  it("never writes: bytes and mtime of the settings file are unchanged by a read", () => {
    const file = write("f.json", settings([FLOW_MERGE_ALLOW_RULE]));
    const stat = () => {
      const st = fs.statSync(file);
      return `${createHash("sha1").update(fs.readFileSync(file)).digest("hex")}@${st.mtimeMs}`;
    };
    const before = stat();
    readMergeAllowRule(file);
    expect(stat()).toBe(before);
  });
});
