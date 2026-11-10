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
};

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
): { files: CompactEntry[]; anyCompacted: boolean } {
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
      };
    }
    let copy = p;
    if (opts.inPlace) {
      fs.writeFileSync(p, res.text);
    } else if (opts.outDir) {
      fs.mkdirSync(opts.outDir, { recursive: true });
      copy = path.resolve(opts.outDir, copyName(p));
      fs.writeFileSync(copy, res.text);
    }
    return {
      path: p,
      copy,
      bytesBefore: before,
      bytesAfter: Buffer.byteLength(res.text),
      compacted: true,
    };
  });
  return { files, anyCompacted: files.some((f) => f.compacted) };
}

export function readJsonOrNull(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
