import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-15 (BOOK-PRIVACY-01), exposure baseline. SYNTHETIC data only.
//
// What an UNAUTHENTICATED visitor can learn about schedule density from the two
// public server actions, with no login, token or client record. It pins today's
// behaviour (including the gaps) so a repair is measured against it; it changes
// nothing. The rate limiter is mocked open here on purpose: the limiter's own
// shape is pinned separately by source reads below.

const queries: Array<{ table: string; op: string }> = [];

const scenario = {
  studio: {
    id: "studio-1",
    slug: "studio-a",
    timezone: "America/Toronto",
    buffer_minutes: 0,
    default_appointment_duration_minutes: 60,
    public_booking_horizon_months: 3,
  } as Record<string, unknown> | null,
  activeServices: 1,
  serviceDuration: 60 as number | null,
  defaults: [] as Array<Record<string, unknown>>,
  overrides: [] as Array<Record<string, unknown>>,
  blockouts: [] as Array<Record<string, unknown>>,
  reservations: [] as Array<Record<string, unknown>>,
  blockoutError: null as { code: string } | null,
  reservationError: null as { code: string } | null,
  defaultsThrow: false,
};

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicSlots: async () => ({ allowed: true }),
  limitPublicBooking: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate-limited",
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://studio.example.test",
}));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => scenario.studio,
}));

// The bulk loaders are counted, not reimplemented: they are the two reads the
// range pass makes for the WHOLE window, so their call count is the headline
// number this file is about.
vi.mock("@/lib/booking/studio-wide-availability", () => ({
  getStudioWideDefaultsSafe: async () => {
    queries.push({ table: "studio_availability_default", op: "bulk" });
    if (scenario.defaultsThrow) {
      throw new Error("availability_read_failed:defaults:42501");
    }
    return scenario.defaults;
  },
  getStudioWideDaySafe: async (_s: unknown, _id: string, dow: number) =>
    scenario.defaults.find((d) => d.day_of_week === dow) ?? null,
  getStudioWideOverrideDaySafe: async (_s: unknown, _id: string, date: string) =>
    scenario.overrides.find((o) => o.effective_date === date) ?? null,
  getStudioWideOverridesSafe: async () => {
    queries.push({ table: "studio_availability_overrides", op: "bulk" });
    return scenario.overrides;
  },
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      queries.push({ table, op: "select" });
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      let page: { from: number; to: number } | null = null;
      const settle = () => {
        if (table === "services") {
          return {
            data:
              scenario.serviceDuration === null
                ? null
                : { default_duration_minutes: scenario.serviceDuration },
            count: scenario.activeServices,
            error: null,
          };
        }
        if (table === "studio_availability_default") {
          return { data: scenario.defaults, error: null };
        }
        if (table === "studio_blockouts") {
          return { data: scenario.blockouts, error: scenario.blockoutError };
        }
        if (scenario.reservationError) {
          return { data: null, error: scenario.reservationError };
        }
        const MAX_ROWS = 1000;
        const from = page?.from ?? 0;
        const to = Math.min(page?.to ?? MAX_ROWS - 1, from + MAX_ROWS - 1);
        return { data: scenario.reservations.slice(from, to + 1), error: null };
      };
      Object.assign(chain, {
        select: self, eq: self, lte: self, gte: self, lt: self, gt: self, is: self,
        order: self,
        range: (f: number, t: number) => {
          page = { from: f, to: t };
          return chain;
        },
        maybeSingle: async () => settle(),
        then: (r: (v: unknown) => unknown) => Promise.resolve(settle()).then(r),
      });
      return chain;
    },
  }),
}));

// Everything below is imported for module load only — this suite calls exactly
// one action and must not send anything.
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async () => ({ ok: true }),
  sendBookingNotificationToStudio: async () => ({ ok: true }),
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async () => ({ ok: false, skipped: true }),
}));
vi.mock("@/lib/conversion/dispatch", () => ({ dispatchBookingConversion: async () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => {} }));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: () => {},
}));
vi.mock("@/lib/intake/queries", () => ({
  ensureIntakeForClient: async () => ({ id: "i", url: "https://x/i" }),
}));


const { fetchNextAvailableDateAction, fetchPublicSlotsAction } = await import("@/app/book/[slug]/actions");

function openDay(dow: number) {
  return { day_of_week: dow, is_open: true, open_time: "09:00", close_time: "17:00" };
}
const CALL = { slug: "studio-a", serviceId: "svc-1" };

beforeEach(() => {
  queries.length = 0;
  scenario.studio = {
    id: "studio-1", slug: "studio-a", timezone: "America/Toronto",
    buffer_minutes: 0, default_appointment_duration_minutes: 60,
    public_booking_horizon_months: 3,
  };
  scenario.activeServices = 1;
  scenario.serviceDuration = 60;
  scenario.defaults = [0, 1, 2, 3, 4, 5, 6].map(openDay);
  scenario.overrides = [];
  scenario.blockouts = [];
  scenario.reservations = [];
  scenario.blockoutError = null;
  scenario.reservationError = null;
  scenario.defaultsThrow = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z")); // Monday 08:00 Toronto
});

// Full-day reservation on a Toronto local date, plus a partly busy day.
const full = (d: string) => ({ starts_at: `${d}T04:00:00.000Z`, ends_at: `${d}T23:59:00.000Z`, source_kind: "appointment", source_id: "a" });
const part = (d: string, fromUtc: string, toUtc: string) => ({ starts_at: `${d}T${fromUtc}:00.000Z`, ends_at: `${d}T${toUtc}:00.000Z`, source_kind: "appointment", source_id: "p" });

describe("HON-15 exposure today (unauthenticated visitor)", () => {
  it("EXPOSED: chaining 'next available' from each answer enumerates every open date in the horizon, one call per open date", async () => {
    const busyDays = ["2026-10-07", "2026-10-08", "2026-10-12", "2026-10-20", "2026-11-02"];
    scenario.reservations = busyDays.map(full);
    const found: string[] = [];
    let from = "2026-10-06";
    let calls = 0;
    for (;;) {
      const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: from });
      calls += 1;
      if (!r.ok || r.date === null) break;
      found.push(r.date);
      const [y, m, d] = r.date.split("-").map(Number);
      from = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      if (calls > 200) throw new Error("runaway");
    }
    // Every date from 2026-10-06 to the horizon edge that is not busy was learned,
    // so the complement (the busy days) is learned exactly.
    const all = new Set(found);
    for (const b of busyDays) expect(all.has(b), `${b} is busy and absent`).toBe(false);
    expect(all.has("2026-10-06")).toBe(true);
    expect(all.has("2026-10-09")).toBe(true);
    expect(found.length).toBeGreaterThan(60);
    expect(calls).toBe(found.length + 1); // one call per open date, plus the closing null
  });

  it("EXPOSED: a day's slot list reveals each booked interval exactly (a missing slot is a booking)", async () => {
    // 2026-10-06, 09:00-17:00 Toronto (EDT = UTC-4). Booked 11:00-13:00 local.
    scenario.reservations = [part("2026-10-06", "15:00", "17:00")];
    const r = await fetchPublicSlotsAction({ ...CALL, date: "2026-10-06" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const labels = r.slots.map((s) => s.startLabel);
    expect(labels).toContain("9:00 AM");
    expect(labels).toContain("10:00 AM");
    expect(labels).not.toContain("11:00 AM");
    expect(labels).not.toContain("12:00 PM");
    expect(labels).toContain("1:00 PM");
  });

  it("a slot carries only start, end and a label: no practitioner, no count, no client", async () => {
    const r = await fetchPublicSlotsAction({ ...CALL, date: "2026-10-06" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slots.length).toBeGreaterThan(0);
    for (const s of r.slots) expect(Object.keys(s).sort()).toEqual(["end", "start", "startLabel"]);
    expect(Object.keys(r).sort()).toEqual(["ok", "slots"]);
  });

  it("a closed or fully booked day looks the same: an empty list (no reason is given)", async () => {
    scenario.reservations = [full("2026-10-06")];
    const booked = await fetchPublicSlotsAction({ ...CALL, date: "2026-10-06" });
    scenario.reservations = [];
    scenario.blockouts = [{ starts_on: "2026-10-06", ends_on: "2026-10-06" }];
    const blocked = await fetchPublicSlotsAction({ ...CALL, date: "2026-10-06" });
    expect(booked).toEqual({ ok: true, slots: [] });
    expect(blocked).toEqual({ ok: true, slots: [] });
  });

  it("the public path is studio-wide: it never passes a practitioner, so per-practitioner availability is not exposed", async () => {
    const src = readFileSync(join(process.cwd(), "app/book/[slug]/actions.ts"), "utf8");
    const slotsFn = src.slice(src.indexOf("export async function fetchPublicSlotsAction"), src.indexOf("export async function fetchNextAvailableDateAction"));
    expect(slotsFn).not.toMatch(/practitioner/i);
    expect(slotsFn).toMatch(/default_appointment_duration_minutes[\s\S]*params\.date,\s*service\.default_duration_minutes,\s*\)/);
  });

  it("the only throttle is 60 requests per minute per (IP, studio), and it FAILS OPEN when unset or when the backend errors", () => {
    const rl = readFileSync(join(process.cwd(), "lib/rate-limit/public.ts"), "utf8");
    const fn = rl.slice(rl.indexOf("export async function limitPublicSlots"), rl.indexOf("export async function limitPublicBooking"));
    expect(rl).toContain("60 req / 60 s per (IP, slug)");
    expect(fn).toContain("if (!limiter) return { allowed: true }; // disabled when env unset");
    expect(fn).toContain("return { allowed: true }; // fail open");
    // there is no cumulative or per-day budget: the key is IP + slug only
    expect(fn).toContain("limiter.limit(`${hashId(ip)}:${args.slug}`)");
  });

  it("both actions apply the same gate before any read, and neither requires a session", () => {
    const src = readFileSync(join(process.cwd(), "app/book/[slug]/actions.ts"), "utf8");
    for (const name of ["fetchPublicSlotsAction", "fetchNextAvailableDateAction"]) {
      const start = src.indexOf(`export async function ${name}`);
      const body = src.slice(start, start + 900);
      expect(body, name).toContain("limitPublicSlots");
      expect(body, name).not.toMatch(/getCurrentPractitioner|requirePractitioner|getUser/);
    }
  });
});
