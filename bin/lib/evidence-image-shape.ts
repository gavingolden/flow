/**
 * Shape check for sign-off evidence images: a picture labelled phone must be
 * phone-shaped, so a screencast frame (the browser window, not the emulated
 * viewport) is refused before it reaches the PR.
 */
import { closeSync, openSync, readSync } from "node:fs";
import * as path from "node:path";

export const PHONE_MAX_WIDTH = 500;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const NOT_PHONE_ALT = /\b(?:desktop|wide|tablet)\b/i;
export const DESKTOP_TOKENS: ReadonlySet<string> = new Set([
  "desktop",
  "wide",
  "1280",
  "1440",
]);
export const TABLET_TOKENS: ReadonlySet<string> = new Set(["tablet", "768"]);
const NOT_PHONE_TOKENS = new Set([...DESKTOP_TOKENS, ...TABLET_TOKENS]);
const PHONE_TOKENS = new Set(["phone", "390"]);

export function pngSize(
  head: Uint8Array,
): { width: number; height: number } | null {
  if (head.length < 24 || PNG_SIGNATURE.some((b, i) => head[i] !== b)) {
    return null;
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function isPhoneLabelled(file: string, alt = ""): boolean {
  const tokens = path
    .basename(file)
    .toLowerCase()
    .split(/[-_.\s]+/);
  if (tokens.some((t) => NOT_PHONE_TOKENS.has(t)) || NOT_PHONE_ALT.test(alt)) {
    return false;
  }
  return /\bphone\b/i.test(alt) || tokens.some((t) => PHONE_TOKENS.has(t));
}

export function phoneShapeError(
  image: { path: string; alt: string },
  readHead: (p: string) => Uint8Array | null,
): string | null {
  if (!isPhoneLabelled(image.path, image.alt)) return null;
  const size = pngSize(readHead(image.path) ?? new Uint8Array(0));
  if (size === null) return null;
  if (size.width <= PHONE_MAX_WIDTH || size.width <= size.height) return null;
  return `--image ${image.path} is ${size.width}x${size.height} but labelled phone — capture a real 390px screenshot (emulate + take_screenshot), never a screencast frame`;
}

/** The first 24 bytes (PNG signature + IHDR dimensions), or null if unreadable. */
export function readHead(file: string): Uint8Array | null {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = new Uint8Array(24);
      return buf.subarray(0, readSync(fd, buf, 0, 24, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
