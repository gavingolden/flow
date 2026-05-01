import { execa } from "execa";

export async function findGitRoot(cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}
