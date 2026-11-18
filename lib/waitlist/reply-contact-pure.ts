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

/**
 * A phone number for READING on the card. North American numbers (10 digits, or 11 starting with 1) become "(416) 555-0123" / "+1 (416) 555-0123";
 * anything else is shown exactly as the person gave it, trimmed, because guessing a format for an international number would misstate it.
 * Display only: the Call link and the Copy button still use the stored value (telHref / the raw string), so the dialable digits never change.
 */
export function formatPhoneForDisplay(phone: string): string {
  const raw = phone.trim();
  if (/[^\d\s().+-]/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  const plus = raw.startsWith("+");
  if (digits.length === 10 && !plus) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1") return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return raw;
}
