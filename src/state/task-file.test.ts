import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setNotifierForTests,
  appendToBodySection,
  readTask,
  readTaskSync,
  transitionStatus,
  transitionStatusSync,
  writeTask,
  writeTaskSync,
  type Task,
} from "./task-file.js";
import type { Notifier, NotifyArgs } from "../util/notify.js";

async function makeTask(tmp: string): Promise<Task> {
  const taskPath = path.join(tmp, "task.md");
  const t: Task = {
    path: taskPath,
    frontmatter: {
      id: "2026-04-29-x",
      status: "triaged",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
      target_repo: tmp,
      worktree: null,
      branch: null,
      pr: null,
      manual_validation: null,
      merge_commit: null,
    },
    body: ["## User prompt", "", "test", "", "## Phase log", "", "## Phase outputs", ""].join("\n"),
  };
  await writeTask(t);
  return readTask(taskPath);
}

describe("writeTaskSync", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tf-sync-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("round-trips byte-equal with the async writer", async () => {
    // Both writers go through the same `formatTask` so a divergence here
    // would mean the sync exit-handler reaper produces files the async
    // `readTask` can't parse — the silent stuck case the PR is meant to
    // prevent.
    const t = await makeTask(tmp);
    t.frontmatter.status = "needs-human";
    writeTaskSync(t);
    const reread = await readTask(t.path);
    expect(reread.frontmatter.status).toBe("needs-human");
  });

  it("uses tmp+rename so a torn write can't leave a half-formed task file", async () => {
    // We can't easily inject an mid-write crash in a unit test, but we can
    // assert the contract: after a successful write, no .tmp sibling
    // remains. If renameSync ever degrades to a copy this would catch it.
    const t = await makeTask(tmp);
    writeTaskSync(t);
    const entries = await fs.readdir(tmp);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("readTaskSync", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tf-rsync-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("matches readTask byte-for-byte on frontmatter and body", async () => {
    const t = await makeTask(tmp);
    const sync = readTaskSync(t.path);
    expect(sync.frontmatter).toEqual(t.frontmatter);
    expect(sync.body).toEqual(t.body);
  });
});

describe("transitionStatus — notifier dispatch", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tf-notify-"));
  });
  afterEach(async () => {
    __setNotifierForTests(null);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function recordingNotifier(): { notifier: Notifier; calls: NotifyArgs[] } {
    const calls: NotifyArgs[] = [];
    return {
      calls,
      notifier: {
        async notify(args) {
          calls.push(args);
        },
        notifySync(args) {
          calls.push(args);
        },
      },
    };
  }

  it("invokes the notifier on every transition (membership filter lives in the notifier)", async () => {
    const { notifier, calls } = recordingNotifier();
    __setNotifierForTests(notifier);
    const t = await makeTask(tmp);
    await transitionStatus(t, "planning");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("planning");
  });

  it("invokes the notifier with task ref, status, and reason on attention transitions", async () => {
    const { notifier, calls } = recordingNotifier();
    __setNotifierForTests(notifier);
    const t = await makeTask(tmp);
    await transitionStatus(t, "needs-human", "verify-exhausted");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toBe(t);
    expect(calls[0]?.status).toBe("needs-human");
    expect(calls[0]?.reason).toBe("verify-exhausted");
  });

  it("transition still succeeds when the notifier rejects", async () => {
    __setNotifierForTests({
      async notify() {
        throw new Error("boom");
      },
      notifySync() {},
    });
    const t = await makeTask(tmp);
    await expect(
      transitionStatus(t, "needs-human", "verify-exhausted"),
    ).resolves.toBeUndefined();
    expect(t.frontmatter.status).toBe("needs-human");
    const reread = await readTask(t.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).toContain("→ needs-human (verify-exhausted)");
  });

  it("same-status transition skips both write and notifier", async () => {
    const { notifier, calls } = recordingNotifier();
    __setNotifierForTests(notifier);
    const t = await makeTask(tmp);
    const before = t.frontmatter.updated;
    await transitionStatus(t, t.frontmatter.status);
    expect(calls).toHaveLength(0);
    expect(t.frontmatter.updated).toBe(before);
  });
});

describe("transitionStatusSync — notifier dispatch", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tf-notify-sync-"));
  });
  afterEach(async () => {
    __setNotifierForTests(null);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("calls notifySync (not notify) so the spawn happens before the exit handler returns", async () => {
    const asyncCalls: NotifyArgs[] = [];
    const syncCalls: NotifyArgs[] = [];
    __setNotifierForTests({
      async notify(args) {
        asyncCalls.push(args);
      },
      notifySync(args) {
        syncCalls.push(args);
      },
    });
    const t = await makeTask(tmp);
    transitionStatusSync(t, "needs-human", "signaled");
    // The sync path must dispatch via notifySync — observable
    // synchronously without awaiting any Promise. Using `notify`
    // (async) from inside Node's `'exit'` would silently drop the
    // spawn after the first await. This test pins the contract.
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]?.status).toBe("needs-human");
    expect(syncCalls[0]?.reason).toBe("signaled");
    expect(asyncCalls).toHaveLength(0);
  });

  it("swallows synchronous throws from notifySync; on-disk file is updated", async () => {
    const throwSpy = vi.fn(() => {
      throw new Error("sync-boom");
    });
    __setNotifierForTests({
      async notify() {},
      // Synchronous throw — must be caught by transitionStatusSync's
      // try/catch, never propagated past the disk write.
      notifySync: throwSpy as unknown as Notifier["notifySync"],
    });
    const t = await makeTask(tmp);
    expect(() =>
      transitionStatusSync(t, "needs-human", "signaled"),
    ).not.toThrow();
    expect(throwSpy).toHaveBeenCalledTimes(1);
    expect(t.frontmatter.status).toBe("needs-human");
    const reread = await readTask(t.path);
    expect(reread.frontmatter.status).toBe("needs-human");
  });

  it("__setNotifierForTests(null) resets so the next call re-resolves the default", async () => {
    const calls: NotifyArgs[] = [];
    __setNotifierForTests({
      async notify(args) {
        calls.push(args);
      },
      notifySync(args) {
        calls.push(args);
      },
    });
    const t = await makeTask(tmp);
    await transitionStatus(t, "planning");
    expect(calls).toHaveLength(1);
    __setNotifierForTests(null);
    // After reset, the lazy default (which is NoopNotifier in the test
    // env where FLOW_NOTIFY is unset) takes over — recording stops.
    await transitionStatus(t, "implementing");
    expect(calls).toHaveLength(1);
  });
});

describe("appendToBodySection — replacement-string special chars", () => {
  // Regression: PR 12 exposed `appendToBodySection` to user-supplied text
  // (the `flow revise` message). The internal `String.prototype.replace`
  // call previously used a string replacement, which expands `$&`, `$1`,
  // `$$`, `$\``, `$'`, `$<n>` patterns — corrupting `task.md` whenever a
  // revise message happened to include them. The replacer now uses a
  // function, so the `line` argument lands in the body verbatim.
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tf-append-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("appends a line containing $& to an existing section verbatim (no replacement-pattern expansion)", async () => {
    const t = await makeTask(tmp);
    // Append into an existing section so the bug path (the .replace call
    // that previously interpreted $&) is exercised.
    appendToBodySection(t, "## Phase log", "- 2026-04-30T00:00:00Z note: $& should stay literal");
    expect(t.body).toContain("note: $& should stay literal");
    // The matched block ("## Phase log\n\n…") must NOT have been spliced
    // back in via $& expansion.
    expect(t.body).not.toContain("note: ## Phase log");
  });

  it("appends a line containing $1, $$, and $` verbatim", async () => {
    const t = await makeTask(tmp);
    appendToBodySection(
      t,
      "## Phase log",
      "- 2026-04-30T00:00:00Z weird: $$ $1 $` $' tail",
    );
    expect(t.body).toContain("weird: $$ $1 $` $' tail");
  });

  it("creates a new section verbatim when the heading is missing (the line is concatenated, not replaced)", async () => {
    const t = await makeTask(tmp);
    // ## Revision notes is not in the base body; the missing-section
    // branch concatenates rather than calling .replace, so it is already
    // safe — pin that to keep both branches covered.
    appendToBodySection(t, "## Revision notes", "- ts: $& $$ $1 verbatim");
    expect(t.body).toContain("## Revision notes");
    expect(t.body).toContain("- ts: $& $$ $1 verbatim");
  });
});
