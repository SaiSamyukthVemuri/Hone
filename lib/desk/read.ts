// The desk's reads: the two held RPCs of migration 0274 and nothing else. No table is read by the
// desk (Privacy R1/R7): the database projects display identity, contact, booking and form STATUS,
// and these functions only normalise the input and name the output columns.
//
// Fixed error messages: no term, name, email or phone is ever in a thrown message or a log line
// (Privacy S6/R5). A fact that cannot be read is "unavailable", never a positive status (R7).
//
// Pure of I/O except the one injected rpc function. Importable from server code only by convention
// (the page and the action); the types are importable anywhere.

export const DESK_PAGE_SIZE = 25;
/** Privacy R2: offset + limit never exceeds this, so the list cannot be walked end to end. */
export const DESK_MAX_WINDOW = 200;
export const DESK_MIN_QUERY_FOR_PAGING = 2;
export const DESK_MAX_QUERY_LENGTH = 100;

export type DeskFilter = "intake_review" | "no_upcoming";
export type DeskSort = "name" | "next";
export type DeskIntake = "not_submitted" | "awaiting_review" | "reviewed" | "unavailable";

export type DeskDirectoryInput = { q: string; filters: DeskFilter[]; sort: DeskSort; page: number };

export type DeskClientRow = {
  id: string;
  displayName: string;
  /** True when the shown name is the stored name with no preferred name (labelled "Name on file"). */
  nameOnFile: boolean;
  phone: string | null;
  email: string | null;
  nextAppointmentAt: string | null;
  /** A calendar date (YYYY-MM-DD), never finer (R7). */
  lastVisitOn: string | null;
  intake: DeskIntake;
  /** The studio's required treatment consent only; null when it could not be read. */
  consentSigned: boolean | null;
};

export type DeskDirectoryPage = {
  rows: DeskClientRow[];
  total: number;
  page: number;
  pageCount: number;
  /** True when more clients match than the window shows: refine the search (R2). */
  capped: boolean;
};

export type DeskScheduleRow = {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  practitionerName: string;
  serviceName: string;
  displayName: string;
  nameOnFile: boolean;
};

type RpcResult = { data: unknown; error: unknown };
export type DeskRpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };

const FILTERS: readonly DeskFilter[] = ["intake_review", "no_upcoming"];

function one(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** Collapse whitespace, trim, bound the length. The database does the matching (display name, email, digits-only phone). */
export function normalizeDeskQuery(raw: unknown): string {
  return (one(raw) ?? "").replace(/\s+/g, " ").trim().slice(0, DESK_MAX_QUERY_LENGTH);
}

export function parseDeskDirectoryInput(raw: {
  q?: unknown;
  filters?: unknown;
  sort?: unknown;
  page?: unknown;
}): DeskDirectoryInput {
  const q = normalizeDeskQuery(raw.q);
  const asked = ([] as unknown[]).concat(raw.filters ?? []);
  const filters = FILTERS.filter((f) => asked.includes(f));
  const sort: DeskSort = one(raw.sort) === "next" ? "next" : "name";
  const n = Number.parseInt(one(raw.page) ?? "1", 10);
  let page = Number.isFinite(n) && n >= 1 ? n : 1;
  // R2: no browse past the first page without a real search term, and never past the window.
  if (q.length < DESK_MIN_QUERY_FOR_PAGING) page = 1;
  page = Math.min(page, Math.floor(DESK_MAX_WINDOW / DESK_PAGE_SIZE));
  return { q, filters, sort, page };
}

const INTAKE: readonly DeskIntake[] = ["not_submitted", "awaiting_review", "reviewed"];

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function mapDeskClientRow(raw: unknown): DeskClientRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.client_id);
  const displayName = str(r.display_name);
  if (!id || !displayName) return null;
  return {
    id,
    displayName,
    nameOnFile: r.name_on_file === true,
    phone: str(r.phone),
    email: str(r.email),
    nextAppointmentAt: str(r.next_appointment_at),
    lastVisitOn: str(r.last_visit_on)?.slice(0, 10) ?? null,
    intake: INTAKE.includes(r.intake_state as DeskIntake) ? (r.intake_state as DeskIntake) : "unavailable",
    consentSigned: typeof r.consent_signed === "boolean" ? r.consent_signed : null,
  };
}

export async function readDeskDirectory(
  db: DeskRpc,
  studioId: string,
  input: DeskDirectoryInput,
): Promise<DeskDirectoryPage> {
  const offset = (input.page - 1) * DESK_PAGE_SIZE;
  const res = await db.rpc("receptionist_client_directory", {
    p_studio_id: studioId,
    p_query: input.q.length > 0 ? input.q : null,
    p_filters: input.filters,
    p_sort: input.sort,
    p_offset: offset,
    p_limit: DESK_PAGE_SIZE,
  });
  if (res.error || !Array.isArray(res.data)) throw new Error("Failed to load clients");
  const rows = res.data.map(mapDeskClientRow).filter((r): r is DeskClientRow => r !== null);
  const first = (res.data[0] ?? {}) as Record<string, unknown>;
  const totalRaw = Number(first.total_count ?? 0);
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : rows.length;
  // Without a real search term only the first page exists (R2); with one, the window is capped.
  const reachable =
    input.q.length >= DESK_MIN_QUERY_FOR_PAGING ? DESK_MAX_WINDOW : DESK_PAGE_SIZE;
  const shown = Math.min(total, reachable);
  return {
    rows,
    total,
    page: input.page,
    pageCount: Math.max(1, Math.ceil(shown / DESK_PAGE_SIZE)),
    capped: total > reachable,
  };
}

export async function readDeskSchedule(
  db: DeskRpc,
  studioId: string,
  fromIso: string,
  toIso: string,
): Promise<DeskScheduleRow[]> {
  const res = await db.rpc("receptionist_calendar_v2", { p_studio_id: studioId, p_from: fromIso, p_to: toIso });
  if (res.error || !Array.isArray(res.data)) throw new Error("Failed to load schedule");
  const out: DeskScheduleRow[] = [];
  for (const raw of res.data) {
    const r = raw as Record<string, unknown>;
    const appointmentId = str(r.appointment_id);
    const startsAt = str(r.starts_at);
    const endsAt = str(r.ends_at);
    const displayName = str(r.display_name);
    if (!appointmentId || !startsAt || !endsAt || !displayName) continue;
    out.push({
      appointmentId,
      startsAt,
      endsAt,
      status: str(r.status) ?? "unknown",
      practitionerName: str(r.practitioner_display_name) ?? "Practitioner",
      serviceName: str(r.service_name) ?? "Appointment",
      displayName,
      nameOnFile: r.name_on_file === true,
    });
  }
  return out;
}
