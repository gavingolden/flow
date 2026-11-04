/**
 * Durable copy of a refused delegated lens's prompt and raw output.
 *
 * `flow-agy-lenses` deletes its `.flow-tmp/` scratch files at the end of every
 * run, so a content-safety refusal leaves nothing to inspect afterwards. This
 * copies `<lens>.prompt` / `<lens>.raw` to `<dir>/<ts>-<lens>.{prompt,raw}`
 * and keeps only the newest `keep` pairs. The prompt embeds the reviewed diff,
 * so files are 0600 and the directory 0700. Diagnostics must never fail a
 * review: every error is swallowed.
 */

export type RefusalCacheFs = {
  // null when the file is absent or unreadable.
  readFile: (path: string) => string | null;
  writeFile: (path: string, contents: string, mode?: number) => void;
  mkdirp: (dir: string, mode?: number) => void;
  listDir: (dir: string) => string[];
  removeFile: (path: string) => void;
};

export const REFUSAL_CACHE_KEEP = 20;

const SUFFIXES = [".prompt", ".raw"] as const;

const stemOf = (name: string): string | null => {
  const suffix = SUFFIXES.find((s) => name.endsWith(s));
  return suffix === undefined ? null : name.slice(0, -suffix.length);
};

export function keepRefusalEvidence(
  opts: {
    dir: string;
    lens: string;
    promptPath: string;
    rawPath: string;
    now: Date;
    keep?: number;
  },
  fs: RefusalCacheFs,
): void {
  try {
    const stem = `${opts.now.toISOString().replace(/[:.]/g, "-")}-${opts.lens}`;
    fs.mkdirp(opts.dir, 0o700);
    const sources: Array<[string, string]> = [
      [opts.promptPath, ".prompt"],
      [opts.rawPath, ".raw"],
    ];
    for (const [src, suffix] of sources) {
      const contents = fs.readFile(src);
      if (contents === null) continue;
      fs.writeFile(`${opts.dir}/${stem}${suffix}`, contents, 0o600);
    }
    const stems = [
      ...new Set(
        fs
          .listDir(opts.dir)
          .map(stemOf)
          .filter((s): s is string => s !== null),
      ),
    ].sort();
    const excess = stems.length - (opts.keep ?? REFUSAL_CACHE_KEEP);
    for (const old of stems.slice(0, Math.max(0, excess))) {
      for (const suffix of SUFFIXES)
        fs.removeFile(`${opts.dir}/${old}${suffix}`);
    }
  } catch {
    // diagnostics only
  }
}
