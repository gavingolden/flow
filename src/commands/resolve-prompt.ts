export type ResolvedPrompt =
  | { ok: true; prompt: string }
  | { ok: false; exitCode: number; message: string };

interface ResolveDeps {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
}

export async function resolvePromptSource(
  argvParts: string[],
  deps: ResolveDeps,
): Promise<ResolvedPrompt> {
  const argvPrompt = argvParts.join(" ").trim();
  const stdinPiped = deps.stdin.isTTY !== true;

  if (argvPrompt.length > 0) {
    if (stdinPiped) {
      deps.stderr.write(
        "flow: ignoring stdin because a prompt was provided as arguments\n",
      );
    }
    return { ok: true, prompt: argvPrompt };
  }

  if (!stdinPiped) {
    return {
      ok: false,
      exitCode: 1,
      message:
        "error: a prompt is required (pass it as arguments or pipe it on stdin)",
    };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of deps.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const prompt = raw.replace(/\n+$/, "");
  if (prompt.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      message: "error: stdin was empty (a prompt is required)",
    };
  }
  return { ok: true, prompt };
}
