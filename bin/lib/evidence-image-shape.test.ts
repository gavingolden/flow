import { describe, expect, it } from "vitest";

import {
  isPhoneLabelled,
  phoneShapeError,
  pngSize,
} from "./evidence-image-shape";

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

const err = (p: string, alt: string, head: Uint8Array | null) =>
  phoneShapeError({ path: p, alt }, () => head);

describe("pngSize", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(pngSize(png(390, 844))).toEqual({ width: 390, height: 844 });
  });

  it("returns null for non-PNG or truncated bytes", () => {
    expect(pngSize(new TextEncoder().encode("GIF89a".repeat(8)))).toBeNull();
    expect(pngSize(png(1, 1).slice(0, 10))).toBeNull();
  });
});

describe("isPhoneLabelled", () => {
  it("labels phone names and alts", () => {
    expect(isPhoneLabelled("a.png", "Placeholder (phone)")).toBe(true);
    expect(isPhoneLabelled("/x/menu-390.png")).toBe(true);
    expect(
      isPhoneLabelled("/Users/x/Desktop/item12-placeholder-phone.png"),
    ).toBe(true);
  });

  it("never labels a desktop shot of a phone feature as phone", () => {
    expect(isPhoneLabelled("verify-phone-desktop.png")).toBe(false);
    expect(isPhoneLabelled("phone-modal-1280.png")).toBe(false);
    expect(isPhoneLabelled("a.png", "Phone settings (desktop)")).toBe(false);
  });
});

describe("phoneShapeError", () => {
  it("refuses a landscape frame labelled phone", () => {
    expect(err("a.png", "Placeholder (phone)", png(980, 732))).toBe(
      "--image a.png is 980x732 but labelled phone — capture a real 390px screenshot (emulate + take_screenshot), never a screencast frame",
    );
  });

  it("accepts real phone shots, including a high-DPR portrait one", () => {
    expect(err("a.png", "x (phone)", png(390, 844))).toBeNull();
    expect(err("a.png", "x (phone)", png(1170, 2532))).toBeNull();
  });

  it("accepts desktop shots and unreadable or non-PNG files", () => {
    expect(err("a.png", "Home (desktop)", png(1280, 800))).toBeNull();
    expect(err("verify-phone-desktop.png", "", png(1280, 800))).toBeNull();
    expect(err("a-phone.png", "", null)).toBeNull();
    expect(err("a-phone.png", "", new Uint8Array(40))).toBeNull();
  });
});
