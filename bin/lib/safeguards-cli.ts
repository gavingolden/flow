/**
 * File-touching halves of the `flow-safeguards` subcommands, kept out of the
 * dispatcher so `bin/flow-safeguards.ts` stays a thin switch.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { collapsePadding } from "./guidance-padding";

export type CompactEntry = {
  path: string;
  copy: string;
  bytesBefore: number;
  bytesAfter: number;
  compacted: boolean;
  // The collapse differs from what a reader of the earlier copy (or, with no
  // earlier copy, of the original) already saw.
  changedFromRead: boolean;
};

export class WriteTargetError extends Error {}

function realpathOfExisting(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Refuse a write target outside the current working directory tree. */
export function assertInside(p: string, root = process.cwd()): void {
  const rel = path.relative(realpathOfExisting(root), realpathOfExisting(p));
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new WriteTargetError(
      `refusing to write outside the working directory (${root}): ${p}`,
    );
  }
}

export function copyName(file: string, cwd = process.cwd()): string {
  const abs = path.resolve(file);
  const rel = path.relative(cwd, abs);
  const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  return (inside ? rel : path.basename(abs)).split(path.sep).join("__");
}

export function compactFiles(
  paths: string[],
  opts: {
    outDir?: string;
    inPlace?: boolean;
    force?: boolean;
    noMarker?: boolean;
  },
): {
  files: CompactEntry[];
  anyCompacted: boolean;
  anyChangedFromRead: boolean;
  copies: Record<string, string>;
} {
  if (opts.inPlace) paths.forEach((p) => assertInside(p));
  if (opts.outDir) assertInside(opts.outDir);
  const files = paths.map((p): CompactEntry => {
    let text: string;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      return {
        path: p,
        copy: p,
        bytesBefore: 0,
        bytesAfter: 0,
        compacted: false,
        changedFromRead: false,
      };
    }
    const before = Buffer.byteLength(text);
    const res = collapsePadding(text, {
      force: opts.force,
      preserveForPrettier: opts.inPlace === true && opts.noMarker !== true,
    });
    if (!res.changed) {
      return {
        path: p,
        copy: p,
        bytesBefore: before,
        bytesAfter: before,
        compacted: false,
        changedFromRead: false,
      };
    }
    let copy = p;
    let read = text;
    if (opts.inPlace) {
      fs.writeFileSync(p, res.text);
    } else if (opts.outDir) {
      fs.mkdirSync(opts.outDir, { recursive: true });
      copy = path.resolve(opts.outDir, copyName(p));
      read = readTextOrNull(copy) ?? text;
      fs.writeFileSync(copy, res.text);
    }
    return {
      path: p,
      copy,
      bytesBefore: before,
      bytesAfter: Buffer.byteLength(res.text),
      compacted: true,
      changedFromRead: read !== res.text,
    };
  });
  return {
    files,
    anyCompacted: files.some((f) => f.compacted),
    anyChangedFromRead: files.some((f) => f.changedFromRead),
    copies: Object.fromEntries(
      files.filter((f) => f.compacted).map((f) => [f.path, f.copy]),
    ),
  };
}

function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readJsonOrNull(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
