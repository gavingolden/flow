#!/usr/bin/env bun
/**
 * Maintainer-only headless eval harness entry point. Every real
 * dependency (filesystem, git, child-process, session id) lives in
 * `bin/lib/eval-cli.ts`'s default `Deps`; this file only adds a SIGINT
 * handler so an interrupted `run` tears down in-flight fixtures rather
 * than leaking `~/.flow/state/eval-*` rows and tmp directories, then
 * delegates to `main`.
 *
 * Deliberately NOT symlinked onto PATH by `flow install` — see the
 * `MAINTAINER_ONLY` set in `bin/lib/sources.ts`. Run it from a flow
 * checkout:
 *   bun bin/flow-eval.ts run --suite <id> --out .flow-tmp/eval
 */

import { activeFixtureTeardowns, main } from "./lib/eval-cli";

// Shared by the SIGINT handler below and the `main()` rejection path: a
// pooled job throwing mid-run (concurrency > 1) rejects `runPool`'s
// `Promise.all` without cancelling its still-running siblings, so any
// fixture/child they materialized needs the same best-effort sweep an
// interrupt gets — otherwise it leaks `~/.flow/state/eval-*` rows and tmp
// directories until the next `flow reap`.
function sweepActiveFixtures(): void {
  for (const teardown of [...activeFixtureTeardowns]) {
    activeFixtureTeardowns.delete(teardown);
    try {
      teardown();
    } catch {
      // best-effort — never block process exit on a failed teardown
    }
  }
}

if (import.meta.main) {
  process.on("SIGINT", () => {
    sweepActiveFixtures();
    process.exit(130);
  });

  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      sweepActiveFixtures();
      process.stderr.write(
        `flow-eval: uncaught error: ${err instanceof Error ? err.stack : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
