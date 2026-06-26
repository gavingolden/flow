import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheKey,
  entryPath,
  getEntry,
  pruneCache,
  putEntry,
} from "./flow-research-cache";

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

describe("pruneCache (GC sweep)", () => {
  const T0 = 1_700_000_000_000;

  // Fixtures use the real `<sha256hex>.json` name shape the helper authors
  // (derived via cacheKey) because pruneCache only ever touches files matching
  // that shape. Each helper returns the on-disk name so assertions reference it.
  function writeEntry(
    seed: string,
    createdAt: number | undefined,
    opts: { synthesis?: unknown } = {},
  ): string {
    mkdirSync(root, { recursive: true });
    const name = cacheKey(seed) + ".json";
    const obj: Record<string, unknown> = {
      synthesis: "synthesis" in opts ? opts.synthesis : seed,
    };
    if (createdAt !== undefined) obj.createdAt = createdAt;
    writeFileSync(join(root, name), JSON.stringify(obj));
    return name;
  }

  // Write a conforming orphan tmp (`<key>.json.<pid>.tmp`) and set its mtime
  // (utimes takes seconds) so the grace-window check is deterministic.
  function writeTmp(seed: string, pid: number, mtimeMs: number): string {
    mkdirSync(root, { recursive: true });
    const name = `${cacheKey(seed)}.json.${pid}.tmp`;
    const p = join(root, name);
    writeFileSync(p, "half-written");
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return name;
  }

  // Verbatim file at an arbitrary name — for corrupt + non-conforming fixtures.
  function writeRaw(name: string, body: string, mtimeMs?: number): void {
    mkdirSync(root, { recursive: true });
    const p = join(root, name);
    writeFileSync(p, body);
    if (mtimeMs !== undefined) utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  }

  const files = () => readdirSync(root).sort();

  it("prune-by-age removes entries older than maxAgeHours and keeps fresher ones", () => {
    writeEntry("old", T0); // 50h old at nowMs
    const fresh = writeEntry("fresh", T0 + 48 * HOUR); // 2h old
    const r = pruneCache({
      root,
      nowMs: T0 + 50 * HOUR,
      maxAgeHours: 48,
      maxEntries: 1000,
    });
    expect(r.removedAge).toBe(1);
    expect(files()).toEqual([fresh]);
    expect(r.remaining).toBe(1);
  });

  it("age prune brackets the get-TTL boundary — exactly-at is reclaimed, one ms under survives", () => {
    writeEntry("edge", T0); // exactly maxAgeHours old at nowMs
    expect(
      pruneCache({ root, nowMs: T0 + 48 * HOUR, maxAgeHours: 48 }).removedAge,
    ).toBe(1);
    expect(files()).toEqual([]);
    // One ms before the boundary the entry is still fresh and must survive,
    // mirroring getEntry's `<`-not-`<=` exact-edge contract.
    const justUnder = writeEntry("just-under", T0);
    const r = pruneCache({ root, nowMs: T0 + 48 * HOUR - 1, maxAgeHours: 48 });
    expect(r.removedAge).toBe(0);
    expect(files()).toEqual([justUnder]);
  });

  it("prune-by-count evicts the oldest-by-createdAt first down to maxEntries", () => {
    writeEntry("a", T0 + 0 * HOUR);
    writeEntry("b", T0 + 1 * HOUR);
    const c = writeEntry("c", T0 + 2 * HOUR);
    const d = writeEntry("d", T0 + 3 * HOUR);
    const r = pruneCache({
      root,
      nowMs: T0 + 4 * HOUR,
      maxEntries: 2,
      maxAgeHours: 1000,
    });
    expect(r.removedCount).toBe(2);
    expect(r.removedAge).toBe(0);
    // The two oldest (a, b) are evicted; the two newest survive.
    expect(files()).toEqual([c, d].sort());
    expect(r.remaining).toBe(2);
  });

  it("no-op when under both limits — nothing removed, file set unchanged", () => {
    writeEntry("a", T0 + 1 * HOUR);
    writeEntry("b", T0 + 2 * HOUR);
    const before = files();
    const r = pruneCache({
      root,
      nowMs: T0 + 3 * HOUR,
      maxEntries: 100,
      maxAgeHours: 100,
    });
    expect(r).toMatchObject({
      removedTmp: 0,
      removedCorrupt: 0,
      removedAge: 0,
      removedCount: 0,
      remaining: 2,
    });
    expect(files()).toEqual(before);
  });

  it("orphan-tmp cleanup removes tmp files past the grace window, keeps fresh ones", () => {
    writeTmp("stale", 123, T0); // 2h old at nowMs
    const freshTmp = writeTmp("fresh", 456, T0 + 90 * 60_000); // 30min old
    const r = pruneCache({
      root,
      nowMs: T0 + 2 * HOUR,
      tmpMaxAgeHours: 1,
    });
    expect(r.removedTmp).toBe(1);
    expect(files()).toEqual([freshTmp]);
  });

  it("corrupt-entry tolerance — malformed/missing-timestamp/non-string-synthesis entries are removed without throwing; valid entries obey age/count", () => {
    const valid = writeEntry("valid", T0 + 3 * HOUR);
    writeEntry("missing-ts", undefined); // no createdAt
    // Valid createdAt but a non-string synthesis: getEntry treats this as a
    // permanent miss, so the sweep must reclaim it too (mirrors the get check).
    writeEntry("bad-synthesis", T0 + 3 * HOUR, { synthesis: 42 });
    writeRaw(cacheKey("garbage") + ".json", "not json {{{");
    let r!: ReturnType<typeof pruneCache>;
    expect(() => {
      r = pruneCache({
        root,
        nowMs: T0 + 4 * HOUR,
        maxEntries: 100,
        maxAgeHours: 100,
      });
    }).not.toThrow();
    expect(r.removedCorrupt).toBe(3);
    expect(files()).toEqual([valid]);
    expect(r.remaining).toBe(1);
  });

  it("only touches the helper's own <sha256hex> name shape — unrelated files are left alone", () => {
    const keep = writeEntry("keep-me", T0); // fresh, valid, conforming
    const orphan = writeTmp("real-orphan", 9, T0); // conforming, 50h old
    writeRaw("notes.json", "not json {{{"); // unrelated .json (not 64-hex)
    writeRaw("README.txt", "hello"); // unrelated, not .json/.tmp
    writeRaw("scratch.tmp", "x", T0); // unrelated .tmp (not the helper's shape)
    const r = pruneCache({
      root,
      nowMs: T0 + 50 * HOUR,
      maxAgeHours: 1000,
      tmpMaxAgeHours: 1,
    });
    // Only the conforming orphan tmp is reaped; the unrelated files survive and
    // are never counted as corrupt.
    expect(r.removedCorrupt).toBe(0);
    expect(r.removedTmp).toBe(1);
    expect(r.removedAge).toBe(0);
    expect(files()).toEqual(
      ["README.txt", "notes.json", "scratch.tmp", keep].sort(),
    );
    expect(files()).not.toContain(orphan);
  });

  it("dry-run reports would-remove counts but mutates nothing", () => {
    writeEntry("a", T0 + 0 * HOUR);
    writeEntry("b", T0 + 1 * HOUR);
    writeEntry("c", T0 + 2 * HOUR);
    writeTmp("orphan", 9, T0);
    const before = files();
    const r = pruneCache({
      root,
      nowMs: T0 + 3 * HOUR,
      maxEntries: 1,
      maxAgeHours: 1000,
      tmpMaxAgeHours: 1,
      dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    expect(r.removedCount).toBe(2); // a, b would be evicted
    expect(r.removedTmp).toBe(1); // orphan would be removed
    expect(files()).toEqual(before); // ...but nothing actually changed
  });

  it("never throws on a missing cache dir — returns an all-zero result", () => {
    const gone = join(root, "does-not-exist");
    let r!: ReturnType<typeof pruneCache>;
    expect(() => {
      r = pruneCache({ root: gone });
    }).not.toThrow();
    expect(r).toMatchObject({
      removedTmp: 0,
      removedCorrupt: 0,
      removedAge: 0,
      removedCount: 0,
      remaining: 0,
    });
  });
});

describe("on-put sweep (opt-in)", () => {
  const T0 = 1_700_000_000_000;

  // Conforming `<sha256hex>.json` seed so the sweep recognises it as an entry.
  function seedEntry(seed: string, createdAt: number): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, cacheKey(seed) + ".json"),
      JSON.stringify({ createdAt, synthesis: seed }),
    );
  }

  it("fires when FLOW_RESEARCH_CACHE_SWEEP_ON_PUT is truthy and bounds the cache to maxEntries", () => {
    seedEntry("old-a", T0);
    seedEntry("old-b", T0 + 1 * HOUR);
    const q = "the freshly put question";
    putEntry(q, "new-body", {
      root,
      nowMs: T0 + 5 * HOUR,
      env: {
        FLOW_RESEARCH_CACHE_SWEEP_ON_PUT: "1",
        FLOW_RESEARCH_CACHE_MAX_ENTRIES: "1",
      } as NodeJS.ProcessEnv,
    });
    // The just-put entry is newest, so it survives the oldest-first eviction.
    expect(readdirSync(root)).toHaveLength(1);
    expect(getEntry(q, { root, nowMs: T0 + 5 * HOUR })).toEqual({
      hit: true,
      synthesis: "new-body",
    });
  });

  it("does not sweep by default (env unset) — pre-existing entries are left untouched", () => {
    seedEntry("old-a", T0);
    seedEntry("old-b", T0 + 1 * HOUR);
    const q = "the un-swept question";
    putEntry(q, "new-body", {
      root,
      nowMs: T0 + 5 * HOUR,
      env: { FLOW_RESEARCH_CACHE_MAX_ENTRIES: "1" } as NodeJS.ProcessEnv,
    });
    // No sweep: all three entries (2 seeded + 1 new) remain.
    expect(readdirSync(root)).toHaveLength(3);
  });

  it("is best-effort — a put still succeeds (and the new entry is readable) with the sweep enabled alongside a corrupt entry", () => {
    mkdirSync(root, { recursive: true });
    // A conforming-but-corrupt sibling entry, so the sweep recognises and
    // reaps it — proving the sweep ran without failing the put.
    writeFileSync(join(root, cacheKey("corrupt") + ".json"), "not json {{{");
    const q = "best-effort question";
    expect(() =>
      putEntry(q, "survives", {
        root,
        nowMs: T0 + 5 * HOUR,
        env: {
          FLOW_RESEARCH_CACHE_SWEEP_ON_PUT: "true",
        } as NodeJS.ProcessEnv,
      }),
    ).not.toThrow();
    // The put's own entry survives; the corrupt sibling was swept.
    expect(getEntry(q, { root, nowMs: T0 + 5 * HOUR })).toEqual({
      hit: true,
      synthesis: "survives",
    });
    expect(readdirSync(root)).toEqual([cacheKey(q) + ".json"]);
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

  describe("prune subcommand", () => {
    it("prune --dry-run exits 0 and removes nothing", () => {
      expect(cli(["put", "--question", "q1", "--synthesis", "a"]).status).toBe(
        0,
      );
      expect(cli(["put", "--question", "q2", "--synthesis", "b"]).status).toBe(
        0,
      );
      const dry = cli(["prune", "--max-entries", "1", "--dry-run"]);
      expect(dry.status).toBe(0);
      expect(readdirSync(root)).toHaveLength(2); // nothing removed
    });

    it("prune --max-entries actually evicts down to the cap and exits 0", () => {
      expect(cli(["put", "--question", "q1", "--synthesis", "a"]).status).toBe(
        0,
      );
      expect(cli(["put", "--question", "q2", "--synthesis", "b"]).status).toBe(
        0,
      );
      const prune = cli(["prune", "--max-entries", "1"]);
      expect(prune.status).toBe(0);
      expect(readdirSync(root)).toHaveLength(1);
    });

    it("prune on an empty/uncreated cache dir exits 0 (best-effort)", () => {
      // FLOW_RESEARCH_CACHE_DIR points at a fresh mkdtemp dir with no entries.
      expect(cli(["prune"]).status).toBe(0);
    });

    it("FLOW_RESEARCH_CACHE_MAX_ENTRIES env bounds the count when no flag is given (env path)", () => {
      expect(cli(["put", "--question", "q1", "--synthesis", "a"]).status).toBe(
        0,
      );
      expect(cli(["put", "--question", "q2", "--synthesis", "b"]).status).toBe(
        0,
      );
      // No --max-entries flag → runPrune resolves the cap from process.env.
      const prune = cli(["prune"], undefined, {
        FLOW_RESEARCH_CACHE_MAX_ENTRIES: "1",
      });
      expect(prune.status).toBe(0);
      expect(readdirSync(root)).toHaveLength(1);
    });

    it("--max-entries flag wins over the env override (flag > env)", () => {
      expect(cli(["put", "--question", "q1", "--synthesis", "a"]).status).toBe(
        0,
      );
      expect(cli(["put", "--question", "q2", "--synthesis", "b"]).status).toBe(
        0,
      );
      // env says cap 1, flag says cap 5 → flag wins → nothing removed.
      const prune = cli(["prune", "--max-entries", "5"], undefined, {
        FLOW_RESEARCH_CACHE_MAX_ENTRIES: "1",
      });
      expect(prune.status).toBe(0);
      expect(readdirSync(root)).toHaveLength(2);
    });
  });
});
