import { describe, expect, it } from "vitest";
import { detectTrustDialog, trustDialogSteps } from "./trust-dialog";

const HOME = "/Users/u";
const OVERLAY = `${HOME}/.flow/overlays/my-slug`;
const CLAUDE_HOME = `${HOME}/.flow/claude-home`;

const TRUST_MENU = `Accessing workspace:

 ~/.flow/manager

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel`;
const NO_MENU_TRUST_MENU = TRUST_MENU.replace("❯ 1. Yes", "  1. Yes");

function boxed(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const row = (l: string) => `│${l.padEnd(width)}│`;
  return [
    `╭${"─".repeat(width)}╮`,
    ...lines.map(row),
    `╰${"─".repeat(width)}╯`,
  ].join("\n");
}

const ADD_DIR_TAIL = [
  " This session hasn't worked here before. Is this a directory you created or one you trust?",
  "",
  " ❯ No, exit",
  "   Yes, add it",
  "",
  " Enter to confirm · Esc to cancel",
];

function addDirPane(folderLines: string[]): string {
  return boxed([
    " Adding a new directory:",
    ...folderLines,
    "",
    ...ADD_DIR_TAIL,
  ]);
}

describe("detectTrustDialog", () => {
  it("should name the candidate folder when the add-directory question shows it", () => {
    const pane = addDirPane([` ${OVERLAY}`]);

    expect(detectTrustDialog(pane, [OVERLAY, CLAUDE_HOME])).toEqual({
      kind: "add-dir",
      folder: OVERLAY,
    });
  });

  it("should still name the folder when its path wraps across two box lines", () => {
    const pane = addDirPane([" /Users/u/.flow/overl", " ays/my-slug"]);

    expect(detectTrustDialog(pane, [OVERLAY])).toEqual({
      kind: "add-dir",
      folder: OVERLAY,
    });
  });

  it("should report a null folder when the shown folder is not a candidate", () => {
    const pane = addDirPane([" /Users/u/elsewhere"]);

    expect(detectTrustDialog(pane, [OVERLAY, CLAUDE_HOME])).toEqual({
      kind: "add-dir",
      folder: null,
    });
  });

  it("should prefer the longest matching candidate", () => {
    const pane = addDirPane([` ${OVERLAY}`]);

    expect(
      detectTrustDialog(pane, [`${HOME}/.flow/overlays`, OVERLAY]),
    ).toEqual({ kind: "add-dir", folder: OVERLAY });
  });

  it("should detect the add-directory question when only the header survives relabelled buttons", () => {
    const pane = boxed([
      " Adding a new directory:",
      ` ${OVERLAY}`,
      " Proceed?",
    ]);

    expect(detectTrustDialog(pane, [OVERLAY])).toEqual({
      kind: "add-dir",
      folder: OVERLAY,
    });
  });

  it("should detect the starting-folder question with or without the cursor", () => {
    expect(detectTrustDialog(TRUST_MENU)).toEqual({ kind: "folder" });
    expect(detectTrustDialog(NO_MENU_TRUST_MENU)).toEqual({ kind: "folder" });
  });

  it("should return null for a pane that only echoes the launch command", () => {
    expect(detectTrustDialog("❯ ")).toBeNull();
    expect(
      detectTrustDialog(
        "env FLOW_MANAGER=1 claude --add-dir x /flow-manage  # trust folder project",
      ),
    ).toBeNull();
  });
});

describe("trustDialogSteps", () => {
  const dialog = (folder: string | null) =>
    ({ kind: "add-dir", folder }) as const;

  it("should send a per-pipeline skill copy to its stable parent folder", () => {
    const steps = trustDialogSteps("my-slug", dialog(OVERLAY), {
      addedFolders: [OVERLAY],
      perPipelineFolders: [OVERLAY],
      home: HOME,
    });

    expect(steps[0]).toBe("flow attach my-slug");
    expect(steps[1]).toContain("Yes, add it");
    expect(steps[1]).toContain("No, exit");
    expect(steps[2]).toContain("cd ~/.flow/overlays && claude");
  });

  it("should trust the claude-home folder itself", () => {
    const steps = trustDialogSteps("manager", dialog(CLAUDE_HOME), {
      addedFolders: [CLAUDE_HOME],
      home: HOME,
    });

    expect(steps[2]).toContain("cd ~/.flow/claude-home && claude");
  });

  it("should send a per-pipeline worktree to its parent folder", () => {
    const worktree = `${HOME}/code/wt/flow-x`;

    const steps = trustDialogSteps("x", dialog(worktree), {
      perPipelineFolders: [worktree],
      home: HOME,
    });

    expect(steps[2]).toContain("cd ~/code/wt && claude");
  });

  it("should name the single implied root when the folder is unknown", () => {
    const steps = trustDialogSteps("manager", dialog(null), {
      addedFolders: [CLAUDE_HOME],
      home: HOME,
    });

    expect(steps[2]).toContain("cd ~/.flow/claude-home && claude");
  });

  it("should fall back to the folder it names when several roots are implied", () => {
    const steps = trustDialogSteps("x", dialog(null), {
      addedFolders: [CLAUDE_HOME, OVERLAY],
      perPipelineFolders: [OVERLAY],
      home: HOME,
    });

    expect(steps[2]).toContain("the folder it names");
    expect(steps[2]).toContain("stable parent folder");
  });

  it("should tell the user to choose the trust button for the starting-folder question", () => {
    const steps = trustDialogSteps("x", { kind: "folder" });

    expect(steps).toHaveLength(2);
    expect(steps[1]).toContain("Yes, I trust this folder");
  });
});
