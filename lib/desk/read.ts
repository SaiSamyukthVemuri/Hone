import { CLIENT_NAME_MAX, clientDisplayName } from "@/lib/clients/identity";
import { isPractitionerColor, type PractitionerColor } from "@/lib/practitioner-colors";

// Project only the fields displayed by the studio calendar. Contacts are fetched separately
// when a receptionist opens an appointment.
export const DESK_NAME_ON_FILE = "Name on file";
export const DESK_FIELD_MAX = 120;

export const DESK_STATUSES = ["confirmed", "completed", "cancelled", "no_show"] as const;
export type DeskStatus = (typeof DESK_STATUSES)[number] | "unknown";

export type DeskScheduleRow = {
  appointmentId: string;
  practitionerId: string | null;
  practitionerColor: PractitionerColor | null;
  startsAt: string;
  endsAt: string;
  status: DeskStatus;
  durationMinutes: number | null;
  /** The studio's IANA zone from the database; empty when unreadable (the page says so). */
  studioTimezone: string;
  practitionerName: string;
  serviceName: string;
  clientName: string;
};

type RpcResult = { data: unknown; error: unknown };
export type DeskRpc = { rpc: (fn: "receptionist_calendar_v3", args: Record<string, unknown>) => PromiseLike<RpcResult> };

export function validDeskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t.slice(0, DESK_FIELD_MAX) : null;
}

export function deskDisplayName(value: unknown): string {
  const name = clientDisplayName({ name: typeof value === "string" ? value : null });
  return Array.from(name).slice(0, CLIENT_NAME_MAX).join("") || DESK_NAME_ON_FILE;
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

export function mapDeskScheduleRow(raw: unknown): DeskScheduleRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!validDeskId(r.appointment_id) || (r.practitioner_id !== null && !validDeskId(r.practitioner_id))) return null;
  if (!isIso(r.starts_at) || !isIso(r.ends_at)) return null;
  return {
    appointmentId: r.appointment_id,
    practitionerId: r.practitioner_id,
    practitionerColor: isPractitionerColor(r.practitioner_color) ? r.practitioner_color : null,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: (DESK_STATUSES as readonly unknown[]).includes(r.status) ? (r.status as DeskStatus) : "unknown",
    durationMinutes: typeof r.duration_minutes === "number" && Number.isInteger(r.duration_minutes) && r.duration_minutes > 0 && r.duration_minutes <= 1440 ? r.duration_minutes : null,
    studioTimezone: text(r.studio_timezone) ?? "",
    practitionerName: text(r.practitioner_display_name) ?? (r.practitioner_id ? "Practitioner" : "Unassigned"),
    serviceName: text(r.service_name) ?? "Appointment",
    clientName: deskDisplayName(r.display_name),
  };
}

// PostgREST applies its own max_rows (1000 on this stack) to a function response and truncates WITH HTTP 200 and no
// error (see SESSION_BLOCK_AREA_ROW_LIMIT in lib/supabase/queries.ts, where the same cap is treated as a failed read).
// A schedule cut at the cap would look complete and silently omit the later appointments, so a response that reaches the
// cap is retried in smaller windows. If a one-day window is still saturated, report it as incomplete. The count is of the rows the database returned, before
// any row is dropped as unreadable.
export const DESK_SCHEDULE_ROW_CAP = 1000;

export class DeskScheduleIncompleteError extends Error {
  constructor() {
    super("Schedule incomplete");
    this.name = "DeskScheduleIncompleteError";
  }
}

export async function readDeskSchedule(db: DeskRpc, studioId: string, fromIso: string, toIso: string): Promise<DeskScheduleRow[]> {
  const res = await db.rpc("receptionist_calendar_v3", { p_studio_id: studioId, p_from: fromIso, p_to: toIso });
  if (res.error || !Array.isArray(res.data)) throw new Error("Failed to load schedule");
  if (res.data.length >= DESK_SCHEDULE_ROW_CAP) {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(to - from) || to - from <= 86_400_000) throw new DeskScheduleIncompleteError();
    const middle = new Date(from + Math.floor((to - from) / 2)).toISOString();
    const first = await readDeskSchedule(db, studioId, fromIso, middle);
    const second = await readDeskSchedule(db, studioId, middle, toIso);
    // Overlap queries include the same appointment on either side of the split
    // if it spans the boundary. Preserve the database's chronological order.
    const unique = new Map(first.map(row => [row.appointmentId, row]));
    for (const row of second) unique.set(row.appointmentId, row);
    return Array.from(unique.values()).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.appointmentId.localeCompare(b.appointmentId));
  }
  return res.data.map(mapDeskScheduleRow).filter((r): r is DeskScheduleRow => r !== null);
}
