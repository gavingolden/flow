// Strip the leading YYYY-MM-DD- date so the slug is a stable branch suffix.
export function slugFromId(id: string): string {
  const datePrefix = /^\d{4}-\d{2}-\d{2}-/;
  return id.replace(datePrefix, "");
}

export function deriveBranchName(id: string, prefix = "agent"): string {
  return `${prefix}/${slugFromId(id)}`;
}
