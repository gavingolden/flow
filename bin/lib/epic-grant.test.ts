import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  grantScopeForSlug,
  readGrant,
  removeGrant,
  writeGrant,
  type Grant,
} from "./epic-grant";
import { managerDir } from "./epic-manager-log";
import type { EpicManifest } from "./epic-manifest-schema";
import { writeState } from "./state";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "egrant-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const grant = (epic = "e1"): Grant => ({
  version: 1,
  epic,
  classes: ["plan"],
  grantedAt: "2026-10-26T00:00:00.000Z",
  grantedBy: "owner-cli",
});

const manifest: EpicManifest = {
  epicId: "e1",
  prompt: "p",
  createdAt: "2026-10-26T00:00:00.000Z",
  features: [{ id: "f1", title: "t", description: "d", dependsOn: [] }],
};

function seedState(slug: string, epic?: { slug: string; featureId: string }) {
  writeState(
    {
      slug,
      phase: "planning",
      repo: "/r",
      worktree: "/w",
      updatedAt: "2026-10-26T00:00:00.000Z",
      ...(epic ? { epic } : {}),
    },
    dir,
  );
}
const load = () => manifest;

describe("grant store", () => {
  it("reads null when absent and round-trips a written grant without model/effort", () => {
    expect(readGrant("e1", dir)).toBeNull();
    writeGrant(grant(), dir);
    expect(readGrant("e1", dir)).toEqual(grant());
    const raw = JSON.parse(
      fs.readFileSync(path.join(managerDir("e1", dir), "grant.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("model");
    expect(raw).not.toHaveProperty("effort");
  });

  it("reads an invalid shape or another epic's file as null", () => {
    fs.mkdirSync(managerDir("e1", dir), { recursive: true });
    const p = path.join(managerDir("e1", dir), "grant.json");
    fs.writeFileSync(p, "{not json");
    expect(readGrant("e1", dir)).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ ...grant(), grantedBy: "agent" }));
    expect(readGrant("e1", dir)).toBeNull();
    fs.writeFileSync(p, JSON.stringify(grant("other")));
    expect(readGrant("e1", dir)).toBeNull();
  });

  it("removeGrant reports whether a file was removed", () => {
    expect(removeGrant("e1", dir)).toBe(false);
    writeGrant(grant(), dir);
    expect(removeGrant("e1", dir)).toBe(true);
    expect(readGrant("e1", dir)).toBeNull();
  });
});

describe("grantScopeForSlug", () => {
  it("state-missing for an unknown slug", () => {
    expect(
      grantScopeForSlug("nope", { stateDir: dir, loadManifest: load }),
    ).toEqual({
      granted: false,
      reason: "state-missing",
    });
  });

  it("not-epic for a non-epic slug", () => {
    seedState("solo");
    writeGrant(grant(), dir);
    expect(
      grantScopeForSlug("solo", { stateDir: dir, loadManifest: load }),
    ).toEqual({
      granted: false,
      reason: "not-epic",
    });
  });

  it("no-grant when the epic has no grant", () => {
    seedState("a", { slug: "e1", featureId: "f1" });
    expect(
      grantScopeForSlug("a", { stateDir: dir, loadManifest: load }),
    ).toEqual({
      granted: false,
      reason: "no-grant",
    });
  });

  it("other-epic when the slug belongs to a different epic than expected", () => {
    seedState("a", { slug: "e2", featureId: "f1" });
    writeGrant(grant("e1"), dir);
    writeGrant(grant("e2"), dir);
    expect(
      grantScopeForSlug("a", {
        stateDir: dir,
        expectedEpic: "e1",
        loadManifest: load,
      }),
    ).toEqual({ granted: false, reason: "other-epic" });
  });

  it("unknown-feature when the manifest lacks the id or cannot load", () => {
    seedState("a", { slug: "e1", featureId: "f9" });
    writeGrant(grant(), dir);
    expect(
      grantScopeForSlug("a", { stateDir: dir, loadManifest: load }),
    ).toEqual({
      granted: false,
      reason: "unknown-feature",
    });
    expect(
      grantScopeForSlug("a", { stateDir: dir, loadManifest: () => null }),
    ).toEqual({
      granted: false,
      reason: "unknown-feature",
    });
  });

  it("granted for a member feature of a granted epic", () => {
    seedState("a", { slug: "e1", featureId: "f1" });
    writeGrant(grant(), dir);
    expect(
      grantScopeForSlug("a", {
        stateDir: dir,
        expectedEpic: "e1",
        loadManifest: load,
      }),
    ).toEqual({ granted: true, epic: "e1", featureId: "f1" });
  });
});
