import * as path from "node:path";
import { currentHome, flowOverlaysDir } from "./paths";
import { WORKTREE_CONTAINER_NAME } from "./worktree-slot";

export type TrustDialog =
  | { kind: "folder" }
  | { kind: "add-dir"; folder: string | null };

const BOX_AND_SPACE = /[\s─-╿]+/g;

function collapse(captured: string): string {
  return captured.replace(/\s+/g, " ").toLowerCase();
}

export function tildePath(p: string, home: string = currentHome()): string {
  if (p === home) return "~";
  return p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

// A long folder path wraps across box lines, so match on the stripped capture.
function matchFolder(
  captured: string,
  candidates: readonly string[],
): string | null {
  const flat = captured.replace(BOX_AND_SPACE, "");
  const home = currentHome();
  let best: string | null = null;
  let bestLen = 0;
  for (const folder of candidates) {
    for (const form of [folder, tildePath(folder, home)]) {
      const needle = form.replace(BOX_AND_SPACE, "");
      if (needle && flat.includes(needle) && needle.length > bestLen) {
        best = folder;
        bestLen = needle.length;
      }
    }
  }
  return best;
}

export function detectTrustDialog(
  captured: string,
  addedFolders: readonly string[] = [],
): TrustDialog | null {
  const text = collapse(captured);
  const noExit = text.includes("no, exit");
  if (
    text.includes("adding a new directory") ||
    (text.includes("yes, add it") && noExit)
  ) {
    return { kind: "add-dir", folder: matchFolder(captured, addedFolders) };
  }
  if (text.includes("yes, i trust this folder") && noExit) {
    return { kind: "folder" };
  }
  return null;
}

// Per-pipeline folders are new every launch, so their stable parent covers
// every future one, but only when that parent is flow-owned: a legacy
// sibling-layout worktree's parent is the user's whole code folder.
function trustRoot(folder: string, perPipeline: readonly string[]): string {
  if (!perPipeline.includes(folder)) return folder;
  const parent = path.dirname(folder);
  const flowOwned =
    path.basename(parent) === WORKTREE_CONTAINER_NAME ||
    parent === flowOverlaysDir();
  return flowOwned ? parent : folder;
}

/** `dialog` is null when no question is on screen yet, so either one may be pending. */
export function trustDialogSteps(
  attachName: string,
  dialog: TrustDialog | null,
  opts: {
    addedFolders?: readonly string[];
    perPipelineFolders?: readonly string[];
    home?: string;
  } = {},
): string[] {
  const attach = `flow attach ${attachName}`;
  const added = opts.addedFolders ?? [];
  if (dialog?.kind === "folder") {
    const next =
      added.length > 0
        ? '; if it next asks "Adding a new directory", press ↓ to "Yes, add it" then Enter (Enter alone exits)'
        : " — it then starts by itself";
    return [
      attach,
      `choose "Yes, I trust this folder"${next} (if the start command sits in the input box, press Enter there)`,
    ];
  }
  const perPipeline = opts.perPipelineFolders ?? [];
  const roots = [...new Set(added.map((f) => trustRoot(f, perPipeline)))];
  const root = dialog?.folder
    ? trustRoot(dialog.folder, perPipeline)
    : roots.length === 1
      ? roots[0]
      : null;
  const cd = (r: string) => `cd ${tildePath(r, opts.home)} && claude`;
  const trust = root
    ? cd(root)
    : roots.length > 1
      ? `run claude in the folder it names (${roots.map(cd).join(" or ")})`
      : "cd into the folder it names and run claude";
  const answer =
    dialog === null
      ? 'if it asks whether you trust the folder, choose "Yes, I trust this folder"; if it asks to add a new directory, press ↓ to "Yes, add it", then Enter — Enter alone picks "No, exit" and closes the session; if it asks again for another folder, answer the same way; if the start command sits in the input box, press Enter there'
      : 'press ↓ to "Yes, add it", then Enter — Enter alone picks "No, exit" and closes the session; if it asks again for another folder, answer the same way';
  return [
    attach,
    answer,
    `so it stops asking on every launch: ${trust}, choose "Yes, I trust this folder", then /exit`,
  ];
}
