import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { adminQuery, adminTx, closePool, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// Pulse count may be blank: an untouched count stays NULL, a touched one is stored as is. Synthetic data only.
const UP = "docs/proposals/pulse-count-null.sql";
const DOWN = "docs/proposals/pulse-count-null.down.sql";
let S: SeededStudio;

const failure = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { message: string }; } };
// The write helper records history as the signed-in practitioner, so run it with the studio owner's JWT claims set for the transaction.
const asOwner = (text: string, params: unknown[]) => adminTx(async (q) => {
  await q(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [S.userId, JSON.stringify({ sub: S.userId, role: "authenticated" })]);
  return q(text, params);
});
const write = async (sess: { sessionId: string; blockId: string }, entry: string | null, pulse: number | null, delay: number | null = null) =>
  (await asOwner(
    `select public.write_electrolysis_entry(p_entry_id => $1, p_session_id => $2, p_block_id => $3, p_area => 'Upper lip', p_areas => null, p_probe_size => null,
       p_probe_lot_id => null, p_mode => 'thermo', p_intensity => null, p_duration_seconds => null, p_pulse_count => $4, p_pulse_delay_seconds => $5,
       p_comments => null, p_observation_chips => null, p_apilus_modality => null, p_energy_level => null, p_minutes_performed => null, p_probe_type => null,
       p_machine_frequency => null, p_hairs_treated => null, p_galvanic_ma => null, p_galvanic_duration_seconds => null,
       p_thermolysis_intensity_percent => 30, p_thermolysis_duration_seconds => null, p_units_of_lye => null)`,
    [entry, sess.sessionId, sess.blockId, pulse, delay])).rows[0].write_electrolysis_entry as string;
const pulseOf = async (entry: string) => (await adminQuery(`select pulse_count from public.electrolysis_entries where id=$1`, [entry])).rows[0]?.pulse_count as number | null;

// THE CATALOG IS LEFT AS IT WAS FOUND. This file replays the proposal SQL (and its down) against the database it runs on, which on a shared stack
// is everyone's, so the column's starting state is recorded and put back afterwards: a stack that began NOT NULL ends NOT NULL (blank counts this
// file stored are cleaned first, because the down refuses while any exist), and one that began nullable is left nullable.
let startedNotNull = false;
const pulseNullable = async () =>
  (await adminQuery(`select is_nullable from information_schema.columns where table_name='electrolysis_entries' and column_name='pulse_count'`)).rows[0].is_nullable as string;
beforeAll(async () => {
  startedNotNull = (await pulseNullable()) === "NO";
  if (startedNotNull) await adminQuery(readFileSync(UP, "utf8"));
  S = await seedStudio("pulse-null");
});
afterAll(async () => {
  try {
    if (startedNotNull && (await pulseNullable()) === "YES") {
      await adminTx(async (q) => { await q(`set local session_replication_role = replica`); await q(`update public.electrolysis_entries set pulse_count = 1 where pulse_count is null`); });
      await adminQuery(readFileSync(DOWN, "utf8"));
    }
  } finally {
    await closePool();
  }
});

describe("pulse count may be blank", () => {
  it("an untouched count stores NULL; a touched count stores as entered; the range check still refuses 0 and 11", async () => {
    const sess = await seedSession(S);
    const a = await write(sess, null, null);
    const b = await write(sess, null, 1);
    expect(await pulseOf(a)).toBeNull();
    expect(await pulseOf(b)).toBe(1);
    for (const bad of [0, 11]) expect((await failure(write(sess, null, bad)))?.message, String(bad)).toMatch(/pulse_count_check/);
  });

  it("an update with no count leaves a stored NULL NULL and a stored 3 at 3; a count can be set and then changed", async () => {
    const sess = await seedSession(S);
    const a = await write(sess, null, null);
    const b = await write(sess, null, 3);
    await write(sess, a, null);
    await write(sess, b, null);
    expect(await pulseOf(a)).toBeNull();
    expect(await pulseOf(b)).toBe(3);
    await write(sess, a, 2);
    expect(await pulseOf(a)).toBe(2);
    await write(sess, a, 4);
    expect(await pulseOf(a)).toBe(4);
  });

  it("the reading-history trigger accepts a NULL pulse count, with and without a delay", async () => {
    const sess = await seedSession(S);
    const a = await write(sess, null, null, null);
    expect(await failure(write(sess, a, 2, 0.5))).toBeNull();
    expect(await failure(write(sess, a, null, 0.5))).toBeNull();
    expect(await failure(write(sess, null, null, 0.5))).toBeNull();
  });

  it("the whole-session fingerprint is stable with a NULL count", async () => {
    const sess = await seedSession(S);
    await write(sess, null, null);
    const f1 = (await adminQuery(`select public._whole_session_copy_fingerprint($1) f`, [sess.sessionId])).rows[0].f;
    const f2 = (await adminQuery(`select public._whole_session_copy_fingerprint($1) f`, [sess.sessionId])).rows[0].f;
    expect(f1).toBe(f2);
  });

  it("the down REFUSES while a blank count is stored and restores nothing; with none stored it restores NOT NULL default 1; re-apply passes", async () => {
    const sess = await seedSession(S);
    await write(sess, null, null);
    expect((await failure(adminQuery(readFileSync(DOWN, "utf8"))))?.message).toMatch(/blank pulse count/);
    expect((await adminQuery(`select is_nullable from information_schema.columns where table_name='electrolysis_entries' and column_name='pulse_count'`)).rows[0].is_nullable).toBe("YES");
    await adminTx(async (q) => { await q(`set local session_replication_role = replica`); await q(`update public.electrolysis_entries set pulse_count = 1 where pulse_count is null`); }); // fixture cleanup across earlier runs
    await adminQuery(readFileSync(DOWN, "utf8"));
    expect((await adminQuery(`select is_nullable, column_default from information_schema.columns where table_name='electrolysis_entries' and column_name='pulse_count'`)).rows[0]).toEqual({ is_nullable: "NO", column_default: "1" });
    await adminQuery(readFileSync(UP, "utf8"));
    expect((await adminQuery(`select is_nullable from information_schema.columns where table_name='electrolysis_entries' and column_name='pulse_count'`)).rows[0].is_nullable).toBe("YES");
  });
});
