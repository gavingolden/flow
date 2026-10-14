export type LaunchSpec = { command: string[]; env: Record<string, string> };
export type LaunchSpecResult =
  | { ok: true; spec: LaunchSpec }
  | { ok: false; error: string };

const UNRESOLVED_PORT = "{{PORT";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function launchSpecFromEnvelope(raw: string): LaunchSpecResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `envelope is not valid JSON: ${msg}` };
  }
  if (!isRecord(parsed) || !isRecord(parsed.meta)) {
    return { ok: false, error: "envelope has no meta object" };
  }
  const { launch, env } = parsed.meta;
  if (typeof launch !== "string") {
    return { ok: false, error: "meta.launch is missing or not a string" };
  }
  if (launch.trim() === "") {
    return { ok: false, error: "meta.launch is empty" };
  }
  if (launch.includes(UNRESOLVED_PORT)) {
    return {
      ok: false,
      error: "meta.launch still contains an unresolved {{PORT placeholder",
    };
  }
  const resolvedEnv: Record<string, string> = {};
  if (env !== undefined) {
    if (!isRecord(env)) {
      return { ok: false, error: "meta.env is not an object" };
    }
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") {
        return { ok: false, error: `meta.env.${key} is not a string` };
      }
      if (value.includes(UNRESOLVED_PORT)) {
        return {
          ok: false,
          error: `meta.env.${key} still contains an unresolved {{PORT placeholder`,
        };
      }
      resolvedEnv[key] = value;
    }
  }
  return {
    ok: true,
    spec: { command: ["sh", "-c", launch], env: resolvedEnv },
  };
}
