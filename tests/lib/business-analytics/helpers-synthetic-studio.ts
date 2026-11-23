import type { SupabaseClient } from "@supabase/supabase-js";

// A synthetic studio behind a fake supabase client that really implements the appointments keyset query (filters, ordering, the (starts_at, id) cursor and the
// API's 1000-row truncation). Shared by the Overview read's equivalence tests and the Overview build's golden test. Deterministic: no clock, no randomness.

export type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };
const SERVER_MAX_ROWS = 1000;

export function table(name: string, rows: Row[], log: { appointmentReads: number; appointmentPages: number }, failAppointmentsAt?: number) {
  const filters: Filter[] = [];
  let order: string[] = [];
  let limit = SERVER_MAX_ROWS;
  let headCount = false;
  const keyset = (or: string) => {
    const m = /^starts_at\.gt\."(.+?)",and\(starts_at\.eq\."(.+?)",id\.gt\."(.+?)"\)$/.exec(or);
    if (!m) throw new Error(`unsupported or(): ${or}`);
    const gt = Date.parse(m[1]);
    return (r: Row) => (r.__t as number) > gt || ((r.__t as number) === Date.parse(m[2]) && (r.id as string) > m[3]);
  };
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get: (_t, prop: string) => {
      if (prop === "then")
        return (res: (v: unknown) => void) => {
          if (headCount) return res({ data: null, count: rows.filter((r) => filters.every((f) => (f.op === "eq" ? r[f.col] === f.val : true))).length, error: null });
          if (name === "appointments") {
            log.appointmentPages += 1;
            if (failAppointmentsAt !== undefined && log.appointmentPages === failAppointmentsAt) return res({ data: null, error: { message: "boom" } });
          }
          let out = rows.filter((r) =>
            filters.every((f) => {
              if (f.op === "eq") return r[f.col] === f.val;
              if (f.op === "is") return r[f.col] === f.val;
              if (f.op === "in") return (f.val as unknown[]).includes(r[f.col]);
              if (f.op === "gte") return (r.__t as number) >= Date.parse(f.val as string);
              if (f.op === "lt") return (r.__t as number) < Date.parse(f.val as string);
              if (f.op === "or") return (f.val as (r: Row) => boolean)(r);
              return true;
            }),
          );
          // the appointments are built already in (starts_at, id) order, which is the only order the loader asks for
          if (order.length && name !== "appointments") out = [...out].sort((a, b) => order.reduce((acc, c) => acc || (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0), 0));
          res({ data: out.slice(0, Math.min(limit, SERVER_MAX_ROWS)), error: null });
        };
      return (...args: unknown[]) => {
        if (prop === "eq" || prop === "gte" || prop === "lt" || prop === "is") filters.push({ op: prop, col: args[0] as string, val: args[1] });
        else if (prop === "in") filters.push({ op: "in", col: args[0] as string, val: args[1] });
        else if (prop === "or") filters.push({ op: "or", col: "", val: keyset(args[0] as string) });
        else if (prop === "order") order.push(args[0] as string);
        else if (prop === "limit") limit = args[0] as number;
        else if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) headCount = true;
        else if (prop === "select" && name === "appointments") log.appointmentReads += 1;
        return self;
      };
    },
  });
  return self;
}

export function studioClient(data: { appointments: Row[]; settlements: Row[]; clients: Row[] }, failAppointmentsAt?: number) {
  const log = { appointmentReads: 0, appointmentPages: 0 };
  const client = {
    from: (t: string) => {
      const rows =
        t === "appointments" ? data.appointments
        : t === "appointment_settlements" ? data.settlements
        : t === "clients" ? data.clients
        : t === "practitioners" ? [{ id: "pr-1", display_name: "Ada Example", active: true }, { id: "pr-2", display_name: "Bo Example", active: true }]
        : [];
      return table(t, rows, log, t === "appointments" ? failAppointmentsAt : undefined);
    },
  } as unknown as SupabaseClient;
  return { client, log };
}

export const STUDIO = "22222222-2222-4222-8222-222222222222";
export const studio = { id: STUDIO, timezone: "America/Toronto" };
export const NOW = new Date("2026-11-19T18:00:00Z");
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** About 1,100 appointments straddling now (May 2026 to Jan 2027): several 500-row pages, tied start times (the keyset's tie-break), every status, two practitioners. */
export function synthetic(total = 1100) {
  const appointments: Row[] = [];
  const settlements: Row[] = [];
  const statuses = ["completed", "completed", "completed", "confirmed", "cancelled", "no_show"];
  const base = Date.parse("2026-05-01T14:00:00Z");
  for (let i = 0; i < total; i++) {
    // two appointments share every start (different practitioners), so the (starts_at, id) cursor is exercised on ties
    const startsAt = new Date(base + Math.floor(i / 2) * 12 * 3600_000).toISOString().replace(".000Z", "+00:00");
    const status = statuses[i % statuses.length];
    appointments.push({ id: id(i + 1), studio_id: STUDIO, client_id: id(100000 + (i % 180)), starts_at: startsAt, status, practitioner_id: i % 2 ? "pr-2" : "pr-1", service_id: null, duration_minutes: 30 + (i % 3) * 15 });
    if (status === "completed") settlements.push({ appointment_id: id(i + 1), studio_id: STUDIO, superseded_at: null, method: i % 4 ? "paid_cash" : "paid_e_transfer", amount_cents: 6000 + (i % 7) * 500, currency: "cad", quoted_amount_cents: 6000 + (i % 7) * 500 });
  }
  const clients = Array.from({ length: 180 }, (_, c) => ({ id: id(100000 + c), studio_id: STUDIO, archived_at: null, name: `Client ${c}`, preferred_name: null }));
  for (const a of appointments) Object.defineProperty(a, "__t", { value: Date.parse(a.starts_at as string), enumerable: false });
  return { appointments, settlements, clients };
}

