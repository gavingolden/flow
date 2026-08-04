import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The one end-to-end proof that the two halves of the flow-spawn adoption
 * actually compose: bin/flow-pre-commit.test.ts's `registryArgv` describe
 * block injects the `hasFlowSpawn` seam and asserts only the argv SHAPE
 * `registryArgv` would produce — it never launches a real `flow-spawn`.
 * bin/flow-spawn.live.test.ts proves the wrapper itself works end-to-end,
 * but never through `flow-pre-commit`. This file is the only one that runs
 * the real `bin/flow-pre-commit.ts` against the real `bin/flow-spawn.ts` and
 * checks that a parseable registry row lands on disk.
 *
 * Real process launches + a real registry file on disk are POSIX
 * assumptions (an executable shim script, `ps`-shaped process semantics) —
 * same guard as bin/flow-spawn.live.test.ts.
 */
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

type LiveRow = {
  pid: number;
  pgid: number;
  slug: string;
  class: string;
  argv: string[];
  recordedAt: number;
  sessionPid: number | null;
  sessionStartEpoch: number | null;
};

/**
 * Bounded retry (<=5 attempts, ~100ms apart), NOT a single read.
 * `appendRow` is a synchronous `appendFileSync` and `flow-pre-commit` drives
 * every check via `Bun.spawnSync`, so by the time our own OUTER `spawnSync`
 * call below returns, the row is normally already on disk — but a
 * single-read assertion would let any future async-ness anywhere in that
 * chain flake this suite, and this suite gates every commit in the repo.
 */
async function readRegistryRows(
  jsonlPath: string,
  attempts = 5,
  intervalMs = 100,
): Promise<LiveRow[]> {
  for (let i = 0; i < attempts; i++) {
    if (fs.existsSync(jsonlPath)) {
      const text = fs.readFileSync(jsonlPath, "utf8").trim();
      if (text.length > 0) {
        return text.split("\n").map((line) => JSON.parse(line) as LiveRow);
      }
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return [];
}

describeOnPosix(
  "flow-pre-commit (live, composed with the real flow-spawn)",
  () => {
    const VALID_SLUG = "flow-pre-commit-live-test";
    let home: string;
    let shimDir: string;
    let fixtureDir: string;
    // Torn down unconditionally in afterEach, mirroring
    // bin/flow-spawn.live.test.ts's own defensive discipline — never assert
    // via a host-global `pgrep -f`, only ever kill a SPECIFIC pid/pgid this
    // test itself recorded. In practice this stays empty: every launch below
    // goes through a synchronous `spawnSync` chain (test -> flow-pre-commit
    // -> flow-spawn -> child), so the whole chain has already exited by the
    // time this test's assertions run — but the mechanism is borrowed as
    // written, not reasoned away, so a future async change here doesn't
    // silently reopen a leak.
    let cleanupPgids: number[];
    let cleanupPids: number[];

    beforeEach(() => {
      cleanupPgids = [];
      cleanupPids = [];
      if (!bunOnPath) return;

      home = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-pre-commit-live-home-"),
      );

      // `flow-pre-commit`'s registry-aware runner shells out to the BARE
      // name "flow-spawn" (resolved via PATH, exactly as it is after a real
      // `flow install`) — a shim keeps this suite independent of whether
      // flow is actually installed on the host running it.
      shimDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-pre-commit-live-shim-"),
      );
      const shimPath = path.join(shimDir, "flow-spawn");
      fs.writeFileSync(
        shimPath,
        `#!/bin/sh\nexec bun "${path.join(repoRoot, "bin", "flow-spawn.ts")}" "$@"\n`,
      );
      fs.chmodSync(shimPath, 0o755);

      // Git-init-tmpdir fixture, same shape as the existing integration
      // blocks in bin/flow-pre-commit.test.ts (e.g. the ".md-only diff"
      // block): package.json declares a fast no-op `test` script so
      // filterDefinedChecks keeps exactly one check (`npm run test`) and the
      // spawn stays deterministic regardless of host environment — this
      // drives that ONE cheap, always-present check, never the repo's own
      // real `npm run test` (which would recursively spawn this very vitest
      // suite).
      fixtureDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-pre-commit-live-fixture-"),
      );
      fs.writeFileSync(
        path.join(fixtureDir, "package.json"),
        JSON.stringify(
          { name: "fixture", version: "0.0.1", scripts: { test: "true" } },
          null,
          2,
        ),
      );
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: fixtureDir });
      spawnSync(
        "git",
        [
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "--allow-empty",
          "-q",
          "-m",
          "init",
        ],
        { cwd: fixtureDir },
      );
      // bin/ is the "scripts" scope's matcher prefix, so this diff detects
      // scope "scripts" -> [typecheck:scripts, test, lint], and
      // filterDefinedChecks drops the two scripts our fixture package.json
      // doesn't declare, leaving only `npm run test`.
      fs.mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
      const helperPath = path.join(fixtureDir, "bin", "x.ts");
      fs.writeFileSync(helperPath, "export const x = 1;\n");
      // Tracked executable: checkHelperExecutableModes gates every changed
      // bin/*.ts on its git mode, and a non-executable one would fail the
      // gate for an unrelated reason having nothing to do with this test.
      fs.chmodSync(helperPath, 0o755);
      spawnSync("git", ["add", "bin/x.ts"], { cwd: fixtureDir });
    });

    afterEach(() => {
      for (const pgid of cleanupPgids) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // already gone — fine
        }
      }
      for (const pid of cleanupPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone — fine
        }
      }
      if (home) fs.rmSync(home, { recursive: true, force: true });
      if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true });
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it.skipIf(!bunOnPath)(
      "drives a real check through the real flow-spawn wrapper and lands a class:default row on disk",
      async () => {
        const scriptPath = path.resolve(repoRoot, "bin", "flow-pre-commit.ts");
        const jsonlPath = path.join(
          home,
          ".flow",
          "state",
          "procs",
          `${VALID_SLUG}.jsonl`,
        );

        const result = spawnSync("bun", [scriptPath, "--json"], {
          cwd: fixtureDir,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            FLOW_SLUG: VALID_SLUG,
            PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          },
        });
        expect(result.status, result.stderr).toBe(0);

        const rows = await readRegistryRows(jsonlPath);
        expect(rows.length).toBeGreaterThan(0);

        const testRow = rows.find(
          (r) => r.argv[0] === "npm" && r.argv.includes("test"),
        );
        expect(testRow, JSON.stringify(rows)).toBeDefined();
        expect(testRow!.class).toBe("default");
        expect(testRow!.argv).toEqual(["npm", "run", "test"]);

        // Defensive-only: see the describe-level comment above on why this
        // is expected to stay empty in practice.
        cleanupPgids.push(testRow!.pgid);
      },
    );

    it.skipIf(!bunOnPath)(
      "creates no registry file at all when FLOW_SLUG is unset",
      () => {
        const scriptPath = path.resolve(repoRoot, "bin", "flow-pre-commit.ts");
        const procsDir = path.join(home, ".flow", "state", "procs");

        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete env.FLOW_SLUG;
        env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;

        const result = spawnSync("bun", [scriptPath, "--json"], {
          cwd: fixtureDir,
          encoding: "utf8",
          env,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(fs.existsSync(procsDir)).toBe(false);
      },
    );
  },
);
