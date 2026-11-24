import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import { cleanupPaymentScenario, seedEligibleQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";
import { loadClientStatementRead } from "@/lib/finance/client-statement-read";
import { loadStatementDirectory } from "@/lib/finance/statement-directory-read";
import { loadStatementView } from "@/lib/finance/statement-read";
import { buildStatementDocument } from "@/lib/finance/statement-document";
import { statementCsvLines } from "@/lib/finance/statement-csv";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// HON-100 (D5): ONE synthetic month, read through the real REST layer as the signed-in owner, must say the same thing on every Statements surface.
//
//   Studio tab (loadStatementView)  ==  Clients tab (loadStatementDirectory)  ==  each client's One-month statement document
//   ==  that document's CSV header (the print view renders the same document, so its figures are the document's figures)
//
// The month holds: a cash-paid visit, an UNPAID completed visit, a fully REFUNDED live card payment, and a second client with an e-transfer visit.
// The test asserts the PROPERTY (the surfaces agree with each other and with the independently known amounts), not a copy of any one surface.
// Synthetic data only; the studio is removed afterwards.

const API = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54321";
const LOCAL_JWT_SECRET = process.env.HONE_LOCAL_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "supabase-demo", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return `${head}.${body}.${createHmac("sha256", LOCAL_JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
function restAs(userId: string): SupabaseClient {
  return createClient(API, jwt({ role: "anon" }), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt({ role: "authenticated", sub: userId })}` } },
  });
}

const MONTH = "2026-03";
const NOW = new Date("2026-06-15T12:00:00Z");
const CASH = 4500;
const ETRANSFER = 6000;
const REFUNDED_CARD = 8000;

let s: PaymentScenario;
let tz: string;
let clientB: string;
let apptUnpaid: string;
let apptRefunded: string;
let apptB: string;
const owner = () => restAs(s.practitionerUserId);
const studio = () => ({ id: s.studioId, timezone: tz });

async function insertAppt(clientId: string, iso: string): Promise<string> {
  const r = await adminQuery(
    `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '30 minutes',30,'completed') returning id`,
    [s.studioId, s.practitionerId, clientId, iso],
  );
  return (r.rows[0] as { id: string }).id;
}
async function settle(appointmentId: string, method: string, cents: number) {
  const rec = await asUser(s.practitionerUserId, async (q) => (await q(`select * from public.record_appointment_settlement($1,$2,$3,$4,$5,$6)`, [s.studioId, appointmentId, method, cents, null, true])).rows[0] as { result: string });
  expect(rec.result).toBe("recorded");
}

beforeAll(async () => {
  s = await seedEligibleQuickCheckoutScenario({ label: "stmt-xview" });
  tz = ((await adminQuery(`select timezone from public.studios where id=$1`, [s.studioId])).rows[0] as { timezone: string }).timezone;
  // Move the scenario's own appointment into the month under test (client A, cash).
  await adminQuery(`update public.appointments set starts_at = '2026-03-10T15:00:00Z', ends_at = '2026-03-10T15:30:00Z' where id = $1`, [s.appointmentId]);
  await settle(s.appointmentId, "paid_cash", CASH);
  // Client A, second visit: completed and UNPAID (no money of any kind).
  apptUnpaid = await insertAppt(s.clientId, "2026-03-17T15:00:00Z");
  // Client A, third visit: a live card payment that was fully refunded.
  apptRefunded = await insertAppt(s.clientId, "2026-03-24T15:00:00Z");
  const sess = await adminQuery(`insert into public.sessions (studio_id, client_id, practitioner_id, modality, appointment_id) values ($1,$2,$3,'electrolysis',$4) returning id`, [s.studioId, s.clientId, s.practitionerId, apptRefunded]);
  await adminQuery(
    `insert into public.payment_charge_attempts (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
        stripe_payment_intent_id, stripe_charge_id, charged_at, refund_status, refund_amount_cents, stripe_account_id)
     values ($1,'session_payment',$2,$3,$4,$5,$6,'cad','succeeded',true,'pi_xview','ch_xview',now(),'succeeded',$6,'acct_xview')`,
    [s.studioId, s.clientId, (sess.rows[0] as { id: string }).id, apptRefunded, s.practitionerId, REFUNDED_CARD],
  );
  // Client B: one e-transfer visit.
  const c = await adminQuery(`insert into public.clients (studio_id, name) values ($1,'Xview Beta') returning id`, [s.studioId]);
  clientB = (c.rows[0] as { id: string }).id;
  apptB = await insertAppt(clientB, "2026-03-12T15:00:00Z");
  await settle(apptB, "paid_e_transfer", ETRANSFER);
}, 120_000);

afterAll(async () => {
  await cleanupPaymentScenario(s.studioId).catch(() => undefined);
  await closePool();
}, 120_000);

async function clientDoc(clientId: string) {
  const r = await loadClientStatementRead({ role: "owner" }, studio(), "cad", clientId, NOW, owner());
  if (!(r.access === "granted" && r.ok)) throw new Error("client read failed");
  const built = buildStatementDocument({
    studioId: s.studioId,
    identity: { studioName: "Synthetic", legalEntityName: null, address: null, contactEmail: null },
    client: r.client,
    scope: { kind: "month", month: MONTH },
    currency: r.studioCurrency,
    preparedOn: "2026-06-15",
    visits: r.visits,
    feeItems: r.feeItems,
  });
  if (!built.ok) throw new Error("build failed");
  return built.document;
}
const csvHeader = (doc: Awaited<ReturnType<typeof clientDoc>>) => {
  const rows = statementCsvLines(doc, 0);
  const get = (k: string) => rows.find((r) => r[0] === k)?.[1];
  return { visits: get("Visits"), paid: get("Paid"), refunded: get("Refunded") };
};

describe("one synthetic month reads the same on every Statements surface", () => {
  it("the independently known amounts: paid = cash + e-transfer, the card payment is refunded (not paid), the unpaid visit counts as a visit", async () => {
    const a = await clientDoc(s.clientId);
    const b = await clientDoc(clientB);
    expect(a.totals.visitCount).toBe(3);
    expect(a.totals.paidCents).toBe(CASH);
    expect(a.totals.refundedCents).toBe(REFUNDED_CARD);
    expect(b.totals.visitCount).toBe(1);
    expect(b.totals.paidCents).toBe(ETRANSFER);
    expect(b.totals.refundedCents).toBe(0);
  });

  it("Studio tab == Clients tab == the sum of the client One-month documents", async () => {
    const studioRead = await loadStatementView({ role: "owner" }, studio(), MONTH as never, "cad", owner());
    if (!(studioRead.access === "granted" && studioRead.ok)) throw new Error("studio read failed");
    const dirRead = await loadStatementDirectory({ role: "owner" }, studio(), "cad", MONTH as never, NOW, owner());
    if (!(dirRead.access === "granted" && dirRead.ok)) throw new Error("directory read failed");
    const a = await clientDoc(s.clientId);
    const b = await clientDoc(clientB);

    const studioCollected = studioRead.statement.all.collectedCents;
    expect(studioCollected).toBe(CASH + ETRANSFER);
    expect(dirRead.directory.totals.paidCents).toBe(studioCollected);
    expect(a.totals.paidCents + b.totals.paidCents).toBe(studioCollected);
    expect(dirRead.directory.totals.visitCount).toBe(a.totals.visitCount + b.totals.visitCount);
    expect(dirRead.directory.reconciliation.reconciled).toBe(true);

    // Each Clients-tab row equals that client's own statement.
    for (const [id, doc] of [[s.clientId, a], [clientB, b]] as const) {
      const row = dirRead.directory.rows.find((x) => x.clientId === id);
      expect(row, `row for ${id}`).toBeDefined();
      expect(row?.visitCount).toBe(doc.totals.visitCount);
      expect(row?.paidCents).toBe(doc.totals.paidCents);
    }
    // Studio tab lists exactly the month's visits.
    expect(studioRead.visitInfo ? Object.keys(studioRead.visitInfo).length : 0).toBe(a.totals.visitCount + b.totals.visitCount);
  });

  it("the CSV header (and so the print view, built from the same document) states the document's own figures", async () => {
    for (const id of [s.clientId, clientB]) {
      const doc = await clientDoc(id);
      const h = csvHeader(doc);
      expect(h.visits).toBe(String(doc.totals.visitCount));
      expect(h.paid).toBe((doc.totals.paidCents / 100).toFixed(2));
      expect(h.refunded).toBe((doc.totals.refundedCents / 100).toFixed(2));
    }
  });

  it("the unpaid visit and the refunded card visit are listed as visits, never as paid", async () => {
    const a = await clientDoc(s.clientId);
    const ids = a.visits.map((v) => v.appointmentId);
    expect(ids).toEqual(expect.arrayContaining([apptUnpaid, apptRefunded]));
    const unpaid = a.visits.find((v) => v.appointmentId === apptUnpaid);
    const refunded = a.visits.find((v) => v.appointmentId === apptRefunded);
    expect(unpaid?.paidCents).toBe(0);
    expect(refunded?.paidCents).toBe(0);
    expect(refunded?.refundedCents).toBe(REFUNDED_CARD);
  });
});
