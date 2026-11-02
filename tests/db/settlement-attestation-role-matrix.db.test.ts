import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { adminQuery, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";
import { seedQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";
import { E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";

// HON-44/HON-49 settlement-attestation role check (Machines). Privacy flagged 0187 (practitioners may record
// "paid by cash / e-transfer"); 0254 redefined record_appointment_settlement owner-only and made the three financial
// tables owner-read. This verifies the END STATE over PostgREST (HTTP, real JWTs for the local stack) rather than
// by reading migrations: every settlement function and table, per role, with an OWNER positive control each time.
//
// Roles: owner, practitioner (same studio), receptionist (same studio), other-studio owner, anonymous.
// Synthetic data, an owned isolated stack, no Stripe call (these functions never call a provider), nothing hosted.
// JWTs are minted with the local stack's public dev secret (the same HS256 secret GoTrue signs with locally); real
// browser sign-ins are covered by e2e/settlement-role-check.spec.ts.

const SECRET = process.env.HONE_LOCAL_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(userId: string): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "authenticated", aud: "authenticated", iss: "supabase-demo", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

type Resp = { status: number; body: unknown };
async function call(token: string | null, method: string, path: string, body?: unknown): Promise<Resp> {
  const res = await fetch(`${E2E_SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${token ?? ANON}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed };
}
const rpc = (t: string | null, fn: string, args: Record<string, unknown>) => call(t, "POST", `rpc/${fn}`, args);
const resultOf = (r: Resp): string | null => (Array.isArray(r.body) && r.body[0] && typeof (r.body[0] as { result?: string }).result === "string" ? (r.body[0] as { result: string }).result : null);
const idOf = (r: Resp): string | null => (Array.isArray(r.body) && r.body[0] ? ((r.body[0] as { settlement_id?: string }).settlement_id ?? null) : null);
const refused = (r: Resp) => r.status >= 400 || (resultOf(r) !== null && ["owner_only", "not_owner", "not_found", "invalid_input"].includes(resultOf(r) as string));

type Who = "owner" | "practitioner" | "receptionist" | "other_owner" | "anon";
const evidence: Array<{ surface: string; role: Who; outcome: string; status: number }> = [];
// Sam (2 Nov): a failure is a PERMISSION finding only when the setup is proven valid by the OWNER positive control in the same
// run; otherwise it is classified SETUP. `controls` records each owner control's pass/fail so the report can say which.
const controls: Array<{ surface: string; passed: boolean }> = [];
const control = (surface: string, passed: boolean) => controls.push({ surface, passed });
const unexpectedExecute: Array<{ proname: string; args: string; secdef: boolean; anon: boolean; authenticated: boolean; src: string }> = [];
const note = (surface: string, role: Who, r: Resp) => evidence.push({ surface, role, outcome: resultOf(r) ?? (r.status >= 400 ? "refused" : Array.isArray(r.body) ? `rows=${(r.body as unknown[]).length}` : "ok"), status: r.status });

let sc: PaymentScenario; // a completed visit with no card attempt (negative target; must stay unsettled)
let ownerSc: PaymentScenario; // supersede target
let studio: SeededStudio;
let tokens: Record<Who, string | null>;
let secondStudio: SeededStudio;

const countSettlements = async (studioId: string) => Number((await adminQuery(`select count(*)::int n from public.appointment_settlements where studio_id=$1`, [studioId])).rows[0].n);

beforeAll(async () => {
  sc = await seedQuickCheckoutScenario({ label: "role-neg", appointmentStatus: "completed", attempt: "none" });
  ownerSc = await seedQuickCheckoutScenario({ label: "role-pos", appointmentStatus: "completed", attempt: "none" });
  studio = { studioId: sc.studioId, userId: sc.practitionerUserId, practitionerId: sc.practitionerId, clientId: sc.clientId };
  const member = await seedMember(studio, "role-prac");
  secondStudio = await seedStudio("role-other");
  const recUser = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [recUser, `role-rec-${recUser.slice(0, 8)}@harness.local`]);
  await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, email, active, created_by_practitioner_id) values ($1,$2,'Synthetic Desk',$3,true,$4)`, [studio.studioId, recUser, `role-rec-${recUser.slice(0, 8)}@harness.local`, studio.practitionerId]);
  tokens = { owner: jwt(sc.practitionerUserId), practitioner: jwt(member.userId), receptionist: jwt(recUser), other_owner: jwt(secondStudio.userId), anon: null };
});
afterAll(async () => {
  const setupValid = controls.length > 0 && controls.every((c) => c.passed);
  if (process.env.SETTLE_EVIDENCE) writeFileSync(process.env.SETTLE_EVIDENCE, JSON.stringify({ setupValid, controls, unexpectedExecute, evidence }, null, 1));
  await closePool();
});

const NEGATIVE: Who[] = ["practitioner", "receptionist", "other_owner", "anon"];

const REC = (studioId: string, appointmentId: string, method: string) => ({ p_studio_id: studioId, p_appointment_id: appointmentId, p_method: method, p_amount_cents: 5000, p_note: null, p_livemode: false });

describe("record_appointment_settlement over PostgREST", () => {
  for (const method of ["paid_cash", "paid_e_transfer", "paid_other_external", "still_owes", "waived"]) {
    it(`${method}: every non-owner is refused and nothing is written`, async () => {
      for (const who of NEGATIVE) {
        const r = await rpc(tokens[who], "record_appointment_settlement", REC(sc.studioId, sc.appointmentId, method));
        note(`record_appointment_settlement(${method})`, who, r);
        expect(refused(r), `${who} must be refused for ${method}: ${JSON.stringify(r)}`).toBe(true);
      }
      expect(await countSettlements(sc.studioId)).toBe(0);
    });
  }

  for (const method of ["paid_cash", "paid_e_transfer", "paid_other_external", "still_owes"]) {
    it(`${method}: the OWNER records it on their own visit (positive control, fresh studio each time)`, async () => {
      const own = await seedQuickCheckoutScenario({ label: `role-ctl-${method.slice(0, 8)}`, appointmentStatus: "completed", attempt: "none" });
      const r = await rpc(jwt(own.practitionerUserId), "record_appointment_settlement", REC(own.studioId, own.appointmentId, method));
      note(`record_appointment_settlement(${method})`, "owner", r);
      control(`record_appointment_settlement(${method})`, resultOf(r) === "recorded");
      expect(resultOf(r)).toBe("recorded");
    });
  }

  it("the owner of the negative studio records paid_cash last (so the table-read control below has a row)", async () => {
    const ctl = await rpc(tokens.owner, "record_appointment_settlement", REC(sc.studioId, sc.appointmentId, "paid_cash"));
    note("record_appointment_settlement(paid_cash)", "owner", ctl);
    control("record_appointment_settlement(paid_cash) on the negative studio", resultOf(ctl) === "recorded");
    expect(resultOf(ctl)).toBe("recorded");
    expect(await countSettlements(sc.studioId)).toBe(1);
  });
});

describe("tables over PostgREST", () => {
  it("the owner can read the settlement written by the control; practitioner, receptionist, other studio and anon read nothing", async () => {
    for (const who of ["owner", ...NEGATIVE] as Who[]) {
      const r = await call(tokens[who], "GET", `appointment_settlements?studio_id=eq.${sc.studioId}&select=id,method,amount_cents,note`);
      note("appointment_settlements SELECT", who, r);
      if (who === "owner") {
        control("appointment_settlements SELECT", Array.isArray(r.body) && (r.body as unknown[]).length >= 1);
        expect(Array.isArray(r.body) && (r.body as unknown[]).length >= 1).toBe(true);
      }
      else expect(r.status >= 400 || (Array.isArray(r.body) && (r.body as unknown[]).length === 0)).toBe(true);
    }
  });
  for (const t of ["payment_charge_attempts", "manual_fee_charge_attempts"]) {
    it(`${t}: practitioner, receptionist, other studio and anon read nothing`, async () => {
      for (const who of NEGATIVE) {
        const r = await call(tokens[who], "GET", `${t}?studio_id=eq.${sc.studioId}&select=id`);
        note(`${t} SELECT`, who, r);
        expect(r.status >= 400 || (Array.isArray(r.body) && (r.body as unknown[]).length === 0)).toBe(true);
      }
    });
  }
  it("nobody (owner included) can write appointment_settlements directly: insert, update and delete are refused", async () => {
    for (const who of ["owner", ...NEGATIVE] as Who[]) {
      const ins = await call(tokens[who], "POST", "appointment_settlements", { studio_id: sc.studioId, appointment_id: sc.appointmentId, method: "paid_cash", amount_cents: 1 });
      const upd = await call(tokens[who], "PATCH", `appointment_settlements?studio_id=eq.${sc.studioId}`, { amount_cents: 1 });
      const del = await call(tokens[who], "DELETE", `appointment_settlements?studio_id=eq.${sc.studioId}`);
      for (const [name, r] of [["INSERT", ins], ["UPDATE", upd], ["DELETE", del]] as const) {
        note(`appointment_settlements ${name}`, who, r);
        expect(r.status >= 400 || (Array.isArray(r.body) && (r.body as unknown[]).length === 0), `${who} ${name}: ${JSON.stringify(r)}`).toBe(true);
      }
    }
  });
});

describe("waive and supersede are owner-only; the service-role-only commands are not callable by any session", () => {
  let waiveSc: PaymentScenario;
  beforeAll(async () => { waiveSc = await seedQuickCheckoutScenario({ label: "role-waive", appointmentStatus: "completed", attempt: "none" }); });

  it("waive_appointment_fee: non-owners refused, nothing written", async () => {
    const own = await seedMember({ studioId: waiveSc.studioId, userId: waiveSc.practitionerUserId, practitionerId: waiveSc.practitionerId, clientId: waiveSc.clientId }, "waive-prac");
    for (const [who, token] of [["practitioner", jwt(own.userId)], ["other_owner", tokens.other_owner], ["anon", null]] as Array<[Who, string | null]>) {
      const r = await rpc(token, "waive_appointment_fee", { p_studio_id: waiveSc.studioId, p_appointment_id: waiveSc.appointmentId, p_amount_cents: 1000, p_note: null, p_livemode: false });
      note("waive_appointment_fee", who, r);
      expect(refused(r)).toBe(true);
    }
    expect(await countSettlements(waiveSc.studioId)).toBe(0);
    const ctl = await rpc(jwt(waiveSc.practitionerUserId), "waive_appointment_fee", { p_studio_id: waiveSc.studioId, p_appointment_id: waiveSc.appointmentId, p_amount_cents: 1000, p_note: null, p_livemode: false });
    note("waive_appointment_fee", "owner", ctl);
    control("waive_appointment_fee", resultOf(ctl) === "recorded");
    expect(resultOf(ctl)).toBe("recorded");
  });

  it("supersede_appointment_settlement: non-owners refused against the owner's record; the owner's correction succeeds", async () => {
    const rec = await rpc(tokens.owner, "record_appointment_settlement", { p_studio_id: ownerSc.studioId, p_appointment_id: ownerSc.appointmentId, p_method: "paid_cash", p_amount_cents: 5000, p_note: null, p_livemode: false });
    const id = idOf(rec);
    expect(id).toBeTruthy();
    const args = (): Record<string, unknown> => ({ p_studio_id: ownerSc.studioId, p_expected_settlement_id: id, p_method: "paid_e_transfer", p_amount_cents: 5000, p_reason: "synthetic correction", p_note: null, p_livemode: false });
    const member = await seedMember({ studioId: ownerSc.studioId, userId: ownerSc.practitionerUserId, practitionerId: ownerSc.practitionerId, clientId: ownerSc.clientId }, "super-prac");
    for (const [who, token] of [["practitioner", jwt(member.userId)], ["other_owner", tokens.other_owner], ["anon", null]] as Array<[Who, string | null]>) {
      const r = await rpc(token, "supersede_appointment_settlement", args());
      note("supersede_appointment_settlement", who, r);
      expect(refused(r)).toBe(true);
    }
    const live = await adminQuery(`select method from public.appointment_settlements where studio_id=$1 and superseded_at is null`, [ownerSc.studioId]);
    expect(live.rows.map((x) => x.method)).toEqual(["paid_cash"]);
    const ctl = await rpc(jwt(ownerSc.practitionerUserId), "supersede_appointment_settlement", args());
    note("supersede_appointment_settlement", "owner", ctl);
    control("supersede_appointment_settlement", resultOf(ctl) === "corrected");
    expect(resultOf(ctl)).toBe("corrected");
  });

  it("reconcile_card_payment_succeeded and claim_session_payment_charge_attempt are service_role-only: no session role may execute them", async () => {
    const probes: Array<[string, Record<string, unknown>]> = [
      ["reconcile_card_payment_succeeded", { p_attempt_id: randomUUID(), p_stripe_payment_intent_id: "pi_synthetic", p_stripe_charge_id: "ch_synthetic" }],
      ["claim_session_payment_charge_attempt", { p_attempt_id: randomUUID(), p_practitioner_id: randomUUID(), p_idempotency_key: "synthetic" }],
    ];
    for (const [fn, args] of probes) {
      for (const who of ["owner", ...NEGATIVE] as Who[]) {
        const r = await rpc(tokens[who], fn, args);
        note(fn, who, r);
        expect(r.status >= 400, `${who} must not execute ${fn}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`).toBe(true);
      }
    }
  });

  it("catalog: record every function in the money area executable by anon or authenticated beyond the three owner-gated commands, with its body, for classification", async () => {
    const rows = (await adminQuery(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as secdef,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
              has_function_privilege('anon', p.oid, 'execute') as anon_exec,
              left(p.prosrc, 1500) as src
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and (p.proname like '%settlement%' or p.proname like '%payment%' or p.proname like '%charge%' or p.proname like '%refund%' or p.proname like '%waive%' or p.proname like '%fee%')
        order by 1`)).rows as Array<{ proname: string; args: string; secdef: boolean; auth_exec: boolean; anon_exec: boolean; src: string }>;
    const expected = new Set(["record_appointment_settlement", "supersede_appointment_settlement", "waive_appointment_fee"]);
    for (const r of rows) {
      evidence.push({ surface: `catalog:${r.proname}(${r.args})`, role: "practitioner", outcome: `authenticated_exec=${r.auth_exec} anon_exec=${r.anon_exec} secdef=${r.secdef}`, status: 0 });
      if ((r.auth_exec || r.anon_exec) && !expected.has(r.proname)) unexpectedExecute.push({ proname: r.proname, args: r.args, secdef: r.secdef, anon: r.anon_exec, authenticated: r.auth_exec, src: r.src });
    }
    // The three commands must be executable by `authenticated`. Anything ELSE executable by anon/authenticated is NOT failed here:
    // a grant alone is not a finding. It is recorded with its body above and classified REAL / HARMLESS-BY-BODY / UNCLEAR in the report.
    for (const n of expected) expect(rows.some((r) => r.proname === n && r.auth_exec), `${n} should be executable by authenticated`).toBe(true);
    expect(rows.filter((r) => expected.has(r.proname) && r.anon_exec)).toEqual([]);
  });
});
