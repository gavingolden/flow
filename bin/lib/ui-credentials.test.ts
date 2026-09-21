import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildFillScript,
  parseDotenvKeys,
  resolveCredentials,
} from "./ui-credentials";

const SENTINEL_USER = "sentinel-user@x";
const SENTINEL_PASS = "sentinel-pass-9f3";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-ui-credentials-test-"));
}

describe("parseDotenvKeys", () => {
  it("ignores unrequested keys", () => {
    const out = parseDotenvKeys("A=1\nB=2\nC=3", ["B"]);
    expect(out).toEqual({ B: "2" });
  });

  it("handles an `export ` prefix", () => {
    const out = parseDotenvKeys("export TOKEN=abc", ["TOKEN"]);
    expect(out).toEqual({ TOKEN: "abc" });
  });

  it("strips matching double quotes", () => {
    const out = parseDotenvKeys('TOKEN="abc def"', ["TOKEN"]);
    expect(out).toEqual({ TOKEN: "abc def" });
  });

  it("strips matching single quotes", () => {
    const out = parseDotenvKeys("TOKEN='abc def'", ["TOKEN"]);
    expect(out).toEqual({ TOKEN: "abc def" });
  });

  it("strips an inline ` #comment` on an unquoted value", () => {
    const out = parseDotenvKeys("TOKEN=abc #trailing note", ["TOKEN"]);
    expect(out).toEqual({ TOKEN: "abc" });
  });

  it("does not strip a `#` glued to the value", () => {
    const out = parseDotenvKeys("TOKEN=abc#nocomment", ["TOKEN"]);
    expect(out).toEqual({ TOKEN: "abc#nocomment" });
  });

  it("skips comment lines and blank lines", () => {
    const out = parseDotenvKeys("# comment\n\nTOKEN=abc", ["TOKEN"]);
    expect(out).toEqual({ TOKEN: "abc" });
  });
});

describe("resolveCredentials — precedence", () => {
  it("prefers process.env over .env.local and .env", () => {
    const dir = mkTmpDir();
    fs.writeFileSync(path.join(dir, ".env.local"), "USER=from-env-local\n");
    fs.writeFileSync(path.join(dir, ".env"), "USER=from-env\n");
    const out = resolveCredentials(
      { user: "USER", pass: "PASS" },
      { worktree: dir, env: { USER: "from-process-env" } },
    );
    expect(out.user).toEqual({
      name: "USER",
      present: true,
      source: "process.env",
    });
  });

  it("prefers .env.local over .env when absent from process.env", () => {
    const dir = mkTmpDir();
    fs.writeFileSync(path.join(dir, ".env.local"), "USER=from-env-local\n");
    fs.writeFileSync(path.join(dir, ".env"), "USER=from-env\n");
    const out = resolveCredentials(
      { user: "USER", pass: "PASS" },
      { worktree: dir, env: {} },
    );
    expect(out.user).toEqual({
      name: "USER",
      present: true,
      source: ".env.local",
    });
  });

  it("falls back to .env when absent elsewhere", () => {
    const dir = mkTmpDir();
    fs.writeFileSync(path.join(dir, ".env"), "USER=from-env\n");
    const out = resolveCredentials(
      { user: "USER", pass: "PASS" },
      { worktree: dir, env: {} },
    );
    expect(out.user).toEqual({ name: "USER", present: true, source: ".env" });
  });

  it("treats an empty value as absent", () => {
    const dir = mkTmpDir();
    const out = resolveCredentials(
      { user: "USER", pass: "PASS" },
      { worktree: dir, env: { USER: "" } },
    );
    expect(out.user).toEqual({ name: "USER", present: false });
  });

  it("resolves through a symlinked .env", () => {
    const realDir = mkTmpDir();
    const worktreeDir = mkTmpDir();
    fs.writeFileSync(
      path.join(realDir, ".env"),
      `USER=${SENTINEL_USER}\nPASS=${SENTINEL_PASS}\n`,
    );
    fs.symlinkSync(path.join(realDir, ".env"), path.join(worktreeDir, ".env"));
    const out = resolveCredentials(
      { user: "USER", pass: "PASS" },
      { worktree: worktreeDir, env: {} },
    );
    expect(out.user).toEqual({ name: "USER", present: true, source: ".env" });
    expect(out.values).toEqual({ user: SENTINEL_USER, pass: SENTINEL_PASS });
  });

  it("returns values only when both are present", () => {
    const dir = mkTmpDir();
    const out = resolveCredentials(
      { user: "USER", pass: "PASS" },
      { worktree: dir, env: { USER: "only-user" } },
    );
    expect(out.values).toBeUndefined();
  });
});

describe("buildFillScript", () => {
  it("never contains the sentinel values", () => {
    const script = buildFillScript({ url: "http://127.0.0.1:12345/tok" });
    expect(script).not.toContain(SENTINEL_USER);
    expect(script).not.toContain(SENTINEL_PASS);
  });

  it("returns an async arrow function source with only the documented return keys", () => {
    const script = buildFillScript({ url: "http://127.0.0.1:12345/tok" });
    expect(script.trim().startsWith("async ()")).toBe(true);
    const returnObjects = [...script.matchAll(/return \{([^}]*)\};?/g)].map(
      (m) => m[1],
    );
    expect(returnObjects.length).toBeGreaterThan(0);
    for (const body of returnObjects) {
      const keys = [...body.matchAll(/(\w+):/g)].map((m) => m[1]);
      expect(new Set(keys)).toEqual(
        new Set(["fetched", "userFilled", "passFilled", "submitted", "reason"]),
      );
    }
  });

  it("embeds the url verbatim", () => {
    const script = buildFillScript({ url: "http://127.0.0.1:9999/abc" });
    expect(script).toContain("http://127.0.0.1:9999/abc");
  });
});

describe("buildFillScript — field-lookup-before-fetch ordering & fetch outcomes", () => {
  function makeDocument(overrides: Record<string, unknown> = {}) {
    return {
      querySelector: (sel: string) =>
        Object.prototype.hasOwnProperty.call(overrides, sel)
          ? overrides[sel]
          : null,
    };
  }

  function makeFn(
    script: string,
    document: unknown,
    fetchImpl: (...args: unknown[]) => Promise<unknown>,
  ): () => Promise<{
    fetched: boolean;
    userFilled: boolean;
    passFilled: boolean;
    submitted: boolean;
    reason: string | null;
  }> {
    return new Function("document", "fetch", `return (${script})`)(
      document,
      fetchImpl,
    ) as () => Promise<{
      fetched: boolean;
      userFilled: boolean;
      passFilled: boolean;
      submitted: boolean;
      reason: string | null;
    }>;
  }

  it("never calls fetch (spends no token) when the fields aren't on the page", async () => {
    let fetchCalled = false;
    const script = buildFillScript({ url: "http://127.0.0.1:1/tok" });
    const fn = makeFn(script, makeDocument(), async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) };
    });
    const result = await fn();
    expect(fetchCalled).toBe(false);
    expect(result.reason).toBe("user-field-not-found");
  });

  it("returns fetch-blocked when fetch throws (network/CSP failure)", async () => {
    const fakeInput = { value: "" };
    const script = buildFillScript({ url: "http://127.0.0.1:1/tok" });
    const doc = makeDocument({
      'input[type="email"]': fakeInput,
      'input[type="password"]': fakeInput,
    });
    const fn = makeFn(script, doc, async () => {
      throw new Error("network fail");
    });
    const result = await fn();
    expect(result.reason).toBe("fetch-blocked");
  });

  it("returns endpoint-refused (never fetch-blocked) on a non-OK response", async () => {
    const fakeInput = { value: "" };
    const script = buildFillScript({ url: "http://127.0.0.1:1/tok" });
    const doc = makeDocument({
      'input[type="email"]': fakeInput,
      'input[type="password"]': fakeInput,
    });
    const fn = makeFn(script, doc, async () => ({ ok: false, status: 410 }));
    const result = await fn();
    expect(result.reason).toBe("endpoint-refused");
  });
});
