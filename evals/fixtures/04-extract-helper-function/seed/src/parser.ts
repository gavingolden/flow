import { readFileSync } from "node:fs";

export type Config = {
  name: string;
  port: number;
  features: string[];
};

/**
 * Read a config JSON file, parse it, and validate its shape.
 * Throws if the file is missing, unparseable, or fails validation.
 */
export function parseConfig(filePath: string): Config {
  const raw = readFileSync(filePath, "utf8");
  const obj = JSON.parse(raw);

  if (typeof obj !== "object" || obj === null) {
    throw new Error("config must be an object");
  }
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error("config.name must be a non-empty string");
  }
  if (typeof obj.port !== "number" || obj.port < 1 || obj.port > 65535) {
    throw new Error("config.port must be a number in [1, 65535]");
  }
  if (!Array.isArray(obj.features)) {
    throw new Error("config.features must be an array");
  }
  for (const f of obj.features) {
    if (typeof f !== "string") {
      throw new Error("config.features must contain only strings");
    }
  }

  return obj as Config;
}
