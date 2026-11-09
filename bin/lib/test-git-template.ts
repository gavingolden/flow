import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const GIT_TEMPLATE_DIRNAME = "flow-git-template-v1";

const EXCLUDE_BODY = `# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
# For a project mostly in C, the following would be a good set of
# exclude patterns (uncomment them if you want to use them):
# *.[oa]
# *~
`;

const WRITABLE = 0o022;
const RACE_CODES = new Set(["ENOENT", "EEXIST", "ENOTEMPTY", "ENOTDIR"]);

function squatReason(st: fs.Stats): string | null {
  if (st.isSymbolicLink()) return "it is a symlink";
  if (!st.isDirectory() && !st.isFile()) {
    return "it is not a directory or regular file";
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    return `it is owned by uid ${st.uid}, not ${uid}`;
  }
  if (st.isDirectory() && (st.mode & WRITABLE) !== 0) {
    return `it is group/other-writable (mode ${(st.mode & 0o777).toString(8)})`;
  }
  return null;
}

function isRealDir(p: string): boolean {
  const st = fs.lstatSync(p);
  return st.isDirectory() && (st.mode & WRITABLE) === 0;
}

function excludeIsCurrent(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    return (
      st.isFile() &&
      (st.mode & WRITABLE) === 0 &&
      fs.readFileSync(file, "utf8") === EXCLUDE_BODY
    );
  } catch {
    return false;
  }
}

function isCurrent(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || squatReason(st)) return false;
    const hooks = path.join(dir, "hooks");
    const info = path.join(dir, "info");
    return (
      fs.readdirSync(dir).sort().join() === "hooks,info" &&
      isRealDir(hooks) &&
      fs.readdirSync(hooks).length === 0 &&
      isRealDir(info) &&
      fs.readdirSync(info).join() === "exclude" &&
      excludeIsCurrent(path.join(info, "exclude"))
    );
  } catch {
    return false;
  }
}

function installFresh(root: string, finalDir: string): void {
  const tmpDir = fs.mkdtempSync(path.join(root, `.${GIT_TEMPLATE_DIRNAME}-`));
  try {
    fs.mkdirSync(path.join(tmpDir, "hooks"), { mode: 0o700 });
    fs.mkdirSync(path.join(tmpDir, "info"), { mode: 0o700 });
    fs.writeFileSync(path.join(tmpDir, "info", "exclude"), EXCLUDE_BODY, {
      mode: 0o644,
    });
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Another run installed the template first.
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function ensureRealDir(p: string): void {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (st && !st.isDirectory()) {
    fs.rmSync(p, { recursive: true, force: true });
    st = null;
  }
  if (!st) {
    try {
      fs.mkdirSync(p, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  } else if ((st.mode & WRITABLE) !== 0) {
    fs.chmodSync(p, 0o700);
  }
}

function removeEntries(dir: string, keep: readonly string[]): void {
  for (const name of fs.readdirSync(dir)) {
    if (!keep.includes(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

function repairInPlace(dir: string, root: string): void {
  const hooks = path.join(dir, "hooks");
  const info = path.join(dir, "info");
  const exclude = path.join(info, "exclude");
  removeEntries(dir, ["hooks", "info"]);
  ensureRealDir(hooks);
  removeEntries(hooks, []);
  ensureRealDir(info);
  removeEntries(info, ["exclude"]);
  if (excludeIsCurrent(exclude)) return;

  // Scratch lives in root, not info/, so a concurrent prune of info/ cannot delete it.
  const scratch = path.join(
    root,
    `.${GIT_TEMPLATE_DIRNAME}-exclude-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    // O_EXCL: never follow a symlink pre-planted at the scratch name.
    fs.writeFileSync(scratch, EXCLUDE_BODY, { mode: 0o644, flag: "wx" });
    // rename() replaces a file or symlink atomically; only a directory blocks it.
    if (
      fs.lstatSync(exclude, { throwIfNoEntry: false })?.isDirectory() === true
    ) {
      fs.rmSync(exclude, { recursive: true, force: true });
    }
    fs.renameSync(scratch, exclude);
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

/**
 * A template dir with an empty `hooks/` and git's stock `info/exclude`, so a
 * `git init` stops writing 14 unused sample hooks and a description file —
 * files macOS would otherwise scan on every test repo. Builds it if missing,
 * replaces a stray regular file we own, repairs a stale tree we own in place
 * (the dir itself is never moved or deleted), and refuses a symlink, foreign
 * owner, group/other-writable dir, or any other file type.
 * Safe to call concurrently.
 */
export function ensureMinimalGitTemplate(root: string = os.tmpdir()): string {
  const finalDir = path.join(root, GIT_TEMPLATE_DIRNAME);
  if (isCurrent(finalDir)) return finalDir;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const st = fs.lstatSync(finalDir, { throwIfNoEntry: false }) ?? null;
    const reason = st && squatReason(st);
    if (reason) {
      throw new Error(
        `refusing to use git template dir ${finalDir}: ${reason}; remove it and re-run`,
      );
    }
    try {
      if (!st) {
        installFresh(root, finalDir);
      } else if (st.isFile()) {
        try {
          fs.rmSync(finalDir, { force: true });
        } catch (rmErr) {
          // rmSync on a directory throws a runtime-specific code (ERR_FS_EISDIR on
          // Node, EFAULT on Bun), so re-lstat: a directory means another run won.
          const now = fs.lstatSync(finalDir, { throwIfNoEntry: false });
          if (now?.isDirectory() && !now.isSymbolicLink()) continue;
          throw rmErr;
        }
        installFresh(root, finalDir);
      } else {
        repairInPlace(finalDir, root);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RACE_CODES.has(code)) throw err;
      lastErr = err;
      continue;
    }
    if (isCurrent(finalDir)) return finalDir;
  }
  throw new Error(
    `could not install git template at ${finalDir} after 3 attempts`,
    { cause: lastErr },
  );
}
