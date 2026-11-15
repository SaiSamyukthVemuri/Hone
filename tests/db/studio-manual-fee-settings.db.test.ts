import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0351: the two per-studio manual-fee switches. Defaults and owner-only writes against the real migrated chain.
// Synthetic data only. NOT RUN by the author on a shared stack: needs a local stack at the 0351 head.

let studio: SeededStudio;
let member: { userId: string; practitionerId: string };
let other: SeededStudio;

beforeAll(async () => {
  studio = await seedStudio("fee-set-a");
  member = await seedMember(studio, "fee-set-m");
  other = await seedStudio("fee-set-b");
});
afterAll(async () => {
  for (const s of [studio, other]) await adminQuery(`delete from public.studios where id = $1`, [s.studioId]);
  await closePool();
});

const read = async (id: string) =>
  (await adminQuery(`select late_cancel_fee_enabled, no_show_fee_enabled from public.studios where id = $1`, [id])).rows[0];

describe("0351 defaults", () => {
  it("both columns exist, are boolean NOT NULL, and default to false", async () => {
    const r = await adminQuery(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'studios' and column_name in ('late_cancel_fee_enabled','no_show_fee_enabled') order by column_name`,
    );
    expect(r.rows).toEqual([
      { column_name: "late_cancel_fee_enabled", data_type: "boolean", is_nullable: "NO", column_default: "false" },
      { column_name: "no_show_fee_enabled", data_type: "boolean", is_nullable: "NO", column_default: "false" },
    ]);
  });
  it("a new studio starts with both OFF", async () => {
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: false, no_show_fee_enabled: false });
  });
  it("NULL is refused", async () => {
    await expect(adminQuery(`update public.studios set late_cancel_fee_enabled = null where id = $1`, [studio.studioId])).rejects.toThrow();
  });
});

describe("0351 owner-only writes (role authenticated with the caller's own JWT)", () => {
  it("the owner can turn each type on and off independently", async () => {
    await asUser(studio.userId, (q) => q(`update public.studios set late_cancel_fee_enabled = true where id = $1`, [studio.studioId]));
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: true, no_show_fee_enabled: false });
    await asUser(studio.userId, (q) => q(`update public.studios set no_show_fee_enabled = true, late_cancel_fee_enabled = false where id = $1`, [studio.studioId]));
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: false, no_show_fee_enabled: true });
    await asUser(studio.userId, (q) => q(`update public.studios set no_show_fee_enabled = false where id = $1`, [studio.studioId]));
  });
  it("a non-owner member's UPDATE changes nothing", async () => {
    const r = await asUser(member.userId, (q) => q(`update public.studios set late_cancel_fee_enabled = true, no_show_fee_enabled = true where id = $1 returning id`, [studio.studioId]));
    expect(r.rows).toHaveLength(0);
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: false, no_show_fee_enabled: false });
  });
  it("another studio's owner cannot change this studio's switches", async () => {
    const r = await asUser(other.userId, (q) => q(`update public.studios set late_cancel_fee_enabled = true where id = $1 returning id`, [studio.studioId]));
    expect(r.rows).toHaveLength(0);
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: false, no_show_fee_enabled: false });
  });
  it("an owner's switch change does not touch the fee amounts", async () => {
    await adminQuery(`update public.studios set late_cancel_fee_cents = 2500, no_show_fee_cents = 4000 where id = $1`, [studio.studioId]);
    await asUser(studio.userId, (q) => q(`update public.studios set late_cancel_fee_enabled = true where id = $1`, [studio.studioId]));
    const r = (await adminQuery(`select late_cancel_fee_cents, no_show_fee_cents from public.studios where id = $1`, [studio.studioId])).rows[0];
    expect(r).toEqual({ late_cancel_fee_cents: 2500, no_show_fee_cents: 4000 });
    await adminQuery(`update public.studios set late_cancel_fee_enabled = false where id = $1`, [studio.studioId]);
  });
});


// ---------------------------------------------------------------------------
// 0351 extension: mode, percentage, attempt basis, change record, sweep dedupe query. Synthetic ids only.
// ---------------------------------------------------------------------------
const settings = async (id: string) =>
  (await adminQuery(
    `select late_cancel_fee_mode, no_show_fee_mode, late_cancel_fee_percent_bp, no_show_fee_percent_bp from public.studios where id = $1`,
    [id],
  )).rows[0];

describe("0351 mode and percentage columns", () => {
  it("a studio starts in fixed mode with no percentage, and its amounts are untouched", async () => {
    expect(await settings(studio.studioId)).toEqual({ late_cancel_fee_mode: "fixed", no_show_fee_mode: "fixed", late_cancel_fee_percent_bp: null, no_show_fee_percent_bp: null });
  });
  it("mode accepts only fixed or percent; NULL is refused", async () => {
    await expect(adminQuery(`update public.studios set late_cancel_fee_mode = 'tiered' where id = $1`, [studio.studioId])).rejects.toMatchObject({ code: "23514" });
    await expect(adminQuery(`update public.studios set no_show_fee_mode = null where id = $1`, [studio.studioId])).rejects.toMatchObject({ code: "23502" });
  });
  it("the percentage is 1..10000 basis points or NULL", async () => {
    for (const bad of [0, -1, 10001]) {
      await expect(adminQuery(`update public.studios set late_cancel_fee_percent_bp = $2 where id = $1`, [studio.studioId, bad])).rejects.toMatchObject({ code: "23514" });
    }
    for (const ok of [1, 7500, 10000]) {
      await adminQuery(`update public.studios set late_cancel_fee_percent_bp = $2 where id = $1`, [studio.studioId, ok]);
    }
    await adminQuery(`update public.studios set late_cancel_fee_percent_bp = null where id = $1`, [studio.studioId]);
  });
  it("the owner may set mode and percentage; a non-owner changes nothing", async () => {
    await asUser(studio.userId, (q) => q(`update public.studios set late_cancel_fee_mode = 'percent', late_cancel_fee_percent_bp = 7500 where id = $1`, [studio.studioId]));
    expect(await settings(studio.studioId)).toMatchObject({ late_cancel_fee_mode: "percent", late_cancel_fee_percent_bp: 7500 });
    const r = await asUser(member.userId, (q) => q(`update public.studios set late_cancel_fee_percent_bp = 100 where id = $1 returning id`, [studio.studioId]));
    expect(r.rows).toHaveLength(0);
    expect((await settings(studio.studioId)).late_cancel_fee_percent_bp).toBe(7500);
    await adminQuery(`update public.studios set late_cancel_fee_mode = 'fixed', late_cancel_fee_percent_bp = null where id = $1`, [studio.studioId]);
  });
});

describe("0351 attempt calculation basis", () => {
  let appt: string;
  const INSERT = `insert into public.payment_charge_attempts
    (id, studio_id, client_id, appointment_id, charge_reason, created_by_practitioner_id, amount_cents, status, calc_mode, basis_cents, percent_bp)
    values ($1, $2, $3, $4, 'late_cancellation_fee', $5, 9000, 'ready', $6, $7, $8)`;
  const ins = (mode: string | null, basis: number | null, bp: number | null, a = appt) =>
    adminQuery(INSERT, [randomUUID(), studio.studioId, studio.clientId, a, studio.practitionerId, mode, basis, bp]);
  beforeAll(async () => {
    appt = randomUUID();
    await adminQuery(
      `insert into public.appointments (id, studio_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
       values ($1, $2, $3, '2031-02-01T10:00:00Z', '2031-02-01T11:00:00Z', 60, 0, '2031-02-01T11:00:00Z')`,
      [appt, studio.studioId, studio.clientId],
    );
  });
  it("the three columns exist, nullable, with no default", async () => {
    const r = await adminQuery(
      `select column_name, is_nullable, column_default from information_schema.columns
        where table_schema='public' and table_name='payment_charge_attempts' and column_name in ('calc_mode','basis_cents','percent_bp') order by 1`,
    );
    expect(r.rows).toEqual([
      { column_name: "basis_cents", is_nullable: "YES", column_default: null },
      { column_name: "calc_mode", is_nullable: "YES", column_default: null },
      { column_name: "percent_bp", is_nullable: "YES", column_default: null },
    ]);
  });
  it("consistency: legacy (all NULL), fixed (mode only) and percent (all three) are accepted; every mixed shape is refused", async () => {
    const a1 = randomUUID(); const a2 = randomUUID(); const a3 = randomUUID();
    for (const a of [a1, a2, a3]) {
      await adminQuery(`insert into public.appointments (id, studio_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
        values ($1, $2, $3, '2031-03-01T10:00:00Z', '2031-03-01T11:00:00Z', 60, 0, '2031-03-01T11:00:00Z')`, [a, studio.studioId, studio.clientId]);
    }
    await ins(null, null, null, a1);
    await ins("fixed", null, null, a2);
    await ins("percent", 12000, 7500, a3);
    for (const [m, b, p] of [
      ["fixed", 12000, null], ["fixed", null, 7500], [null, 12000, null], [null, null, 7500],
      ["percent", null, 7500], ["percent", 12000, null], ["percent", 0, 7500], ["percent", 12000, 0], ["percent", 12000, 10001], ["bogus", null, null],
    ] as Array<[string | null, number | null, number | null]>) {
      await expect(ins(m, b, p, randomUUID()), `${m}/${b}/${p}`).rejects.toThrow();
    }
  });
  it("once written the basis never changes (trigger), not even for the service role", async () => {
    const a = randomUUID();
    await adminQuery(`insert into public.appointments (id, studio_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
      values ($1, $2, $3, '2031-04-01T10:00:00Z', '2031-04-01T11:00:00Z', 60, 0, '2031-04-01T11:00:00Z')`, [a, studio.studioId, studio.clientId]);
    const id = randomUUID();
    await adminQuery(INSERT, [id, studio.studioId, studio.clientId, a, studio.practitionerId, "percent", 12000, 7500]);
    for (const set of ["calc_mode = 'fixed', basis_cents = null, percent_bp = null", "basis_cents = 13000", "percent_bp = 5000", "calc_mode = null, basis_cents = null, percent_bp = null"]) {
      await expect(adminQuery(`update public.payment_charge_attempts set ${set} where id = $1`, [id]), set).rejects.toMatchObject({ code: "23514" });
    }
    // an unrelated status update is fine and leaves the basis alone
    await adminQuery(`update public.payment_charge_attempts set internal_note = 'x' where id = $1`, [id]);
    const r = (await adminQuery(`select calc_mode, basis_cents, percent_bp from public.payment_charge_attempts where id = $1`, [id])).rows[0];
    expect(r).toEqual({ calc_mode: "percent", basis_cents: 12000, percent_bp: 7500 });
  });
});

describe("0351 change record: written by the database for every path, readable only by the owner", () => {
  const log = async (id: string) =>
    (await adminQuery(`select field, old_value, new_value, changed_by from public.studio_manual_fee_setting_changes where studio_id = $1 order by changed_at, field`, [id])).rows;
  it("an owner's DIRECT Data API update records who, which field, old and new (every audited field)", async () => {
    const before = (await log(studio.studioId)).length;
    await asUser(studio.userId, (q) => q(
      `update public.studios set late_cancel_fee_cents = 4000, no_show_fee_cents = 1000, late_cancel_fee_mode = 'percent', late_cancel_fee_percent_bp = 7500,
         late_cancel_fee_enabled = true, no_show_fee_enabled = true, no_show_fee_mode = 'percent', no_show_fee_percent_bp = 5000 where id = $1`, [studio.studioId]));
    const rows = (await log(studio.studioId)).slice(before);
    expect(rows.map((r) => r.field).sort()).toEqual([
      "late_cancel_fee_cents", "late_cancel_fee_enabled", "late_cancel_fee_mode", "late_cancel_fee_percent_bp",
      "no_show_fee_cents", "no_show_fee_enabled", "no_show_fee_mode", "no_show_fee_percent_bp",
    ]);
    for (const r of rows) expect(r.changed_by).toBe(studio.userId);
    const mode = rows.find((r) => r.field === "late_cancel_fee_mode");
    expect(mode).toMatchObject({ old_value: "fixed", new_value: "percent" });
    expect(rows.find((r) => r.field === "late_cancel_fee_percent_bp")).toMatchObject({ old_value: null, new_value: "7500" });
    await adminQuery(`update public.studios set late_cancel_fee_enabled = false, no_show_fee_enabled = false, late_cancel_fee_mode = 'fixed', no_show_fee_mode = 'fixed',
      late_cancel_fee_percent_bp = null, no_show_fee_percent_bp = null where id = $1`, [studio.studioId]);
  });
  it("an update that changes nothing, or changes another column, records nothing", async () => {
    const before = (await log(studio.studioId)).length;
    await adminQuery(`update public.studios set late_cancel_fee_enabled = false where id = $1`, [studio.studioId]);
    await adminQuery(`update public.studios set name = name where id = $1`, [studio.studioId]);
    expect((await log(studio.studioId)).length).toBe(before);
  });
  it("a service-role / SQL change is recorded with changed_by NULL", async () => {
    await adminQuery(`update public.studios set no_show_fee_enabled = true where id = $1`, [studio.studioId]);
    const last = (await log(studio.studioId)).filter((r) => r.field === "no_show_fee_enabled").pop();
    expect(last).toMatchObject({ new_value: "true", changed_by: null });
    await adminQuery(`update public.studios set no_show_fee_enabled = false where id = $1`, [studio.studioId]);
  });
  it("the owner can READ the record; a member and another studio's owner read nothing", async () => {
    expect((await asUser(studio.userId, (q) => q(`select 1 from public.studio_manual_fee_setting_changes where studio_id = $1`, [studio.studioId]))).rows.length).toBeGreaterThan(0);
    expect((await asUser(member.userId, (q) => q(`select 1 from public.studio_manual_fee_setting_changes where studio_id = $1`, [studio.studioId]))).rows).toHaveLength(0);
    expect((await asUser(other.userId, (q) => q(`select 1 from public.studio_manual_fee_setting_changes where studio_id = $1`, [studio.studioId]))).rows).toHaveLength(0);
  });
  it("append-only: the owner (authenticated) cannot insert, update or delete a row, and anon holds nothing", async () => {
    const id = (await log(studio.studioId))[0] && (await adminQuery(`select id from public.studio_manual_fee_setting_changes where studio_id = $1 limit 1`, [studio.studioId])).rows[0].id;
    await expect(asUser(studio.userId, (q) => q(`insert into public.studio_manual_fee_setting_changes (studio_id, field) values ($1, 'late_cancel_fee_enabled')`, [studio.studioId]))).rejects.toThrow(/permission denied/i);
    await expect(asUser(studio.userId, (q) => q(`update public.studio_manual_fee_setting_changes set new_value = 'x' where id = $1`, [id]))).rejects.toThrow(/permission denied/i);
    await expect(asUser(studio.userId, (q) => q(`delete from public.studio_manual_fee_setting_changes where id = $1`, [id]))).rejects.toThrow(/permission denied/i);
    const priv = (await adminQuery(
      `select r, p, has_table_privilege(r, 'public.studio_manual_fee_setting_changes', p) as has
         from unnest(array['anon','authenticated','service_role']) r, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p`)).rows;
    for (const row of priv) expect(row.has, `${row.r} ${row.p}`).toBe(false);
    expect((await adminQuery(`select has_table_privilege('anon','public.studio_manual_fee_setting_changes','SELECT') as s`)).rows[0].s).toBe(false);
  });
  it("the trigger functions cannot be executed by any role (revoked by name)", async () => {
    for (const fn of ["studios_manual_fee_setting_audit()", "payment_charge_attempts_calc_basis_immutable()"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await adminQuery(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, `public.${fn}`]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});

describe("stuck-fee sweep dedupe predicate, against a real jsonb column", () => {
  it("the safe_details->>'attempt_id' / ->>'reason' lookup the sweep issues finds exactly the alert it recorded", async () => {
    const attempt = randomUUID();
    await adminQuery(
      `insert into public.ops_alerts (severity, event, message, studio_id, safe_details)
       values ('critical', 'session_payment_needs_manual_review', 'x', $1, $2::jsonb)`,
      [studio.studioId, JSON.stringify({ attempt_id: attempt, reason: "fee_stuck_no_pi", charge_reason: "late_cancellation_fee" })],
    );
    const q = (id: string, reason: string) =>
      adminQuery(
        `select id from public.ops_alerts where event = 'session_payment_needs_manual_review' and safe_details->>'attempt_id' = $1 and safe_details->>'reason' = $2 limit 1`,
        [id, reason],
      );
    expect((await q(attempt, "fee_stuck_no_pi")).rows).toHaveLength(1);
    expect((await q(attempt, "fee_stuck_pi_unreconciled")).rows).toHaveLength(0);
    expect((await q(randomUUID(), "fee_stuck_no_pi")).rows).toHaveLength(0);
    await adminQuery(`delete from public.ops_alerts where studio_id = $1`, [studio.studioId]);
  });
});
