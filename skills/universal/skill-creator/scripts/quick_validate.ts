import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_PROPERTIES = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
]);

function parseFrontmatterKeys(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  const lines = text.split("\n");
  let currentKey = "";
  let currentValue = "";

  for (const line of lines) {
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.includes(":")) {
      if (currentKey) keys.set(currentKey, currentValue.trim());
      const colonIdx = line.indexOf(":");
      currentKey = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();
      if ([">", "|", ">-", "|-"].includes(rawValue)) {
        currentValue = "";
      } else {
        currentValue = rawValue.replace(/^['"]|['"]$/g, "");
      }
    } else if (currentKey && (line.startsWith("  ") || line.startsWith("\t"))) {
      currentValue += " " + line.trim();
    }
  }
  if (currentKey) keys.set(currentKey, currentValue.trim());

  return keys;
}

export function validateSkill(skillPath: string): {
  valid: boolean;
  message: string;
} {
  if (!existsSync(join(skillPath, "SKILL.md"))) {
    return { valid: false, message: "SKILL.md not found" };
  }

  const content = readFileSync(join(skillPath, "SKILL.md"), "utf-8");
  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" };
  }

  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return { valid: false, message: "Invalid frontmatter format" };
  }

  const keys = parseFrontmatterKeys(match[1]);

  const unexpected = [...keys.keys()].filter((k) => !ALLOWED_PROPERTIES.has(k));
  if (unexpected.length > 0) {
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.sort().join(", ")}. Allowed properties are: ${[...ALLOWED_PROPERTIES].sort().join(", ")}`,
    };
  }

  if (!keys.has("name")) {
    return { valid: false, message: "Missing 'name' in frontmatter" };
  }
  if (!keys.has("description")) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  const name = (keys.get("name") || "").trim();
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return {
        valid: false,
        message: `Name '${name}' should be kebab-case (lowercase letters, digits, and hyphens only)`,
      };
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return {
        valid: false,
        message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`,
      };
    }
    if (name.length > 64) {
      return {
        valid: false,
        message: `Name is too long (${name.length} characters). Maximum is 64 characters.`,
      };
    }
  }

  const description = (keys.get("description") || "").trim();
  if (description) {
    if (description.includes("<") || description.includes(">")) {
      return {
        valid: false,
        message: "Description cannot contain angle brackets (< or >)",
      };
    }
    if (description.length > 1024) {
      return {
        valid: false,
        message: `Description is too long (${description.length} characters). Maximum is 1024 characters.`,
      };
    }
  }

  const compat = (keys.get("compatibility") || "").trim();
  if (compat && compat.length > 500) {
    return {
      valid: false,
      message: `Compatibility is too long (${compat.length} characters). Maximum is 500 characters.`,
    };
  }

  return { valid: true, message: "Skill is valid!" };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.log("Usage: bun run scripts/quick_validate.ts <skill_directory>");
    process.exit(1);
  }
  const { valid, message } = validateSkill(args[0]);
  console.log(message);
  process.exit(valid ? 0 : 1);
}
