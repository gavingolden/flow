import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedUserProductBrief } from "./product-brief-seed";

let scratch!: string;
let homeDir!: string;
let flowSource!: string;

const TEMPLATE_TEXT = "# Product brief\n\nfrom flowSource\n";

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-brief-seed-"));
  homeDir = path.join(scratch, "home");
  flowSource = path.join(scratch, "flow-src");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(path.join(flowSource, "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(flowSource, "templates", "product.md.template"),
    TEMPLATE_TEXT,
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function briefPath(): string {
  return path.join(homeDir, ".flow", "product.md");
}

describe("seedUserProductBrief", () => {
  it("seeds into an empty home", () => {
    const result = seedUserProductBrief({ homeDir, flowSource });
    expect(result.status).toBe("created");
    expect(result.path).toBe(briefPath());
    expect(fs.readFileSync(briefPath(), "utf8")).toBe(TEMPLATE_TEXT);
  });

  it("no-ops when a non-empty brief already exists", () => {
    fs.mkdirSync(path.dirname(briefPath()), { recursive: true });
    const existing = "# my own brief\n";
    fs.writeFileSync(briefPath(), existing);

    const result = seedUserProductBrief({ homeDir, flowSource });

    expect(result.status).toBe("exists");
    expect(fs.readFileSync(briefPath(), "utf8")).toBe(existing);
  });

  it("treats a whitespace-only existing file as absent and writes over it", () => {
    fs.mkdirSync(path.dirname(briefPath()), { recursive: true });
    fs.writeFileSync(briefPath(), "   \n\t\n");

    const result = seedUserProductBrief({ homeDir, flowSource });

    expect(result.status).toBe("created");
    expect(fs.readFileSync(briefPath(), "utf8")).toBe(TEMPLATE_TEXT);
  });

  it("returns no-template when the template is missing from both installRoot and flowSource", () => {
    const installRoot = path.join(scratch, "install-root");
    fs.mkdirSync(installRoot, { recursive: true });
    const bareFlowSource = path.join(scratch, "bare-flow-src");
    fs.mkdirSync(bareFlowSource, { recursive: true });

    const result = seedUserProductBrief({
      homeDir,
      flowSource: bareFlowSource,
      installRoot,
    });

    expect(result.status).toBe("no-template");
    expect(fs.existsSync(briefPath())).toBe(false);
  });

  it("prefers installRoot's template and falls back to flowSource's when installRoot lacks it", () => {
    const installRoot = path.join(scratch, "install-root");
    fs.mkdirSync(path.join(installRoot, "templates"), { recursive: true });
    const installRootText = "# Product brief\n\nfrom installRoot\n";
    fs.writeFileSync(
      path.join(installRoot, "templates", "product.md.template"),
      installRootText,
    );

    const preferred = seedUserProductBrief({
      homeDir,
      flowSource,
      installRoot,
    });
    expect(preferred.status).toBe("created");
    expect(fs.readFileSync(briefPath(), "utf8")).toBe(installRootText);

    // Fresh home: installRoot lacks the template, so flowSource's answers.
    const homeDir2 = path.join(scratch, "home2");
    fs.mkdirSync(homeDir2, { recursive: true });
    const bareInstallRoot = path.join(scratch, "bare-install-root");
    fs.mkdirSync(bareInstallRoot, { recursive: true });

    const fallback = seedUserProductBrief({
      homeDir: homeDir2,
      flowSource,
      installRoot: bareInstallRoot,
    });
    expect(fallback.status).toBe("created");
    expect(
      fs.readFileSync(path.join(homeDir2, ".flow", "product.md"), "utf8"),
    ).toBe(TEMPLATE_TEXT);
  });

  it("returns failed rather than throwing when the destination cannot be written", () => {
    // Occupy the `.flow` parent path with a plain file so mkdirSync(recursive)
    // fails with ENOTDIR instead of creating the directory.
    fs.writeFileSync(path.join(homeDir, ".flow"), "not a directory");

    const result = seedUserProductBrief({ homeDir, flowSource });

    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
  });
});
