import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { promoteEvidenceImages } from "./evidence-images";

const ROOT = "/w/repo";
const REL = ".flow-tmp/ui-evidence/review/9-strip.png";

const existing =
  (...files: string[]) =>
  (p: string) =>
    files.includes(p);

describe("promoteEvidenceImages", () => {
  it("promotes an existing relative path", () => {
    const out = promoteEvidenceImages(
      `Screenshots: ${REL}`,
      [],
      [ROOT],
      existing(`${ROOT}/${REL}`),
    );
    expect(out).toEqual([{ path: REL, alt: "9-strip.png" }]);
  });

  it("promotes an existing absolute worktree path", () => {
    const out = promoteEvidenceImages(
      `shot ${ROOT}/${REL} saved`,
      [],
      [ROOT],
      existing(`${ROOT}/${REL}`),
    );
    expect(out).toEqual([{ path: `${ROOT}/${REL}`, alt: "9-strip.png" }]);
  });

  it("emits an absolute path when the file lives under a secondary root", () => {
    const out = promoteEvidenceImages(
      REL,
      [],
      [ROOT, "/other"],
      existing(`/other/${REL}`),
    );
    expect(out).toEqual([{ path: `/other/${REL}`, alt: "9-strip.png" }]);
  });

  it("skips a file that does not exist", () => {
    expect(promoteEvidenceImages(REL, [], [ROOT], () => false)).toEqual([]);
  });

  it("does not duplicate an image already passed via --image", () => {
    const images = [{ path: `${ROOT}/${REL}`, alt: "mine" }];
    const out = promoteEvidenceImages(
      `${REL} and ${REL}`,
      images,
      [ROOT],
      existing(`${ROOT}/${REL}`),
    );
    expect(out).toEqual(images);
  });

  it("promotes a repeated mention once", () => {
    const out = promoteEvidenceImages(
      `${REL}\n${REL}`,
      [],
      [ROOT],
      existing(`${ROOT}/${REL}`),
    );
    expect(out).toHaveLength(1);
  });

  it("ignores non-image extensions and paths outside .flow-tmp/ui-evidence/", () => {
    const out = promoteEvidenceImages(
      ".flow-tmp/ui-evidence/log.txt docs/shot.png .flow-tmp/other/shot.png",
      [],
      [ROOT],
      () => true,
    );
    expect(out).toEqual([]);
  });

  it("ignores an absolute path outside every root", () => {
    const out = promoteEvidenceImages(
      `/elsewhere/${REL}`,
      [],
      [ROOT],
      () => true,
    );
    expect(out).toEqual([]);
  });

  it("returns images unchanged when there are no roots", () => {
    const images = [{ path: "a.png", alt: "a" }];
    expect(promoteEvidenceImages(REL, images, [], () => true)).toBe(images);
  });

  it("does not promote a relative path that escapes ui-evidence via ..", () => {
    const out = promoteEvidenceImages(
      ".flow-tmp/ui-evidence/../../x.png",
      [],
      [ROOT],
      () => true,
    );
    expect(out).toEqual([]);
  });

  it("does not promote an absolute path that escapes ui-evidence via ..", () => {
    const out = promoteEvidenceImages(
      `${ROOT}/.flow-tmp/ui-evidence/../../x.png`,
      [],
      [ROOT],
      () => true,
    );
    expect(out).toEqual([]);
  });

  it("scans a long unbroken token in linear time", () => {
    const t = Date.now();
    expect(
      promoteEvidenceImages("a".repeat(200_000), [], [ROOT], () => true),
    ).toEqual([]);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it.each([
    ["key=path", `shot=${REL}`],
    ["key:path", `shot:${REL}`],
    ["file://", `file://${ROOT}/${REL}`],
    ["comma list", `a.txt,${REL},b.txt`],
    ["semicolon list", `a.txt;${REL};b.txt`],
  ])("promotes a path in a %s form", (_name, text) => {
    const out = promoteEvidenceImages(
      text,
      [],
      [ROOT],
      existing(`${ROOT}/${REL}`),
    );
    expect(out).toHaveLength(1);
    expect(out[0].alt).toBe("9-strip.png");
  });

  it("canonicalizes symlinks: dedupes a real path against a symlinked root and rejects a symlink escape", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "evidence-link-"));
    try {
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      mkdirSync(path.join(real, ".flow-tmp", "ui-evidence"), {
        recursive: true,
      });
      symlinkSync(real, link);
      const shot = path.join(real, ".flow-tmp", "ui-evidence", "a.png");
      writeFileSync(shot, "x");
      const outside = path.join(base, "secret.png");
      writeFileSync(outside, "x");
      symlinkSync(
        outside,
        path.join(real, ".flow-tmp", "ui-evidence", "evil.png"),
      );
      const out = promoteEvidenceImages(
        `${shot} .flow-tmp/ui-evidence/evil.png`,
        [{ path: ".flow-tmp/ui-evidence/a.png", alt: "a" }],
        [link],
      );
      expect(out).toEqual([{ path: ".flow-tmp/ui-evidence/a.png", alt: "a" }]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
