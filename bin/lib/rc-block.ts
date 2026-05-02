/**
 * Managed-block parser/writer for shell rc files (~/.zshrc, ~/.bashrc,
 * ~/.bash_profile). Mirrors the marker convention in `bin/lib/gitignore.ts`
 * — `#` is both the gitignore and the shell comment character — but operates
 * on arbitrary shell-source bodies rather than path lists, so the two
 * implementations stay parallel rather than sharing a base. Two consumers
 * isn't enough to justify a shared module; revisit if a third appears.
 *
 * Block format:
 *   # managed by flow <tag>
 *   <body line 1>
 *   <body line 2>
 *   # end flow <tag>
 */

export function applyManagedBlock(input: string, tag: string, body: string[]): string {
  const beginMarker = `# managed by flow ${tag}`;
  const endMarker = `# end flow ${tag}`;
  const lines = input.split("\n");
  const beginIdx = lines.indexOf(beginMarker);
  const endIdx = beginIdx >= 0 ? lines.indexOf(endMarker, beginIdx + 1) : -1;

  const rendered = renderBlock(beginMarker, endMarker, body);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = lines.slice(0, beginIdx);
    const after = lines.slice(endIdx + 1);
    if (rendered.length === 0) {
      if (before.length > 0 && before[before.length - 1] === "") before.pop();
      return ensureTrailingNewline([...before, ...after].join("\n"));
    }
    return ensureTrailingNewline([...before, ...rendered, ...after].join("\n"));
  }

  if (rendered.length === 0) return ensureTrailingNewline(input);

  const trimmed = trimTrailingBlankLines(lines);
  const out = [...trimmed];
  if (trimmed.length > 0) out.push("");
  out.push(...rendered);
  return ensureTrailingNewline(out.join("\n"));
}

export function removeManagedBlock(input: string, tag: string): string {
  const beginMarker = `# managed by flow ${tag}`;
  const endMarker = `# end flow ${tag}`;
  const lines = input.split("\n");
  const beginIdx = lines.indexOf(beginMarker);
  if (beginIdx < 0) return input;
  const endIdx = lines.indexOf(endMarker, beginIdx + 1);
  if (endIdx < 0) return input;

  const before = lines.slice(0, beginIdx);
  const after = lines.slice(endIdx + 1);
  if (before.length > 0 && before[before.length - 1] === "") before.pop();
  return ensureTrailingNewline([...before, ...after].join("\n"));
}

export function hasManagedBlock(input: string, tag: string): boolean {
  const beginMarker = `# managed by flow ${tag}`;
  const endMarker = `# end flow ${tag}`;
  const lines = input.split("\n");
  const beginIdx = lines.indexOf(beginMarker);
  if (beginIdx < 0) return false;
  return lines.indexOf(endMarker, beginIdx + 1) > beginIdx;
}

function renderBlock(begin: string, end: string, body: string[]): string[] {
  if (body.length === 0) return [];
  return [begin, ...body, end];
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function ensureTrailingNewline(s: string): string {
  if (s.length === 0) return "";
  return s.endsWith("\n") ? s : s + "\n";
}
