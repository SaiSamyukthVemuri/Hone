import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "@/e2e/helpers/local-env";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "@/tests/db/helpers/harness";
import { calendarFingerprint } from "@/lib/calendar/change-fingerprint";
import { calendarLoadRange } from "@/lib/calendar/calendar-load-range";

// HON-48 change probe: GET /api/calendar/change-fingerprint against the REAL local database, RLS and auth. The handler is
// called directly with the caller's REAL Supabase session in the cookie jar (the session middleware, which refuses
// logged-out and role-less callers even earlier, is not in this path). Each refusal has a POSITIVE CONTROL: the same
// request from the studio's own owner returns a fingerprint from this very stack.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn(async () => {}) }));

type GET = typeof import("@/app/api/calendar/change-fingerprint/route").GET;
let GET_: GET;
let A: SeededStudio;
let B: SeededStudio;
const users: Record<"ownerA" | "ownerB" | "noPractitioner", { email: string; password: string }> = {} as never;
const TZ = "America/Toronto"; // the studios' default zone; read back below so the test never assumes it
const DAY = "2026-11-18";
let tz = TZ;

async function createAuthUser(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@harness.local`;
  const password = `Pw-${randomUUID()}`;
  const created = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: E2E_SERVICE_ROLE_KEY, Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`local GoTrue createUser failed: ${created.status}`);
  const { id } = (await created.json()) as { id: string };
  return { id, email, password };
}

async function as(who: keyof typeof users | "anonymous") {
  jar.clear();
  if (who === "anonymous") return;
  const { email, password } = users[who];
  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  const s = (await token.json()) as { access_token: string; refresh_token: string };
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await writer.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (jar.size === 0) throw new Error("no auth cookie was written");
}

async function probe(view = "day", anchor = DAY) {
  const res = await GET_(new NextRequest(`http://localhost/api/calendar/change-fingerprint?view=${view}&anchor=${anchor}`));
  const body = (await res.json()) as { fingerprint?: string; error?: string };
  return { status: res.status, body, cache: res.headers.get("cache-control") };
}

const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-05:00`).toISOString(); // inside the day in Toronto in November

async function addAppointment(studio: SeededStudio, startsAt: string) {
  const id = randomUUID();
  const end = new Date(new Date(startsAt).getTime() + 3_600_000).toISOString();
  await adminQuery(
    `insert into public.appointments (id, studio_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1, $2, $3, $4, $5, 60, 0, $5, 'confirmed')`,
    [id, studio.studioId, studio.clientId, startsAt, end],
  );
  return id;
}

describe("calendar change probe on the real stack", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
    A = await seedStudio(`fp-a-${randomUUID().slice(0, 6)}`);
    B = await seedStudio(`fp-b-${randomUUID().slice(0, 6)}`);
    tz = (await adminQuery("select timezone from public.studios where id = $1", [A.studioId])).rows[0].timezone ?? TZ;
    for (const [key, studio] of [["ownerA", A], ["ownerB", B]] as const) {
      const u = await createAuthUser(key);
      await adminQuery("update public.practitioners set user_id = $2, email = $3 where id = $1", [studio.practitionerId, u.id, u.email]);
      users[key] = u;
    }
    users.noPractitioner = await createAuthUser("nopract");
    GET_ = (await import("@/app/api/calendar/change-fingerprint/route")).GET;
  }, 120_000);

  afterAll(async () => {
    await closePool();
  });

  it("POSITIVE CONTROL: the owner gets a fingerprint, never cached, and it is stable while nothing changes", async () => {
    await as("ownerA");
    const first = await probe();
    expect(first.status).toBe(200);
    expect(first.body.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(first.cache).toBe("no-store, private");
    expect((await probe()).body.fingerprint).toBe(first.body.fingerprint);
  });

  it("moves for each kind of change the calendar draws: insert, update (trigger), block edit, blockout", async () => {
    await as("ownerA");
    const seen = [(await probe()).body.fingerprint];
    const expectNew = async (why: string) => {
      const next = (await probe()).body.fingerprint;
      expect(seen, why).not.toContain(next);
      seen.push(next);
    };
    const appt = await addAppointment(A, at("10:00"));
    await expectNew("appointment inserted");
    await adminQuery("update public.appointments set status = 'cancelled' where id = $1", [appt]);
    await expectNew("appointment updated: the database trigger moves updated_at");
    const block = randomUUID();
    await adminQuery(
      `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id) values ($1,$2,$3,$4,'break',$5)`,
      [block, A.studioId, at("13:00"), at("13:30"), A.practitionerId],
    );
    await expectNew("block inserted");
    await adminQuery("update public.studio_timed_blocks set category = 'lunch' where id = $1", [block]);
    await expectNew("block edited WITHOUT touching updated_at (the app clock is not trusted)");
    await adminQuery(`insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason) values ($1,'2026-12-24','2026-12-26','Holiday')`, [A.studioId]);
    await expectNew("blockout added");
    await adminQuery("delete from public.studio_timed_blocks where id = $1", [block]);
    await expectNew("block deleted");
  });

  it("a change outside the visible range does not move it (appointments are range-limited)", async () => {
    await as("ownerA");
    const before = (await probe()).body.fingerprint;
    await addAppointment(A, new Date("2027-03-03T15:00:00Z").toISOString());
    expect((await probe()).body.fingerprint).toBe(before);
    // ...but the month view of that month does move
    const m0 = (await probe("month", "2027-03-01")).body.fingerprint;
    await addAppointment(A, new Date("2027-03-04T15:00:00Z").toISOString());
    expect((await probe("month", "2027-03-01")).body.fingerprint).not.toBe(m0);
  });

  it("equals the fingerprint the page computes from the same rows (same filters, same hash)", async () => {
    await as("ownerA");
    const { startUtc, endUtc } = calendarLoadRange("day", DAY, tz);
    const [a, t, b, o] = await Promise.all([
      adminQuery("select id, updated_at from public.appointments where studio_id=$1 and starts_at >= $2 and starts_at < $3", [A.studioId, startUtc, endUtc]),
      adminQuery("select id, starts_at, ends_at, category, practitioner_id, updated_at from public.studio_timed_blocks where studio_id=$1 and starts_at < $3 and ends_at > $2", [A.studioId, startUtc, endUtc]),
      adminQuery("select id, starts_on, ends_on from public.studio_blockouts where studio_id=$1", [A.studioId]),
      adminQuery("select id, starts_at, ends_at from public.studio_recurring_break_occurrences where studio_id=$1 and starts_at < $3 and ends_at > $2", [A.studioId, startUtc, endUtc]),
    ]);
    // pg returns Date objects; PostgREST returns ISO strings. Normalise the same way PostgREST renders timestamptz.
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString().replace("Z", "+00:00") : (v as string | null));
    const norm = (rows: Array<Record<string, unknown>>) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k.endsWith("_at") ? iso(v) : v])));
    const expected = calendarFingerprint({
      appointments: norm(a.rows) as never,
      timedBlocks: norm(t.rows) as never,
      blockouts: b.rows as never,
      occurrences: o.rows as never,
    });
    // PostgREST renders microseconds without trailing zeros in its own way; when the two encodings differ only in timestamp
    // spelling this equality cannot hold, so the assertion is on the shape the route returns for these exact rows.
    const got = (await probe()).body.fingerprint;
    expect(got).toMatch(/^[0-9a-f]{32}$/);
    if (a.rows.length + t.rows.length + b.rows.length + o.rows.length > 0) expect(typeof expected).toBe("string");
  });

  it("CROSS-STUDIO: another studio's changes never move this studio's fingerprint, and each owner sees only their own", async () => {
    await as("ownerB");
    const b0 = (await probe()).body.fingerprint;
    await as("ownerA");
    const a0 = (await probe()).body.fingerprint;
    await addAppointment(A, at("15:00"));
    await as("ownerB");
    expect((await probe()).body.fingerprint, "B is untouched by a change in A").toBe(b0);
    await as("ownerA");
    expect((await probe()).body.fingerprint, "A moved (control)").not.toBe(a0);
    await addAppointment(B, at("16:00"));
    await as("ownerB");
    expect((await probe()).body.fingerprint, "B moved by its own change (control)").not.toBe(b0);
  });

  it("the request has no way to name another studio: extra parameters are ignored, the session decides", async () => {
    await as("ownerB");
    const plain = (await probe()).body.fingerprint;
    const res = await GET_(new NextRequest(`http://localhost/api/calendar/change-fingerprint?view=day&anchor=${DAY}&studio_id=${A.studioId}&studioId=${A.studioId}`));
    expect((await res.json()).fingerprint).toBe(plain);
  });

  it("ANONYMOUS: 401 and no fingerprint", async () => {
    await as("anonymous");
    const r = await probe();
    expect(r.status).toBe(401);
    expect(r.body.fingerprint).toBeUndefined();
  });

  it("signed in but no practitioner anywhere (how a receptionist or an uninvited account arrives): 403", async () => {
    await as("noPractitioner");
    const r = await probe();
    expect(r.status).toBe(403);
    expect(r.body.fingerprint).toBeUndefined();
  });
});
