// The desk's one read: the schedule function of the 0274 projection (receptionist_calendar_v2) and nothing else. No
// table is read by the desk. This layer is a CLOSED projection that fails closed: it copies named fields only, bounds
// each one, and never carries an identifier, a stored client name, a note, a price or a payment state to a page.
//
// WHAT IT SHOWS LESS THAN THE DATABASE CAN RETURN. The database function also returns the appointment and client
// identifiers and the client's name (the preferred name, or for a client with none, the STORED name flagged
// name_on_file). This layer drops the identifiers and never reads the name field at all: every client is the words
// "Name on file", whatever the database sent. That is a display rule, not a privacy control: a receptionist can call
// the function directly and get the name until the database itself changes. Do not describe this as protection.
//
// Fixed error messages: no name, term or id is ever in a thrown message or a log line.

export const DESK_NAME_ON_FILE = "Name on file";
export const DESK_FIELD_MAX = 120;

export const DESK_STATUSES = ["confirmed", "completed", "cancelled", "no_show"] as const;
export type DeskStatus = (typeof DESK_STATUSES)[number] | "unknown";

export type DeskScheduleRow = {
  startsAt: string;
  endsAt: string;
  status: DeskStatus;
  durationMinutes: number | null;
  /** The studio's IANA zone from the database; empty when unreadable (the page says so). */
  studioTimezone: string;
  practitionerName: string;
  serviceName: string;
  /** Always exactly DESK_NAME_ON_FILE. No client name of any kind reaches the desk. */
  clientName: typeof DESK_NAME_ON_FILE;
};

type RpcResult = { data: unknown; error: unknown };
export type DeskRpc = { rpc: (fn: "receptionist_calendar_v2", args: Record<string, unknown>) => PromiseLike<RpcResult> };

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t.slice(0, DESK_FIELD_MAX) : null;
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

export function mapDeskScheduleRow(raw: unknown): DeskScheduleRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isIso(r.starts_at) || !isIso(r.ends_at)) return null;
  return {
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: (DESK_STATUSES as readonly unknown[]).includes(r.status) ? (r.status as DeskStatus) : "unknown",
    durationMinutes: typeof r.duration_minutes === "number" && Number.isInteger(r.duration_minutes) && r.duration_minutes > 0 && r.duration_minutes <= 1440 ? r.duration_minutes : null,
    studioTimezone: text(r.studio_timezone) ?? "",
    practitionerName: text(r.practitioner_display_name) ?? "Practitioner",
    serviceName: text(r.service_name) ?? "Appointment",
    clientName: DESK_NAME_ON_FILE,
  };
}

export async function readDeskSchedule(db: DeskRpc, studioId: string, fromIso: string, toIso: string): Promise<DeskScheduleRow[]> {
  const res = await db.rpc("receptionist_calendar_v2", { p_studio_id: studioId, p_from: fromIso, p_to: toIso });
  if (res.error || !Array.isArray(res.data)) throw new Error("Failed to load schedule");
  return res.data.map(mapDeskScheduleRow).filter((r): r is DeskScheduleRow => r !== null);
}
