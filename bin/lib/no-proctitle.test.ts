import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PRELOAD = fileURLToPath(new URL("./no-proctitle.cjs", import.meta.url));
const MARKER = "process[Symbol.for('flow.noProctitle')]";
const darwin = process.platform === "darwin";

function runNode(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, args, { encoding: "utf8", env });
}

describe("no-proctitle preload", () => {
  it("should keep process.title assignments readable when preloaded", () => {
    const r = runNode([
      "--require",
      PRELOAD,
      "-e",
      "process.title='x'; process.exit(process.title==='x'?0:1)",
    ]);
    expect(r.status, r.stderr).toBe(0);
  });

  it("should tolerate being required twice", () => {
    const r = runNode([
      "--require",
      PRELOAD,
      "--require",
      PRELOAD,
      "-e",
      "process.title='x'; process.exit(process.title==='x'?0:1)",
    ]);
    expect(r.status, r.stderr).toBe(0);
  });

  it("should set the marker only on darwin when preloaded", () => {
    const r = runNode([
      "--require",
      PRELOAD,
      "-e",
      `console.log(JSON.stringify(${MARKER} ?? null))`,
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(darwin ? true : null);
  });

  it("should have the marker in the vitest worker when on darwin", () => {
    expect(
      (process as unknown as Record<symbol, unknown>)[
        Symbol.for("flow.noProctitle")
      ],
    ).toBe(darwin ? true : undefined);
  });

  it("should propagate the marker to nested children via NODE_OPTIONS when on darwin", () => {
    const r = runNode(
      ["-e", `console.log(JSON.stringify(${MARKER} ?? null))`],
      process.env,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(darwin ? true : null);
  });

  // Off darwin the value depends only on the caller's env, so there is nothing to assert.
  it.runIf(darwin)(
    "should define the libuv opt-out in the worker when on darwin",
    () => {
      expect(process.env.UV_PROCESS_TITLE_USE_LAUNCH_SERVICES).toBeDefined();
    },
  );
});
