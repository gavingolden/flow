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

function isCurrent(dir: string): boolean {
  try {
    return (
      fs.statSync(path.join(dir, "hooks")).isDirectory() &&
      fs.readFileSync(path.join(dir, "info", "exclude"), "utf8") ===
        EXCLUDE_BODY
    );
  } catch {
    return false;
  }
}

/**
 * A template dir with an empty `hooks/` and git's stock `info/exclude`, so a
 * `git init` stops writing 14 unused sample hooks and a description file —
 * files macOS would otherwise scan on every test repo. Safe to call
 * concurrently: the tree is built in a unique sibling and renamed into place.
 */
export function ensureMinimalGitTemplate(root: string = os.tmpdir()): string {
  const finalDir = path.join(root, GIT_TEMPLATE_DIRNAME);
  if (isCurrent(finalDir)) return finalDir;

  const tmpDir = fs.mkdtempSync(path.join(root, `.${GIT_TEMPLATE_DIRNAME}-`));
  fs.mkdirSync(path.join(tmpDir, "hooks"));
  fs.mkdirSync(path.join(tmpDir, "info"));
  fs.writeFileSync(path.join(tmpDir, "info", "exclude"), EXCLUDE_BODY);
  try {
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if ((code === "EEXIST" || code === "ENOTEMPTY") && isCurrent(finalDir)) {
      return finalDir;
    }
    throw err;
  }
  return finalDir;
}
