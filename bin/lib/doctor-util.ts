const MAX_LISTED = 5;

/** POSIX single-quote a path so a copy-paste `fix:` line survives spaces. */
export function shq(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** The package-manager command for the current platform, as a bare command. */
export function installCommand(
  pkg: string,
  platform: string = process.platform,
): string {
  return platform === "darwin" ? `brew install ${pkg}` : `apt install ${pkg}`;
}

/** At most `max` items, with a `(+N more)` tail so a report line stays short. */
export function capped(items: string[], max: number = MAX_LISTED): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `(+${items.length - max} more)`];
}
