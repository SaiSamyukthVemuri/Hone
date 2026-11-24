import { DESK_FIELD_MAX, DESK_NAME_ON_FILE } from "./read";

export type DeskBookingOptions = {
  timezone: string;
  studioId: string;
  services: { id: string; name: string; durationMinutes: number }[];
  practitioners: { id: string; name: string }[];
};
export type DeskBookingClient = { id: string; displayName: string; contactHint: string };
export type DeskOpening = {
  date: string; localTime: string; start: string; end: string;
  practitionerId: string; practitionerName: string; serviceId: string;
};
export type DeskResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export function validDeskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

export function instant(value: unknown): value is string {
  // A bare wall clock implicitly uses the server timezone.
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function deskText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, DESK_FIELD_MAX) : "";
}

/** A selected client can be identified without sending their legal name or contact details to the browser. */
export function bookingClient(row: Record<string, unknown>, query: string): DeskBookingClient | null {
  if (!validDeskId(row.client_id) || typeof row.name_on_file !== "boolean") return null;
  const preferred = row.name_on_file ? "" : deskText(row.display_name);
  const phone = typeof row.phone === "string" ? row.phone : "";
  const email = typeof row.email === "string" ? row.email : "";
  // On databases predating 0374, contacts_v2 could MATCH a stored name even
  // when it flagged the result name_on_file. Do not reveal even that match.
  if (![preferred, phone, email].some(value => value.toLowerCase().includes(query.toLowerCase()))) return null;
  const digits = phone.replace(/\D/g, "");
  const emailMatch = /^([^@\s])[^@\s]*@[^@\s]+$/.exec(email);
  const contactHint = digits.length >= 4 ? `Phone ending in ${digits.slice(-4)}`
    : emailMatch ? `Email starts with ${emailMatch[1]}…` : "";
  return { id: row.client_id, displayName: preferred || DESK_NAME_ON_FILE, contactHint };
}
