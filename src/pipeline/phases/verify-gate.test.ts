import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VERIFY_TIMEOUT_MS,
  runVerifyGate,
  runVerifyGateWithTimeout,
} from "./verify-gate.js";

const DIAGNOSTIC = (cwd: string) =>
  `.flow/verify is missing or not executable in ${cwd}; create an executable script that runs this repository's required pre-PR validation checks`;

async function makeTmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "flow-verify-gate-"));
}

async function writeScript(
  dir: string,
  body: string,
  { executable }: { executable: boolean },
): Promise<string> {
  const flowDir = path.join(dir, ".flow");
  await fs.mkdir(flowDir, { recursive: true });
  const scriptPath = path.join(flowDir, "verify");
  await fs.writeFile(scriptPath, body, "utf8");
  await fs.chmod(scriptPath, executable ? 0o755 : 0o644);
  return scriptPath;
}

describe("runVerifyGate — .flow/verify contract", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTmpdir();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns the generic diagnostic when .flow/verify is missing", async () => {
    const result = await runVerifyGate(tmp);
    expect(result.ok).toBe(false);
    expect(result.output).toBe(DIAGNOSTIC(tmp));
  });

  it("returns the same diagnostic when .flow/verify exists but is not executable", async () => {
    await writeScript(tmp, "#!/bin/sh\nexit 0\n", { executable: false });
    const result = await runVerifyGate(tmp);
    expect(result.ok).toBe(false);
    expect(result.output).toBe(DIAGNOSTIC(tmp));
  });

  it("diagnostic contains no tool-specific terms", async () => {
    const result = await runVerifyGate(tmp);
    expect(result.output).not.toMatch(/npm|package\.json|node\b/i);
  });

  it("returns ok:true when an executable .flow/verify exits 0", async () => {
    await writeScript(tmp, "#!/bin/sh\necho verify-ok\nexit 0\n", {
      executable: true,
    });
    const result = await runVerifyGate(tmp);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("verify-ok");
  });

  it("returns ok:false with stderr captured when .flow/verify exits non-zero", async () => {
    await writeScript(
      tmp,
      "#!/bin/sh\necho verify-bad 1>&2\nexit 1\n",
      { executable: true },
    );
    const result = await runVerifyGate(tmp);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("verify-bad");
  });

  it("converts an execa timeout into { ok: false } rather than throwing", async () => {
    await writeScript(tmp, "#!/bin/sh\nsleep 5\n", { executable: true });
    const result = await runVerifyGateWithTimeout(tmp, 50);
    expect(result.ok).toBe(false);
    expect(typeof result.output).toBe("string");
  });

  it("converts spawn failure (bad shebang) into { ok: false } rather than throwing", async () => {
    await writeScript(
      tmp,
      "#!/no/such/interpreter\necho should-not-run\n",
      { executable: true },
    );
    const result = await runVerifyGate(tmp);
    // Bad shebang surfaces either as a spawn throw (caught) or a non-zero
    // exit (no throw). Either way, the gate must not propagate an exception
    // and must return ok:false. The exact output text is platform-dependent
    // and not part of the contract.
    expect(result.ok).toBe(false);
    expect(typeof result.output).toBe("string");
  });

  it("VERIFY_TIMEOUT_MS is 10 minutes", () => {
    expect(VERIFY_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });
});
