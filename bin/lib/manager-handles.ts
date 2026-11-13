/**
 * `~/.flow/manager/handles.json`: the short `#N` handle the manager prints
 * beside every needs-you line (written by `writeManagerStatus`). One handle is
 * one pipeline sitting in one owner-needed phase. The owner types "yes #3";
 * the owner-words matcher resolves `#3` back to that pipeline here.
 */

import * as fs from "node:fs";
import { managerFile, managerHome } from "./manager-home";

export type HandleFile = {
  version: 1;
  next: number;
  items: Record<string, number>;
};

export function handlesPath(home: string): string {
  return managerFile("handles.json", home);
}

/** Tolerant: a missing or malformed file starts over. */
export function readHandles(home: string): HandleFile {
  try {
    const v = JSON.parse(
      fs.readFileSync(handlesPath(home), "utf8"),
    ) as HandleFile;
    if (
      v?.version === 1 &&
      Number.isInteger(v.next) &&
      v.items &&
      typeof v.items === "object" &&
      Object.values(v.items).every((n) => Number.isInteger(n))
    ) {
      return v;
    }
  } catch {
    // missing or malformed: start over
  }
  return { version: 1, next: 1, items: {} };
}

/** `#3` (or `3`) to the slug and phase that handle currently names; null when none. */
export function resolveHandle(
  handle: string,
  home: string = managerHome(),
): { slug: string; phase: string } | null {
  const m = /^#?(\d+)$/.exec(handle.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const key = Object.entries(readHandles(home).items).find(
    ([, v]) => v === n,
  )?.[0];
  if (key === undefined) return null;
  const cut = key.lastIndexOf(":");
  return cut > 0
    ? { slug: key.slice(0, cut), phase: key.slice(cut + 1) }
    : null;
}
