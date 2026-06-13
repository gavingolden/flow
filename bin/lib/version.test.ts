/**
 * Tests for `flow --version`. Stands up a fake flow source tree in tmpdir
 * and points runVersion at it via the flowSource override.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFlowVersion } from "./pkg-version";
import { runVersion, runVersionCli } from "./version";

let scratch!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-version-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function writePkg(contents: unknown): void {
  fs.writeFileSync(
    path.join(scratch, "package.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

describe("runVersion", () => {
  it("prints the version from package.json and returns 0", () => {
    writePkg({ name: "flow", version: "1.2.3" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runVersion({ flowSource: scratch });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith("1.2.3");
    log.mockRestore();
  });

  it("returns 1 with a stderr message when package.json is missing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runVersion({ flowSource: scratch });

    expect(code).toBe(1);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain("cannot read");
    err.mockRestore();
  });

  it("returns 1 when package.json is unparseable", () => {
    writePkg("{ not json");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runVersion({ flowSource: scratch });

    expect(code).toBe(1);
    expect(String(err.mock.calls[0][0])).toContain("cannot parse");
    err.mockRestore();
  });

  it("returns 1 when the version field is missing", () => {
    writePkg({ name: "flow" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runVersion({ flowSource: scratch });

    expect(code).toBe(1);
    expect(String(err.mock.calls[0][0])).toContain("no 'version' field");
    err.mockRestore();
  });
});

describe("runVersion — update notice seam", () => {
  it("should print the bare version string to stdout unchanged when an update notice is also emitted", () => {
    writePkg({ name: "flow", version: "1.2.3" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runVersion({
      flowSource: scratch,
      checkUpdate: () => ({
        status: "behind",
        behind: 2,
        upgradeCmd: "flow setup --upgrade",
      }),
    });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith("1.2.3");
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("2 commits behind");
    log.mockRestore();
    err.mockRestore();
  });

  it("should not emit a notice when checkUpdate reports current/skipped", () => {
    writePkg({ name: "flow", version: "1.2.3" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      runVersion({
        flowSource: scratch,
        checkUpdate: () => ({ status: "current" }),
      }),
    ).toBe(0);
    expect(
      runVersion({
        flowSource: scratch,
        checkUpdate: () => ({ status: "skipped", reason: "fetch-failed" }),
      }),
    ).toBe(0);

    expect(log).toHaveBeenCalledWith("1.2.3");
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});

describe("readFlowVersion (extracted, unit-testable)", () => {
  it("round-trips the version field from package.json", () => {
    writePkg({ name: "flow", version: "2.5.0" });
    expect(readFlowVersion(scratch)).toBe("2.5.0");
  });

  it("runVersion prints exactly what readFlowVersion returns", () => {
    writePkg({ name: "flow", version: "9.9.9" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = runVersion({ flowSource: scratch });
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(readFlowVersion(scratch));
    log.mockRestore();
  });

  it("throws (rather than printing) on a missing package.json", () => {
    expect(() => readFlowVersion(scratch)).toThrow(/cannot read/);
  });

  it("throws when the version field is absent", () => {
    writePkg({ name: "flow" });
    expect(() => readFlowVersion(scratch)).toThrow(/no 'version' field/);
  });
});

describe("runVersionCli (--help / -h short-circuit)", () => {
  // Point flowSource at a directory with no package.json. If the help check
  // regresses, runVersion would log a "cannot read" error and return 1.

  for (const flag of ["--help", "-h"]) {
    it(`exits 0 and prints help when args is ['${flag}'] (no package.json read)`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const code = runVersionCli([flag], { flowSource: scratch });
      expect(code).toBe(0);
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(
        /^flow version — print the installed/,
      );
      expect(err).not.toHaveBeenCalled();
      log.mockRestore();
      err.mockRestore();
    });
  }
});
