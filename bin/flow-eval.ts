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

process.on("SIGINT", () => {
  for (const teardown of [...activeFixtureTeardowns]) {
    activeFixtureTeardowns.delete(teardown);
    try {
      teardown();
    } catch {
      // best-effort — never block process exit on a failed teardown
    }
  }
  process.exit(130);
});

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
