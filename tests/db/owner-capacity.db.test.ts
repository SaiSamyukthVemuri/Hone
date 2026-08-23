import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import {
  addDays,
  localDateString,
  localTimeString,
  todayInTz,
  utcInstantFromLocal,
} from "@/lib/booking/tz";
import { getOwnerCapacityBriefing } from "@/lib/dashboard/owner-capacity";
import { capacityWeeks } from "@/lib/dashboard/owner-capacity-model";
import type { Studio } from "@/lib/types/database";
import { adminQuery, seedMember, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// OWNER CAPACITY — proved against the REAL migrated database
// ===========================================================================
//
// Real rows, real RLS, real triggers: every appointment below materialises its
// own studio_calendar_reservations shadow through the shipped triggers, and the
// briefing reads that shadow the way the booking page does. Nothing is mocked
// except Next's cookie store, which this process has no request to supply.
//
// The seed is built so each claim has a control: a client record that is not an
// active treatment client, a repeat consultation that must not count as
// new-client demand, a consultation too recent to have had a chance to convert,
// a conversion that happened too late, a block that must remove capacity, and a
// studio with no treatment plans at all whose active-client count must come back
// UNKNOWN rather than 0.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TZ = "America/Toronto";
const BUFFER_MINUTES = 15;

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

// ---------------------------------------------------------------------------
// PostgREST request capture — the round-trip record for this page
// ---------------------------------------------------------------------------

const ALL_REQUESTS: string[] = [];

function installCapture(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("/rest/v1/")) {
      ALL_REQUESTS.push(
        url.replace(E2E_SUPABASE_URL, "").replace("/rest/v1/", "").split("?")[0],
      );
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const at = (dateStr: string, hhmm: string) => utcInstantFromLocal(dateStr, hhmm, TZ);

async function newClient(studioId: string, name: string, archived = false): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name, archived_at)
     values ($1, $2, $3, case when $4 then now() else null end)`,
    [id, studioId, name, archived],
  );
  return id;
}

async function seedAppointment(opts: {
  studioId: string;
  clientId: string;
  serviceId: string;
  dateStr: string;
  start: string;
  end: string;
  status: "confirmed" | "completed";
}): Promise<void> {
  const startsAt = at(opts.dateStr, opts.start);
  const endsAt = at(opts.dateStr, opts.end);
  const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
  await adminQuery(
    `insert into public.appointments
       (studio_id, client_id, service_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      opts.studioId,
      opts.clientId,
      opts.serviceId,
      startsAt.toISOString(),
      endsAt.toISOString(),
      minutes,
      BUFFER_MINUTES,
      new Date(endsAt.getTime() + BUFFER_MINUTES * 60_000).toISOString(),
      opts.status,
    ],
  );
}

type Session = { access_token: string; refresh_token: string };

/** A real local GoTrue user, repointed at an existing practitioner row. */
async function signIn(practitionerId: string, label: string): Promise<Session> {
  const email = `${label}-${randomUUID().slice(0, 8)}@harness.local`;
  const password = `Pw-${randomUUID()}`;
  const created = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: E2E_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`local GoTrue createUser failed: ${created.status}`);
  const authUser = (await created.json()) as { id: string };
  await adminQuery(
    "update public.practitioners set user_id = $2, email = $3 where id = $1",
    [practitionerId, authUser.id, email],
  );
  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  return (await token.json()) as Session;
}

/** The cookies the app would hold for `accessToken`, written by @supabase/ssr itself. */
async function cookiesFor(accessToken: string, refreshToken: string): Promise<Map<string, string>> {
  const local = new Map<string, string>();
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...local.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) =>
        list.forEach(({ name, value }) => local.set(name, value)),
    },
  });
  await writer.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (local.size === 0) throw new Error("no auth cookie was written");
  return local;
}

/**
 * A client whose reads on ONE table resolve with `{ data: null, error }` — the
 * shape supabase-js really returns on a transient failure. It does not reject,
 * which is exactly how a discarded error becomes an empty row set.
 */
function failingOn(table: string): SupabaseClient {
  const build = (name: string) => {
    const result =
      name === table
        ? { data: null, error: { code: "57014" }, count: null }
        : { data: [], error: null, count: 0 };
    const builder: Record<string | symbol, unknown> = {};
    const proxy: unknown = new Proxy(builder, {
      get: (_t, prop) =>
        prop === "then"
          ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(result).then(res, rej)
          : () => proxy,
    });
    return proxy;
  };
  return { from: (name: string) => build(name) } as unknown as SupabaseClient;
}

function authedClient(accessToken: string): SupabaseClient {
  return createSupabaseClient(E2E_SUPABASE_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

const todayLocal = todayInTz(TZ);
const WEEKS = capacityWeeks(todayLocal);
/** Sunday of week 2: entirely in the future, so no "rest of today" clipping. */
const W2 = WEEKS[2].startLocal;

let studio: Studio;
let ownerClient: SupabaseClient;
let ownerCookies: Map<string, string>;
let memberCookies: Map<string, string>;
let planlessStudio: Studio;
let planlessClient: SupabaseClient;
let renderPage: () => Promise<unknown>;

async function loadStudio(studioId: string): Promise<Studio> {
  const { rows } = await adminQuery("select * from public.studios where id = $1", [studioId]);
  return rows[0] as Studio;
}

describe("owner capacity briefing", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

    const seed = await seedStudio(`cap-${randomUUID().slice(0, 6)}`);
    const studioId = seed.studioId;
    await adminQuery(
      `update public.studios
          set timezone = $2, buffer_minutes = $3, default_appointment_duration_minutes = 60
        where id = $1`,
      [studioId, TZ, BUFFER_MINUTES],
    );

    // Services. The consultation predicate reads services.modality.
    const consultationId = randomUUID();
    const treatmentId = randomUUID();
    await adminQuery(
      `insert into public.services (id, studio_id, name, modality, default_duration_minutes)
       values ($1, $2, 'New Client Consultation', 'consultation', 30),
              ($3, $2, 'Electrolysis', 'electrolysis', 60)`,
      [consultationId, studioId, treatmentId],
    );

    // Open every weekday 09:00–17:00 …
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id, day_of_week, is_open, open_time, close_time)
       select $1, g, true, '09:00', '17:00' from generate_series(0, 6) g`,
      [studioId],
    );
    // … then close everything from today up to the Sunday of week 2, so the
    // openings the briefing reports can only come from the seeded week.
    for (let day = todayLocal; day < W2; day = addDays(day, 1)) {
      await adminQuery(
        `insert into public.studio_availability_overrides
           (studio_id, effective_date, is_open) values ($1, $2, false)`,
        [studioId, day],
      );
    }
    // A full-day closure inside week 3, and a one-hour block inside week 2.
    await adminQuery(
      `insert into public.studio_blockouts (studio_id, starts_on, ends_on) values ($1, $2, $2)`,
      [studioId, addDays(W2, 7)],
    );
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id, starts_at, ends_at, category)
       values ($1, $2, $3, 'lunch')`,
      [
        studioId,
        at(addDays(W2, 2), "12:00").toISOString(),
        at(addDays(W2, 2), "13:00").toISOString(),
      ],
    );

    // --- clients ----------------------------------------------------------
    const c = {
      new1: await newClient(studioId, "New One"),
      new2: await newClient(studioId, "New Two"),
      new3: await newClient(studioId, "New Three"),
      repeat: await newClient(studioId, "Returning"),
      convYes: await newClient(studioId, "Converted"),
      convNo: await newClient(studioId, "Not Converted"),
      convLate: await newClient(studioId, "Converted Late"),
      immature: await newClient(studioId, "Consulted Recently"),
      stranded: await newClient(studioId, "Active No Future"),
      one: await newClient(studioId, "Active One Booking"),
      three: await newClient(studioId, "Active Three Bookings"),
      closedPlan: await newClient(studioId, "Plan Closed"),
      archived: await newClient(studioId, "Archived", true),
    };

    // Treatment plans — the ONE authority for "in active treatment".
    for (const [clientId, status] of [
      [c.stranded, "active"],
      [c.one, "active"],
      [c.three, "active"],
      [c.closedPlan, "closed"],
    ] as const) {
      await adminQuery(
        `insert into public.treatment_plans (studio_id, client_id, name, status)
         values ($1, $2, 'Plan', $3)`,
        [studioId, clientId, status],
      );
    }

    const appt = (
      clientId: string,
      serviceId: string,
      dateStr: string,
      start: string,
      end: string,
      status: "confirmed" | "completed",
    ) => seedAppointment({ studioId, clientId, serviceId, dateStr, start, end, status });

    // --- future consultations (new-client demand) -------------------------
    // Placed at 07:00, before the studio opens, so they cannot disturb the
    // capacity arithmetic the seeded week is built to prove.
    await appt(c.new1, consultationId, addDays(todayLocal, 3), "07:00", "07:30", "confirmed");
    await appt(c.new2, consultationId, addDays(todayLocal, 10), "07:00", "07:30", "confirmed");
    await appt(c.new3, consultationId, addDays(todayLocal, 24), "07:00", "07:30", "confirmed");
    // The control: a REPEAT consultation for someone already treated here.
    await appt(c.repeat, treatmentId, addDays(todayLocal, -50), "10:00", "11:00", "completed");
    await appt(c.repeat, consultationId, addDays(todayLocal, 5), "07:00", "07:30", "confirmed");

    // --- the conversion cohort --------------------------------------------
    await appt(c.convYes, consultationId, addDays(todayLocal, -30), "10:00", "10:30", "completed");
    await appt(c.convYes, treatmentId, addDays(todayLocal, -25), "10:00", "11:00", "completed");
    await appt(c.convNo, consultationId, addDays(todayLocal, -30), "11:00", "11:30", "completed");
    await appt(c.convLate, consultationId, addDays(todayLocal, -60), "10:00", "10:30", "completed");
    // 20 days later: a real return, but outside the 14-day window.
    await appt(c.convLate, treatmentId, addDays(todayLocal, -40), "10:00", "11:00", "completed");
    // Too recent to have had its chance — must be on neither side of the ratio.
    await appt(c.immature, consultationId, addDays(todayLocal, -5), "10:00", "10:30", "completed");
    await appt(c.stranded, treatmentId, addDays(todayLocal, -45), "10:00", "11:00", "completed");

    // --- the seeded week (week 2) ------------------------------------------
    await appt(c.three, treatmentId, W2, "09:00", "12:00", "confirmed");
    await appt(c.three, treatmentId, W2, "13:00", "17:00", "confirmed");
    await appt(c.one, treatmentId, addDays(W2, 1), "09:00", "15:45", "confirmed");
    await appt(c.three, treatmentId, addDays(W2, 3), "09:00", "10:00", "confirmed");

    studio = await loadStudio(studioId);

    // --- identities ---------------------------------------------------------
    const ownerSession = await signIn(seed.practitionerId, "cap-owner");
    ownerClient = authedClient(ownerSession.access_token);
    ownerCookies = await cookiesFor(
      ownerSession.access_token,
      ownerSession.refresh_token,
    );

    // An ORDINARY practitioner in the SAME studio: the control for owner-only.
    const member = await seedMember(seed, "cap-member");
    const memberSession = await signIn(member.practitionerId, "cap-member");
    memberCookies = await cookiesFor(
      memberSession.access_token,
      memberSession.refresh_token,
    );

    // --- a studio that keeps NO treatment plans ----------------------------
    const planless = await seedStudio(`cap-noplan-${randomUUID().slice(0, 6)}`);
    await adminQuery("update public.studios set timezone = $2 where id = $1", [
      planless.studioId,
      TZ,
    ]);
    planlessStudio = await loadStudio(planless.studioId);
    const planlessSession = await signIn(planless.practitionerId, "cap-noplan");
    planlessClient = authedClient(planlessSession.access_token);

    renderPage = (await import("@/app/(app)/dashboard/capacity/page"))
      .default as unknown as () => Promise<unknown>;
    installCapture();
  }, 120_000);

  // -------------------------------------------------------------------------
  // Client definitions
  // -------------------------------------------------------------------------

  it("counts client records and active treatment clients as DIFFERENT numbers", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    // 13 non-archived rows (the archived one is excluded), 3 of whom have an
    // open treatment plan. Collapsing these two would be the headline error.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 13 });
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 3 });
  });

  it("places an active client with no future treatment in the no-future group, and one with a booking outside it", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({ known: true, value: 1 });
    expect(b.depth).toEqual({
      known: true,
      value: { zero: 1, oneOrMore: 2, twoOrMore: 1, threeOrMore: 1 },
    });
  });

  it("reports the treatment time already committed, buffers excluded", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    // 3h + 4h + 6h45m + 1h of real treatment, carried as exact minutes.
    // Deliberately NOT the booked capacity figure below, which includes each
    // appointment's protected buffer, and deliberately not rounded to hours:
    // 885 minutes is 14h45m, and "14.8" would be a quarter-hour of fiction.
    expect(b.futureTreatmentMinutes).toEqual({ known: true, value: 885 });
  });

  // -------------------------------------------------------------------------
  // Consultations
  // -------------------------------------------------------------------------

  it("counts first-ever consultations per horizon and ignores a repeat", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    // The returning client's consultation at +5 days would land in all three
    // buckets if repeats counted.
    expect(b.newDemand.consultationsByDays).toEqual({
      known: true,
      value: { 7: 1, 14: 2, 28: 3 },
    });
  });

  it("excludes an immature consultation from the conversion denominator and counts a converted one", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    // Cohort: converted, not-converted, converted-too-late. The 5-day-old
    // consultation is excluded from BOTH sides — it is unfinished, not failed.
    expect(b.newDemand.conversion).toEqual({
      known: true,
      value: { converted: 1, matured: 3, percent: 33 },
    });
  });

  // -------------------------------------------------------------------------
  // Slots
  // -------------------------------------------------------------------------

  it("returns the next 30/60/90 openings from legal availability, never from blocked or booked time", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    if (!b.access.known) throw new Error(`expected openings: ${b.access.reason}`);
    const local = (iso: string | null) =>
      iso ? `${localDateString(new Date(iso), TZ)} ${localTimeString(new Date(iso), TZ)}` : null;
    const byDuration = new Map(b.access.value.map((o) => [o.durationMinutes, o]));

    // 30 min: the 45-minute gap between the two Sunday appointments, starting
    // exactly at the first one's protected end — not one minute earlier.
    expect(local(byDuration.get(30)!.startsAt)).toBe(`${W2} 12:15`);
    // 60 min: that gap cannot hold a 60-minute treatment AND its buffer, so the
    // first one is the next day's closing hour.
    expect(local(byDuration.get(60)!.startsAt)).toBe(`${addDays(W2, 1)} 16:00`);
    // 90 min: not until a day with a long enough clear window.
    expect(local(byDuration.get(90)!.startsAt)).toBe(`${addDays(W2, 2)} 09:00`);

    // Every reported opening is after every closed day.
    for (const opening of b.access.value) {
      expect(opening.startsAt).not.toBeNull();
      expect(localDateString(new Date(opening.startsAt!), TZ) >= W2).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Capacity
  // -------------------------------------------------------------------------

  it("gives a closed week no bookable hours at all", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    if (!b.weeks.known) throw new Error(`expected weeks: ${b.weeks.reason}`);
    expect(b.weeks.value[0].netBookableMinutes).toBe(0);
    expect(b.weeks.value[1].netBookableMinutes).toBe(0);
    expect(b.weeks.value[0].bookedPercent).toBeNull();
  });

  it("subtracts a block from net capacity and appointment occupancy from free hours", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    if (!b.weeks.known) throw new Error(`expected weeks: ${b.weeks.reason}`);
    const week = b.weeks.value[2];
    // 7 open days x 8h = 3360 minutes, less the one-hour block on the Tuesday.
    // ANTI-VACUITY: ignoring the block leaves 3360 here.
    expect(week.netBookableMinutes).toBe(3300);
    // Appointment time INCLUDING each one's protected buffer.
    expect(week.bookedMinutes).toBe(930);
    expect(week.freeMinutes).toBe(2370);
    expect(week.bookedPercent).toBe(28);
    // Free time is not free treatments: 39h30m free, 29 bookable openings.
    expect(week.usableOpenings).toBe(29);
  });

  it("removes a full-day closure from the week that contains it", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    if (!b.weeks.known) throw new Error(`expected weeks: ${b.weeks.reason}`);
    // Week 3 holds the blockout: six open days, not seven.
    expect(b.weeks.value[3].netBookableMinutes).toBe(6 * 8 * 60);
  });

  it("cuts weeks on the studio's own Sunday boundary", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    if (!b.weeks.known) throw new Error(`expected weeks: ${b.weeks.reason}`);
    expect(b.weeks.value).toHaveLength(8);
    expect(b.weeks.value[2].startLocal).toBe(W2);
    expect(b.weeks.value[0].isCurrentWeek).toBe(true);
    // The studio-local calendar, not UTC: the boundary instants are Toronto
    // midnight, which is 04:00 or 05:00 UTC depending on the season.
    expect(localTimeString(at(W2, "00:00"), TZ)).toBe("00:00");
  });

  // -------------------------------------------------------------------------
  // UNKNOWN
  // -------------------------------------------------------------------------

  it("a studio with no treatment plans reports UNKNOWN active clients, not zero", async () => {
    const b = await getOwnerCapacityBriefing(planlessStudio, planlessClient);
    expect(b.clients.totalRecords.known).toBe(true);
    expect(b.clients.activeTreatment.known).toBe(false);
    if (b.clients.activeTreatment.known) throw new Error("unreachable");
    expect(b.clients.activeTreatment.reason).toContain("It is not zero");
    // And everything derived from that set inherits the unknown.
    expect(b.depth.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
  });

  it("keeps the admission count UNKNOWN while the studio records none of the required evidence", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    expect(b.admission.kind).toBe("unknown");
    if (b.admission.kind !== "unknown") throw new Error("unreachable");
    // Four facts Hone does not hold. Any of them silently defaulting to 0 would
    // let this page answer a question it cannot answer.
    expect(b.admission.missing).toHaveLength(4);
    expect(b.admission.missing.join(" ")).toContain("lead-time target");
    expect(b.admission.missing.join(" ")).toContain("intake cap");
  });

  // -------------------------------------------------------------------------
  // Owner authority and read shape
  // -------------------------------------------------------------------------

  it("renders for the owner", async () => {
    jar.clear();
    for (const [k, v] of ownerCookies) jar.set(k, v);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const markup = renderToStaticMarkup((await renderPage()) as never);
    expect(markup).toContain("Practice capacity");
    expect(markup).toContain("Admission capacity");
  }, 30_000);

  it("refuses an ordinary practitioner, and issues NO studio-wide analytics query for them", async () => {
    jar.clear();
    for (const [k, v] of memberCookies) jar.set(k, v);
    const from = ALL_REQUESTS.length;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const markup = renderToStaticMarkup((await renderPage()) as never);
    expect(markup).toContain("Only studio owners");
    expect(markup).not.toContain("Admission capacity");
    // The refusal happens BEFORE the briefing is loaded: the only table read is
    // the practitioner identity the gate itself needs.
    expect([...new Set(ALL_REQUESTS.slice(from))]).toEqual(["practitioners"]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Read soundness — a read that did not return the truth must not be consumed
  // -------------------------------------------------------------------------

  it("FAILS CLOSED when a read errors, rather than reporting a free calendar", async () => {
    // supabase-js RESOLVES with { data: null, error } on a transient failure.
    // Read as an empty row set, that renders zero booked hours, a wholly free
    // calendar and a confident next opening — on an admission screen.
    await expect(
      getOwnerCapacityBriefing(studio, failingOn("studio_calendar_reservations")),
    ).rejects.toThrow(/owner_capacity_read_failed:studio_calendar_reservations/);
  });

  it("reads PAST the Data API row ceiling instead of calling 1,000 rows complete", async () => {
    // supabase/config.toml sets max_rows = 1000, so PostgREST truncates a
    // response before any app-side limit is reached. The client whose plan is
    // asserted below is the LAST one in id order, so it can only be seen by a
    // read that went past the first page.
    const big = await seedStudio(`cap-page-${randomUUID().slice(0, 6)}`);
    await adminQuery("update public.studios set timezone = $2 where id = $1", [
      big.studioId,
      TZ,
    ]);
    await adminQuery(
      `insert into public.clients (studio_id, name)
       select $1, 'Paged ' || g from generate_series(1, 1049) g`,
      [big.studioId],
    );
    const last = await adminQuery(
      "select id from public.clients where studio_id = $1 order by id desc limit 1",
      [big.studioId],
    );
    await adminQuery(
      `insert into public.treatment_plans (studio_id, client_id, name, status)
       values ($1, $2, 'Plan', 'active')`,
      [big.studioId, last.rows[0].id],
    );
    const bigStudio = await loadStudio(big.studioId);
    const session = await signIn(big.practitionerId, "cap-page");
    const b = await getOwnerCapacityBriefing(bigStudio, authedClient(session.access_token));

    // 1049 seeded + the one seedStudio creates. A ceiling-blind read reported
    // 1,000 here and called it complete.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1050 });
    // And the plan intersection saw the client that lives beyond page one.
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
  }, 60_000);

  it("answers the owner in two waves of batched reads, with no per-day or per-client query", async () => {
    jar.clear();
    for (const [k, v] of ownerCookies) jar.set(k, v);
    const from = ALL_REQUESTS.length;
    const { renderToStaticMarkup } = await import("react-dom/server");
    renderToStaticMarkup((await renderPage()) as never);
    const taken = ALL_REQUESTS.slice(from);
    const tally: Record<string, number> = {};
    for (const table of taken) tally[table] = (tally[table] ?? 0) + 1;

    // The identity read the gate needs, then nine studio-scoped reads: eight
    // issued together, and one follow-up that needs the client ids the first
    // wave found. Fifty-six days of availability cost NOTHING extra here.
    expect(tally).toEqual({
      practitioners: 1,
      clients: 1,
      treatment_plans: 1,
      appointments: 3,
      studio_availability_default: 1,
      studio_availability_overrides: 1,
      studio_blockouts: 1,
      studio_calendar_reservations: 1,
    });
    expect(taken).toHaveLength(10);
  }, 30_000);
});
