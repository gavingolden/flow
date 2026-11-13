/** Reads a Claude Code hook payload from stdin, giving up after `timeoutMs` so a hook never hangs a turn. */
export function readHookStdin(timeoutMs = 500): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c) => chunks.push(c as Uint8Array));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}
