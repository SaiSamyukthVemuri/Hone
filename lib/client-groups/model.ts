/** Studio organisation only: group membership conveys no clinical or booking status. */
export type ClientGroup = { id: string; name: string; updated_at: string };
export type GroupRead<T> = { available: true; value: T } | { available: false };
export const unavailable = { available: false } as const;
export const GROUP_LIMIT = 100;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function groupName(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const name = value.trim();
  return name.length > 0 && Array.from(name).length <= 60 ? name : null;
}
export function groupFilter(value: string | string[] | undefined): string | undefined {
  // Keep invalid selections so the server can refuse them rather than silently showing all clients.
  return (Array.isArray(value) ? value[0] : value) || undefined;
}
export function filterGroup<T extends { id: string }>(rows: T[], members: ReadonlySet<string>): T[] {
  return rows.filter((row) => members.has(row.id));
}
