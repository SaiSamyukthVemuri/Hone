import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicationFixture } from "../fixtures/machine-publication";
import { planContractPublication } from "../../lib/machines/contract-publication";
import { adminQuery, asRole, asUser, closePool, RECORD_GROUP_SQL, seedMember, seedSession, seedStudio } from "./helpers/harness";
import { releaseAllKeys } from "./helpers/permission-release";

// 0333 (I1), second half: the pay.*-only role in two forms, definer-RPC and INVOKER-function behaviour, and the plan on a realistic sessions table.
// Synthetic data only. Needs 0333 applied (the same slot as clin-read-enforcement-records.db.test.ts).
const MIGRATION = readFileSync("supabase/migrations/0333_clinical_read_enforcement_records.sql", "utf8");
const SESSIONS_POLICY_STMT = MIGRATION.match(/alter policy "sessions: members select"[\s\S]*?;/)![0];
const OLD_SESSIONS_POLICY = `alter policy "sessions: members select" on public.sessions using (public.is_studio_member(studio_id))`;

async function setStored(studioId: string, key: string, scope: string): Promise<void> {
  await adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,$3, now()) on conflict (studio_id,role,key) do update set scope=$3, set_at=now()",
    [studioId, key, scope],
  );
}

beforeAll(async () => { await releaseAllKeys(); });
afterAll(async () => { await adminQuery(OLD_SESSIONS_POLICY).catch(() => undefined); await adminQuery(SESSIONS_POLICY_STMT); await closePool(); });

describe("0333: a role holding pay.view_appointment but not clin.view_records", () => {
  it("(a) reads ZERO sessions rows through the user client (price/payment columns and the appointment link included)", async () => {
    const s = await seedStudio("p333a");
    const m = await seedMember(s, "p333am");
    const { sessionId } = await seedSession(s);
    const appt = randomUUID();
    await adminQuery(
      "insert into public.appointments(id, studio_id, client_id, practitioner_id, starts_at, ends_at, status) values ($1,$2,$3,$4, now(), now() + interval '1 hour', 'confirmed')",
      [appt, s.studioId, s.clientId, s.practitionerId],
    );
    await adminQuery("update public.sessions set appointment_id=$2, price_paid_cents=1234 where id=$1", [sessionId, appt]);
    await setStored(s.studioId, "pay.view_appointment", "studio");
    await setStored(s.studioId, "clin.view_records", "off");
    await asUser(m.userId, async (q) => {
      expect((await q("select public.has_studio_permission($1,'pay.view_appointment') p", [s.studioId])).rows[0].p, "holds the pay key").toBe(true);
      expect((await q("select public.has_studio_permission($1,'clin.view_records') p", [s.studioId])).rows[0].p, "lacks the clinical key").toBe(false);
      expect((await q("select count(*)::int n from public.sessions where id=$1", [sessionId])).rows[0].n).toBe(0);
      expect((await q("select count(*)::int n from public.sessions where appointment_id=$1", [appt])).rows[0].n).toBe(0);
      expect((await q("select count(*)::int n from public.appointments a join public.sessions x on x.appointment_id=a.id where a.id=$1", [appt])).rows[0].n).toBe(0);
    });
  });

  it("(b) the admin / service-role path still returns that studio's payment state (price and appointment link)", async () => {
    const s = await seedStudio("p333b");
    const { sessionId } = await seedSession(s);
    const appt = randomUUID();
    await adminQuery(
      "insert into public.appointments(id, studio_id, client_id, practitioner_id, starts_at, ends_at, status) values ($1,$2,$3,$4, now(), now() + interval '1 hour', 'confirmed')",
      [appt, s.studioId, s.clientId, s.practitionerId],
    );
    await adminQuery("update public.sessions set appointment_id=$2, price_paid_cents=1234 where id=$1", [sessionId, appt]);
    await setStored(s.studioId, "clin.view_records", "off");
    const r = await asRole("service_role", (q) => q("select id, appointment_id, price_paid_cents from public.sessions where id=$1", [sessionId]));
    expect(r.rows).toEqual([{ id: sessionId, appointment_id: appt, price_paid_cents: 1234 }]);
  });
});

describe("0333: definer RPC writes behave the same under the new and the old policy (no new error text, no new refusal)", () => {
  const outcome = async (userId: string, sessionId: string, clientId: string, blockId: string) => {
    try {
      const r = await asUser(userId, (q) => q("select public.soft_delete_session_block($1,$2,$3,'synthetic') as id", [sessionId, clientId, blockId]));
      return { ok: true as const, id: r.rows[0].id as string | null };
    } catch (e) {
      return { ok: false as const, message: (e as Error).message };
    }
  };
  const run = async (label: string, who: "keyed" | "restricted") => {
    const s = await seedStudio(label);
    const m = await seedMember(s, `${label}m`);
    const { sessionId, blockId } = await seedSession(s);
    if (who === "restricted") await setStored(s.studioId, "clin.view_records", "off");
    const o = await outcome(m.userId, sessionId, s.clientId, blockId);
    return o.ok ? { ok: true, deleted: o.id === blockId } : o;
  };

  it("keyed practitioner: the write succeeds", async () => {
    expect(await run("w333k", "keyed")).toEqual({ ok: true, deleted: true });
  });
  it("restricted practitioner: the outcome is IDENTICAL with sessions' old policy and with 0333's (write keys are not part of this change)", async () => {
    const withNew = await run("w333r1", "restricted");
    await adminQuery(OLD_SESSIONS_POLICY);
    let withOld;
    try { withOld = await run("w333r2", "restricted"); } finally { await adminQuery(SESSIONS_POLICY_STMT); }
    expect(withNew).toEqual(withOld);
  });
});

describe("0333: INVOKER functions follow the caller's policy", () => {
  it("setup_capture_history_for_block / setup_readings_for_block return the history to a keyed member and nothing to a restricted one", async () => {
    const p = publicationFixture(`synthetic:inv-${randomUUID()}`);
    const c = planContractPublication([p]).publish[0];
    const studio = await seedStudio("i333");
    const keyed = await seedMember(studio, "i333k");
    const { blockId, sessionId } = await seedSession(studio);
    await asRole("service_role", async (q) => {
      await q("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
    });
    await asUser(studio.userId, async (q) => {
      const machine = (await q("select public.register_studio_machine($1,$2,1,'Invoker fixture','{}') as id", [studio.studioId, p.profileId])).rows[0].id;
      const field = p.modes[0].fields[0];
      await q(RECORD_GROUP_SQL, [blockId, machine, p.modes[0].key, "g1", [], JSON.stringify([{ field_key: field.key, value: "1", observation_source: "practitioner-entered" }]), sessionId, studio.clientId]);
    });
    const history = (userId: string) => asUser(userId, async (q) => ({
      h: (await q("select public.setup_capture_history_for_block($1) as d", [blockId])).rows[0].d,
      r: (await q("select public.setup_readings_for_block($1,$2) as d", [blockId, sessionId])).rows[0].d,
    }));
    const len = (v: unknown) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v as object).length : v ? 1 : 0);
    const k = await history(keyed.userId);
    expect(len(k.h), "keyed history").toBeGreaterThan(0);
    await setStored(studio.studioId, "clin.view_records", "off");
    const r = await history(keyed.userId);
    expect(len(r.h), "restricted history").toBe(0);
    expect(len(r.r), "restricted readings").toBe(0);
    // the owner of the same studio is unaffected
    expect(len((await history(studio.userId)).h)).toBeGreaterThan(0);
  });
});

describe("0333: the policy is evaluated once per statement (plan and timing on a realistic sessions table)", () => {
  it("5,000 sessions for one studio: the keyed read's plan has no per-row function call and is not slower than the old policy by more than 3x", async () => {
    const s = await seedStudio("e333");
    const m = await seedMember(s, "e333m");
    await adminQuery(
      `insert into public.sessions(id, studio_id, client_id, practitioner_id, modality, started_at)
       select gen_random_uuid(), $1, $2, $3, 'electrolysis', now() - (g || ' hours')::interval from generate_series(1,5000) g`,
      [s.studioId, s.clientId, s.practitionerId],
    );
    await adminQuery("analyze public.sessions");
    const sql = "explain (analyze, buffers, format json) select id, started_at from public.sessions where studio_id=$1 and client_id=$2 order by started_at desc limit 20";
    const plan = async () => {
      const r = await asUser(m.userId, (q) => q(sql, [s.studioId, s.clientId]));
      const j = r.rows[0]["QUERY PLAN"][0];
      return { ms: j["Execution Time"] as number, text: JSON.stringify(j.Plan) };
    };
    await plan(); // warm
    const withNew = await plan();
    await adminQuery(OLD_SESSIONS_POLICY);
    let withOld;
    try { await plan(); withOld = await plan(); } finally { await adminQuery(SESSIONS_POLICY_STMT); }
    console.log(`EXPLAIN 0333 sessions(5000): new=${withNew.ms.toFixed(2)}ms old=${withOld.ms.toFixed(2)}ms`);
    // the key is checked in a subplan evaluated once, never as a per-row Filter calling the helper
    expect(withNew.text).not.toMatch(/"Filter":"[^"]*clin_key_studios/);
    expect(withNew.text).toMatch(/clin_key_studios|Hashed SubPlan|SubPlan|InitPlan|Function Scan/);
    expect(withNew.ms).toBeLessThan(Math.max(withOld.ms * 3, 50));
  }, 120_000);
});
