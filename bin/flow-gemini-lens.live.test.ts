import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The one end-to-end proof that the Gemini cross-model lens actually returns
 * findings. Every other test in bin/flow-gemini-lens.test.ts injects the
 * `runDelegate` seam and asserts envelope SHAPE — none of them ever reaches
 * agy, which is exactly why the denied-tool-call regression this file guards
 * survived unnoticed across many real reviews: the unit suite was green the
 * whole time.
 *
 * A unit assertion on the built prompt is necessary but NOT sufficient. Only a
 * real agy call proves the model can satisfy the prompt with the tools
 * `--add-dir` pre-authorizes, without reaching for a shell command agy will
 * auto-deny.
 *
 * Gated on RUN_AGY=1 plus agy-on-PATH so a CI runner without agy (or a local
 * `npm run verify`) skips cleanly and spends no Google AI Ultra quota. The
 * gating shape mirrors bin/flow-pre-commit.live.test.ts's `bunOnPath` probe
 * (`it.skipIf`, not `describe.skipIf`).
 *
 * $HOME: vitest.setup.ts sandboxes HOME for the whole suite, so a spawned agy
 * would otherwise find no credentials and come back `agy-not-authenticated`.
 * The spawn below opts back into the real home via FLOW_TEST_REAL_HOME — the
 * seam vitest.setup.ts publishes for exactly this case.
 *
 * Real process launch + real network are POSIX assumptions, same guard as the
 * other bin/*.live.test.ts files.
 */
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const agyOnPath = spawnSync("sh", ["-c", "command -v agy"]).status === 0;
const liveEnabled = process.env.RUN_AGY === "1" && agyOnPath;

// A small but genuinely reviewable diff: a real bug (an off-by-one bound and a
// swallowed error) that any competent reviewer should have something to say
// about. Kept inline so the test needs no fixture checkout and no git state.
const SAMPLE_DIFF = `diff --git a/src/pager.ts b/src/pager.ts
--- a/src/pager.ts
+++ b/src/pager.ts
@@ -1,6 +1,18 @@
 export type Page<T> = { items: T[]; nextCursor: string | null };
+
+export async function fetchAllPages<T>(
+  fetchPage: (cursor: string | null) => Promise<Page<T>>,
+  maxPages = 10,
+): Promise<T[]> {
+  const out: T[] = [];
+  let cursor: string | null = null;
+  for (let i = 0; i <= maxPages; i++) {
+    try {
+      const page = await fetchPage(cursor);
+      out.push(...page.items);
+      cursor = page.nextCursor;
+      if (cursor === null) break;
+    } catch {}
+  }
+  return out;
+}
`;

type LensEnvelope = {
  ran: boolean;
  skipReason?: string;
  skipClass?: string;
  findingCount?: number;
  decodedVia?: string;
  degraded?: string;
  degradedReason?: string;
  deniedActions?: string[];
  stderrTail?: string;
};

describeOnPosix("flow-gemini-lens live (RUN_AGY=1)", () => {
  it.skipIf(!liveEnabled)(
    "returns ran:true with at least one schema-valid finding against a real diff",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-lens-live-"));
      const diffFile = path.join(tmp, "diff.patch");
      const outFile = path.join(tmp, "agent-output-gemini.json");
      const configFile = path.join(tmp, "config.json");
      fs.writeFileSync(diffFile, SAMPLE_DIFF);
      // Pin the gate on rather than depending on the user's real config, so the
      // test asserts the lens's behaviour and not the host's opt-in state.
      fs.writeFileSync(
        configFile,
        JSON.stringify({ review: { gemini: true } }),
      );

      const realHome = process.env.FLOW_TEST_REAL_HOME;
      expect(
        realHome,
        "vitest.setup.ts must publish FLOW_TEST_REAL_HOME for live tests",
      ).toBeTruthy();

      const res = spawnSync(
        "bun",
        [
          path.join(repoRoot, "bin", "flow-gemini-lens.ts"),
          "--worktree",
          repoRoot,
          "--diff-file",
          diffFile,
          "--out",
          outFile,
          "--config",
          configFile,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: realHome },
          // Generous: a real agentic agy run reads files before answering.
          timeout: 9 * 60 * 1000,
        },
      );

      const envelope = JSON.parse(res.stdout.trim()) as LensEnvelope;

      // Fail loudly rather than false-greening when agy is present but unusable
      // (logged out, quota exhausted). A skip here means the proof did not run,
      // which is exactly what this file exists to catch.
      expect(
        envelope.ran,
        `lens did not run: ${envelope.skipReason ?? "unknown"} (class ${
          envelope.skipClass ?? "none"
        }); denied=${JSON.stringify(envelope.deniedActions ?? [])}; stderr=${
          envelope.stderrTail ?? ""
        }`,
      ).toBe(true);

      expect(envelope.findingCount ?? 0).toBeGreaterThanOrEqual(1);
      expect(envelope.decodedVia).toBeTruthy();

      const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
      expect(Array.isArray(parsed.findings)).toBe(true);
      expect(Array.isArray(parsed.rejected_alternatives)).toBe(true);
      expect(Array.isArray(parsed.anti_patterns_found)).toBe(true);
      expect(parsed.findings.length).toBeGreaterThanOrEqual(1);

      // The fix's whole point: the primary --add-dir call succeeds, so the
      // diff-only fallback must NOT have been needed.
      expect(envelope.degraded).toBeUndefined();

      fs.rmSync(tmp, { recursive: true, force: true });
    },
    10 * 60 * 1000,
  );
});
