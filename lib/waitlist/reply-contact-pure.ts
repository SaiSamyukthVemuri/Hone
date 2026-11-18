// Client-safe, pure helpers for the contact shown on the owner's waitlist response cards. No I/O and NO server imports: client
// components import from here. The session-scoped read lives in lib/waitlist/reply-contact.ts (server only).

export type ReplyContact =
  | { kind: "entry"; email: string | null; phone: string | null }
  | { kind: "gone" };

export type ReplyContactMap = { kind: "unknown" } | { kind: "ok"; byEntry: ReadonlyMap<string, ReplyContact> };

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Pure: turns the rows read for the listed entry ids into a per-entry answer. An id with no row is "gone". */
export function contactsFromRows(entryIds: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): ReplyContactMap {
  const found = new Map<string, ReplyContact>();
  for (const r of rows) {
    if (typeof r.id !== "string") continue;
    found.set(r.id, { kind: "entry", email: clean(r.email), phone: clean(r.phone) });
  }
  const byEntry = new Map<string, ReplyContact>();
  for (const id of entryIds) byEntry.set(id, found.get(id) ?? { kind: "gone" });
  return { kind: "ok", byEntry };
}

/** A mailto: href that cannot carry anything but the address. */
export function mailtoHref(email: string): string {
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`;
}

/** A tel: href with only digits and a leading plus; null when nothing dialable is left. */
export function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /\d/.test(digits) ? `tel:${digits}` : null;
}
