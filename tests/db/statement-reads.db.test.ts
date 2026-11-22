import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, adminTx, closePool, seedMember } from "./helpers/harness";
import { cleanupPaymentScenario, seedEligibleQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";
import { asUser } from "./helpers/harness";
import { loadClientStatementRead } from "@/lib/finance/client-statement-read";
import { loadFinderClients, loadStatementDirectory } from "@/lib/finance/statement-directory-read";
import { readAppointmentsKeyset, readMoneyForAppointments } from "@/lib/finance/statement-money-read";
import { localDateString } from "@/lib/booking/tz";
import { yearMonthOf } from "@/lib/finance/statement-period";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// The statement reads against the REAL REST layer (PostgREST) as a signed-in database user, not a shim: it proves the keyset `or(...)` filter
// syntax, the `quoted_amount_cents` column, the month window and the row-level-security behaviour that the fake-client unit tests cannot.
// Each client below is an ordinary supabase-js client carrying a JWT minted for one seeded user with the stack's own signing secret, so every row
// it sees is decided by RLS exactly as for a signed-in user. Synthetic data only; every studio created here is removed afterwards.

const API = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54321";
// The local stack's well-known development signing secret (the tracked config sets none, so the CLI default applies). Not a real secret.
const LOCAL_JWT_SECRET = process.env.HONE_LOCAL_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "supabase-demo", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const sig = createHmac("sha256", LOCAL_JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function restAs(userId: string): SupabaseClient {
  const anon = jwt({ role: "anon" });
  return createClient(API, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt({ role: "authenticated", sub: userId })}` } },
  });
}

const created: string[] = [];
let a: PaymentScenario;
let b: PaymentScenario;
let member: { userId: string; practitionerId: string };
let tz: string;
let currentMonth: string;
const BULK = 501; // one more than a keyset page, so two pages are read
const NOW = new Date();

beforeAll(async () => {
  a = await seedEligibleQuickCheckoutScenario({ label: "stmtread-a" });
  b = await seedEligibleQuickCheckoutScenario({ label: "stmtread-b" });
  created.push(a.studioId, b.studioId);
  member = await seedMember({ studioId: a.studioId, userId: a.practitionerUserId, practitionerId: a.practitionerId, clientId: a.clientId }, "stmtread-member");

  // The scenario's own appointment gets an owner-recorded cash settlement (through the real command, as the owner).
  const rec = await asUser(a.practitionerUserId, async (q) => {
    const r = await q(`select * from public.record_appointment_settlement($1,$2,$3,$4,$5,$6)`, [a.studioId, a.appointmentId, "paid_cash", 4500, null, true]);
    return r.rows[0] as { result: string };
  });
  expect(rec.result).toBe("recorded");

  // 501 further completed appointments for the same client, one an hour from 1 March 2026 (all in one local month), no money on any.
  await adminQuery(
    `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     select $1, $2, $3, ts, ts + interval '30 minutes', 30, 'completed'
       from generate_series(timestamptz '2026-03-01 12:00+00', timestamptz '2026-03-01 12:00+00' + ($4 - 1) * interval '1 hour', interval '1 hour') ts`,
    [a.studioId, a.practitionerId, a.clientId, BULK],
  );
  const s = await adminQuery(`select a.starts_at, st.timezone from public.appointments a join public.studios st on st.id = a.studio_id where a.id = $1`, [a.appointmentId]);
  tz = (s.rows[0] as { timezone: string }).timezone;
  currentMonth = yearMonthOf(localDateString(new Date((s.rows[0] as { starts_at: string }).starts_at), tz));
}, 120_000);

afterAll(async () => {
  for (const id of created) await cleanupPaymentScenario(id).catch(() => undefined);
  await closePool();
}, 300_000);

const studioA = () => ({ id: a.studioId, timezone: tz });

describe("the client statement read through the real REST layer", () => {
  it("reads the whole history across TWO keyset pages with the real `or(...)` filter, each visit once", async () => {
    const r = await loadClientStatementRead({ role: "owner" }, studioA(), "cad", a.clientId, NOW, restAs(a.practitionerUserId));
    expect(r).toMatchObject({ access: "granted", ok: true });
    if (!(r.access === "granted" && r.ok)) return;
    expect(r.visits.length + r.feeItems.length).toBe(BULK + 1);
    expect(new Set(r.visits.map((v) => v.appointmentId)).size).toBe(r.visits.length);
    // ordered by start, ties by id
    const starts = r.visits.map((v) => v.startsAt);
    expect([...starts].sort()).toEqual(starts);
  });
  it("selects quoted_amount_cents and carries the recorded cash payment on its visit", async () => {
    const r = await loadClientStatementRead({ role: "owner" }, studioA(), "cad", a.clientId, NOW, restAs(a.practitionerUserId));
    if (!(r.access === "granted" && r.ok)) throw new Error("expected ok");
    const v = r.visits.find((x) => x.appointmentId === a.appointmentId);
    expect(v?.lines.map((l) => l.kind)).toEqual(["collected_cash"]);
    expect(v?.lines[0].cents).toBe(4500);
    expect(Array.isArray(v?.feeCandidates)).toBe(true);
    expect(v?.feeCandidates.some((c) => c.source === "settlement_quote")).toBe(true); // the column was selected and read
  });
  it("another studio's client and an unknown id are the same not-found, with no data", async () => {
    const owner = restAs(a.practitionerUserId);
    expect(await loadClientStatementRead({ role: "owner" }, studioA(), "cad", b.clientId, NOW, owner)).toEqual({ access: "granted", ok: false, reason: "client_not_found" });
    expect(await loadClientStatementRead({ role: "owner" }, studioA(), "cad", "00000000-0000-4000-8000-000000000000", NOW, owner)).toEqual({ access: "granted", ok: false, reason: "client_not_found" });
  });
  it("a non-owner role is refused by the gate before any request", async () => {
    expect(await loadClientStatementRead({ role: "practitioner" }, studioA(), "cad", a.clientId, NOW, restAs(member.userId))).toEqual({ access: "refused" });
  });
});

describe("the Clients tab and finder reads through the real REST layer", () => {
  it("the 501-visit month lists the client with every visit counted and no payment record flagged", async () => {
    const r = await loadStatementDirectory({ role: "owner" }, studioA(), "cad", "2026-03", NOW, restAs(a.practitionerUserId));
    expect(r).toMatchObject({ access: "granted", ok: true });
    if (!(r.access === "granted" && r.ok)) return;
    const row = r.directory.rows.find((x) => x.clientId === a.clientId);
    expect(row).toMatchObject({ visitCount: BULK, paidCents: 0, awaitingCount: BULK });
    expect(r.directory.reconciliation.reconciled).toBe(true);
    expect(r.directory.rows.every((x) => x.clientId !== b.clientId)).toBe(true); // another studio's client never appears
  });
  it("the current month holds the recorded cash and reconciles to the studio total", async () => {
    const r = await loadStatementDirectory({ role: "owner" }, studioA(), "cad", currentMonth, NOW, restAs(a.practitionerUserId));
    if (!(r.access === "granted" && r.ok)) throw new Error("expected ok");
    expect(r.directory.rows.find((x) => x.clientId === a.clientId)).toMatchObject({ paidCents: 4500 });
    expect(r.directory.reconciliation).toMatchObject({ clientsSpendCents: 4500, studioCollectedCents: 4500, reconciled: true });
  });
  it("the month window is the studio's local month: an appointment just outside it is not read", async () => {
    // 1 March 2026 12:00 UTC is inside March; February's window must hold none of the bulk rows.
    const r = await loadStatementDirectory({ role: "owner" }, studioA(), "cad", "2026-02", NOW, restAs(a.practitionerUserId));
    if (!(r.access === "granted" && r.ok)) throw new Error("expected ok");
    expect(r.directory.rows).toEqual([]);
  });
  it("Find a client reads only the active studio's clients", async () => {
    const r = await loadFinderClients({ role: "owner" }, { id: a.studioId }, restAs(a.practitionerUserId));
    if (!(r.access === "granted" && r.ok)) throw new Error("expected ok");
    const ids = r.clients.map((c) => c.id);
    expect(ids).toContain(a.clientId);
    expect(ids).not.toContain(b.clientId);
    await expect(loadFinderClients({ role: "practitioner" }, { id: a.studioId }, restAs(member.userId))).resolves.toEqual({ access: "refused" });
  });
});

describe("the owner gate is load-bearing: a non-owner's database session reads NO money, and no error says so", () => {
  it("the same money read as a non-owner member returns zero rows for a visit that has a settlement", async () => {
    const ownerRows = await readMoneyForAppointments(restAs(a.practitionerUserId), a.studioId, [a.appointmentId]);
    expect(ownerRows.ok && ownerRows.settlementRows.length).toBe(1);
    const memberRows = await readMoneyForAppointments(restAs(member.userId), a.studioId, [a.appointmentId]);
    expect(memberRows).toMatchObject({ ok: true, settlementRows: [], cardRows: [], legacyFeeRows: [] });
  });
});

describe("the studio-local month across daylight-saving changes", () => {
  let dst: string;
  beforeAll(async () => {
    const c = await adminQuery(`insert into public.clients (studio_id, name) values ($1, 'Dst Client') returning id`, [a.studioId]);
    dst = (c.rows[0] as { id: string }).id;
    // Toronto: spring forward 8 March, fall back 1 November 2026. Local midnight is 05:00Z on 1 March (EST), 04:00Z on 1 April (EDT),
    // 04:00Z on 1 November (EDT) and 05:00Z on 1 December (EST). A five-minute appointment ending exactly at each boundary, and one starting on it.
    for (const iso of ["2026-03-01T04:55:00Z", "2026-03-01T05:00:00Z", "2026-03-31T03:55:00Z", "2026-04-01T04:00:00Z", "2026-11-01T03:55:00Z", "2026-11-01T04:00:00Z", "2026-12-01T04:55:00Z", "2026-12-01T05:00:00Z"]) {
      await adminQuery(
        `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
         values ($1,$2,$3,$4::timestamptz, $4::timestamptz + interval '5 minutes', 5, 'completed')`,
        [a.studioId, a.practitionerId, dst, iso],
      );
    }
  });
  const countFor = async (month: string) => {
    const r = await loadStatementDirectory({ role: "owner" }, studioA(), "cad", month, NOW, restAs(a.practitionerUserId));
    if (!(r.access === "granted" && r.ok)) throw new Error("expected ok");
    return r.directory.rows.find((x) => x.clientId === dst)?.visitCount ?? 0;
  };
  it("the query's own window is half-open: an appointment starting exactly at the end instant is NOT read, one at the start instant is", async () => {
    const r = await readAppointmentsKeyset(restAs(a.practitionerUserId), a.studioId, { clientId: dst, startUtc: "2026-03-01T05:00:00.000Z", endUtc: "2026-04-01T04:00:00.000Z" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows).toHaveLength(2);
  });
  it("each month holds exactly the appointments between its two local midnights, whatever the offset", async () => {
    expect(await countFor("2026-02")).toBe(1); // 04:55Z on 1 March is still 28 February at 23:55 local
    expect(await countFor("2026-03")).toBe(2); // 05:00Z on 1 March .. 04:00Z on 1 April (a 743-hour month): the 1 March start and the 31 March one
    expect(await countFor("2026-04")).toBe(1); // 04:00Z on 1 April is local midnight
    expect(await countFor("2026-10")).toBe(1); // 03:55Z on 1 November is 31 October at 23:55 local
    expect(await countFor("2026-11")).toBe(2); // 04:00Z on 1 November .. 05:00Z on 1 December (a 721-hour month)
    expect(await countFor("2026-12")).toBe(1);
  });
});

describe("the caps fail closed against the real REST layer", () => {
  let capClient: string;
  beforeAll(async () => {
    const c = await adminQuery(`insert into public.clients (studio_id, name) values ($1, 'Cap Client') returning id`, [b.studioId]);
    capClient = (c.rows[0] as { id: string }).id;
    // 10,001 appointments in one month: one past the 20-page appointment cap.
    // Bulk rows are inserted with triggers off (replica role): the calendar-reservation sync would reject one-minute-apart rows, and none of it is under test.
    await adminTx(async (q) => {
      await q(`set local session_replication_role = replica`);
      await q(
        `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, buffer_minutes_snapshot, blocked_ends_at)
         select $1, $2, $3, ts, ts + interval '5 minutes', 5, 'completed', 0, ts + interval '5 minutes'
           from generate_series(timestamptz '2026-05-01 12:00+00', timestamptz '2026-05-01 12:00+00' + 10000 * interval '1 minute', interval '1 minute') ts`,
        [b.studioId, b.practitionerId, capClient],
      );
      // 25,001 clients with the one above: one past the finder's 50-block cap.
      await q(`insert into public.clients (studio_id, name) select $1, 'Bulk ' || g from generate_series(1, 25000) g`, [b.studioId]);
    });
  }, 180_000);
  const studioB = () => ({ id: b.studioId, timezone: tz });
  it("a month with more appointments than the cap is refused, never a shortened statement", async () => {
    const r = await loadStatementDirectory({ role: "owner" }, studioB(), "cad", "2026-05", NOW, restAs(b.practitionerUserId));
    expect(r).toEqual({ access: "granted", ok: false, reason: "too_many_appointments" });
  }, 120_000);
  it("a client history beyond the cap is refused the same way", async () => {
    const r = await loadClientStatementRead({ role: "owner" }, studioB(), "cad", capClient, NOW, restAs(b.practitionerUserId));
    expect(r).toEqual({ access: "granted", ok: false, reason: "too_many_appointments" });
  }, 120_000);
  it("the finder refuses a studio larger than its cap instead of listing part of it", async () => {
    const r = await loadFinderClients({ role: "owner" }, { id: b.studioId }, restAs(b.practitionerUserId));
    expect(r).toEqual({ access: "granted", ok: false, reason: "read_failed" });
  }, 120_000);
});

describe("a non-owner is refused, not shown an empty page", () => {
  it("every loader returns the refusal for a practitioner role, and the member's own session would have read nothing anyway", async () => {
    const m = restAs(member.userId);
    expect(await loadStatementDirectory({ role: "practitioner" }, studioA(), "cad", "2026-03", NOW, m)).toEqual({ access: "refused" });
    expect(await loadClientStatementRead({ role: "practitioner" }, studioA(), "cad", a.clientId, NOW, m)).toEqual({ access: "refused" });
    expect(await loadFinderClients({ role: "practitioner" }, { id: a.studioId }, m)).toEqual({ access: "refused" });
  });
});

describe("the keyset page boundary falls INSIDE a run of identical start times", () => {
  it("no appointment is skipped or repeated when four share one start and the 500-row page ends between them", async () => {
    const c = await adminQuery(`insert into public.clients (studio_id, name) values ($1, 'Tie Client') returning id`, [a.studioId]);
    const tie = (c.rows[0] as { id: string }).id;
    await adminTx(async (q) => {
      await q(`set local session_replication_role = replica`);
      // 498 distinct hourly starts, then four appointments on ONE start: rows 499-502, so the first page (500) ends after the second of them.
      await q(
        `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, buffer_minutes_snapshot, blocked_ends_at)
         select $1, $2, $3, ts, ts + interval '5 minutes', 5, 'completed', 0, ts + interval '5 minutes'
           from generate_series(timestamptz '2025-01-01 12:00+00', timestamptz '2025-01-01 12:00+00' + 497 * interval '1 hour', interval '1 hour') ts`,
        [a.studioId, a.practitionerId, tie],
      );
      await q(
        `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, buffer_minutes_snapshot, blocked_ends_at)
         select $1, $2, $3, timestamptz '2025-03-01 12:00+00', timestamptz '2025-03-01 12:05+00', 5, 'completed', 0, timestamptz '2025-03-01 12:05+00' from generate_series(1, 4)`,
        [a.studioId, a.practitionerId, tie],
      );
    });
    const r = await loadClientStatementRead({ role: "owner" }, studioA(), "cad", tie, NOW, restAs(a.practitionerUserId));
    if (!(r.access === "granted" && r.ok)) throw new Error("expected ok");
    expect(r.visits.length).toBe(502);
    expect(new Set(r.visits.map((v) => v.appointmentId)).size).toBe(502);
    expect(r.visits.filter((v) => v.startsAt.startsWith("2025-03-01T12:00")).length).toBe(4);
  }, 60_000);
});
