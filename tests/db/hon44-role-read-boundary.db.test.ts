import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import {
  cleanupPaymentScenario,
  seedEligibleQuickCheckoutScenario,
  type PaymentScenario,
} from "./helpers/payment-seed";

// ===========================================================================
// HON-44 — read boundaries by role, at the DATABASE, on the hosted-equivalent
// chain (synthetic data only).
// ===========================================================================
//
// A role boundary that lives only in navigation or in a server action is not a
// boundary: the browser holds an authenticated database session. This proves,
// for the three table families the requirement names, what each session can
// SELECT directly:
//
//   family     table                      owner   practitioner   receptionist
//   clinical   sessions                    rows    rows (shared)  none
//   clinical   client_intake_forms         rows    rows (shared)  none
//   financial  payment_charge_attempts     rows    none           none
//   financial  manual_fee_charge_attempts  rows    none           none
//   financial  appointment_settlements     rows    none           none
//
// Each row is also checked from a SECOND studio's owner (tenant isolation).
//
// TRAP: a "0 rows" assertion passes vacuously on an empty table. Every table is
// seeded in the studio under test and the OWNER must see it first (positive
// control), so a zero for another role can only mean the policy refused.
//
// Not covered here, and owned elsewhere: server-action refusals
// (tests/app/hon-44-owner-only-actions.test.ts), appointment write privileges
// (appointment-boundary-revocation.db.test.ts) and receptionist scheduling
// commands (0220). The schema enforcement for the receptionist role beyond
// today's policies is 0254, which is held; this file asserts ONLY what the
// hosted chain does today and must be re-run, unchanged, when 0254 lands.

let S: PaymentScenario;
let owner: { userId: string };
let member: { userId: string };
let receptionist: { userId: string };
let other: SeededStudio;
let fixtureErrors: Record<string, string> = {};

type Family = { table: string; ownerSees: boolean; memberSees: boolean };
const FAMILIES: Family[] = [
  { table: "sessions", ownerSees: true, memberSees: true },
  { table: "client_intake_forms", ownerSees: true, memberSees: true },
  { table: "payment_charge_attempts", ownerSees: true, memberSees: false },
  { table: "manual_fee_charge_attempts", ownerSees: true, memberSees: false },
  { table: "appointment_settlements", ownerSees: true, memberSees: false },
];

async function countAs(userId: string, table: string, studioId: string): Promise<number> {
  const r = await asUser(userId, (q) =>
    q(`select count(*)::int as n from public.${table} where studio_id = $1`, [studioId]),
  );
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  S = await seedEligibleQuickCheckoutScenario({ label: "hon44", attempt: "succeeded" });
  owner = { userId: S.practitionerUserId };
  const studio: SeededStudio = {
    studioId: S.studioId,
    userId: S.practitionerUserId,
    practitionerId: S.practitionerId,
    clientId: S.clientId,
  };
  member = await seedMember(studio, "hon44-prac");
  // A receptionist holds NO practitioners row: only a studio_receptionists row.
  const rid = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    rid,
    `hon44-recept-${rid.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.studio_receptionists (studio_id, user_id, display_name, active)
     values ($1, $2, 'Synthetic Front Desk', true)`,
    [S.studioId, rid],
  );
  receptionist = { userId: rid };
  await adminQuery(
    `insert into public.client_intake_forms (studio_id, client_id) values ($1, $2)`,
    [S.studioId, S.clientId],
  );
  other = await seedStudio("hon44-other");

  // The two seeds below are isolated so a fixture error is reported by name in
  // the non-vacuity test instead of failing every case in the file with a
  // beforeAll error that reads like the policy refusal this file exists to prove.
  const seedErrors: Record<string, string> = {};
  fixtureErrors = seedErrors;
  // manual_fee_charge_attempts: reuse the scenario's own card, template and
  // card-authorization signature; only the policy acknowledgement is added.
  try {
    const refs = await adminQuery(
      `select
         (select id from public.client_payment_methods where studio_id = $1 limit 1) as pm_id,
         (select id from public.client_consent_signatures where studio_id = $1 limit 1) as sig_id`,
      [S.studioId],
    );
    const { pm_id: pmId, sig_id: sigId } = refs.rows[0] as { pm_id: string; sig_id: string };
    const ackId = randomUUID();
    await adminQuery(
      `insert into public.appointment_policy_acknowledgements
         (id, studio_id, appointment_id, client_id, action, policy_snapshot_hash)
       values ($1, $2, $3, $4, 'cancel', 'policy-hash-hon44')`,
      [ackId, S.studioId, S.appointmentId, S.clientId],
    );
    await adminQuery(
      `insert into public.manual_fee_charge_attempts
         (studio_id, appointment_id, client_id, confirmed_by_practitioner_id,
          charge_type, amount_cents, client_payment_method_id,
          card_authorization_signature_id, appointment_policy_acknowledgement_id,
          policy_snapshot_hash, internal_note)
       values ($1, $2, $3, $4, 'no_show', 5000, $5, $6, $7, 'policy-hash-hon44', 'synthetic')`,
      [S.studioId, S.appointmentId, S.clientId, S.practitionerId, pmId, sigId, ackId],
    );
  } catch (e) {
    seedErrors.manual_fee_charge_attempts = String(e);
  }
  try {
    await adminQuery(
      `insert into public.appointment_settlements
         (studio_id, appointment_id, method, amount_cents, recorded_by_practitioner_id)
       values ($1, $2, 'paid_cash', 5000, $3)`,
      [S.studioId, S.appointmentId, S.practitionerId],
    );
  } catch (e) {
    seedErrors.appointment_settlements = String(e);
  }
});

afterAll(async () => {
  await cleanupPaymentScenario(S.studioId).catch(() => undefined);
  await closePool();
});

describe("HON-44 database read boundaries by role", () => {
  it("the fixture is non-vacuous: every table holds a row in the studio under test", async () => {
    expect(fixtureErrors, "fixture seeding failed (not a policy result)").toEqual({});
    for (const f of FAMILIES) {
      const r = await adminQuery(
        `select count(*)::int as n from public.${f.table} where studio_id = $1`,
        [S.studioId],
      );
      expect((r.rows[0] as { n: number }).n, f.table).toBeGreaterThanOrEqual(1);
    }
  });

  it("the OWNER sees every family (positive control)", async () => {
    for (const f of FAMILIES) {
      expect(await countAs(owner.userId, f.table, S.studioId), f.table).toBeGreaterThanOrEqual(1);
    }
  });

  it("a non-owner PRACTITIONER sees shared clinical rows and NO financial rows", async () => {
    for (const f of FAMILIES) {
      const n = await countAs(member.userId, f.table, S.studioId);
      if (f.memberSees) expect(n, f.table).toBeGreaterThanOrEqual(1);
      else expect(n, f.table).toBe(0);
    }
  });

  it("a RECEPTIONIST (no practitioners row) sees NO clinical and NO financial rows", async () => {
    for (const f of FAMILIES) {
      expect(await countAs(receptionist.userId, f.table, S.studioId), f.table).toBe(0);
    }
  });

  it("the owner of ANOTHER studio sees none of this studio's rows", async () => {
    for (const f of FAMILIES) {
      expect(await countAs(other.userId, f.table, S.studioId), f.table).toBe(0);
    }
  });
});
