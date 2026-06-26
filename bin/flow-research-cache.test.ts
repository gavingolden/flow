import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey, entryPath, getEntry, putEntry } from "./flow-research-cache";

let root!: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rcache-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const HOUR = 3600_000;

describe("getEntry / putEntry round-trip", () => {
  it("fresh hit — put then get within TTL returns exact synthesis bytes", () => {
    const q = "Does RFC 4180 require quoting embedded commas?";
    const s = "Yes — fields containing a comma must be quoted. (high)";
    putEntry(q, s, { root });
    expect(getEntry(q, { root })).toEqual({ hit: true, synthesis: s });
  });

  it("miss — no entry returns {hit:false}", () => {
    expect(getEntry("never put this question", { root })).toEqual({
      hit: false,
    });
  });

  it("different-question miss — a different sharp question gets a different key", () => {
    const q1 = "Is argon2id the current OWASP recommendation?";
    const q2 = "What is the safe bcrypt cost factor for 2026?";
    putEntry(q1, "synthesis-1", { root });
    expect(getEntry(q2, { root })).toEqual({ hit: false });
    expect(cacheKey(q1)).not.toBe(cacheKey(q2));
  });

  it("stale-expiry — an entry older than the TTL is a miss; within TTL is a hit", () => {
    const q = "current GitHub Search API rate limit";
    const t0 = 1_700_000_000_000;
    putEntry(q, "limit is N/min", { root, nowMs: t0 });
    expect(getEntry(q, { root, nowMs: t0 + 49 * HOUR, ttlHours: 48 })).toEqual({
      hit: false,
    });
    expect(getEntry(q, { root, nowMs: t0 + 47 * HOUR, ttlHours: 48 })).toEqual({
      hit: true,
      synthesis: "limit is N/min",
    });
    // Custom small TTL: a 2h-old entry misses under ttlHours:1.
    expect(getEntry(q, { root, nowMs: t0 + 2 * HOUR, ttlHours: 1 })).toEqual({
      hit: false,
    });
  });

  it("stale-expiry exact edge — an entry exactly at the TTL boundary is a miss (pins < not <=)", () => {
    const q = "boundary question";
    const t0 = 1_700_000_000_000;
    putEntry(q, "edge-synth", { root, nowMs: t0 });
    // age === ttlHours * MS_PER_HOUR exactly: the comparison is `<`, so the
    // edge falls on the miss side. A flip to `<=` would silently make it a hit.
    expect(getEntry(q, { root, nowMs: t0 + 48 * HOUR, ttlHours: 48 })).toEqual({
      hit: false,
    });
    // One ms before the edge is still a hit — brackets the boundary tightly.
    expect(
      getEntry(q, { root, nowMs: t0 + 48 * HOUR - 1, ttlHours: 48 }),
    ).toEqual({ hit: true, synthesis: "edge-synth" });
  });

  it("corrupt-entry — malformed JSON and missing/garbage timestamp both miss without throwing", () => {
    const q = "a researchable question";
    const p = entryPath(q, { root });
    mkdirSync(root, { recursive: true });

    writeFileSync(p, "this is not json {{{");
    expect(() => getEntry(q, { root })).not.toThrow();
    expect(getEntry(q, { root })).toEqual({ hit: false });

    writeFileSync(p, JSON.stringify({ synthesis: "x" })); // no createdAt
    expect(getEntry(q, { root })).toEqual({ hit: false });

    writeFileSync(
      p,
      JSON.stringify({ createdAt: "not-a-number", synthesis: "x" }),
    );
    expect(getEntry(q, { root })).toEqual({ hit: false });
  });

  it("key-normalization — case/whitespace variants share one key; a genuinely different string differs", () => {
    expect(cacheKey("Foo  Bar")).toBe(cacheKey(" foo bar "));
    expect(cacheKey(" foo bar ")).toBe(cacheKey("FOO BAR\n"));
    expect(cacheKey("FOO BAR\n")).toBe(cacheKey("foo\tbar"));
    expect(cacheKey("foo bar")).not.toBe(cacheKey("foo baz"));

    putEntry("Foo  Bar", "normalized-synth", { root });
    expect(getEntry("foo\tbar", { root })).toEqual({
      hit: true,
      synthesis: "normalized-synth",
    });
  });

  it("round-trip with on-demand dir creation", () => {
    const nested = join(root, "nested", "dir");
    const q = "needs a created dir";
    putEntry(q, "deep-synth", { root: nested });
    expect(getEntry(q, { root: nested })).toEqual({
      hit: true,
      synthesis: "deep-synth",
    });
    expect(entryPath(q, { root: nested }).startsWith(nested)).toBe(true);
  });
});

describe("CLI (spawned binary, env-var seam)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");

  function cli(
    args: string[],
    input?: string,
    extraEnv: Record<string, string> = {},
  ) {
    return spawnSync("bun", ["bin/flow-research-cache.ts", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      input,
      env: { ...process.env, FLOW_RESEARCH_CACHE_DIR: root, ...extraEnv },
    });
  }

  it("put then get round-trips via FLOW_RESEARCH_CACHE_DIR", () => {
    const q = "CLI seam question";
    const put = cli(["put", "--question", q, "--synthesis", "-"], "cli-body");
    expect(put.status).toBe(0);
    const get = cli(["get", "--question", q]);
    expect(get.status).toBe(0);
    expect(get.stdout).toBe("cli-body");
  });

  it("get-miss exits 3 with empty stdout", () => {
    const get = cli(["get", "--question", "definitely-not-cached"]);
    expect(get.status).toBe(3);
    expect(get.stdout).toBe("");
  });

  // Bad-args (exit 2) must stay distinct from miss (exit 3): the Step 1.5 wiring
  // treats ANY non-zero `get` as a graceful miss, but the helper's own contract
  // pins 2 for operator/wiring errors vs 3 for a clean cache miss.
  it("get with no --question exits 2 (bad args, not the miss code 3)", () => {
    const get = cli(["get"]);
    expect(get.status).toBe(2);
    expect(get.status).not.toBe(3);
  });

  it("unknown subcommand exits 2", () => {
    expect(cli(["bogus"]).status).toBe(2);
  });

  it("put with no synthesis source exits 2", () => {
    expect(cli(["put", "--question", "q"]).status).toBe(2);
  });

  describe("--ttl-hours flag / env precedence (flag > env > default)", () => {
    it("--ttl-hours flag ages out a just-written entry (flag wired)", () => {
      expect(cli(["put", "--question", "q", "--synthesis", "x"]).status).toBe(
        0,
      );
      // A near-zero TTL (1e-12h ≈ 3.6e-6ms) makes any non-zero-age entry stale,
      // so the separately-spawned `get` always misses. Proves the flag reaches
      // getEntry's ttlHours without depending on inter-spawn wall-clock timing.
      expect(
        cli(["get", "--question", "q", "--ttl-hours", "1e-12"]).status,
      ).toBe(3);
      // Without the tiny TTL the same entry is a fresh hit under the 48h default.
      const hit = cli(["get", "--question", "q"]);
      expect(hit.status).toBe(0);
      expect(hit.stdout).toBe("x");
    });

    it("FLOW_RESEARCH_CACHE_TTL_HOURS env ages out an entry (env wired)", () => {
      expect(cli(["put", "--question", "q", "--synthesis", "x"]).status).toBe(
        0,
      );
      expect(
        cli(["get", "--question", "q"], undefined, {
          FLOW_RESEARCH_CACHE_TTL_HOURS: "1e-12",
        }).status,
      ).toBe(3);
    });

    it("--ttl-hours flag wins over the env override (flag > env)", () => {
      expect(cli(["put", "--question", "q", "--synthesis", "x"]).status).toBe(
        0,
      );
      // env says expire-immediately, flag says 48h → flag wins → fresh hit.
      const get = cli(
        ["get", "--question", "q", "--ttl-hours", "48"],
        undefined,
        {
          FLOW_RESEARCH_CACHE_TTL_HOURS: "0.0001",
        },
      );
      expect(get.status).toBe(0);
      expect(get.stdout).toBe("x");
    });

    it("a non-positive --ttl-hours falls through to the env override", () => {
      expect(cli(["put", "--question", "q", "--synthesis", "x"]).status).toBe(
        0,
      );
      // --ttl-hours -5 is rejected by positiveFloat → falls through to env's
      // expire-immediately value → miss. Proves the precedence fall-through.
      expect(
        cli(["get", "--question", "q", "--ttl-hours", "-5"], undefined, {
          FLOW_RESEARCH_CACHE_TTL_HOURS: "1e-12",
        }).status,
      ).toBe(3);
    });
  });

  describe("put input modes", () => {
    it("put --synthesis <literal> round-trips the literal value", () => {
      expect(
        cli(["put", "--question", "lit", "--synthesis", "literal-body"]).status,
      ).toBe(0);
      const get = cli(["get", "--question", "lit"]);
      expect(get.status).toBe(0);
      expect(get.stdout).toBe("literal-body");
    });

    it("put --synthesis-file round-trips file contents", () => {
      const f = join(root, "syn.txt");
      writeFileSync(f, "file-body");
      expect(
        cli(["put", "--question", "fromfile", "--synthesis-file", f]).status,
      ).toBe(0);
      const get = cli(["get", "--question", "fromfile"]);
      expect(get.status).toBe(0);
      expect(get.stdout).toBe("file-body");
    });

    it("put --synthesis-file with a missing path exits 2", () => {
      expect(
        cli([
          "put",
          "--question",
          "q",
          "--synthesis-file",
          join(root, "does-not-exist"),
        ]).status,
      ).toBe(2);
    });
  });
});
