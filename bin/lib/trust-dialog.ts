import * as path from "node:path";
import { currentHome } from "./paths";

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

// Per-pipeline folders are new every launch, so trusting the folder itself
// would help once; their stable parent covers every future one.
function trustRoot(folder: string, perPipeline: readonly string[]): string {
  return perPipeline.includes(folder) ? path.dirname(folder) : folder;
}

export function trustDialogSteps(
  attachName: string,
  dialog: TrustDialog,
  opts: {
    addedFolders?: readonly string[];
    perPipelineFolders?: readonly string[];
    home?: string;
  } = {},
): string[] {
  const attach = `flow attach ${attachName}`;
  if (dialog.kind === "folder") {
    return [
      attach,
      'choose "Yes, I trust this folder" — it then starts by itself (if the start command sits in the input box, press Enter there)',
    ];
  }
  const perPipeline = opts.perPipelineFolders ?? [];
  const roots = new Set(
    (opts.addedFolders ?? []).map((f) => trustRoot(f, perPipeline)),
  );
  const root = dialog.folder
    ? trustRoot(dialog.folder, perPipeline)
    : roots.size === 1
      ? [...roots][0]
      : null;
  const trust = root
    ? `cd ${tildePath(root, opts.home)} && claude`
    : "cd into the stable parent folder of the folder it names and run claude";
  return [
    attach,
    'press ↓ to "Yes, add it", then Enter — Enter alone picks "No, exit" and closes the session; if it asks again for another folder, answer the same way',
    `so it stops asking on every launch: ${trust}, choose "Yes, I trust this folder", then /exit`,
  ];
}
