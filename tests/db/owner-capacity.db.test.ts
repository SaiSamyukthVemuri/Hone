import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import { addDays, todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import { getOwnerCapacityBriefing } from "@/lib/dashboard/owner-capacity";
import type { Studio } from "@/lib/types/database";
import { adminQuery, seedMember, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// OWNER CAPACITY (Slice 1) — proved against the REAL migrated database
// ===========================================================================
//
// Real rows, real RLS, real triggers. Nothing is mocked except Next's cookie
// store, which this process has no request to supply.
//
// The seed is built so each claim has a control: a client record that is not an
// active treatment client, an archived client holding an open plan, a
// consultation that must NOT count as treatment booked, a cancelled
// appointment that must not count at all, and a separate studio with no
// treatment plans whose active-client count must come back UNKNOWN rather
// than 0.

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

async function newService(
  studioId: string,
  name: string,
  modality: string | null,
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.services
       (id, studio_id, name, modality, default_duration_minutes, active)
     values ($1, $2, $3, $4, 60, true)`,
    [id, studioId, name, modality],
  );
  return id;
}

async function openPlan(studioId: string, clientId: string): Promise<void> {
  await adminQuery(
    `insert into public.treatment_plans (studio_id, client_id, name, suggested_visit_count, status)
     values ($1, $2, 'Plan', 6, 'active')`,
    [studioId, clientId],
  );
}

async function seedAppointment(opts: {
  studioId: string;
  clientId: string;
  serviceId: string;
  dateStr: string;
  start: string;
  end: string;
  status: "confirmed" | "completed" | "cancelled";
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
async function cookiesFor(
  accessToken: string,
  refreshToken: string,
): Promise<Map<string, string>> {
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
 * A client for `accessToken`, returned only once the token is actually usable.
 *
 * The local GoTrue and PostgREST run in separate containers whose clocks drift
 * by a second or so, so a JUST-minted JWT can be rejected with
 * `PGRST303 "JWT issued at future"` for its first moment of life. It surfaces
 * as whichever query happens to race first, which is why it looked like a
 * different table each time.
 *
 * This is a harness race, not a product defect — and it is invisible until the
 * briefing starts failing closed instead of reading an errored response as an
 * empty one, which is precisely the behaviour these tests exist to protect. The
 * fix belongs here: wait for the token, rather than teaching production to
 * retry past an auth error.
 */
async function authedClient(accessToken: string): Promise<SupabaseClient> {
  const client = createSupabaseClient(E2E_SUPABASE_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { error } = await client.from("practitioners").select("id").limit(1);
    if (error?.code !== "PGRST303") return client;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("token never became valid: PostgREST kept reporting PGRST303");
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

const todayLocal = todayInTz(TZ);
/** Comfortably in the future, so "starts_at >= now" cannot clip it. */
const SOON = addDays(todayLocal, 9);

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

beforeAll(async () => {
  installCapture();
  // The page builds its own server client from the environment the app runs
  // under; this process has none, so point it at the local stack.
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

  const seeded = await seedStudio(`cap-${randomUUID().slice(0, 6)}`);
  await adminQuery("update public.studios set timezone = $2 where id = $1", [
    seeded.studioId,
    TZ,
  ]);
  studio = await loadStudio(seeded.studioId);

  const treatment = await newService(studio.id, "Laser session", "laser");
  const consult = await newService(studio.id, "Consultation", "consultation");

  // booked: an active treatment client holding two future treatments.
  const booked = await newClient(studio.id, "Booked");
  await openPlan(studio.id, booked);
  await seedAppointment({
    studioId: studio.id,
    clientId: booked,
    serviceId: treatment,
    dateStr: SOON,
    start: "09:00",
    end: "10:00",
    status: "confirmed",
  });
  await seedAppointment({
    studioId: studio.id,
    clientId: booked,
    serviceId: treatment,
    dateStr: addDays(SOON, 7),
    start: "09:00",
    end: "09:30",
    status: "confirmed",
  });

  // quiet: an active treatment client with nothing on the calendar. THE number.
  const quiet = await newClient(studio.id, "Quiet");
  await openPlan(studio.id, quiet);

  // consulting: an active treatment client whose only future booking is a
  // CONSULTATION. A conversation booked is not treatment booked.
  const consulting = await newClient(studio.id, "Consulting");
  await openPlan(studio.id, consulting);
  await seedAppointment({
    studioId: studio.id,
    clientId: consulting,
    serviceId: consult,
    dateStr: SOON,
    start: "11:00",
    end: "12:00",
    status: "confirmed",
  });

  // cancelled: an active treatment client whose only future booking is
  // cancelled. The studio is not committed to it.
  const cancelled = await newClient(studio.id, "Cancelled");
  await openPlan(studio.id, cancelled);
  await seedAppointment({
    studioId: studio.id,
    clientId: cancelled,
    serviceId: treatment,
    dateStr: SOON,
    start: "13:00",
    end: "14:00",
    status: "cancelled",
  });

  // A plain client record with no plan: counted in records, never in treatment.
  await newClient(studio.id, "No plan");

  // An ARCHIVED client holding an open plan: history, not current care.
  const archived = await newClient(studio.id, "Archived", true);
  await openPlan(studio.id, archived);

  const ownerSession = await signIn(seeded.practitionerId, "cap-owner");
  ownerCookies = await cookiesFor(ownerSession.access_token, ownerSession.refresh_token);
  ownerClient = await authedClient(ownerSession.access_token);

  const member = await seedMember(seeded, "practitioner");
  const memberSession = await signIn(member.practitionerId, "cap-member");
  memberCookies = await cookiesFor(memberSession.access_token, memberSession.refresh_token);

  // A studio that keeps no treatment plans at all.
  const planless = await seedStudio(`cap-noplan-${randomUUID().slice(0, 6)}`);
  await adminQuery("update public.studios set timezone = $2 where id = $1", [
    planless.studioId,
    TZ,
  ]);
  planlessStudio = await loadStudio(planless.studioId);
  await newClient(planlessStudio.id, "Someone");
  const planlessSession = await signIn(planless.practitionerId, "cap-noplan");
  planlessClient = await authedClient(planlessSession.access_token);

  renderPage = async () => {
    const mod = await import("@/app/(app)/dashboard/capacity/page");
    return mod.default();
  };
}, 180_000);

// ---------------------------------------------------------------------------

describe("owner capacity briefing", () => {
  it("counts client records and active treatment clients as DIFFERENT numbers", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    // 6 non-archived: seedStudio's own client, plus booked, quiet, consulting,
    // cancelled and no-plan. The archived one is excluded even though it holds
    // an open plan.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 6 });
    // 4 hold an open plan and are not archived — a DIFFERENT number, which is
    // the whole reason both are shown.
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 4 });
  });

  it("puts the client with nothing booked in the no-future group, and the booked one outside it", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    // quiet, consulting (consultation only) and cancelled (not committed).
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 3,
    });
    expect(b.depth).toEqual({
      known: true,
      value: { zero: 3, oneOrMore: 1, twoOrMore: 1, threeOrMore: 0 },
    });
  });

  it("reports the treatment time already committed, buffers excluded", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    // 60 + 30 real treatment minutes. The 15-minute buffers on each and the
    // 60-minute consultation are all excluded.
    expect(b.futureTreatmentMinutes).toEqual({ known: true, value: 90 });
  });

  it("a studio with no treatment plans reports UNKNOWN active clients, not zero", async () => {
    const b = await getOwnerCapacityBriefing(planlessStudio, planlessClient);
    // seedStudio's own client, plus the one seeded here.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 2 });
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
  });

  it("states the basis for the active-treatment figure on the briefing itself", async () => {
    const b = await getOwnerCapacityBriefing(studio, ownerClient);
    expect(b.clients.activeTreatmentBasis).toMatch(/open treatment plan/i);
  });

  it("a studio whose ONLY open plans belong to archived clients reports UNKNOWN, not zero", async () => {
    // Against real rows: the plan is genuinely open, its client is genuinely
    // archived, and the intersection is genuinely empty. A "no plans on file"
    // guard cannot see this state, because there IS a plan on file.
    const s = await seedStudio(`cap-arch-${randomUUID().slice(0, 6)}`);
    await adminQuery("update public.studios set timezone = $2 where id = $1", [
      s.studioId,
      TZ,
    ]);
    const gone = await newClient(s.studioId, "Archived only", true);
    await openPlan(s.studioId, gone);
    const st = await loadStudio(s.studioId);
    const session = await signIn(s.practitionerId, "cap-arch");
    const b = await getOwnerCapacityBriefing(st, await authedClient(session.access_token));

    // The plan row really is there and really is active.
    const plans = await adminQuery(
      "select count(*)::int as n from public.treatment_plans where studio_id = $1 and status = 'active'",
      [s.studioId],
    );
    expect(plans.rows[0].n).toBe(1);

    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
    // seedStudio's own (non-archived) client is still counted.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1 });
  }, 60_000);

  it("a CLOSED plan is not active-treatment evidence — the embedded filter really binds", async () => {
    // The plan evidence is an embedded aggregate with its own filters. If those
    // filters silently failed to bind, every closed plan in the studio's history
    // would count as active treatment and the screen would be confidently wrong
    // in the worst direction. Proved against real rows rather than trusted.
    const s = await seedStudio(`cap-closed-${randomUUID().slice(0, 6)}`);
    await adminQuery("update public.studios set timezone = $2 where id = $1", [
      s.studioId,
      TZ,
    ]);
    const c = await newClient(s.studioId, "Finished a course");
    await adminQuery(
      `insert into public.treatment_plans
         (studio_id, client_id, name, suggested_visit_count, status, closed_at)
       values ($1, $2, 'Done', 6, 'closed', now())`,
      [s.studioId, c],
    );
    const st = await loadStudio(s.studioId);
    const session = await signIn(s.practitionerId, "cap-closed");
    const b = await getOwnerCapacityBriefing(st, await authedClient(session.access_token));

    // The plan row exists and is genuinely closed.
    const plans = await adminQuery(
      "select status from public.treatment_plans where studio_id = $1",
      [s.studioId],
    );
    expect(plans.rows.map((r) => r.status)).toEqual(["closed"]);

    // So there is no evidence anyone is in active treatment — UNKNOWN, not 0.
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 2 });
  }, 60_000);

  it("a future booking whose SERVICE WAS DELETED degrades the figures it feeds", async () => {
    // The production state Codex named: service_id is nullable and the embed
    // also disappears when the service row is deleted. Proved by actually
    // deleting it, so the appointment survives with a null service_id through
    // the shipped ON DELETE behaviour rather than by writing null directly.
    const s = await seedStudio(`cap-nosvc-${randomUUID().slice(0, 6)}`);
    await adminQuery("update public.studios set timezone = $2 where id = $1", [
      s.studioId,
      TZ,
    ]);
    const c = await newClient(s.studioId, "Has an orphaned booking");
    await openPlan(s.studioId, c);
    const doomed = await newService(s.studioId, "Doomed", "laser");
    await seedAppointment({
      studioId: s.studioId,
      clientId: c,
      serviceId: doomed,
      dateStr: SOON,
      start: "09:00",
      end: "10:00",
      status: "confirmed",
    });
    await adminQuery("delete from public.services where id = $1", [doomed]);

    // The appointment survived the deletion with no service attached.
    const orphan = await adminQuery(
      "select service_id from public.appointments where studio_id = $1",
      [s.studioId],
    );
    expect(orphan.rows).toHaveLength(1);
    expect(orphan.rows[0].service_id).toBeNull();

    const st = await loadStudio(s.studioId);
    const session = await signIn(s.practitionerId, "cap-nosvc");
    const b = await getOwnerCapacityBriefing(st, await authedClient(session.access_token));

    // It is neither counted as treatment nor silently dropped: both are wrong,
    // in opposite directions.
    expect(b.futureTreatmentMinutes.known).toBe(false);
    expect(b.depth.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    // The client population is untouched by an appointment-classification gap.
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
  }, 60_000);

  // -------------------------------------------------------------------------
  // Owner authority
  // -------------------------------------------------------------------------

  it("renders for the owner", async () => {
    jar.clear();
    for (const [k, v] of ownerCookies) jar.set(k, v);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const markup = renderToStaticMarkup((await renderPage()) as never);
    expect(markup).toContain("Practice capacity");
    expect(markup).toContain("No future treatment booked");
  }, 30_000);

  it("refuses an ordinary practitioner, and issues NO studio-wide analytics query for them", async () => {
    jar.clear();
    for (const [k, v] of memberCookies) jar.set(k, v);
    const from = ALL_REQUESTS.length;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const markup = renderToStaticMarkup((await renderPage()) as never);
    expect(markup).toContain("Only studio owners");
    expect(markup).not.toContain("No future treatment booked");
    // The refusal happens BEFORE the briefing is loaded: the only table read is
    // the practitioner identity the gate itself needs.
    expect([...new Set(ALL_REQUESTS.slice(from))]).toEqual(["practitioners"]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Read soundness — a read that did not return the truth must not be consumed
  // -------------------------------------------------------------------------

  it("keeps the exact TOTAL past the real row ceiling, and refuses every id-dependent figure", async () => {
    // supabase/config.toml sets max_rows = 1000, so ONE response cannot carry
    // this studio's 1,050 clients — against the real Data API, not a stub.
    //
    // What survives is the exact count: PostgREST reports it in Content-Range
    // and the ceiling does not bound it. What cannot survive is anything
    // computed over the IDENTIFIERS. This module used to close that gap by
    // issuing a second range() request and treating the union as one
    // population; it is not one. Offsets are evaluated against live data, so a
    // row archived between the two requests shifts every later offset and the
    // arithmetic still says "complete". There is no cursor or retry that fixes
    // it without a transaction boundary this module has no vehicle for — it is
    // Data API reads only, no RPC — so the enumeration is refused instead.
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
    await openPlan(big.studioId, last.rows[0].id as string);
    const bigStudio = await loadStudio(big.studioId);
    const session = await signIn(big.practitionerId, "cap-page");
    const b = await getOwnerCapacityBriefing(
      bigStudio,
      await authedClient(session.access_token),
    );

    // 1049 seeded + the one seedStudio creates.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1050 });
    // Everything that needed the ids is refused, including the plan that lives
    // beyond the ceiling. This is a real product ceiling for large studios,
    // stated rather than papered over.
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
  }, 120_000);

  it("a studio that exactly fills one response still gets real figures", async () => {
    // The guard is "rows returned !== exact count", not "we touched the
    // ceiling". Without this control the ceiling fix could have replaced a
    // false zero with a permanent false unknown and no test would notice.
    const exact = await seedStudio(`cap-exact-${randomUUID().slice(0, 6)}`);
    await adminQuery("update public.studios set timezone = $2 where id = $1", [
      exact.studioId,
      TZ,
    ]);
    // seedStudio already created one client; add 999 for exactly 1,000.
    await adminQuery(
      `insert into public.clients (studio_id, name)
       select $1, 'Exact ' || g from generate_series(1, 999) g`,
      [exact.studioId],
    );
    const one = await adminQuery(
      "select id from public.clients where studio_id = $1 order by id limit 1",
      [exact.studioId],
    );
    await openPlan(exact.studioId, one.rows[0].id as string);
    const exactStudio = await loadStudio(exact.studioId);
    const session = await signIn(exact.practitionerId, "cap-exact");
    const b = await getOwnerCapacityBriefing(
      exactStudio,
      await authedClient(session.access_token),
    );

    expect(b.clients.totalRecords).toEqual({ known: true, value: 1000 });
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
    });
  }, 120_000);

  it("answers the owner in ONE wave of batched reads, with no per-client query", async () => {
    jar.clear();
    for (const [k, v] of ownerCookies) jar.set(k, v);
    const from = ALL_REQUESTS.length;
    const { renderToStaticMarkup } = await import("react-dom/server");
    renderToStaticMarkup((await renderPage()) as never);
    const taken = ALL_REQUESTS.slice(from);
    const tally: Record<string, number> = {};
    for (const table of taken) tally[table] = (tally[table] ?? 0) + 1;

    // The identity read the gate needs, then ONE analytics statement. Not three
    // — three requests are three snapshots, and the join across them can report
    // a combination of states that never coexisted. Six clients, their plans
    // and their bookings all arrive in that single statement, so this tally is
    // the snapshot property expressed as a number.
    expect(tally).toEqual({ practitioners: 1, clients: 1 });
    expect(taken).toHaveLength(2);
  }, 30_000);

  it("detects a CLIPPED embedded rowset against the real Data API", async () => {
    // Measured, not assumed. The Data API clips an EMBEDDED rowset at the same
    // ceiling it clips a top-level one, PER PARENT ROW, and the response's
    // Content-Range describes only the ROOT — so nothing in the response body
    // says rows went missing. A naive embed would have silently undercounted
    // exactly the way the old offset paging did.
    const s = await seedStudio(`cap-embed-${randomUUID().slice(0, 6)}`);
    await adminQuery("update public.studios set timezone = $2 where id = $1", [
      s.studioId,
      TZ,
    ]);
    const c = await newClient(s.studioId, "Very busy");
    await openPlan(s.studioId, c);
    const svc = await newService(s.studioId, "Busy svc", "laser");
    // 1,100 well-spaced future bookings: past the 1,000-row embed ceiling.
    await adminQuery(
      `insert into public.appointments
         (studio_id, client_id, service_id, starts_at, ends_at, duration_minutes,
          buffer_minutes_snapshot, blocked_ends_at, status)
       select $1, $2, $3,
              now() + (g * interval '3 hours') + interval '2 days',
              now() + (g * interval '3 hours') + interval '2 days' + interval '30 minutes',
              30, 15,
              now() + (g * interval '3 hours') + interval '2 days' + interval '45 minutes',
              'confirmed'
       from generate_series(1, 1100) g`,
      [s.studioId, c, svc],
    );
    const seeded = await adminQuery(
      "select count(*)::int as n from public.appointments where studio_id = $1",
      [s.studioId],
    );
    expect(seeded.rows[0].n).toBe(1100);

    const st = await loadStudio(s.studioId);
    const session = await signIn(s.practitionerId, "cap-embed");
    const b = await getOwnerCapacityBriefing(st, await authedClient(session.access_token));

    // The client population is small and fully in hand...
    expect(b.clients.totalRecords).toEqual({ known: true, value: 2 });
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
    // ...but the bookings behind these figures are not, and that is detected
    // rather than silently rounded down to the 1,000 that came back.
    expect(b.futureTreatmentMinutes.known).toBe(false);
    expect(b.depth.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
  }, 180_000);
});
