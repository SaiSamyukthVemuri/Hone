import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { adminQuery, asUser, closePool, seedMember } from "./helpers/harness";
import { getAppointmentPaymentStates } from "@/lib/billing/appointment-payment-state";
import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "../../e2e/helpers/local-env";

// The app's server client reads auth from next/headers cookies. Serve it the
// cookies @supabase/ssr itself writes for a real local GoTrue session, so the
// PRODUCTION loader runs as that signed-in user (the owner-capacity DB test's
// pattern). Codex P2 4301170887: the owner view must come from the app's own
// read path, not a hand-written copy of it.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TZ = "America/Toronto";
import {
  cleanupPaymentScenario,
  seedEligibleQuickCheckoutScenario,
  type PaymentScenario,
} from "./helpers/payment-seed";

// HON-45 — complete clinical charting WITHOUT a card charge, against the real
// local Postgres.
//
// The studio here is a clinic that bills a third party (an insurer) and is
// paid later: NO connected payment account, NO card on file, and no Stripe
// fact anywhere. The question is whether today's schema already lets such a
// visit be charted, left honestly OUTSTANDING, and resolved later, without a
// card charge ever being required and without anything reading as money Hone
// received. This file proves the existing 0187 path does exactly that; it adds
// no schema. A distinct "billed to insurer" state is deliberately NOT here: it
// waits on product decisions (full amount vs copay split; who records the
// insurer's payment; what a denial does).

const LIVE = true;
const PRICE = 15000;

const created: string[] = [];
afterAll(async () => {
  for (const studioId of created) {
    await cleanupPaymentScenario(studioId).catch(() => undefined);
  }
  await closePool();
});

/**
 * A completed, CHARTED visit at a studio with no payment account and no card,
 * charted THROUGH THE PRACTITIONER'S OWN PATH (Codex P2 4301054610): the seed
 * leaves a CONFIRMED appointment with NO session; the practitioner then starts
 * the session (start_session) and charts a treatment pass
 * (add_electrolysis_pass) as themselves, under the commands' own authority and
 * RLS, and the appointment is completed by mark_appointment_complete, the same
 * command the app's finish action calls. If any of those refused a studio with
 * no payment account or card, this fixture, and every test below, would fail.
 */
async function cardlessChartedVisit(): Promise<PaymentScenario & { sessionId: string; entryId: string }> {
  // The visit is BOOKED at PRICE, so 0187 snapshots that as the settlement's
  // quoted amount: the proof is "the FULL visit price is outstanding", not
  // "some amount can be marked outstanding" (Codex P2 4301066739).
  const s = await seedEligibleQuickCheckoutScenario({
    label: "hon45",
    connect: "missing_account",
    withCard: false,
    bookedService: { name: "Electrolysis 60", priceCents: PRICE },
    appointmentStatus: "confirmed",
    withSession: false,
  });
  created.push(s.studioId);

  const started = await asUser(s.practitionerUserId, (q) =>
    q(`select session_id from public.start_session($1, $2, $3, $4, $5)`, [
      s.clientId,
      "electrolysis",
      s.appointmentId,
      0,
      s.studioId,
    ]),
  );
  const sessionId = started.rows[0]?.session_id as string | undefined;
  if (!sessionId) throw new Error("hon45: start_session returned no session for a cardless studio");

  const pass = await asUser(s.practitionerUserId, (q) =>
    q(
      `select entry_id from public.add_electrolysis_pass(
         p_session_id => $1, p_client_id => $2, p_block_id => null, p_block_defaults => '{}'::jsonb,
         p_area => 'upper lip', p_areas_list => null, p_probe_size => null, p_probe_lot_id => null,
         p_mode => null, p_intensity => null, p_duration_seconds => null, p_pulse_count => 3,
         p_pulse_delay_seconds => null, p_comments => 'cardless chart', p_observation_chips => null,
         p_apilus_modality => null, p_energy_level => null, p_minutes_performed => 15, p_probe_type => null,
         p_machine_frequency => null, p_hairs_treated => null, p_galvanic_ma => null,
         p_galvanic_duration_seconds => null, p_thermolysis_intensity_percent => null,
         p_thermolysis_duration_seconds => null, p_units_of_lye => null)`,
      [sessionId, s.clientId],
    ),
  );
  const entryId = pass.rows[0]?.entry_id as string | undefined;
  if (!entryId) throw new Error("hon45: add_electrolysis_pass charted nothing for a cardless studio");

  // Completion: the command the app's finish action calls (with the server's
  // client, after its own practitioner check).
  await adminQuery(`select public.mark_appointment_complete($1, $2, $3)`, [
    s.appointmentId,
    s.studioId,
    s.practitionerId,
  ]);
  return { ...s, sessionId, entryId };
}

async function record(userId: string, studioId: string, appointmentId: string, method: string, cents: number) {
  return asUser(userId, async (q) => {
    const r = await q(
      `select * from public.record_appointment_settlement($1,$2,$3,$4,$5,$6)`,
      [studioId, appointmentId, method, cents, null, LIVE],
    );
    return r.rows[0] as { result: string; settlement_id: string | null };
  });
}

async function supersede(userId: string, studioId: string, targetId: string, method: string, cents: number, reason: string) {
  return asUser(userId, async (q) => {
    const r = await q(
      `select * from public.supersede_appointment_settlement($1,$2,$3,$4,$5,$6,$7)`,
      [studioId, targetId, method, cents, reason, null, LIVE],
    );
    return r.rows[0] as { result: string; settlement_id: string | null };
  });
}

async function settlements(studioId: string) {
  const r = await adminQuery(
    `select id, method, amount_cents, quoted_amount_cents, superseded_at, supersedes_id, supersede_reason
       from public.appointment_settlements where studio_id = $1 order by recorded_at`,
    [studioId],
  );
  return r.rows as Array<{
    id: string;
    method: string;
    amount_cents: number;
    quoted_amount_cents: number | null;
    superseded_at: string | null;
    supersedes_id: string | null;
    supersede_reason: string | null;
  }>;
}

type SignedIn = { userId: string; cookies: Map<string, string> };

/**
 * Sign a practitioner in for real: a local GoTrue user (password grant),
 * repointed at the practitioner row, and the auth cookies @supabase/ssr writes
 * for that session. Returns the new auth user id, which is now this
 * practitioner's identity for the database's owner checks too.
 */
async function signIn(practitionerId: string, label: string): Promise<SignedIn> {
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
  await adminQuery(`update public.practitioners set user_id = $2, email = $3 where id = $1`, [
    practitionerId,
    authUser.id,
    email,
  ]);
  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  const session = (await token.json()) as { access_token: string; refresh_token: string };
  const cookies = new Map<string, string>();
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...cookies.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) =>
        list.forEach(({ name, value }) => cookies.set(name, value)),
    },
  });
  await writer.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (cookies.size === 0) throw new Error("no auth cookie was written");
  return { userId: authUser.id, cookies };
}

/**
 * What the OWNER sees for this visit, from the PRODUCTION loader the app uses
 * to badge appointments (getAppointmentPaymentStates, which composes the card
 * read, the live-settlement read and the precedence rules), run with the
 * signed-in user's own cookies. A newly minted JWT can briefly read as issued
 * in the future (PGRST303) while the containers' clocks settle, which the
 * loader reports as "unavailable"; that is retried, never accepted.
 */
async function ownerView(who: SignedIn, studioId: string, appointmentId: string): Promise<string | undefined> {
  // The app's server client reads these; point them at the SAME stack the
  // paired guard selected (as tests/db/owner-capacity.db.test.ts does).
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  jar.clear();
  for (const [name, value] of who.cookies) jar.set(name, value);
  let state: string | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = (await getAppointmentPaymentStates(studioId, [appointmentId], TZ, true)).get(appointmentId);
    if (state !== "unavailable") return state;
    await new Promise((r) => setTimeout(r, 250));
  }
  return state;
}

async function cardFacts(studioId: string) {
  const r = await adminQuery(
    `select
       (select count(*)::int from public.payment_charge_attempts where studio_id = $1) as attempts,
       (select count(*)::int from public.studio_payment_settings where studio_id = $1) as accounts,
       (select count(*)::int from public.client_payment_methods where studio_id = $1) as cards`,
    [studioId],
  );
  return r.rows[0] as { attempts: number; accounts: number; cards: number };
}

async function chartIntact(s: PaymentScenario & { sessionId: string; entryId: string }) {
  const r = await adminQuery(
    `select
       (select count(*)::int from public.sessions where id = $1) as sessions,
       (select count(*)::int from public.electrolysis_entries where id = $2 and session_id = $1) as entries,
       (select status from public.appointments where id = $3) as appointment_status,
       (select price_paid_cents from public.sessions where id = $1) as price_paid_cents`,
    [s.sessionId, s.entryId, s.appointmentId],
  );
  return r.rows[0] as {
    sessions: number;
    entries: number;
    appointment_status: string;
    price_paid_cents: number | null;
  };
}

/** The chart is intact AND carries no payment fact: an unpaid visit. */
const INTACT_UNPAID = { sessions: 1, entries: 1, appointment_status: "completed", price_paid_cents: null };

describe("HON-45 — a cardless clinic completes a charted visit with the amount left outstanding", () => {
  it("the visit is completed and charted with no payment account, no card and no charge attempt", async () => {
    const s = await cardlessChartedVisit();
    expect(await cardFacts(s.studioId)).toEqual({ attempts: 0, accounts: 0, cards: 0 });
    expect(await chartIntact(s)).toEqual(INTACT_UNPAID);
  });

  it("the OWNER records the visit as STILL OWED (a practitioner is refused: owner_only, HON-44); nothing reads as money received", async () => {
    const s = await cardlessChartedVisit();
    const member = await seedMember(
      { studioId: s.studioId, userId: s.practitionerUserId, practitionerId: s.practitionerId, clientId: s.clientId },
      "hon45-member",
    );
    // BEFORE anything is recorded, the signed-in owner's loader gives a real
    // answer that is NOT "settled_owing": the state below comes from the record.
    const owner = await signIn(s.practitionerId, "hon45-owner");
    const beforeView = await ownerView(owner, s.studioId, s.appointmentId);
    expect(beforeView).toBeDefined();
    expect(["settled_owing", "unavailable"]).not.toContain(beforeView);

    // HON-44 / 0254 (Sam decision 12): recording what is owed is a financial act.
    // A practitioner of the studio is refused and nothing is written.
    const refused = await record(member.userId, s.studioId, s.appointmentId, "still_owes", PRICE);
    expect(refused.result).toBe("owner_only");
    expect(await settlements(s.studioId)).toHaveLength(0);

    const out = await record(owner.userId, s.studioId, s.appointmentId, "still_owes", PRICE);
    expect(out.result).toBe("recorded");

    const rows = await settlements(s.studioId);
    expect(rows).toHaveLength(1);
    // 0187: for still_owes the one amount column is the amount OUTSTANDING,
    // and the server snapshots the visit's price as quoted_amount_cents. The
    // outstanding amount IS the full visit price, not a partial one.
    expect(rows[0]).toMatchObject({
      method: "still_owes",
      amount_cents: PRICE,
      quoted_amount_cents: PRICE,
      superseded_at: null,
    });
    expect(rows[0].amount_cents).toBe(rows[0].quoted_amount_cents);

    // No card money exists or was created, and the outstanding record does not
    // block a later payment (0187: still_owes is deliberately non-blocking).
    expect(await cardFacts(s.studioId)).toEqual({ attempts: 0, accounts: 0, cards: 0 });
    const flags = await adminQuery(
      `select public.appointment_has_live_card_money($1,$2,$3) as card_money,
              public.appointment_has_blocking_settlement($1,$2) as blocking`,
      [s.studioId, s.appointmentId, LIVE],
    );
    expect(flags.rows[0]).toEqual({ card_money: false, blocking: false });

    // THE OWNER SEES IT AS OUTSTANDING, through the app's own loader, signed in.
    expect(await ownerView(owner, s.studioId, s.appointmentId)).toBe("settled_owing");
    // CONTROL: the loader runs under RLS, so it CAN say something else. The
    // owner of a different studio, through the same loader, does not see it.
    const other = await cardlessChartedVisit();
    const otherOwner = await signIn(other.practitionerId, "hon45-other");
    const otherView = await ownerView(otherOwner, s.studioId, s.appointmentId);
    // A real answer (the loader ran and RLS hid the visit's records), not a
    // failed read and not the owner's view.
    expect(otherView).toBeDefined();
    expect(["settled_owing", "unavailable"]).not.toContain(otherView);

    // Recording the outstanding amount changed nothing in the chart.
    expect(await chartIntact(s)).toEqual(INTACT_UNPAID);
  });

  // TODAY'S MECHANISM, NOT A DECISION. Whether a practitioner should be able to
  // record the insurer's payment is an open product question (HON-45 D2). This
  // pins what 0187 does now, owner-only correction, so a change to it is
  // deliberate and visible; it does not settle D2.
  it("today, when the third party pays later, only the OWNER can record it, and the outstanding history is kept", async () => {
    const s = await cardlessChartedVisit();
    const member = await seedMember(
      { studioId: s.studioId, userId: s.practitionerUserId, practitionerId: s.practitionerId, clientId: s.clientId },
      "hon45-payer",
    );
    // The owner records the outstanding amount (HON-44 / 0254: a practitioner can
    // no longer record it). Signing in repoints the owner's practitioner row at the
    // new auth user, so the owner signs in first.
    const owner = await signIn(s.practitionerId, "hon45-owner");
    const owed = await record(owner.userId, s.studioId, s.appointmentId, "still_owes", PRICE);
    expect(owed.result).toBe("recorded");

    // A practitioner cannot turn "owed" into "paid": that is a correction, and
    // corrections are owner-only (0187). The visit stays outstanding.
    const byMember = await supersede(member.userId, s.studioId, owed.settlement_id!, "paid_other_external", PRICE, "insurer paid");
    expect(byMember.result).toBe("not_owner");
    expect((await settlements(s.studioId)).filter((r) => r.superseded_at === null)).toEqual([
      expect.objectContaining({ method: "still_owes", amount_cents: PRICE }),
    ]);
    expect(await ownerView(owner, s.studioId, s.appointmentId)).toBe("settled_owing");

    // The owner records the payment as received some other way. (Signing in
    // repointed the owner's practitioner row at the new auth user.)
    const byOwner = await supersede(owner.userId, s.studioId, owed.settlement_id!, "paid_other_external", PRICE, "insurer paid");
    expect(byOwner.result).toBe("corrected");

    const rows = await settlements(s.studioId);
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === owed.settlement_id)!;
    expect(original).toMatchObject({ method: "still_owes", amount_cents: PRICE });
    expect(original.superseded_at).not.toBeNull();
    const live = rows.filter((r) => r.superseded_at === null);
    expect(live).toEqual([
      expect.objectContaining({
        method: "paid_other_external",
        amount_cents: PRICE,
        supersedes_id: owed.settlement_id,
        supersede_reason: "insurer paid",
      }),
    ]);

    // The owner now sees the visit as paid some other way, no longer outstanding.
    expect(await ownerView(owner, s.studioId, s.appointmentId)).toBe("settled_other");

    // Still no card fact anywhere, and the chart is untouched.
    expect(await cardFacts(s.studioId)).toEqual({ attempts: 0, accounts: 0, cards: 0 });
    expect(await chartIntact(s)).toEqual(INTACT_UNPAID);
  });
});
