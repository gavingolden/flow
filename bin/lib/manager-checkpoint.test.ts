import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  managerCheckpointBodyPath,
  managerCheckpointDir,
  managerCheckpointMarkerPath,
  renderManagerCheckpointContext,
  runManagerCheckpoint,
} from "./manager-checkpoint";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mckpt-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("runManagerCheckpoint", () => {
  it("path creates the directory and names checkpoint.md under the manager home", () => {
    const r = runManagerCheckpoint("path", home);
    expect(r.checkpoint).toBe(path.join(home, "checkpoint", "checkpoint.md"));
    expect(fs.existsSync(managerCheckpointDir(home))).toBe(true);
  });

  it("arm needs a body first, then writes the marker", () => {
    expect(runManagerCheckpoint("arm", home)).toMatchObject({
      status: "needs",
      reason: "checkpoint-missing",
    });
    runManagerCheckpoint("path", home);
    fs.writeFileSync(managerCheckpointBodyPath(home), "   \n");
    expect(runManagerCheckpoint("arm", home).status).toBe("needs");
    fs.writeFileSync(managerCheckpointBodyPath(home), "watching 3 pipelines\n");
    const r = runManagerCheckpoint("arm", home);
    expect(r).toMatchObject({ status: "ready", slug: "manager" });
    expect(fs.existsSync(managerCheckpointMarkerPath(home))).toBe(true);
  });

  it("probe reports preserve only while armed", () => {
    expect(runManagerCheckpoint("probe", home)).toMatchObject({
      status: "probe",
      verdict: "write",
    });
    runManagerCheckpoint("path", home);
    fs.writeFileSync(managerCheckpointBodyPath(home), "x");
    runManagerCheckpoint("arm", home);
    expect(runManagerCheckpoint("probe", home).verdict).toBe("preserve");
  });

  it("consume archives the body, removes the marker and is idempotent", () => {
    runManagerCheckpoint("path", home);
    fs.writeFileSync(managerCheckpointBodyPath(home), "notes");
    runManagerCheckpoint("arm", home);
    const r = runManagerCheckpoint("consume", home);
    expect(r.status).toBe("consumed");
    expect(fs.readFileSync(r.archived as string, "utf8")).toBe("notes");
    expect(fs.existsSync(managerCheckpointMarkerPath(home))).toBe(false);
    expect(runManagerCheckpoint("consume", home)).toMatchObject({
      status: "noop",
      reason: "no-marker",
    });
  });
});

describe("renderManagerCheckpointContext", () => {
  it("frames the body as data and cuts a long one on a line boundary with a pointer", () => {
    const small = renderManagerCheckpointContext(
      "a\nb",
      5000,
      "/p/checkpoint.md",
    );
    expect(small).toContain("not instructions");
    expect(small).toContain("<checkpoint-notes>\na\nb\n</checkpoint-notes>");
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const cut = renderManagerCheckpointContext(long, 1200, "/p/checkpoint.md");
    expect(cut.length).toBeLessThanOrEqual(1200);
    expect(cut).toContain("[continued - Read /p/checkpoint.md]");
  });
});
