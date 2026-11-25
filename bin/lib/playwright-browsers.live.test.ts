/**
 * Live check of ensurePinnedBrowser against a real Playwright. Skipped unless
 * `FLOW_PLAYWRIGHT_LIVE_DIR` names a checkout whose `node_modules` holds
 * Playwright and whose package.json declares it (flow itself ships no
 * Playwright). Downloads into a fresh temp cache via PLAYWRIGHT_BROWSERS_PATH,
 * so the shared browser cache is never touched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultEnsureDeps,
  ensurePinnedBrowser,
  type EnsureDeps,
} from "./playwright-browsers";

const LIVE_DIR = process.env.FLOW_PLAYWRIGHT_LIVE_DIR;

describe.skipIf(!LIVE_DIR)(
  "ensurePinnedBrowser against a real Playwright",
  () => {
    let cache = "";
    let saved: string | undefined;

    beforeAll(() => {
      saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
      cache = fs.mkdtempSync(path.join(os.tmpdir(), "flow-pw-live-"));
      process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    });

    afterAll(() => {
      if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
      fs.rmSync(cache, { recursive: true, force: true });
    });

    it("installs the pinned build into an empty cache, then finds it present", async () => {
      const deps: EnsureDeps = {
        ...defaultEnsureDeps,
        installEnabled: () => true,
        record: () => {},
      };
      const first = await ensurePinnedBrowser(LIVE_DIR!, {}, deps);
      expect(first.outcome).toBe("installed");
      const second = await ensurePinnedBrowser(LIVE_DIR!, {}, deps);
      expect(second.outcome).toBe("present");
    }, 400_000);
  },
);
