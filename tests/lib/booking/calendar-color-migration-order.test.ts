import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMissingColumnError } from "@/lib/db/missing-column";

type CalendarRow = { id: string; starts_at: string; studio_id: string; practitioner: unknown; client: unknown; service: unknown };
const calendar = vi.hoisted(() => ({ rows: [] as CalendarRow[], cap: 1000, missingColor: false, failFrom: Infinity, onRead: null as null | ((page: number) => void), ignoreCursor: false, requests: [] as Array<{ from: number; studio: unknown; orders: string[]; start: string; end: string; columns: string }> }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("privileged client must not be used"); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => {
  let studio: unknown; let start = ""; let end = ""; let from = 0; let to = Infinity; let columns = "";
  const orders: string[] = [];
  let cursor: { key: keyof CalendarRow; value: string } | null = null;
  const run = () => {
    const page = calendar.requests.length;
    calendar.onRead?.(page);
    calendar.requests.push({ from, studio, orders: [...orders], start, end, columns });
    if (calendar.missingColor && columns.includes("calendar_color")) return { data: null, error: { code: "42703", message: "column services.calendar_color does not exist" } };
    if (page >= calendar.failFrom) return { data: null, error: { code: "08006", message: "synthetic private appointment diagnostic" } };
    const rows = calendar.rows.filter((r) => r.studio_id === studio && r.starts_at >= start && r.starts_at < end
      && (calendar.ignoreCursor || cursor === null || String(r[cursor.key]) > cursor.value));
    rows.sort((a, b) => {
      for (const key of orders) { const x = a[key as "id" | "starts_at"]; const y = b[key as "id" | "starts_at"]; if (x !== y) return x < y ? -1 : 1; }
      return 0;
    });
    return { data: rows.slice(from, Math.min(to + 1, from + calendar.cap)).map((row) => ({ ...row })), error: null };
  };
  const query: Record<string, unknown> = {
    select: (value: string) => { columns = value; return query; },
    eq: (key: string, value: unknown) => { if (key === "studio_id") studio = value; return query; },
    gte: (key: string, value: string) => { if (key === "starts_at") start = value; return query; },
    lt: (key: string, value: string) => { if (key === "starts_at") end = value; return query; },
    gt: (key: keyof CalendarRow, value: string) => { cursor = { key, value }; return query; },
    order: (key: string) => { orders.push(key); return query; },
    range: (a: number, b: number) => { from = a; to = b; return query; },
    then: (resolve: (value: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return query;
} }) }));
import { getAppointmentsForRange } from "@/lib/booking/queries";

beforeEach(() => { calendar.rows = []; calendar.cap = 1000; calendar.missingColor = false; calendar.failFrom = Infinity; calendar.requests = []; calendar.onRead = null; calendar.ignoreCursor = false; });

const START = "2026-10-20T00:00:00Z";
const END = "2026-10-21T00:00:00Z";
function seedAppointments(n: number) {
  calendar.rows = Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(5, "0"), starts_at: START, studio_id: "A", practitioner: [{ id: "P", color: "blue" }], client: [{ id: "C", name: "Synthetic" }], service: [{ id: "S", name: "Service", modality: "electrolysis" }] })).reverse();
  calendar.rows.push({ ...calendar.rows[0], id: "foreign", studio_id: "B" }, { ...calendar.rows[0], id: "exclusive-end", starts_at: END });
}

describe("SCH-005 calendar range completeness", () => {
  it("includes all appointments past the API ceiling, preserving studio, range and deterministic ties", async () => {
    seedAppointments(1305);
    const rows = await getAppointmentsForRange("A", START, END);
    expect(rows).toHaveLength(1305);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 1305 }, (_, i) => String(i).padStart(5, "0")));
    expect(calendar.requests.every((q) => q.studio === "A" && q.orders.includes("id"))).toBe(true);
    expect(rows[0].practitioner).toEqual({ id: "P", color: "blue" });
    expect(rows[0].client).toEqual({ id: "C", name: "Synthetic" });
  });
  it("continues paging even when the server returns fewer rows than requested", async () => {
    seedAppointments(23); calendar.cap = 7;
    expect(await getAppointmentsForRange("A", START, END)).toHaveLength(23);
  });
  it("retains pre-0153 color fallback across every page", async () => {
    seedAppointments(1305); calendar.missingColor = true;
    const rows = await getAppointmentsForRange("A", START, END);
    expect(rows).toHaveLength(1305);
    expect(rows.every((r) => r.service?.calendar_color === null)).toBe(true);
  });
  it("refuses partial ranges and private diagnostics if a later page fails", async () => {
    seedAppointments(1305); calendar.failFrom = 1;
    const result = await getAppointmentsForRange("A", START, END).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("Failed to load appointments");
  });
});

// Migration-order safety: the missing-column detector is column-scoped so the
// calendar read + settings write fall back ONLY when calendar_color is genuinely
// absent (app deployed before 0153), and NEVER swallow unrelated DB errors.
describe("isMissingColumnError — column-scoped, migration-order safe", () => {
  it("detects a missing SELECT column (42703) that names the column", () => {
    expect(isMissingColumnError({ code: "42703", message: 'column services.calendar_color does not exist' }, "calendar_color")).toBe(true);
  });
  it("detects a missing INSERT/UPDATE column (PGRST204 schema cache) that names the column", () => {
    expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'calendar_color' column of 'services' in the schema cache" }, "calendar_color")).toBe(true);
  });
  it("does NOT match a different column's undefined-column error", () => {
    expect(isMissingColumnError({ code: "42703", message: 'column services.price_cents does not exist' }, "calendar_color")).toBe(false);
  });
  it("does NOT match unrelated DB errors (permission, connection, constraint)", () => {
    for (const e of [
      { code: "42501", message: "permission denied for table services" },
      { code: "23505", message: "duplicate key value violates unique constraint" },
      { code: "08006", message: "connection failure" },
      { code: "23514", message: "new row violates check constraint services_calendar_color_allowed" },
      null,
      undefined,
    ]) {
      expect(isMissingColumnError(e, "calendar_color")).toBe(false);
    }
  });
});


describe("SCH-005 moving appointments cannot shift an unread row behind an offset", () => {
  it.each(["move outside view", "delete", "move later"])("preserves unread appointments when a prior-page row changes: %s", async (change) => {
    seedAppointments(9); calendar.cap = 3;
    calendar.onRead = (page) => {
      if (page !== 1) return;
      const prior = calendar.rows.find((row) => row.id === "00000")!;
      if (change === "delete") calendar.rows = calendar.rows.filter((row) => row !== prior);
      else prior.starts_at = change === "move outside view" ? END : "2026-10-20T23:00:00Z";
    };
    const rows = await getAppointmentsForRange("A", START, END);
    // Captured rows are snapshots, not a whole-range transaction. A change to
    // an already-read row must not drop an untouched later appointment.
    expect(rows.map((row) => row.id).sort()).toEqual(Array.from({ length: 9 }, (_, i) => String(i).padStart(5, "0")));
    expect(calendar.requests.every((q) => q.studio === "A" && q.start === START && q.end === END
      && q.columns.includes("appointments_practitioner_same_studio_fk") && q.columns.includes("client:clients"))).toBe(true);
  });

  it("includes an unread appointment moved before the prior time boundary and sorts captured instants for display", async () => {
    seedAppointments(9); calendar.cap = 3;
    calendar.rows.filter((row) => row.studio_id === "A" && row.starts_at === START).forEach((row) => { row.starts_at = "2026-10-20T12:00:00Z"; });
    calendar.onRead = (page) => { if (page === 1) calendar.rows.find((row) => row.id === "00007")!.starts_at = "2026-10-20T01:00:00Z"; };
    const rows = await getAppointmentsForRange("A", START, END);
    expect(rows.map((row) => row.id)).toEqual(["00007", "00000", "00001", "00002", "00003", "00004", "00005", "00006", "00008"]);
  });

  it("retains chronological display ordering and stable id ties separately from traversal", async () => {
    seedAppointments(3); calendar.cap = 1;
    calendar.rows.find((row) => row.id === "00000")!.starts_at = "2026-10-20T15:00:00Z";
    for (const id of ["00001", "00002"]) calendar.rows.find((row) => row.id === id)!.starts_at = "2026-10-20T09:00:00Z";
    expect((await getAppointmentsForRange("A", START, END)).map((row) => row.id)).toEqual(["00001", "00002", "00000"]);
  });

  it("refuses a repeated server page rather than silently ending with a partial range", async () => {
    seedAppointments(9); calendar.cap = 3; calendar.ignoreCursor = true;
    await expect(getAppointmentsForRange("A", START, END)).rejects.toThrow("Failed to load appointments");
  });
});
