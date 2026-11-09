/**
 * Tagged checkpoint decisions: parse a note body into items and decide which
 * items are still instructions. Pure — no I/O. A note line `- [standing] …`,
 * `- [one-time] …` or `- [revoke S<n>] …` starts an item; every other
 * non-blank line is gathered verbatim into one `one-time` item, so an
 * untagged note behaves exactly as it did before tagging existed.
 */

export type ParsedItem =
  | { tag: "standing" | "one-time"; text: string }
  | { tag: "revoke"; revokes: string; text: string };

export type DecisionNote = {
  at: string;
  phase: string;
  site: string;
  sha: string;
  items: ParsedItem[];
};

export type DecisionStatus =
  | "retired"
  | "superseded"
  | "revoked"
  | "ended"
  | "record-only";

export type ClassifiedItem = {
  note: DecisionNote;
  item: ParsedItem;
  id?: string;
};

const TAG_LINE = /^- \[(standing|one-time|revoke S(\d+))\][ \t]*(.*)$/;

export function parseNoteItems(body: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const loose: string[] = [];
  let current: { item: ParsedItem; lines: string[] } | null = null;
  const flush = (): void => {
    if (current) {
      current.item.text = current.lines.join("\n").trim();
      items.push(current.item);
      current = null;
    }
  };
  for (const line of body.split(/\r?\n/)) {
    const m = TAG_LINE.exec(line);
    if (m) {
      flush();
      const item: ParsedItem =
        m[1] === "standing" || m[1] === "one-time"
          ? { tag: m[1], text: "" }
          : { tag: "revoke", revokes: `S${m[2]}`, text: "" };
      current = { item, lines: [m[3]] };
    } else if (current && /^[ \t]+\S/.test(line)) {
      current.lines.push(line.trim());
    } else if (line.trim() !== "") {
      flush();
      loose.push(line);
    }
  }
  flush();
  if (loose.length > 0) {
    items.push({ tag: "one-time", text: loose.join("\n") });
  }
  return items;
}

const norm = (text: string): string => text.replace(/\s+/g, " ").trim();

type Recorded = ClassifiedItem & { status: DecisionStatus; revokedBy?: string };

export function classifyDecisions(
  notes: DecisionNote[],
  ctx: {
    liveNoteSha: string | null;
    liveNoteUsable: boolean;
    pipelineEnded: boolean;
  },
): { active: ClassifiedItem[]; record: Recorded[] } {
  const ids = new Map<string, string>();
  const flat: ClassifiedItem[] = [];
  const noteIndex = new Map<DecisionNote, number>();
  notes.forEach((note, n) => {
    noteIndex.set(note, n);
    for (const item of note.items) {
      if (item.tag !== "standing") {
        flat.push({ note, item });
        continue;
      }
      const key = norm(item.text);
      let id = ids.get(key);
      if (id === undefined) {
        id = `S${ids.size + 1}`;
        ids.set(key, id);
      }
      flat.push({ note, item, id });
    }
  });

  const active: ClassifiedItem[] = [];
  const record: Recorded[] = [];
  flat.forEach((c, pos) => {
    const { item, note } = c;
    if (item.tag === "revoke") {
      record.push({ ...c, status: "record-only" });
    } else if (item.tag === "standing") {
      const revoker = flat.find(
        (later, p) =>
          p > pos && later.item.tag === "revoke" && later.item.revokes === c.id,
      );
      if (revoker) {
        record.push({ ...c, status: "revoked", revokedBy: revoker.note.at });
      } else if (ctx.pipelineEnded) {
        record.push({ ...c, status: "ended" });
      } else {
        active.push(c);
      }
    } else if (ctx.pipelineEnded) {
      record.push({ ...c, status: "ended" });
    } else if (
      noteIndex.get(note) === notes.length - 1 &&
      note.sha === ctx.liveNoteSha &&
      ctx.liveNoteUsable
    ) {
      active.push(c);
    } else {
      const newer = (noteIndex.get(note) as number) < notes.length - 1;
      record.push({ ...c, status: newer ? "superseded" : "retired" });
    }
  });
  return { active, record };
}
