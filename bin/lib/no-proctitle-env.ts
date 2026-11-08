import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the preload; resolved via realpath so a PATH symlink to the helper still finds it. */
export const NO_PROCTITLE_PRELOAD: string = join(
  dirname(realpathSync(fileURLToPath(import.meta.url))),
  "no-proctitle.cjs",
);

// libuv opt-out for LaunchServices registration on process-title set
// (https://github.com/libuv/libuv/pull/5370, https://github.com/libuv/libuv/issues/5300).
// Only "0" opts out, and libuv reads it once at process start.
export const LAUNCH_SERVICES_OPT_OUT = "UV_PROCESS_TITLE_USE_LAUNCH_SERVICES";

/**
 * Copy of `env` that, on macOS, appends the no-proctitle preload to
 * NODE_OPTIONS (when the file exists and is not already named) and sets the
 * libuv opt-out when unset. Never mutates `env`; never writes an undefined value.
 */
export function withNoProctitlePreload(
  env: NodeJS.ProcessEnv,
  opts: {
    platform?: NodeJS.Platform;
    preloadPath?: string;
    exists?: (p: string) => boolean;
  } = {},
): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  const preloadPath = opts.preloadPath ?? NO_PROCTITLE_PRELOAD;
  const exists = opts.exists ?? existsSync;
  const out: NodeJS.ProcessEnv = { ...env };
  if (platform !== "darwin") return out;
  if (out[LAUNCH_SERVICES_OPT_OUT] === undefined)
    out[LAUNCH_SERVICES_OPT_OUT] = "0";
  const existing = out.NODE_OPTIONS ?? "";
  if (exists(preloadPath) && !existing.includes(preloadPath)) {
    const flag = /\s/.test(preloadPath)
      ? `--require "${preloadPath}"`
      : `--require=${preloadPath}`;
    out.NODE_OPTIONS = [existing.trim(), flag].filter(Boolean).join(" ");
  }
  return out;
}
