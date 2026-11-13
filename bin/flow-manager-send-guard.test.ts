import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideSend,
  denyOutput,
  main,
  peerSlug,
} from "./flow-manager-send-guard";
import { readManagerLog } from "./lib/manager-log";
import { updateScope } from "./lib/manager-scope";
import { writeState } from "./lib/state";

let dir: string;
let home: string;
let stateDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendguard-"));
  home = path.join(dir, "manager");
  stateDir = path.join(dir, "state");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const deps = () => ({ home, stateDir });
const seed = (slug: string, phase = "implementing", repo = "/r/flow") =>
  writeState(
    { slug, phase, repo, updatedAt: "2026-11-12T00:00:00.000Z" },
    stateDir,
  );
const scope = (...scopes: string[]) =>
  updateScope(
    () => ({
      version: 1,
      scopes,
      updatedAt: "2026-11-12T00:00:00.000Z",
      source: "cli",
    }),
    home,
  );
const send = (to: unknown) => ({
  tool_name: "SendMessage",
  tool_input: { to, message: "hi" },
});

describe("peerSlug", () => {
  it("should strip a trailing [ref] and surrounding space", () => {
    expect(peerSlug("my-slug [abc123]")).toBe("my-slug");
    expect(peerSlug("my-slug")).toBe("my-slug");
    expect(peerSlug("  my-slug  [x y] ")).toBe("my-slug");
  });
});

describe("decideSend", () => {
  it("should allow a pipeline the scope covers, with or without a ref", () => {
    seed("covered");
    scope("pipeline:covered");
    expect(decideSend(send("covered"), deps())).toEqual({
      allow: true,
      slug: "covered",
    });
    expect(decideSend(send("covered [r1]"), deps())).toEqual({
      allow: true,
      slug: "covered",
    });
  });

  it("should allow any pipeline of a covered repo", () => {
    seed("a");
    scope("repo:flow");
    expect(decideSend(send("a"), deps()).allow).toBe(true);
  });

  it("should deny a pipeline outside the scope", () => {
    seed("other", "implementing", "/r/else");
    scope("repo:flow");
    const v = decideSend(send("other"), deps());
    expect(v.allow).toBe(false);
    expect(!v.allow && v.reason).toContain("outside the manager's scope");
  });

  it("should deny when there is no scope file", () => {
    seed("a");
    expect(decideSend(send("a"), deps()).allow).toBe(false);
  });

  it("should deny a finished pipeline even when it is in scope", () => {
    seed("done", "merged");
    scope("repo:flow");
    expect(decideSend(send("done"), deps()).allow).toBe(false);
  });

  it("should deny an unknown pipeline", () => {
    scope("repo:flow");
    expect(decideSend(send("ghost"), deps()).allow).toBe(false);
  });

  it("should deny names that are not slugs, including broadcast and traversal", () => {
    seed("a");
    scope("repo:flow");
    for (const to of ["*", "all", "../a", "A", "", "a b", "manager"]) {
      expect(decideSend(send(to), deps()).allow, to).toBe(false);
    }
  });

  it("should fail closed on malformed payloads", () => {
    seed("a");
    scope("repo:flow");
    for (const input of [
      null,
      undefined,
      "text",
      42,
      {},
      { tool_name: "SendMessage" },
      { tool_name: "SendMessage", tool_input: null },
      { tool_name: "SendMessage", tool_input: {} },
      { tool_name: "SendMessage", tool_input: { to: 5 } },
      { tool_name: "Bash", tool_input: { to: "a" } },
    ]) {
      expect(decideSend(input, deps()).allow, JSON.stringify(input)).toBe(
        false,
      );
    }
  });
});

describe("main", () => {
  const io = (stdin: string) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        readStdin: async () => stdin,
        out: (s: string) => void out.push(s),
        err: (s: string) => void err.push(s),
      },
    };
  };

  it("should print the PreToolUse deny JSON for an out-of-scope target and exit 0", async () => {
    scope("repo:flow");
    seed("other", "implementing", "/r/else");
    const t = io(JSON.stringify(send("other")));
    expect(await main([], t.io, deps())).toBe(0);
    const parsed = JSON.parse(t.out.join(""));
    expect(parsed.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      "outside the manager's scope",
    );
  });

  it("should print nothing and log manager-send for an allowed target", async () => {
    scope("repo:flow");
    seed("a");
    const t = io(JSON.stringify(send("a [r]")));
    expect(await main([], t.io, deps())).toBe(0);
    expect(t.out).toEqual([]);
    const sends = readManagerLog({}, home).filter(
      (e) => e.kind === "manager-send",
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ slug: "a", repo: "flow" });
  });

  it("should not log a denied send", async () => {
    scope("repo:flow");
    const t = io(JSON.stringify(send("ghost")));
    await main([], t.io, deps());
    expect(readManagerLog({}, home)).toEqual([]);
  });

  it("should deny on unparseable or empty stdin", async () => {
    for (const stdin of ["", "{nope"]) {
      const t = io(stdin);
      expect(await main([], t.io, deps())).toBe(0);
      expect(
        JSON.parse(t.out.join("")).hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    }
  });

  it("--to prints the verdict and exits 0 for allow, 2 for deny", async () => {
    scope("repo:flow");
    seed("a");
    const ok = io("");
    expect(await main(["--to", "a [x]"], ok.io, deps())).toBe(0);
    expect(JSON.parse(ok.out.join(""))).toEqual({ allow: true, slug: "a" });
    const no = io("");
    expect(await main(["--to", "ghost"], no.io, deps())).toBe(2);
    expect(JSON.parse(no.out.join("")).allow).toBe(false);
    expect(readManagerLog({}, home)).toEqual([]);
  });

  it("should refuse stray arguments", async () => {
    const t = io("");
    expect(await main(["--bogus"], t.io, deps())).toBe(2);
    expect(await main(["--to"], t.io, deps())).toBe(2);
  });
});

describe("denyOutput", () => {
  it("should be one JSON line", () => {
    expect(denyOutput("no").endsWith("\n")).toBe(true);
  });
});

describe("file mode", () => {
  it("should be executable", () => {
    const mode = fs.statSync(
      path.join(__dirname, "flow-manager-send-guard.ts"),
    ).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});
