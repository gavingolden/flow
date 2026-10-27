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
});
