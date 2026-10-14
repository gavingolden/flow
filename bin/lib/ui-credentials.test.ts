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
    const script = buildFillScript({
      url: "http://127.0.0.1:12345/flow-ui-login",
    });
    expect(script).not.toContain(SENTINEL_USER);
    expect(script).not.toContain(SENTINEL_PASS);
  });

  it("is a one-line async arrow function source, compact, with no secret-shaped run", () => {
    const script = buildFillScript({
      url: "http://127.0.0.1:12345/flow-ui-login",
    });
    expect(script.startsWith("async () =>")).toBe(true);
    expect(script).not.toContain("\n");
    expect(script.length).toBeLessThanOrEqual(1200);
    expect(script).not.toMatch(/[0-9a-f]{32,}/);
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

  it("never calls fetch (leaves the one-time endpoint unused) when the fields aren't on the page", async () => {
    let fetchCalled = false;
    const script = buildFillScript({ url: "http://127.0.0.1:1/flow-ui-login" });
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
    const script = buildFillScript({ url: "http://127.0.0.1:1/flow-ui-login" });
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
    const script = buildFillScript({ url: "http://127.0.0.1:1/flow-ui-login" });
    const doc = makeDocument({
      'input[type="email"]': fakeInput,
      'input[type="password"]': fakeInput,
    });
    const fn = makeFn(script, doc, async () => ({ ok: false, status: 410 }));
    const result = await fn();
    expect(result.reason).toBe("endpoint-refused");
  });
});

describe("buildFillScript — every branch returns exactly the documented keys", () => {
  const KEYS = ["fetched", "passFilled", "reason", "submitted", "userFilled"];

  class FakeInput {
    events: string[] = [];
    form: unknown = null;
    private v = "";
    set value(x: string) {
      this.v = x;
    }
    get value(): string {
      return this.v;
    }
    dispatchEvent(e: { type: string }): void {
      this.events.push(e.type);
    }
    closest(): unknown {
      return this.form;
    }
  }

  function run(
    selectors: Record<string, unknown>,
    fetchImpl: (...args: unknown[]) => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    const script = buildFillScript({
      url: "http://127.0.0.1:1/flow-ui-login",
    });
    class FakeEvent {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    }
    const document = {
      querySelector: (sel: string) =>
        Object.prototype.hasOwnProperty.call(selectors, sel)
          ? selectors[sel]
          : null,
    };
    const fn = new Function("document", "fetch", "Event", `return (${script})`)(
      document,
      fetchImpl,
      FakeEvent,
    ) as () => Promise<Record<string, unknown>>;
    return fn();
  }

  const okFetch = async () => ({
    ok: true,
    json: async () => ({ user: SENTINEL_USER, pass: SENTINEL_PASS }),
  });

  it("user-field-not-found", async () => {
    const r = await run({}, okFetch);
    expect(Object.keys(r).sort()).toEqual(KEYS);
    expect(r).toEqual({
      fetched: false,
      userFilled: false,
      passFilled: false,
      submitted: false,
      reason: "user-field-not-found",
    });
  });

  it("pass-field-not-found", async () => {
    const r = await run({ 'input[type="email"]': new FakeInput() }, okFetch);
    expect(Object.keys(r).sort()).toEqual(KEYS);
    expect(r.reason).toBe("pass-field-not-found");
    expect(r.fetched).toBe(false);
  });

  it("fetch-blocked", async () => {
    const r = await run(
      {
        'input[type="email"]': new FakeInput(),
        'input[type="password"]': new FakeInput(),
      },
      async () => {
        throw new Error("blocked");
      },
    );
    expect(Object.keys(r).sort()).toEqual(KEYS);
    expect(r.reason).toBe("fetch-blocked");
    expect(r.userFilled).toBe(false);
  });

  it("endpoint-refused", async () => {
    const r = await run(
      {
        'input[type="email"]': new FakeInput(),
        'input[type="password"]': new FakeInput(),
      },
      async () => ({ ok: false, status: 410 }),
    );
    expect(Object.keys(r).sort()).toEqual(KEYS);
    expect(r.reason).toBe("endpoint-refused");
  });

  it("fetches with mode cors and credentials omit", async () => {
    let init: unknown;
    await run(
      {
        'input[type="email"]': new FakeInput(),
        'input[type="password"]': new FakeInput(),
      },
      async (...args: unknown[]) => {
        init = args[1];
        return { ok: false };
      },
    );
    expect(init).toEqual({ mode: "cors", credentials: "omit" });
  });

  it("success clicks the submit button and fills both fields via input/change", async () => {
    const user = new FakeInput();
    const pass = new FakeInput();
    let clicked = false;
    const form = {
      querySelector: () => ({
        click: () => {
          clicked = true;
        },
      }),
    };
    user.form = form;
    pass.form = form;
    const r = await run(
      { 'input[type="email"]': user, 'input[type="password"]': pass },
      okFetch,
    );
    expect(Object.keys(r).sort()).toEqual(KEYS);
    expect(r).toEqual({
      fetched: true,
      userFilled: true,
      passFilled: true,
      submitted: true,
      reason: null,
    });
    expect(clicked).toBe(true);
    expect(user.events).toEqual(["input", "change"]);
    expect(pass.events).toEqual(["input", "change"]);
    expect(user.value).toBe(SENTINEL_USER);
    expect(pass.value).toBe(SENTINEL_PASS);
  });

  it("success falls back to requestSubmit when there is no submit control", async () => {
    const user = new FakeInput();
    const pass = new FakeInput();
    let requested = false;
    const form = {
      querySelector: () => null,
      requestSubmit: () => {
        requested = true;
      },
    };
    user.form = form;
    pass.form = form;
    const r = await run(
      { 'input[type="email"]': user, 'input[type="password"]': pass },
      okFetch,
    );
    expect(Object.keys(r).sort()).toEqual(KEYS);
    expect(r.submitted).toBe(true);
    expect(requested).toBe(true);
  });

  it("queries the documented user-field fallbacks in order", async () => {
    const seen: string[] = [];
    const script = buildFillScript({
      url: "http://127.0.0.1:1/flow-ui-login",
    });
    const document = { querySelector: (s: string) => (seen.push(s), null) };
    await new Function("document", "fetch", `return (${script})`)(
      document,
      okFetch,
    )();
    expect(seen).toEqual([
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      "#email",
      'input[type="password"]',
    ]);
  });

  it.each([
    'input[autocomplete="username"]',
    'input[name*="email" i]',
    'input[name*="user" i]',
    "#email",
  ])("finds the user field through the %s fallback", async (selector) => {
    const user = new FakeInput();
    const pass = new FakeInput();
    const r = await run(
      { [selector]: user, 'input[type="password"]': pass },
      okFetch,
    );
    expect(r.reason).toBeNull();
    expect(r.userFilled).toBe(true);
    expect(user.value).toBe(SENTINEL_USER);
    expect(pass.value).toBe(SENTINEL_PASS);
  });

  it("submits through the user field's form when the password input has none", async () => {
    const user = new FakeInput();
    const pass = new FakeInput();
    let clicked = false;
    user.form = {
      querySelector: () => ({
        click: () => {
          clicked = true;
        },
      }),
    };
    pass.form = null;
    const r = await run(
      { 'input[name*="user" i]': user, 'input[type="password"]': pass },
      okFetch,
    );
    expect(r.submitted).toBe(true);
    expect(clicked).toBe(true);
  });

  it("success without a form reports submitted:false", async () => {
    const r = await run(
      {
        'input[type="email"]': new FakeInput(),
        'input[type="password"]': new FakeInput(),
      },
      okFetch,
    );
    expect(Object.keys(r).sort()).toEqual(KEYS);
    expect(r).toEqual({
      fetched: true,
      userFilled: true,
      passFilled: true,
      submitted: false,
      reason: null,
    });
  });
});
