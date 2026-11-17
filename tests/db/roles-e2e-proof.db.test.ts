import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { adminQuery, adminTx, asUser, closePool, resolveLocalDbUrl, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-44: the Roles end-to-end proof, measured on a local stack with the full migration chain including 0355/0356. Synthetic data only.
// Every row is MEASURED (a real statement as a real database role) and labelled with its level. Nothing here is hosted, released or activated.
// ROLES_E2E_ROWS_OUT=<file> dumps the rows. A red test is a finding, not something to adjust.

type Level = "command-level";
type Row = { id: string; claim: string; level: Level; actor: string; observed: string; ok: boolean };
const rows: Row[] = [];
const note = (id: string, claim: string, actor: string, observed: unknown, ok: boolean) => {
  rows.push({ id, claim, level: "command-level", actor, observed: typeof observed === "string" ? observed : JSON.stringify(observed), ok });
  expect(ok, `${id}: ${claim} -> ${JSON.stringify(observed)}`).toBe(true);
};
afterAll(async () => {
  if (process.env.ROLES_E2E_ROWS_OUT) writeFileSync(process.env.ROLES_E2E_ROWS_OUT, JSON.stringify(rows, null, 2));
  await superPool.end();
  await closePool();
});

// A second connection as the DATABASE OWNER of the stack, used only to seed money rows past foreign keys (session_replication_role needs it).
const superPool = new Pool({ connectionString: resolveLocalDbUrl().replace("//postgres:", "//supabase_admin:") });
const hash64 = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
const asService = async <T,>(fn: (q: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> =>
  adminTx(async (q) => {
    await q("set local role service_role");
    try {
      return await fn(q as never);
    } finally {
      await q("reset role").catch(() => undefined);
    }
  });
const as = async <T,>(userId: string, fn: (q: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>) => asUser(userId, fn as never) as Promise<T>;
const attempt = async (fn: () => Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 140) };
  }
};
const n = (r: { rows: Record<string, unknown>[] }) => Number(r.rows[0].n);

let A: SeededStudio;
let B: SeededStudio;
let serviceA: string;
let serviceB: string;
let pract: { userId: string; practitionerId: string; email: string };
let sessionId: string;
let apptId: string;
let enforceKeys: string[] = [];

describe("two synthetic studios, each with an owner, a client and a service", () => {
  it("setup", async () => {
    A = await seedStudio("e2e-a");
    B = await seedStudio("e2e-b");
    serviceA = randomUUID();
    serviceB = randomUUID();
    for (const [st, id] of [[A, serviceA], [B, serviceB]] as const) {
      await adminQuery(`insert into public.services (id, studio_id, name, price_cents, default_duration_minutes, active) values ($1, $2, 'Synthetic service', 12000, 30, true)`, [id, st.studioId]);
      for (let d = 0; d < 7; d++) {
        await adminQuery(`insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time) values ($1, $2, true, '00:00', '23:59')`, [st.studioId, d]);
      }
    }
    const keys = (await adminQuery(`select key from public.permission_catalog order by key`)).rows.map((r) => String(r.key));
    enforceKeys = keys;
    const rel = await adminQuery(`select count(*) filter (where released_at is not null) rel, (select count(*) from public.permission_key_activation) act from public.permission_key_release`);
    note("S0.1", "a fresh stack: the engine is unreleased and nothing is activated (the state every inert-choice row below depends on)", "postgres", { released_keys: Number(rel.rows[0].rel), activations: Number(rel.rows[0].act) }, Number(rel.rows[0].rel) === 0 && Number(rel.rows[0].act) === 0);
    const mig = await adminQuery(`select count(*) n from pg_proc where proname in ('save_role_permissions_reviewed','preview_role_changes_at')`);
    note("S0.2", "0355/0356 are applied on this local stack", "postgres", { review_commands: n(mig) }, n(mig) === 2);
  });
});

describe("owner invites a practitioner; the practitioner accepts", () => {
  const email = () => `e2e-practitioner-${A.studioId.slice(0, 8)}@harness.local`;
  it("the owner's invite is a row the owner wrote through RLS; the other studio's owner cannot see it or write one for this studio", async () => {
    const ins = await attempt(() =>
      as(A.userId, (q) => q(`insert into public.pending_invitations (studio_id, email, invited_by, role, display_name, status) values ($1, $2, $3, 'practitioner', 'Synthetic Practitioner', 'pending') returning id`, [A.studioId, email(), A.practitionerId])),
    );
    note("I1", "the owner of studio A creates a pending invitation (the same insert the Team page makes)", "owner A (authenticated)", ins.ok ? "inserted" : ins.error, ins.ok);
    const seenA = await as(A.userId, (q) => q(`select count(*) n from public.pending_invitations where studio_id = $1`, [A.studioId]));
    const seenB = await as(B.userId, (q) => q(`select count(*) n from public.pending_invitations where studio_id = $1`, [A.studioId]));
    note("I2", "studio B's owner sees 0 of studio A's invitations (A's owner sees 1)", "owners A and B", { owner_a: n(seenA), owner_b: n(seenB) }, n(seenA) === 1 && n(seenB) === 0);
    const cross = await attempt(() => as(B.userId, (q) => q(`insert into public.pending_invitations (studio_id, email, invited_by, role, status) values ($1, 'x-${randomUUID().slice(0, 6)}@harness.local', $2, 'practitioner', 'pending')`, [A.studioId, B.practitionerId])));
    note("I3", "studio B's owner cannot invite someone into studio A", "owner B (authenticated)", cross.ok ? "WROTE" : cross.error, !cross.ok);
  });

  it("acceptance: the invited person's account exists with that verified email and the governed command links them", async () => {
    const userId = randomUUID();
    await adminQuery(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [userId, email()]);
    const res = await asService((q) => q(`select public.admin_accept_pending_invitation($1) as r`, [userId]));
    const out = res.rows[0].r as { status?: string };
    note("A1", "admin_accept_pending_invitation (service-role only; the Accept page's server action calls exactly this) links the invited verified user", "service_role", out, out.status === "linked");
    const p = (await adminQuery(`select id, studio_id, role, active from public.practitioners where user_id = $1`, [userId])).rows;
    pract = { userId, practitionerId: String(p[0]?.id), email: email() };
    note("A2", "a practitioner row exists in studio A only: role practitioner, active", "postgres", p, p.length === 1 && p[0].studio_id === A.studioId && p[0].role === "practitioner" && p[0].active === true);
    const inv = (await adminQuery(`select status from public.pending_invitations where studio_id = $1 and lower(email) = lower($2)`, [A.studioId, email()])).rows[0];
    note("A3", "the invitation is marked accepted", "postgres", inv, inv?.status === "accepted");
    await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1, $2, $3) on conflict do nothing`, [A.studioId, serviceA, pract.practitionerId]);
    await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1, $2, $3) on conflict do nothing`, [A.studioId, serviceA, A.practitionerId]);
    const direct = await attempt(() => as(userId, (q) => q(`select public.admin_accept_pending_invitation($1)`, [userId])));
    note("A4", "the browser role cannot call the acceptance command itself", "the practitioner (authenticated)", direct.ok ? "CALLED" : direct.error, !direct.ok);
  });
});

describe("the practitioner does a permitted booking and charting", () => {
  it("booking: for themself it is created; for someone else it is refused; into the other studio it is refused", async () => {
    const self = await asService((q) => q(`select * from public.create_internal_appointment_v2($1, $2, $2, $3, $4, now() + interval '40 days', $5, null, null, false)`, [A.studioId, pract.practitionerId, A.clientId, serviceA, hash64()]));
    note("B1", "the practitioner books a client for themself: created", "practitioner (via the governed create command)", { result: self.rows[0].result }, self.rows[0].result === "created");
    apptId = String(self.rows[0].appointment_id);
    const other = await asService((q) => q(`select * from public.create_internal_appointment_v2($1, $2, $3, $4, $5, now() + interval '41 days', $6, null, null, false)`, [A.studioId, pract.practitionerId, A.practitionerId, A.clientId, serviceA, hash64()]));
    note("B2", "the practitioner booking INTO ANOTHER practitioner's calendar is refused", "practitioner (via the governed create command)", { result: other.rows[0].result }, other.rows[0].result !== "created");
    const crossStudio = await attempt(() => asService((q) => q(`select * from public.create_internal_appointment_v2($1, $2, $2, $3, $4, now() + interval '42 days', $5, null, null, false)`, [B.studioId, pract.practitionerId, B.clientId, serviceB, hash64()])));
    const crossOk = crossStudio.ok ? (crossStudio.value as { rows: { result: string }[] }).rows[0].result !== "created" : true;
    note("B3", "the practitioner cannot book in studio B", "practitioner (via the governed create command)", crossStudio.ok ? (crossStudio.value as { rows: { result: string }[] }).rows[0] : crossStudio.error, crossOk);
    const appts = await as(pract.userId, (q) => q(`select count(*) n from public.appointments where studio_id = $1`, [A.studioId]));
    note("B4", "the practitioner reads the studio's appointment they made", "practitioner (authenticated)", { visible_appointments: n(appts) }, n(appts) >= 1);
  });

  it("charting: the practitioner writes and reads a treatment session in their studio, not in the other", async () => {
    const ins = await attempt(() => as(pract.userId, (q) => q(`select * from public.start_session($1, 'electrolysis', $2, null, $3)`, [A.clientId, apptId, A.studioId])));
    const started = ins.ok ? (ins.value as { rows: Record<string, unknown>[] }).rows[0] : null;
    const sid = started ? String(Object.values(started)[0] ?? "") : "";
    sessionId = sid || String((await adminQuery(`select id from public.sessions where studio_id = $1 order by created_at desc limit 1`, [A.studioId])).rows[0]?.id ?? "");
    note("C1", "the practitioner starts a treatment session for a client of their studio (start_session, the command the chart uses)", "practitioner (authenticated)", ins.ok ? { started } : ins.error, ins.ok && sessionId !== "");
    const read = await as(pract.userId, (q) => q(`select count(*) n from public.sessions where id = $1`, [sessionId]));
    note("C2", "the practitioner reads their own session", "practitioner (authenticated)", { read: n(read) }, n(read) === 1);
    const owner = await as(A.userId, (q) => q(`select count(*) n from public.sessions where id = $1`, [sessionId]));
    note("C3", "the owner of the studio sees the practitioner's session", "owner A (authenticated)", { read: n(owner) }, n(owner) === 1);
    const cross = await attempt(() => as(pract.userId, (q) => q(`select * from public.start_session($1, 'laser', null, null, $2)`, [B.clientId, B.studioId])));
    note("C4", "the practitioner cannot chart in studio B", "practitioner (authenticated)", cross.ok ? "WROTE" : cross.error, !cross.ok);
  });
});

// Money rows are seeded with real values past foreign keys by the stack owner, then READ as the practitioner. Which of these the practitioner can see is
// a measurement, not an assumption: a row of "visible" is a finding to report, never something this test hides.
const MONEY: { table: string; override: Record<string, string>; extra?: Record<string, string> }[] = [
  { table: "appointment_payments", override: {} },
  { table: "appointment_settlements", override: { method: "'paid_cash'" } },
  { table: "manual_fee_charge_attempts", override: { charge_type: "'no_show'" } },
  { table: "payment_charge_attempts", override: { charge_reason: "'no_show_fee'" }, extra: { appointment_id: "gen_random_uuid()" } },
  { table: "stripe_charge_attempts", override: { status: "'failed'" } },
  { table: "stripe_disputes", override: { status: "'won'" } },
  { table: "stripe_payment_audit", override: { action: "'charge_succeeded'" }, extra: { appointment_id: "gen_random_uuid()" } },
  { table: "stripe_refund_attempts", override: { status: "'succeeded'" } },
  { table: "stripe_refunds", override: { source: "'stripe_dashboard_observed'", status: "'succeeded'" } },
  { table: "studio_payment_settings", override: {} },
];
const unseeded: Record<string, string> = {};
async function seedMoney(studioId: string): Promise<string[]> {
  const seeded: string[] = [];
  const c = await superPool.connect();
  try {
    for (const m of MONEY) {
      await c.query("begin");
      try {
        await c.query("set local session_replication_role = replica");
        const cols = (await c.query(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1 and is_nullable='NO' and column_default is null`, [m.table])).rows as { column_name: string; data_type: string }[];
        const names: string[] = [];
        const vals: string[] = [];
        for (const col of cols) {
          names.push(`"${col.column_name}"`);
          vals.push(
            col.column_name === "studio_id" ? `'${studioId}'`
            : m.override[col.column_name] ??
              (col.data_type === "uuid" ? "gen_random_uuid()" : ["integer", "bigint", "smallint", "numeric"].includes(col.data_type) ? "1" : col.data_type === "boolean" ? "false" : col.data_type.startsWith("timestamp") ? "now()" : col.data_type === "jsonb" || col.data_type === "json" ? "'{}'" : col.data_type === "ARRAY" ? "'{}'" : "'x' || gen_random_uuid()::text"),
          );
        }
        for (const [k, v] of Object.entries(m.extra ?? {})) {
          names.push(`"${k}"`);
          vals.push(v);
        }
        await c.query(`insert into public.${m.table} (${names.join(",")}) values (${vals.join(",")})`);
        await c.query("commit");
        seeded.push(m.table);
      } catch (e) {
        unseeded[m.table] = String((e as Error).message).slice(0, 190);
        await c.query("rollback").catch(() => undefined);
      }
    }
  } finally {
    c.release();
  }
  return seeded;
}

describe("financial privacy: what a practitioner can read of the studio's money", () => {
  it("payment ledgers, settlements and attempts: counted as the owner and as the practitioner, on rows that really exist", async () => {
    const seeded = await seedMoney(A.studioId);
    note("M0", "money rows seeded in studio A (tables listed in `seeded`; any table that refused a synthetic row is listed with the reason and is NOT MEASURED)", "stack owner", { seeded, not_measured: unseeded }, seeded.length >= 6);
    const out: Record<string, { owner: number; practitioner: number }> = {};
    for (const t of seeded) {
      const o = await as(A.userId, (q) => q(`select count(*) n from public.${t} where studio_id = $1`, [A.studioId])).catch(() => ({ rows: [{ n: -1 }] }));
      const p = await as(pract.userId, (q) => q(`select count(*) n from public.${t} where studio_id = $1`, [A.studioId])).catch(() => ({ rows: [{ n: -1 }] }));
      out[t] = { owner: n(o), practitioner: n(p) };
    }
    const hidden = Object.entries(out).filter(([, v]) => v.practitioner <= 0).map(([t]) => t);
    const visible = Object.entries(out).filter(([, v]) => v.practitioner > 0).map(([t]) => t);
    note("M1", "tables whose rows exist (owner reads >=1) but the practitioner reads 0 or is denied: the studio's payment records are not visible to a practitioner", "owner A and practitioner (authenticated)", { per_table: out, hidden_from_practitioner: hidden, visible_to_practitioner: visible }, Object.values(out).every((v) => v.owner > 0 || v.practitioner <= 0));
    note("M2", "FINDING IF NON-EMPTY: payment tables a practitioner can read", "practitioner (authenticated)", { visible_to_practitioner: visible }, visible.length === 0);
  });

  it("price and fee columns: measured, reported as they are (these are the client-price surfaces)", async () => {
    await adminQuery(`insert into public.client_pricing (studio_id, client_id, service_name, price_cents) values ($1, $2, 'Synthetic', 7777)`, [A.studioId, A.clientId]);
    await adminQuery(`update public.services set price_cents = 12000 where id = $1`, [serviceA]).catch(() => undefined);
    await adminQuery(`update public.sessions set price_paid_cents = 9900 where id = $1`, [sessionId]);
    await adminQuery(`update public.studios set late_cancel_fee_cents = 5000, no_show_fee_cents = 6000 where id = $1`, [A.studioId]);
    const q1 = async (sql: string) => Number((await as(pract.userId, (q) => q(sql, [A.studioId]))).rows[0].n);
    const seen = {
      client_pricing_rows: await q1(`select count(*) n from public.client_pricing where studio_id = $1`).catch(() => -1),
      services_with_price: await q1(`select count(*) n from public.services where studio_id = $1 and price_cents is not null`).catch(() => -1),
      sessions_with_price_paid: await q1(`select count(*) n from public.sessions where studio_id = $1 and price_paid_cents is not null`).catch(() => -1),
      studio_fee_columns: await q1(`select count(*) n from public.studios where id = $1 and (late_cancel_fee_cents is not null or no_show_fee_cents is not null)`).catch(() => -1),
    };
    // This row only RECORDS what is visible today; it is reported in the document as a finding when any is > 0 (these are not gated by the engine while it is unreleased).
    note("M3", "price/fee surfaces a practitioner can read TODAY (not gated while the engine is unreleased)", "practitioner (authenticated)", seen, true);
    const ownerSeen = await as(A.userId, (q) => q(`select count(*) n from public.client_pricing where studio_id = $1`, [A.studioId]));
    note("M4", "the owner reads the same client_pricing rows (comparison)", "owner A (authenticated)", { client_pricing_rows: n(ownerSeen) }, true);
  });
});

describe("inert choices: the owner's saved Roles choices change nobody's access while nothing is released", () => {
  const snapshotAccess = async () => {
    const out: Record<string, boolean> = {};
    for (const [who, uid, pid] of [["owner", A.userId, A.practitionerId], ["practitioner", pract.userId, pract.practitionerId]] as const) {
      const r = await as(uid, async (q) => {
        const o: { key: string; ok: boolean }[] = [];
        for (const key of enforceKeys) o.push({ key, ok: (await q(`select public.has_studio_permission($1, $2, null, null, $3) as ok`, [A.studioId, key, pid])).rows[0].ok === true });
        return o;
      });
      for (const row of r) out[`${who}:${row.key}`] = row.ok;
    }
    return out;
  };
  const effective = async () => (await adminQuery(`select public.perm_effective_map($1, 'practitioner') as m, public.perm_effective_map($1, 'receptionist') as r`, [A.studioId])).rows[0];
  it("a reviewed save through the Roles commands stores the choices and moves no one's effective access", async () => {
    const accessBefore = await snapshotAccess();
    const effBefore = await effective();
    const raises = ["appt.cancel", "appt.move", "clin.view_records", "clin.view_photos"];
    const changes = { practitioner: Object.fromEntries(raises.map((k) => [k, "off"])) };
    const result = await as(A.userId, async (q) => {
      const v = Number(((await q(`select public.get_role_permissions($1) as r`, [A.studioId])).rows[0].r as { version?: number }).version ?? 0);
      return { v, p: (await q(`select public.preview_role_changes_at($1, $2::jsonb, $3) as r`, [A.studioId, JSON.stringify(changes), v])).rows[0].r as { ok?: boolean; review_hash?: string; code?: string } };
    }).catch((e) => ({ v: -1, p: { ok: false, code: String(e.message).slice(0, 80) } as { ok?: boolean; review_hash?: string; code?: string } }));
    note("R1", "the owner previews the choices with the page's version (preview_role_changes_at)", "owner A (authenticated)", { ok: result.p.ok, code: result.p.code }, result.p.ok === true);
    const saved = await as(A.userId, (q) => q(`select public.save_role_permissions_reviewed($1, $2, $3::jsonb, null, false, $4) as r`, [A.studioId, result.v, JSON.stringify(changes), result.p.review_hash])).then((r) => r.rows[0].r as { ok?: boolean; code?: string });
    note("R2", "the owner saves them with the preview's review hash (save_role_permissions_reviewed)", "owner A (authenticated)", saved, saved.ok === true || ["sensitive_unconfirmed", "reason_required"].includes(String(saved.code)));
    if (saved.ok !== true) {
      // the engine asks for a reason when a sensitive key is involved; give one the same way the page does
      const again = await as(A.userId, (q) => q(`select public.save_role_permissions_reviewed($1, $2, $3::jsonb, 'Synthetic proof of an inert choice', true, $4) as r`, [A.studioId, result.v, JSON.stringify(changes), result.p.review_hash])).then((r) => r.rows[0].r as { ok?: boolean; code?: string });
      note("R2b", "the same save with the reason and confirmation the engine asked for", "owner A (authenticated)", again, again.ok === true);
    }
    const stored = (await adminQuery(`select role, key, scope from public.studio_role_permissions where studio_id = $1 order by role, key`, [A.studioId])).rows;
    note("R3", "the choices are STORED (rows exist)", "postgres", { stored_rows: stored.length }, stored.length >= 4);
    const audit = (await adminQuery(`select count(*) n from public.permission_audit where studio_id = $1`, [A.studioId])).rows[0];
    note("R4", "an append-only audit row records the save", "postgres", { audit_rows: Number(audit.n) }, Number(audit.n) >= 1);
    const accessAfter = await snapshotAccess();
    const effAfter = await effective();
    const diffs = Object.keys(accessBefore).filter((k) => accessBefore[k] !== accessAfter[k]);
    note("R5", "has_studio_permission answers for the owner and the practitioner, for EVERY catalog key, are identical before and after the save", "owner A / practitioner (authenticated)", { keys_compared: Object.keys(accessBefore).length, differences: diffs }, diffs.length === 0);
    note("R6", "perm_effective_map for both roles is identical before and after the save", "postgres", { practitioner_same: JSON.stringify(effBefore.m) === JSON.stringify(effAfter.m), receptionist_same: JSON.stringify(effBefore.r) === JSON.stringify(effAfter.r) }, JSON.stringify(effBefore) === JSON.stringify(effAfter));
    const got = (await as(A.userId, (q) => q(`select public.get_role_permissions($1) as r`, [A.studioId]))).rows[0].r as { roles?: Record<string, Record<string, { stored?: string; effective?: string; source?: string }>> };
    const p = got.roles?.practitioner ?? {};
    note("R7", "the Roles page's own read shows the stored choice beside what is in force and where it comes from (stored 'off', source not 'stored')", "owner A (authenticated)", Object.fromEntries(raises.map((k) => [k, p[k]])), raises.every((k) => p[k]?.stored === "off" && p[k]?.source !== "stored"));
    const still = await asService((q) => q(`select * from public.create_internal_appointment_v2($1, $2, $2, $3, $4, now() + interval '43 days', $5, null, null, false)`, [A.studioId, pract.practitionerId, A.clientId, serviceA, hash64()]));
    note("R8", "after the save the practitioner can still book and the practitioner can still read the client and the chart", "practitioner", { booking: still.rows[0].result }, still.rows[0].result === "created");
    const chart = await as(pract.userId, (q) => q(`select (select count(*) from public.clients where studio_id = $1) c, (select count(*) from public.sessions where studio_id = $1) s`, [A.studioId]));
    note("R9", "and still reads clients and sessions (the clinical-read choices saved 'off' are inert)", "practitioner (authenticated)", chart.rows[0], Number(chart.rows[0].c) >= 1 && Number(chart.rows[0].s) >= 1);
  });
});

describe("two-studio isolation", () => {
  it("each studio's owner and practitioner see none of the other studio's rows and cannot use its commands", async () => {
    const counts = async (uid: string, studio: string) =>
      (await as(uid, (q) => q(`select (select count(*) from public.clients where studio_id = $1) clients, (select count(*) from public.sessions where studio_id = $1) sessions, (select count(*) from public.appointments where studio_id = $1) appointments, (select count(*) from public.practitioners where studio_id = $1) practitioners, (select count(*) from public.services where studio_id = $1) services`, [studio]))).rows[0];
    const bySeenOwnerB = await counts(B.userId, A.studioId);
    const bySeenPractA = await counts(pract.userId, B.studioId);
    const zero = (r: Record<string, unknown>) => Object.values(r).every((v) => Number(v) === 0);
    note("X1", "studio B's owner reads 0 rows of studio A in clients, sessions, appointments, practitioners, services", "owner B (authenticated)", bySeenOwnerB, zero(bySeenOwnerB));
    note("X2", "studio A's practitioner reads 0 rows of studio B", "practitioner (authenticated)", bySeenPractA, zero(bySeenPractA));
    const getB = await attempt(async () => (await as(A.userId, (q) => q(`select public.get_role_permissions($1) as r`, [B.studioId]))).rows[0].r);
    const refusedGet = getB.ok ? (getB.value as { ok?: boolean }).ok === false : true;
    note("X3", "studio A's owner cannot read studio B's role permissions", "owner A (authenticated)", getB.ok ? getB.value : getB.error, refusedGet);
    const saveB = await attempt(async () => (await as(A.userId, (q) => q(`select public.save_role_permissions_reviewed($1, 0, '{"practitioner":{"appt.cancel":"off"}}'::jsonb, null, false, $2) as r`, [B.studioId, "0".repeat(64)]))).rows[0].r);
    const refusedSave = saveB.ok ? (saveB.value as { ok?: boolean; code?: string }).ok === false : true;
    note("X4", "studio A's owner cannot change studio B's role permissions", "owner A (authenticated)", saveB.ok ? saveB.value : saveB.error, refusedSave);
    const stored = Number((await adminQuery(`select count(*) n from public.studio_role_permissions where studio_id = $1`, [B.studioId])).rows[0].n);
    note("X5", "studio B has no stored role choices after all of the above", "postgres", { stored_rows: stored }, stored === 0);
    const prac = await attempt(async () => (await as(pract.userId, (q) => q(`select public.get_role_permissions($1) as r`, [A.studioId]))).rows[0].r);
    const pracRefused = prac.ok ? (prac.value as { ok?: boolean }).ok === false : true;
    note("X6", "the practitioner cannot read or use the Roles settings even of their own studio (owner only)", "practitioner (authenticated)", prac.ok ? prac.value : prac.error, pracRefused);
  });
});

describe("the owner removes the practitioner: access is gone at once", () => {
  it("the same statements that worked before now find nothing and write nothing, in the very next statement", async () => {
    const before = await as(pract.userId, (q) => q(`select (select count(*) from public.clients where studio_id = $1) c, public.has_studio_permission($1, 'appt.book', null, null, $2) as book`, [A.studioId, pract.practitionerId]));
    note("V0", "before removal: the practitioner reads clients and the engine says yes to booking", "practitioner (authenticated)", before.rows[0], Number(before.rows[0].c) >= 1 && before.rows[0].book === true);
    const res = await asService((q) => q(`select public.set_practitioner_active_locked($1, $2, $3, false) as r`, [A.studioId, A.practitionerId, pract.practitionerId]));
    note("V1", "the owner deactivates the practitioner (the command the Team page's remove uses)", "service_role, as the owner's server action", res.rows[0].r, true);
    const after = await as(pract.userId, (q) => q(`select (select count(*) from public.clients where studio_id = $1) c, (select count(*) from public.sessions where studio_id = $1) s, (select count(*) from public.appointments where studio_id = $1) a, public.has_studio_permission($1, 'appt.book', null, null, $2) as book, public.has_studio_permission($1, 'clin.view_records', null, null, $2) as clin`, [A.studioId, pract.practitionerId]));
    const r = after.rows[0];
    note("V2", "after removal the practitioner reads 0 clients, 0 sessions, 0 appointments and the engine answers false", "practitioner (authenticated)", r, Number(r.c) === 0 && Number(r.s) === 0 && Number(r.a) === 0 && r.book === false && r.clin === false);
    const w = await attempt(() => as(pract.userId, (q) => q(`select * from public.start_session($1, 'laser', null, null, $2)`, [A.clientId, A.studioId])));
    note("V3", "after removal the practitioner cannot chart", "practitioner (authenticated)", w.ok ? "WROTE" : w.error, !w.ok);
    const book = await asService((q) => q(`select * from public.create_internal_appointment_v2($1, $2, $2, $3, $4, now() + interval '44 days', $5, null, null, false)`, [A.studioId, pract.practitionerId, A.clientId, serviceA, hash64()]));
    note("V4", "after removal the governed booking command refuses the removed practitioner", "practitioner (via the governed create command)", { result: book.rows[0].result }, book.rows[0].result !== "created");
    const kept = Number((await adminQuery(`select count(*) n from public.sessions where id = $1`, [sessionId])).rows[0].n);
    const ownerSees = n(await as(A.userId, (q) => q(`select count(*) n from public.sessions where id = $1`, [sessionId])));
    note("V5", "the practitioner's charted session is kept and the owner still reads it (removal revokes access, it does not delete records)", "owner A (authenticated)", { session_rows: kept, owner_reads: ownerSees }, kept === 1 && ownerSees === 1);
    const back = await asService((q) => q(`select public.set_practitioner_active_locked($1, $2, $3, true) as r`, [A.studioId, A.practitionerId, pract.practitionerId]));
    const restored = await as(pract.userId, (q) => q(`select count(*) n from public.clients where studio_id = $1`, [A.studioId]));
    note("V6", "restoring the practitioner restores access (reversible, nothing was lost)", "owner A then practitioner", { restore: back.rows[0].r, clients_visible: n(restored) }, n(restored) >= 1);
    const stillB = n(await as(B.userId, (q) => q(`select count(*) n from public.clients where studio_id = $1`, [B.studioId])));
    note("V7", "studio B was unaffected by any of this", "owner B (authenticated)", { clients_visible: stillB }, stillB === 1);
  });
});

// A receptionist is not a practitioner: RLS membership (is_studio_member) is practitioner-only, so a receptionist works through the receptionist_* commands.
describe("a receptionist: invite, accept, work, removal", () => {
  let rec: { userId: string; receptionistId: string; email: string };
  const email = () => `e2e-receptionist-${A.studioId.slice(0, 8)}@harness.local`;
  it("invite and accept (seeded verified user, the real accept command)", async () => {
    const ins = await attempt(() =>
      as(A.userId, (q) => q(`insert into public.pending_invitations (studio_id, email, invited_by, role, display_name, status) values ($1, $2, $3, 'receptionist', 'Synthetic Receptionist', 'pending')`, [A.studioId, email(), A.practitionerId])),
    );
    note("RC1", "owner A invites a receptionist (a pending invitation with role receptionist, under RLS)", "owner A (authenticated)", ins.ok ? "inserted" : ins.error, ins.ok);
    const userId = randomUUID();
    await adminQuery(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [userId, email()]);
    const res = await asService((q) => q(`select public.admin_accept_pending_invitation($1) as r`, [userId]));
    const out = res.rows[0].r as { status?: string; role?: string };
    note("RC2", "admin_accept_pending_invitation links the invited verified user (seeded user, real command)", "service_role", out, out.status === "linked");
    const r = (await adminQuery(`select id, studio_id, active from public.studio_receptionists where user_id = $1`, [userId])).rows;
    rec = { userId, receptionistId: String(r[0]?.id), email: email() };
    const asPractitioner = Number((await adminQuery(`select count(*) n from public.practitioners where user_id = $1`, [userId])).rows[0].n);
    note("RC3", "one active receptionist row in studio A and NO practitioner row for that user", "postgres", { receptionist_rows: r.length, studio_a: r[0]?.studio_id === A.studioId, active: r[0]?.active, practitioner_rows: asPractitioner }, r.length === 1 && r[0].studio_id === A.studioId && r[0].active === true && asPractitioner === 0);
  });

  it("what the receptionist can do through the receptionist commands", async () => {
    const appt = await attempt(() => as(rec.userId, (q) => q(`select * from public.receptionist_create_appointment($1, $2, $3, $4, now() + interval '50 days')`, [A.studioId, pract.practitionerId, A.clientId, serviceA])));
    const row = appt.ok ? (appt.value as { rows: Record<string, unknown>[] }).rows[0] : null;
    note("RC4", "the receptionist books a client with a practitioner (receptionist_create_appointment)", "receptionist (authenticated)", appt.ok ? row : appt.error, appt.ok && (row?.result === "created" || Object.values(row ?? {}).includes("created")));
    const dir = await attempt(() => as(rec.userId, (q) => q(`select * from public.receptionist_client_directory($1, null, null, null, 0, 50)`, [A.studioId])));
    const dirRows = dir.ok ? (dir.value as { rows: Record<string, unknown>[] }).rows : [];
    const fields = [...new Set(dirRows.flatMap((r) => Object.keys(r)))].sort();
    note("RC5", "the receptionist reads the client directory; the columns it returns are listed (check them for price or clinical fields)", "receptionist (authenticated)", dir.ok ? { rows: dirRows.length, columns: fields } : dir.error, dir.ok && dirRows.length >= 1);
    note("RC5b", "the directory carries no price, payment, note, chart or photo column", "receptionist (authenticated)", { columns: fields }, !fields.some((f) => /price|paid|fee|amount|note|chart|photo/i.test(f)));
    const statusCols = fields.filter((f) => /intake|consent|visit|appointment/i.test(f));
    note("RC5c", "RECORDED, not asserted away: the directory DOES carry intake/consent STATUS and visit dates (no answers or contents)", "receptionist (authenticated)", { status_columns: statusCols }, true);
  });

  it("what the receptionist cannot reach: direct tables, charting, payments, prices, the Roles settings, the other studio", async () => {
    const direct = await as(rec.userId, (q) => q(`select (select count(*) from public.clients where studio_id = $1) clients, (select count(*) from public.sessions where studio_id = $1) sessions, (select count(*) from public.appointments where studio_id = $1) appointments, (select count(*) from public.client_pricing where studio_id = $1) client_pricing, (select count(*) from public.services where studio_id = $1) services, (select count(*) from public.appointment_settlements where studio_id = $1) settlements, (select count(*) from public.payment_charge_attempts where studio_id = $1) charge_attempts`, [A.studioId]));
    const dz = Object.values(direct.rows[0]).every((v) => Number(v) === 0);
    note("RC6", "direct table reads by the receptionist in studio A: clients, sessions, appointments, client pricing, services, settlements, charge attempts", "receptionist (authenticated)", direct.rows[0], dz);
    const chart = await attempt(() => as(rec.userId, (q) => q(`select * from public.start_session($1, 'laser', null, null, $2)`, [A.clientId, A.studioId])));
    note("RC7", "the receptionist cannot start a treatment session", "receptionist (authenticated)", chart.ok ? "STARTED" : chart.error, !chart.ok);
    const roles = await attempt(async () => (await as(rec.userId, (q) => q(`select public.get_role_permissions($1) as r`, [A.studioId]))).rows[0].r);
    note("RC8", "the receptionist cannot read the Roles settings", "receptionist (authenticated)", roles.ok ? roles.value : roles.error, roles.ok ? (roles.value as { ok?: boolean }).ok === false : true);
    const other = await attempt(() => as(rec.userId, (q) => q(`select * from public.receptionist_client_directory($1, null, null, null, 0, 50)`, [B.studioId])));
    const otherRows = other.ok ? (other.value as { rows: unknown[] }).rows.length : 0;
    note("RC9", "the receptionist reads the client directory of studio B", "receptionist (authenticated)", other.ok ? { rows: otherRows } : other.error, otherRows === 0);
    const bookB = await attempt(() => as(rec.userId, (q) => q(`select * from public.receptionist_create_appointment($1, $2, $3, $4, now() + interval '51 days')`, [B.studioId, B.practitionerId, B.clientId, serviceB])));
    const bookBVal = bookB.ok ? ((bookB.value as { rows: Record<string, unknown>[] }).rows[0]) : null;
    note("RC10", "the receptionist books in studio B", "receptionist (authenticated)", bookB.ok ? bookBVal : bookB.error, !bookB.ok || !Object.values(bookBVal ?? {}).includes("created"));
    // the declared return type of the command, read from the catalog, and the columns of a real call as the receptionist
    const declared = String((await adminQuery(`select pg_get_function_result('public.receptionist_booking_options(uuid)'::regprocedure) as t`)).rows[0].t);
    const declaredCols = [...declared.matchAll(/(?:^TABLE\(|, )([a-z_]+) [a-z ]+/g)].map((m) => m[1]);
    const opts = await attempt(() => as(rec.userId, (q) => q(`select * from public.receptionist_booking_options($1)`, [A.studioId])));
    const optRows = opts.ok ? (opts.value as { rows: Record<string, unknown>[] }).rows : [];
    const returnedCols = [...new Set(optRows.flatMap((r) => Object.keys(r)))].sort();
    const priceLike = [...declaredCols, ...returnedCols].filter((c) => /price|paid|fee|amount|cost|cents|deposit/i.test(c));
    note("RC6b", "receptionist_booking_options: the DECLARED return columns (from the catalog) and the columns of a real call; any price, paid, fee, amount or cost column is listed", "receptionist (authenticated)", { declared, declared_columns: declaredCols, rows: optRows.length, returned_columns: returnedCols, price_like_columns: priceLike }, opts.ok && declaredCols.length >= 4 && priceLike.length === 0);
    const ownerSees = await as(A.userId, (q) => q(`select count(*) n from public.appointments where studio_id = $1 and created_by_receptionist_id = $2`, [A.studioId, rec.receptionistId]));
    note("RC11", "the owner sees the appointment the receptionist booked, attributed to the receptionist", "owner A (authenticated)", { appointments: n(ownerSees) }, n(ownerSees) === 1);
  });

  it("the owner removes the receptionist: gone at once, and reversible", async () => {
    const res = await asService((q) => q(`select public.set_studio_receptionist_active($1, $2, $3, false) as r`, [A.studioId, A.practitionerId, rec.receptionistId]));
    note("RC12", "the owner deactivates the receptionist (set_studio_receptionist_active)", "service_role, as the owner's server action", res.rows[0].r, true);
    const dir = await attempt(() => as(rec.userId, (q) => q(`select * from public.receptionist_client_directory($1, null, null, null, 0, 50)`, [A.studioId])));
    const dirRows = dir.ok ? (dir.value as { rows: unknown[] }).rows.length : 0;
    note("RC13", "the very next call: the client directory returns nothing (or is refused)", "receptionist (authenticated)", dir.ok ? { rows: dirRows } : dir.error, dirRows === 0);
    const book = await attempt(() => as(rec.userId, (q) => q(`select * from public.receptionist_create_appointment($1, $2, $3, $4, now() + interval '52 days')`, [A.studioId, pract.practitionerId, A.clientId, serviceA])));
    const bv = book.ok ? ((book.value as { rows: Record<string, unknown>[] }).rows[0]) : null;
    note("RC14", "the very next booking is refused", "receptionist (authenticated)", book.ok ? bv : book.error, !book.ok || !Object.values(bv ?? {}).includes("created"));
    const kept = n(await as(A.userId, (q) => q(`select count(*) n from public.appointments where studio_id = $1 and created_by_receptionist_id = $2`, [A.studioId, rec.receptionistId])));
    note("RC15", "the appointment the receptionist made is kept", "owner A (authenticated)", { appointments: kept }, kept === 1);
    await asService((q) => q(`select public.set_studio_receptionist_active($1, $2, $3, true)`, [A.studioId, A.practitionerId, rec.receptionistId]));
    const back = await attempt(() => as(rec.userId, (q) => q(`select * from public.receptionist_client_directory($1, null, null, null, 0, 50)`, [A.studioId])));
    const backRows = back.ok ? (back.value as { rows: unknown[] }).rows.length : 0;
    note("RC16", "restoring the receptionist restores access", "owner A then receptionist", { directory_rows: backRows }, backRows >= 1);
  });
});
