import { DESK_FIELD_MAX, deskDisplayName, validDeskId } from "./read";

export { validDeskId };

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

export function instant(value: unknown): value is string {
  // A bare wall clock implicitly uses the server timezone.
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function deskText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, DESK_FIELD_MAX) : "";
}

/** This projection consumes the operational name from receptionist_booking_clients_v3. */
export function bookingClient(row: Record<string, unknown>): DeskBookingClient | null {
  if (!validDeskId(row.client_id) || typeof row.display_name !== "string") return null;
  const displayName = deskDisplayName(row.display_name);
  // The database already masked the hint (e.g. "•••@ex…com · •••0188"); a full phone or email is never read here.
  const contactHint = typeof row.contact_hint === "string" ? row.contact_hint.replace(/\s+/g, " ").trim().slice(0, DESK_FIELD_MAX) : "";
  return { id: row.client_id, displayName, contactHint };
}
