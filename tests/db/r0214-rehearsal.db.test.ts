import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  adminQuery,
  adminTx,
  asRole,
  asUser,
  closePool,
} from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import {
  seedQuickCheckoutScenario,
  type PaymentScenario,
  type SeedOptions,
} from "./helpers/payment-seed";

// R0214-REHEARSAL (Sam's directions B, section 2). SYNTHETIC DATA ONLY.
//
// OBSERVES, does not assert, what works and what fails after S1 for each
// historical state, before and after the S2 jurisdiction initialization. Every
// cell prints ONE parseable line:
//
//   R0214|<variant>|<state>|<phase>|<area>|<WORKS|FAILS|NOT_EXERCISED>|<detail>
//
// The only assertion is that every expected cell was emitted, so the file
// cannot pass vacuously. The variant is read from the DATABASE (does the
// initializer exist?), not from the branch name.
//
// METHOD LIMITS (reported, not hidden):
//  * The chain is applied in full (0001..0246) before this file runs; history is
//    written afterwards, with the studio's jurisdiction row then removed. That
//    equals a pre-0214 studio only if 0214 does nothing to existing rows at
//    apply time. The only statements in 0214 that read existing rows are the
//    ALTER TABLE ... ADD CONSTRAINT ... CHECK statements, so each state replays
//    exactly those statements, inside a rolled-back transaction, over the seeded
//    history (area apply_replay).
//  * The app layer runs in-process against this database: the REAL
//    getSessionPaymentEligibility, runSessionPaymentCharge and
//    refundPaymentChargeAttempt with the repo's fake Stripe. Connect onboarding
//    creates its account through getStripe(), which has no fake; that cell
//    stubs the Stripe SDK and says so.
//  * There is no distinct "insurance-pending" state in the schema at this head
//    (HON-45 draft, unnumbered). The insurance-pending cell completes a visit
//    and records the only existing disposition, still_owes.

// THE REPO'S FAKE STRIPE RETURNS A REFUND WITH NO charge / payment_intent /
// customer, and refundPaymentChargeAttempt's identity check requires them to
// equal the attempt's, so against the bare fake EVERY refund ends in
// needs_manual_review regardless of jurisdiction (measured in round 2/3 of this
// rehearsal). This adapter fills those three fields from the attempt row so the
// rest of the real refund path is exercised. It is a rehearsal-only test double.
vi.mock("@/lib/stripe/session-payment-stripe", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/stripe/session-payment-stripe")>();
  return {
    ...orig,
    getSessionPaymentStripe: () => {
      const fake = orig.getSessionPaymentStripe() as unknown as {
        refunds: { create: (p: { charge?: string | null }, o?: unknown) => Promise<Record<string, unknown>> };
      };
      const create = fake.refunds.create.bind(fake.refunds);
      fake.refunds.create = async (params, opts) => {
        const r = await create(params, opts);
        const { adminQuery: q } = await import("./helpers/harness");
        const a = await q(
          `select stripe_payment_intent_id, stripe_customer_id from public.payment_charge_attempts where stripe_charge_id=$1 limit 1`,
          [params.charge],
        );
        return {
          ...r,
          charge: params.charge,
          payment_intent: a.rows[0]?.stripe_payment_intent_id ?? null,
          customer: a.rows[0]?.stripe_customer_id ?? null,
        };
      };
      return fake as never;
    },
  };
});

type Outcome = "WORKS" | "FAILS" | "NOT_EXERCISED";
class NotExercised extends Error {}
class Refused extends Error {}

const cells: string[] = [];
let variant: "A" | "U" = "A";

function clean(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b(acct|pi|ch|re|cus|pm|seti)_[A-Za-z0-9_]+/g, "$1_<id>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .slice(0, 220);
}

function emit(state: string, phase: string, area: string, outcome: Outcome, detail: string) {
  const line = `R0214|${variant}|${state}|${phase}|${area}|${outcome}|${clean(detail)}`;
  cells.push(`${state}|${phase}|${area}`);
  console.log(line);
}

async function cell(state: string, phase: string, area: string, fn: () => Promise<string>) {
  try {
    emit(state, phase, area, "WORKS", await fn());
  } catch (e) {
    if (e instanceof NotExercised) return emit(state, phase, area, "NOT_EXERCISED", e.message);
    if (e instanceof Refused) return emit(state, phase, area, "FAILS", e.message);
    const err = e as { code?: string; message?: string };
    emit(state, phase, area, "FAILS", `${err.code ?? "error"}: ${err.message ?? String(e)}`);
  }
}

async function prep<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new NotExercised(`setup failed (${what}): ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// environment for the in-process app libraries
// ---------------------------------------------------------------------------
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}
const saved = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  stripe: process.env.STRIPE_SECRET_KEY,
  fake: process.env.HONE_E2E_FAKE_STRIPE,
  run: process.env.HONE_E2E_RUN_ID,
};

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.HONE_E2E_FAKE_STRIPE = "1";
  process.env.HONE_E2E_RUN_ID = `r0214-${randomUUID().slice(0, 8)}`;
  const r = await adminQuery(
    `select to_regprocedure('public.initialize_studio_payment_jurisdiction_from_history(uuid,text,text,text,text,text,boolean,text[],uuid[])') is not null as has_init`,
  );
  variant = r.rows[0].has_init ? "A" : "U";
  console.log(`R0214|${variant}|-|-|variant_detected|WORKS|initializer ${r.rows[0].has_init ? "present" : "absent"} in the applied chain`);
  const ver = await adminQuery(`select max(version) as v from supabase_migrations.schema_migrations`).catch(() => null);
  console.log(`R0214|${variant}|-|-|chain_head|WORKS|${ver ? String(ver.rows[0].v) : "unreadable"}`);
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  process.env.STRIPE_SECRET_KEY = saved.stripe;
  process.env.HONE_E2E_FAKE_STRIPE = saved.fake;
  process.env.HONE_E2E_RUN_ID = saved.run;
  await closePool();
});

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------
type StateKey = "h0" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
type StateDef = { opts: SeedOptions; hasCard: boolean; history: (sc: PaymentScenario) => Promise<void> };

const rid = () => randomUUID().replace(/-/g, "").slice(0, 14);

async function raw(table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await adminTx(async (q) => {
    await q(`set local session_replication_role = replica`);
    await q(
      `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      cols.map((c) => row[c]),
    );
  });
}

let apptCounter = 0;
async function newAppt(sc: PaymentScenario, status: string, withSession: boolean, price = 22500) {
  // A distinct hour per call: the scenario's own visit sits at now-90..now-30
  // minutes and a practitioner cannot overlap themselves.
  apptCounter += 1;
  const starts = new Date(Date.now() - (300 + apptCounter * 90) * 60_000).toISOString();
  const ends = new Date(Date.now() - (240 + apptCounter * 90) * 60_000).toISOString();
  const a = await adminQuery(
    `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4,$5,60,$6) returning id`,
    [sc.studioId, sc.practitionerId, sc.clientId, starts, ends, status],
  );
  const appointmentId = a.rows[0].id as string;
  if (!withSession) return { appointmentId, sessionId: undefined as string | undefined };
  const s = await adminQuery(
    `insert into public.sessions (studio_id, client_id, practitioner_id, performed_by_practitioner_id, modality, appointment_id, started_at, price_paid_cents)
     values ($1,$2,$3,$3,'electrolysis',$4,now(),$5) returning id`,
    [sc.studioId, sc.clientId, sc.practitionerId, appointmentId, price],
  );
  return { appointmentId, sessionId: s.rows[0].id as string };
}

async function settleSeed(sc: PaymentScenario, method: string) {
  const a = await newAppt(sc, "completed", false);
  await asUser(sc.practitionerUserId, (q) =>
    q(`select * from public.record_appointment_settlement($1,$2,$3,$4,$5,$6)`, [sc.studioId, a.appointmentId, method, 4500, null, false]),
  );
}

/**
 * The seeded 'succeeded' card charge lacks the account/customer/method ids the
 * real charge path writes onto the row; refund refuses without them. Add them
 * (replica mode: a succeeded row is otherwise immutable).
 */
async function bindSucceededAttempt(sc: PaymentScenario) {
  await adminTx(async (q) => {
    await q(`set local session_replication_role = replica`);
    await q(
      `update public.payment_charge_attempts a set
         stripe_account_id = (select stripe_account_id from public.studio_payment_settings where studio_id=a.studio_id limit 1),
         stripe_customer_id = (select stripe_customer_id from public.client_stripe_customers where client_id=a.client_id limit 1),
         stripe_payment_method_id = (select stripe_payment_method_id from public.client_payment_methods where client_id=a.client_id and studio_id=a.studio_id limit 1)
       where a.studio_id=$1 and a.status='succeeded'`,
      [sc.studioId],
    );
  });
}

const ELIGIBLE: SeedOptions = {
  appointmentStatus: "completed", withSession: true, sessionStarted: true,
  withCard: true, cardStatus: "active", withTemplate: true, withSignature: true,
  signatureCurrent: true, connect: "enabled", attempt: "none",
};
const CARDLESS: SeedOptions = {
  appointmentStatus: "completed", withSession: true, sessionStarted: true,
  withCard: false, connect: "missing_account", attempt: "none",
};

const STATES: Record<StateKey, StateDef> = {
  h0: {
    hasCard: false,
    opts: { ...CARDLESS, appointmentStatus: "confirmed", withSession: false },
    history: async () => undefined,
  },
  h1: {
    hasCard: true,
    opts: { ...ELIGIBLE, attempt: "succeeded" },
    history: async (sc) => {
      await bindSucceededAttempt(sc);
      await settleSeed(sc, "paid_cash");
      // Audit rows written before currency was recorded: NULL currency.
      for (let i = 0; i < 2; i++) {
        await raw("stripe_payment_audit", {
          studio_id: sc.studioId, action: "charge_attempted", appointment_id: randomUUID(),
          stripe_account_id: null, stripe_livemode: null, currency: null,
        });
      }
    },
  },
  h2: {
    hasCard: false,
    opts: { ...ELIGIBLE, withCard: false, withTemplate: false, withSignature: false, connectLivemode: false },
    history: async (sc) => {
      await raw("stripe_account_provisioning_attempts", {
        studio_id: sc.studioId, status: "failed", idempotency_key: `idem_${rid()}`,
        stripe_account_id: null, stripe_livemode: false,
      });
    },
  },
  h3: { hasCard: false, opts: CARDLESS, history: async () => undefined },
  h4: { hasCard: false, opts: CARDLESS, history: async () => undefined },
  h5: {
    hasCard: true,
    opts: { ...ELIGIBLE },
    history: async (sc) => {
      for (const m of ["paid_cash", "paid_e_transfer", "paid_other_external"]) await settleSeed(sc, m);
    },
  },
  h6: { hasCard: true, opts: { ...ELIGIBLE, attempt: "succeeded" }, history: bindSucceededAttempt },
};

// ---------------------------------------------------------------------------
// the 0214 apply-time replay over seeded history
// ---------------------------------------------------------------------------
function migration0214(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  const f = readdirSync(dir).find((n) => n.startsWith("0214_"))!;
  return readFileSync(join(dir, f), "utf8");
}

/** Exactly the statements of 0214 that read existing rows when they run. */
function replayStatements(sql: string): string[] {
  const noComments = sql.replace(/--[^\n]*/g, "");
  const out: string[] = [];
  const re = /alter table public\.[a-z_]+[\s\S]*?;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    if (/add constraint|add column|drop constraint/i.test(m[0])) out.push(m[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------
const AREAS = [
  "charting", "records_read", "booking",
  "complete_unpaid", "complete_insurance_pending",
  "settle_cash", "settle_e_transfer", "settle_other_external", "settle_still_owes",
  "card_eligibility_app", "card_prepare_db", "card_run_app", "card_refund_app",
  "onboard_claim_db", "onboard_app_stubbed_stripe",
] as const;

const ran = new Map<string, string>();
let slot = 0;
const nextStart = () => {
  slot += 1;
  const d = new Date(Date.UTC(2031, 8, 15 + Math.floor(slot / 20), 6 + (slot % 20), 0, 0));
  return d.toISOString();
};

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

async function ensureBookable(sc: PaymentScenario) {
  await adminQuery(`update public.studios set timezone='UTC', buffer_minutes=0, practitioner_capacity_enabled=true, practitioner_capacity_booking_enabled=true where id=$1`, [sc.studioId]);
  await adminQuery(
    `insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time)
     select $1, d, true, '00:00', '23:59' from generate_series(0,6) d
     on conflict do nothing`,
    [sc.studioId],
  ).catch(() => undefined);
  const svc = await adminQuery(
    `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
     values ($1,'R0214 Consult',30,0,true,'consultation') returning id`,
    [sc.studioId],
  );
  return svc.rows[0].id as string;
}

function resultOf(rows: Array<Record<string, unknown>>): string {
  const r = rows[0] ?? {};
  return String(r.result ?? r.out_result ?? "no_row");
}

async function probes(state: StateKey, phase: "pre_s2" | "post_s2", sc: PaymentScenario, serviceId: string | null, hasCard: boolean) {
  const user = sc.practitionerUserId;

  await cell(state, phase, "charting", async () => {
    const a = await prep("appointment", () => newAppt(sc, "confirmed", false));
    const started = await asUser(user, (q) =>
      q(`select session_id from public.start_session($1,$2,$3,$4,$5)`, [sc.clientId, "electrolysis", a.appointmentId, 0, sc.studioId]),
    );
    const sessionId = started.rows[0]?.session_id as string | undefined;
    if (!sessionId) throw new Refused("start_session returned no session");
    const pass = await asUser(user, (q) =>
      q(
        `select entry_id from public.add_electrolysis_pass(
           p_session_id => $1, p_client_id => $2, p_block_id => null, p_block_defaults => '{}'::jsonb,
           p_area => 'upper lip', p_areas_list => null, p_probe_size => null, p_probe_lot_id => null,
           p_mode => null, p_intensity => null, p_duration_seconds => null, p_pulse_count => 3,
           p_pulse_delay_seconds => null, p_comments => 'r0214 chart', p_observation_chips => null,
           p_apilus_modality => null, p_energy_level => null, p_minutes_performed => 15, p_probe_type => null,
           p_machine_frequency => null, p_hairs_treated => null, p_galvanic_ma => null,
           p_galvanic_duration_seconds => null, p_thermolysis_intensity_percent => null,
           p_thermolysis_duration_seconds => null, p_units_of_lye => null)`,
        [sessionId, sc.clientId],
      ),
    );
    if (!pass.rows[0]?.entry_id) throw new Refused("add_electrolysis_pass charted nothing");
    return "start_session + add_electrolysis_pass charted an entry";
  });

  await cell(state, phase, "records_read", async () => {
    const r = await asUser(user, (q) =>
      q(`select (select count(*) from public.clients where id=$1)::int as c, (select count(*) from public.sessions where client_id=$1)::int as s`, [sc.clientId]),
    );
    if (r.rows[0].c !== 1) throw new Refused(`client row not visible (count ${r.rows[0].c})`);
    return `client visible, ${r.rows[0].s} session row(s) readable as the owner`;
  });

  await cell(state, phase, "booking", async () => {
    const svc = serviceId ?? (await prep("service", () => ensureBookable(sc)));
    const out = await adminQuery(
      `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10)`,
      [sc.studioId, sc.practitionerId, sc.practitionerId, sc.clientId, svc, nextStart(), hash64(), null, null, false],
    );
    const res = resultOf(out.rows);
    if (res !== "created" && res !== "ok" && !out.rows[0]?.appointment_id) throw new Refused(`result ${res}`);
    return `create_internal_appointment_v2 -> ${res}`;
  });

  await cell(state, phase, "complete_unpaid", async () => {
    const a = await prep("appointment", () => newAppt(sc, "confirmed", true));
    await adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [a.appointmentId, sc.studioId, sc.practitionerId]);
    const s = await adminQuery(`select status from public.appointments where id=$1`, [a.appointmentId]);
    if (s.rows[0].status !== "completed") throw new Refused(`status ${s.rows[0].status}`);
    const owed = await adminQuery(`select count(*)::int c from public.appointment_settlements where appointment_id=$1`, [a.appointmentId]);
    return `completed with ${owed.rows[0].c} settlement rows (left unpaid)`;
  });

  const settle = async (method: string, livemode = false) => {
    const a = await prep("appointment", () => newAppt(sc, "completed", true));
    const r = await asUser(user, (q) =>
      q(`select * from public.record_appointment_settlement($1,$2,$3,$4,$5,$6)`, [sc.studioId, a.appointmentId, method, 4500, null, livemode]),
    );
    const res = resultOf(r.rows);
    if (res !== "recorded") throw new Refused(`result ${res}`);
    const back = await adminQuery(`select method, currency from public.appointment_settlements where id=$1`, [r.rows[0].settlement_id]);
    return `recorded ${back.rows[0].method} currency=${back.rows[0].currency}`;
  };

  await cell(state, phase, "complete_insurance_pending", async () => {
    const a = await prep("appointment", () => newAppt(sc, "confirmed", true));
    await adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [a.appointmentId, sc.studioId, sc.practitionerId]);
    const r = await asUser(user, (q) =>
      q(`select * from public.record_appointment_settlement($1,$2,'still_owes',4500,null,false)`, [sc.studioId, a.appointmentId]),
    );
    const res = resultOf(r.rows);
    if (res !== "recorded") throw new Refused(`completed, but still_owes result ${res}`);
    return "completed, then the only existing disposition (still_owes) recorded";
  });

  await cell(state, phase, "settle_cash", () => settle("paid_cash"));
  await cell(state, phase, "settle_e_transfer", () => settle("paid_e_transfer"));
  await cell(state, phase, "settle_other_external", () => settle("paid_other_external"));
  await cell(state, phase, "settle_still_owes", () => settle("still_owes"));

  // ---- card, app layer ----------------------------------------------------
  await cell(state, phase, "card_eligibility_app", async () => {
    const a = await prep("appointment", () => newAppt(sc, "completed", true));
    const { getSessionPaymentEligibility } = await import("@/lib/billing/session-payment-eligibility");
    const e = await getSessionPaymentEligibility({ studioId: sc.studioId, sessionId: a.sessionId! });
    if (e.eligible) return "eligible: true";
    throw new Refused(`not eligible: ${e.blockingReasons.join(" / ")}`);
  });

  const readyAttempt = async () => {
    const a = await newAppt(sc, "completed", true);
    const row = await adminQuery(
      `insert into public.payment_charge_attempts
         (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id,
          amount_cents, currency, status, stripe_livemode, client_payment_method_id, card_authorization_signature_id,
          stripe_account_id, stripe_customer_id, stripe_payment_method_id)
       values ($1,'session_payment',$2,$3,$4,$5,22500,'cad','ready',false,
         (select id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1),
         (select id from public.client_consent_signatures where client_id=$2 and studio_id=$1 order by template_version desc limit 1),
         (select stripe_account_id from public.studio_payment_settings where studio_id=$1 limit 1),
         (select stripe_customer_id from public.client_stripe_customers where client_id=$2 limit 1),
         (select stripe_payment_method_id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1))
       returning id`,
      [sc.studioId, sc.clientId, a.sessionId, a.appointmentId, sc.practitionerId],
    );
    return row.rows[0].id as string;
  };

  await cell(state, phase, "card_prepare_db", async () => {
    if (!hasCard) throw new NotExercised("state has no saved card or authorization, so a ready attempt cannot be built for it");
    const id = await readyAttempt();
    return `ready attempt row inserted (guard trigger passed) ${id ? "" : ""}`.trim();
  });

  await cell(state, phase, "card_run_app", async () => {
    if (!hasCard) throw new NotExercised("state has no saved card or authorization");
    let id: string;
    try {
      id = await readyAttempt();
    } catch (e) {
      const m = (e as Error).message;
      if (/payment_jurisdiction_missing/.test(m)) throw new Refused(`charge attempt could not be created: ${m}`);
      throw new NotExercised(`setup failed (ready attempt): ${m}`);
    }
    const { runSessionPaymentCharge } = await import("@/lib/billing/session-payment-charge");
    const r = (await runSessionPaymentCharge({ attemptId: id, studioId: sc.studioId, practitionerId: sc.practitionerId })) as unknown as Record<string, unknown>;
    if (r.ok === true) {
      ran.set(`${state}|${phase}`, id);
      return `runSessionPaymentCharge -> ${String(r.outcome)} (fake Stripe)`;
    }
    throw new Refused(`runSessionPaymentCharge -> ${String(r.outcome ?? "")} ${String(r.message ?? r.failureCode ?? "")}`);
  });

  await cell(state, phase, "card_refund_app", async () => {
    const made = ran.get(`${state}|${phase}`);
    const att = made
      ? { rows: [{ id: made }] }
      : await adminQuery(
          `select id from public.payment_charge_attempts where studio_id=$1 and status='succeeded' and (refund_status is null or refund_status='none') order by created_at limit 1`,
          [sc.studioId],
        );
    if (att.rows.length === 0) throw new NotExercised("no refund-eligible succeeded card charge in this state (or already refunded by an earlier phase)");
    const { refundPaymentChargeAttempt } = await import("@/lib/billing/payment-refund");
    const r = (await refundPaymentChargeAttempt({ attemptId: att.rows[0].id, studioId: sc.studioId, practitionerId: sc.practitionerId })) as unknown as Record<string, unknown>;
    if (r.ok === true) return `refundPaymentChargeAttempt -> ${String(r.outcome)} (fake Stripe)`;
    throw new Refused(`refundPaymentChargeAttempt -> ${String(r.outcome ?? "")} ${String(r.message ?? r.failureCode ?? "")}`);
  });

  // ---- Connect onboarding -------------------------------------------------
  await cell(state, phase, "onboard_claim_db", async () => {
    const r = await asRole("service_role", (q) =>
      q(`select * from public.create_or_claim_stripe_account_provisioning($1,false)`, [sc.studioId]),
    );
    const row = r.rows[0] ?? {};
    return `claim returned ${Object.keys(row).filter((k) => /already|account|status/i.test(k)).map((k) => `${k}=${String(row[k] === null ? "null" : typeof row[k] === "string" && /^acct_/.test(String(row[k])) ? "acct" : row[k])}`).join(",") || "a row"}`;
  });

  await cell(state, phase, "onboard_app_stubbed_stripe", async () => {
    const mod = await import("@/lib/stripe/account");
    // The Stripe SDK itself is not reachable (no fake exists for Connect); this
    // cell therefore proves only the app/DB decision BEFORE any Stripe call.
    try {
      const out = await mod.createOrLoadConnectedAccountForStudio(sc.studioId);
      return `createOrLoadConnectedAccountForStudio -> alreadyProvisioned=${out.alreadyProvisioned}`;
    } catch (e) {
      const m = (e as Error).message;
      if (/Could not start Stripe onboarding|payment_jurisdiction_missing|jurisdiction/i.test(m)) throw new Refused(m);
      throw new NotExercised(`reached the Stripe SDK boundary (${m.slice(0, 80)}); no Connect fake exists, so the SDK call is not exercised`);
    }
  });
}

// ---------------------------------------------------------------------------
// one test per state
// ---------------------------------------------------------------------------
async function stripJurisdiction(studioId: string) {
  await adminTx(async (q) => {
    await q(`set local session_replication_role = replica`);
    await q(`delete from public.studio_payment_jurisdiction_changes where studio_id=$1`, [studioId]);
    await q(`delete from public.studio_payment_jurisdictions where studio_id=$1`, [studioId]);
  });
}

async function s2(state: StateKey, sc: PaymentScenario) {
  await cell(state, "s2", "s2_init", async () => {
    if (variant === "A") {
      const call = (ackPrices: boolean, accounts: string[] | null, attempts: string[] | null) =>
        adminQuery(
          `select * from public.initialize_studio_payment_jurisdiction_from_history($1,'CA','cad','operator:rehearsal','rehearsal over synthetic history','fixture:r0214',$2,$3::text[],$4::uuid[])`,
          [sc.studioId, ackPrices, accounts, attempts],
        );
      const ok = (x: string) => x === "initialized" || x === "changed" || x === "unchanged";
      const first = resultOf((await call(false, null, null)).rows);
      if (ok(first)) return `initializer: ${first}`;
      const accts = (await adminQuery(`select stripe_account_id from public.studio_payment_settings where studio_id=$1 and stripe_account_id is not null`, [sc.studioId])).rows.map((x) => x.stripe_account_id as string);
      const atts = (await adminQuery(`select id from public.stripe_account_provisioning_attempts where studio_id=$1`, [sc.studioId])).rows.map((x) => x.id as string);
      const second = resultOf((await call(true, accts.length ? accts : null, atts.length ? atts : null)).rows);
      if (!ok(second)) throw new Refused(`first call ${first}; with every acknowledgement ${second}`);
      return `initializer: first call ${first}; with acknowledgements ${second}`;
    }
    const setter = (ack: boolean) =>
      adminQuery(
        `select * from public.set_studio_payment_jurisdiction($1,'CA','cad','operator:rehearsal','rehearsal over synthetic history',$2,'fixture:r0214')`,
        [sc.studioId, ack],
      );
    const first = resultOf((await setter(false)).rows);
    if (first === "initialized" || first === "changed") return `plain setter -> ${first}`;
    const second = first === "refused_priced_configuration" ? resultOf((await setter(true)).rows) : first;
    if (second !== "initialized" && second !== "changed") throw new Refused(`plain setter: first call ${first}; with price acknowledgement ${second}`);
    return `plain setter: first call ${first}; with price acknowledgement ${second}`;
  });
}

describe("R0214 rehearsal: what works and what fails after S1, per historical state", () => {
  for (const state of Object.keys(STATES) as StateKey[]) {
    it(`state ${state}`, async () => {
      const def = STATES[state];
      let sc: PaymentScenario;
      try {
        sc = await seedQuickCheckoutScenario({ ...def.opts, label: `r0214${state}` });
        await def.history(sc);
      } catch (e) {
        for (const phase of ["pre_s2", "post_s2"]) for (const a of AREAS) emit(state, phase, a, "NOT_EXERCISED", `state seeding failed: ${(e as Error).message}`);
        emit(state, "s2", "s2_init", "NOT_EXERCISED", "state seeding failed");
        emit(state, "apply", "apply_replay", "NOT_EXERCISED", "state seeding failed");
        return;
      }

      // The 0214 apply-time statements that read rows, over this history.
      await cell(state, "apply", "apply_replay", async () => {
        const stmts = replayStatements(migration0214());
        if (stmts.length === 0) throw new Refused("no replayable statements found");
        await adminTx(async (q) => {
          for (const s of stmts) await q(s);
          throw new Error("__rollback__");
        }).catch((e) => {
          if ((e as Error).message !== "__rollback__") throw e;
        });
        return `${stmts.length} ADD CONSTRAINT/ADD COLUMN statements accepted over the seeded history (rolled back)`;
      });

      await stripJurisdiction(sc.studioId);
      const j = await adminQuery(`select count(*)::int c from public.studio_payment_jurisdictions where studio_id=$1`, [sc.studioId]);
      expect(j.rows[0].c).toBe(0);

      const serviceId = await ensureBookable(sc).catch(() => null);
      await probes(state, "pre_s2", sc, serviceId, def.hasCard);
      await s2(state, sc);
      await probes(state, "post_s2", sc, serviceId, def.hasCard);
    }, 240_000);
  }

  it("every expected cell was emitted", () => {
    const expected: string[] = [];
    for (const state of Object.keys(STATES)) {
      expected.push(`${state}|apply|apply_replay`, `${state}|s2|s2_init`);
      for (const phase of ["pre_s2", "post_s2"]) for (const a of AREAS) expected.push(`${state}|${phase}|${a}`);
    }
    expect(cells.sort()).toEqual(expected.sort());
  });
});
