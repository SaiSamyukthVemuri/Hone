import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, resolveLocalDbUrl, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-126 / migration 0397. ops_alerts becomes operator-only: no studio owner, practitioner, receptionist or signed-out
// visitor can read ANY alert, existing or new, and no client role holds a table privilege. The service role (operators, the
// admin pages, recordOpsAlert, the SECURITY DEFINER functions) is untouched.
//
// The file rehearses the change on the stack it runs against: it puts the table in its pre-0397 state with the down file,
// seeds EXISTING studio-scoped alerts (one with a client id, one like the 0238 Stripe-account alert), proves members CAN read
// them there (positive control: a zero afterwards is the change, not an empty fixture), applies the up file, writes NEW alerts
// through the service role and the SQL definer path, and re-checks every role. It finishes with an up, down, up round trip.
// Synthetic fixtures only. Run it only on an owned stack (E2E_SUPABASE_URL + HONE_LOCAL_DB_URL).

const UP = readFileSync("supabase/migrations/0397_ops_alerts_operator_only.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0397_ops_alerts_operator_only.down.sql", "utf8");
const POLICY = "ops_alerts_member_read";

// Run a migration file that is EXPECTED to refuse, on its own connection, and roll back: a refusal raised inside the file's own begin;
// leaves that session in an aborted transaction, which must not poison the shared pool.
async function refusal(sql: string): Promise<string> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  try {
    await c.query(sql);
    return "";
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.query("rollback").catch(() => undefined);
    await c.end();
  }
}

const VERBS = ["select", "insert", "update", "delete"] as const;
const grants = async (role: string) =>
  Object.fromEntries(
    await Promise.all(
      VERBS.map(async (v) => [
        v,
        (await adminQuery(`select has_table_privilege($1, 'public.ops_alerts', $2) as ok`, [role, v])).rows[0].ok as boolean,
      ]),
    ),
  );
const policies = async () =>
  (await adminQuery(`select polname from pg_policy where polrelid = 'public.ops_alerts'::regclass order by 1`)).rows.map((r) => r.polname);
const relacl = async () =>
  (await adminQuery(`select relacl::text as a from pg_class where oid = 'public.ops_alerts'::regclass`)).rows[0].a as string;

let studio: SeededStudio;
let other: SeededStudio;
let member: { userId: string };
let desk: string;
let stranger: string;
const ids = { plain: "", withClient: "", stripe: "", otherStudio: "" };
const newIds = { service: "", definer: "" };

async function insertAlert(s: SeededStudio, event: string, over: { clientId?: string; details?: object } = {}): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.ops_alerts (id, severity, event, message, studio_id, client_id, route, safe_details)
     values ($1, 'warning', $2, 'synthetic', $3, $4, 'tests/db/ops-alerts-operator-only-0397', $5::jsonb)`,
    [id, event, s.studioId, over.clientId ?? null, JSON.stringify(over.details ?? {})],
  );
  return id;
}

type Read = { rows: { id: string }[] } | { refused: string };
const readAs = (who: string | "anon") => {
  const sql = `select id from public.ops_alerts where id = any($1::uuid[])`;
  const all = [...Object.values(ids), ...Object.values(newIds)].filter(Boolean);
  const run = who === "anon" ? asRole("anon", (q) => q(sql, [all])) : asUser(who, (q) => q(sql, [all]));
  return run.then(
    (r): Read => ({ rows: r.rows }),
    (e: { code?: string }): Read => ({ refused: e.code ?? "unknown" }),
  );
};
// Zero rows or a refusal (42501 insufficient_privilege) is the contract; anything else (rows, or a different error) is a failure.
const noAccess = (r: Read) => ("refused" in r ? r.refused === "42501" : r.rows.length === 0);

beforeAll(async () => {
  studio = await seedStudio("ops-alerts-a");
  other = await seedStudio("ops-alerts-b");
  member = await seedMember(studio, "plain-practitioner");
  desk = randomUUID();
  stranger = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2), ($3, $4)`, [
    desk, `desk-${desk.slice(0, 8)}@harness.local`, stranger, `stranger-${stranger.slice(0, 8)}@harness.local`,
  ]);
  // A fixture row: from 0390 on a front-desk seat gate (front_desk_not_enabled) guards the insert, and this file is about alert reads, not seats,
  // so the seat triggers are skipped for this one statement.
  await adminQuery(`begin; set local session_replication_role = replica; insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ('${studio.studioId}', '${desk}', 'Desk', true); commit;`);
});

afterAll(async () => {
  const all = [...Object.values(ids), ...Object.values(newIds)].filter(Boolean);
  if (all.length) await adminQuery(`delete from public.ops_alerts where id = any($1::uuid[])`, [all]);
  await closePool();
});

describe("0397: ops_alerts is operator-only", () => {
  it("the chain is at the 0397 end state: no policy, RLS on, anon and authenticated hold nothing, service_role keeps everything", async () => {
    expect(await policies()).toEqual([]);
    expect((await adminQuery(`select relrowsecurity as r from pg_class where oid = 'public.ops_alerts'::regclass`)).rows[0].r).toBe(true);
    for (const role of ["anon", "authenticated"]) expect(await grants(role), role).toEqual({ select: false, insert: false, update: false, delete: false });
    expect(await grants("service_role")).toEqual({ select: true, insert: true, update: true, delete: true });
    for (const role of ["anon", "authenticated"]) {
      expect((await adminQuery(`select has_any_column_privilege($1, 'public.ops_alerts', 'select') as ok`, [role])).rows[0].ok, `${role} column`).toBe(false);
    }
  });

  it("the four SECURITY DEFINER functions are unchanged by it: definer, owned by postgres, pinned search_path, not executable by anon or authenticated", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig::text as cfg,
              has_function_privilege('anon', p.oid, 'execute') as anon_x, has_function_privilege('authenticated', p.oid, 'execute') as auth_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('claim_stripe_account_country_alert', 'enqueue_calendar_outbound', 'enqueue_calendar_outbound_on_delete', 'reminder_sms_unroutable_studios')
        order by 1`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual(["claim_stripe_account_country_alert", "enqueue_calendar_outbound", "enqueue_calendar_outbound_on_delete", "reminder_sms_unroutable_studios"]);
    for (const x of r.rows) {
      expect(x.prosecdef, x.proname).toBe(true);
      expect(x.owner, x.proname).toBe("postgres");
      expect(x.cfg, x.proname).toMatch(/search_path/);
      expect(x.anon_x, x.proname).toBe(false);
      expect(x.auth_x, x.proname).toBe(false);
    }
  });

  it("BEFORE the change, members read existing studio-scoped alerts (the positive control), and after it nobody does", async () => {
    // Put the table in its pre-0397 state, exactly as the down file restores it.
    await adminQuery(DOWN);
    expect(await policies()).toEqual([POLICY]);
    expect((await grants("authenticated")).select).toBe(true);

    ids.plain = await insertAlert(studio, "reminder_send_exhausted", { details: { sms_type: "reminder_24h" } });
    ids.withClient = await insertAlert(studio, "refund_failed", { clientId: studio.clientId, details: { amount_cents: 12500 } });
    // Like the 0238 alert: studio-scoped, carries a Stripe account id.
    ids.stripe = await insertAlert(studio, "stripe_account_country_mismatch", { details: { stripe_account_id: `acct_${randomUUID().slice(0, 12)}`, livemode: false, reason: "country_mismatch" } });
    ids.otherStudio = await insertAlert(other, "reminder_send_exhausted");

    const mine = [ids.plain, ids.withClient, ids.stripe];
    for (const who of [studio.userId, member.userId]) {
      const r = await readAs(who);
      expect("rows" in r && mine.every((id) => r.rows.some((x) => x.id === id)), "a studio member reads the existing alerts before 0397").toBe(true);
      expect("rows" in r && r.rows.some((x) => x.id === ids.otherStudio), "and never another studio's").toBe(false);
    }
    // The receptionist, a signed-in stranger and anon are already blind before the change; recorded as the baseline.
    expect(noAccess(await readAs(desk))).toBe(true);
    expect(noAccess(await readAs(stranger))).toBe(true);

    await adminQuery(UP);
    expect(await policies()).toEqual([]);
  });

  it("AFTER the change an owner, a non-owner practitioner, a receptionist, a signed-in stranger and a signed-out visitor read nothing of the existing alerts", async () => {
    for (const [label, who] of [["owner", studio.userId], ["practitioner", member.userId], ["receptionist", desk], ["stranger", stranger], ["other studio owner", other.userId], ["anon", "anon"]] as const) {
      const r = await readAs(who);
      expect(noAccess(r), `${label}: ${JSON.stringify(r)}`).toBe(true);
    }
    // And no write path either.
    for (const [label, run] of [
      ["owner update", () => asUser(studio.userId, (q) => q(`update public.ops_alerts set resolved_at = now() where id = $1`, [ids.plain]))],
      ["member delete", () => asUser(member.userId, (q) => q(`delete from public.ops_alerts where id = $1`, [ids.plain]))],
      ["owner insert", () => asUser(studio.userId, (q) => q(`insert into public.ops_alerts (severity, event, message) values ('info', 'x', 'y')`))],
      ["anon insert", () => asRole("anon", (q) => q(`insert into public.ops_alerts (severity, event, message) values ('info', 'x', 'y')`))],
    ] as const) {
      await expect(run(), label).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("operators still investigate: the service role reads every existing alert", async () => {
    const r = await asRole("service_role", (q) => q(`select id from public.ops_alerts where id = any($1::uuid[])`, [Object.values(ids)]));
    expect(r.rows.map((x) => x.id).sort()).toEqual(Object.values(ids).sort());
  });

  it("NEW alerts written after the change, by the service role and by the SQL definer path, are equally unreadable to every client role and visible to the service role", async () => {
    newIds.service = randomUUID();
    // What recordOpsAlert does through PostgREST: an insert as service_role.
    await adminQuery(
      `begin; set local role service_role;
       insert into public.ops_alerts (id, severity, event, message, studio_id, route, safe_details)
       values ('${newIds.service}', 'critical', 'synthetic_after_0397', 'synthetic', '${studio.studioId}', 'tests/db', '{"k":"v"}'::jsonb);
       commit;`,
    );
    // The 0238 definer path: a studio whose Stripe account country differs from its payment country.
    const acct = `acct_${randomUUID().slice(0, 12)}`;
    await adminQuery(
      `insert into public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode, stripe_account_status, stripe_account_country) values ($1, $2, false, 'enabled', 'US')`,
      [studio.studioId, acct],
    );
    const first = await adminQuery(`select * from public.claim_stripe_account_country_alert($1, $2, false)`, [studio.studioId, acct]);
    expect(first.rows[0].out_result).toBe("created");
    newIds.definer = first.rows[0].out_alert_id;
    // It deduplicates: the same incident returns the same row.
    const second = await adminQuery(`select * from public.claim_stripe_account_country_alert($1, $2, false)`, [studio.studioId, acct]);
    expect(second.rows[0]).toMatchObject({ out_result: "existing", out_alert_id: newIds.definer });

    for (const [label, who] of [["owner", studio.userId], ["practitioner", member.userId], ["receptionist", desk], ["stranger", stranger], ["anon", "anon"]] as const) {
      expect(noAccess(await readAs(who)), label).toBe(true);
    }
    const r = await asRole("service_role", (q) => q(`select id from public.ops_alerts where id = any($1::uuid[])`, [[newIds.service, newIds.definer]]));
    expect(r.rows).toHaveLength(2);
  });

  it("up, down, up: the down restores the exact 0067 policy and the captured grants, the second up returns to the end state", async () => {
    const upAcl = await relacl();
    expect(upAcl).not.toMatch(/(^|[{,])anon=/);
    expect(upAcl).not.toMatch(/authenticated=/);
    expect(upAcl).toMatch(/service_role=arwdDxtm\/postgres/);

    await adminQuery(DOWN);
    expect(await policies()).toEqual([POLICY]);
    expect((await adminQuery(`select pg_get_expr(polqual, polrelid) as q from pg_policy where polrelid = 'public.ops_alerts'::regclass`)).rows[0].q).toBe(
      "((studio_id IS NOT NULL) AND is_studio_member(studio_id))",
    );
    const downAcl = await relacl();
    expect(downAcl).toMatch(/anon=arwdDxtm\/postgres/);
    expect(downAcl).toMatch(/authenticated=arwdDxtm\/postgres/);
    expect(downAcl).toMatch(/service_role=arwdDxtm\/postgres/);
    // The emergency down re-opens member read of existing alerts: say so in the test, so nobody mistakes it for a safe rollback.
    const reopened = await readAs(studio.userId);
    expect("rows" in reopened && reopened.rows.some((x) => x.id === ids.withClient)).toBe(true);

    await adminQuery(UP);
    expect(await policies()).toEqual([]);
    expect(await relacl()).toBe(upAcl);
    expect(noAccess(await readAs(studio.userId))).toBe(true);
  });

  it("the guards refuse a half state: a hand-modified policy stops the up, and the down will not run over an existing policy or a granted table", async () => {
    await adminQuery(DOWN);
    await adminQuery(`alter policy ${POLICY} on public.ops_alerts using (true)`);
    expect(await refusal(UP)).toMatch(/refuses to run: ops_alerts must have exactly the 0067 policy/);
    // Nothing changed: the policy is still there and anon/authenticated still hold their grants.
    expect(await policies()).toEqual([POLICY]);
    expect((await grants("authenticated")).select).toBe(true);
    await adminQuery(`alter policy ${POLICY} on public.ops_alerts using (studio_id is not null and public.is_studio_member(studio_id))`);
    expect(await refusal(DOWN)).toMatch(/0397 down refuses to run: ops_alerts already has a policy/);
    await adminQuery(UP);
    await adminQuery(`grant select on table public.ops_alerts to anon`);
    expect(await refusal(DOWN)).toMatch(/refuses to run: anon or authenticated already holds/);
    await adminQuery(`revoke all on table public.ops_alerts from anon`);
    // Left in the 0397 end state for the next file.
    expect(await policies()).toEqual([]);
    expect((await grants("authenticated")).select).toBe(false);
  });
});
