import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

afterAll(async () => {
  await closePool();
});

const root = join(__dirname, "..", "..", "supabase");
const up = readFileSync(join(root, "migrations", "0325_waitlist_decline_followups.sql"), "utf8");
const down = readFileSync(join(root, "rollbacks", "0325_waitlist_decline_followups.down.sql"), "utf8");
const q = async (t: string) => (await adminQuery(t, [])).rows as any[];
const tables = () =>
  q(`select count(*)::int n from pg_tables where schemaname='public' and tablename in
  ('waitlist_followups','waitlist_decline_answers','waitlist_decline_owner_emails','waitlist_erase_records')`).then((r) => r[0].n);
const admitSrc = () =>
  q(`select prosrc from pg_proc where proname='admit_new_client_waitlist_entry' and pronamespace='public'::regnamespace`).then((r) => r[0].prosrc as string);

describe("0325 down file (T4, D2, D3)", () => {
  it("takes its table locks BEFORE the checks, refuses on open follow-ups and on answers, and asserts the restored bodies", () => {
    const lock = down.indexOf("lock table public.waitlist_followups, public.waitlist_decline_answers in access exclusive mode");
    const refuseAnswers = down.indexOf("down refused: decline answers still exist");
    const refuseOpen = down.indexOf("down refused: open follow-ups exist");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(refuseAnswers);
    expect(refuseAnswers).toBeLessThan(refuseOpen);
    expect(down).toContain("md5(p.prosrc) = 'd22e76ad1c73f9c82e6e99af89e3232a'");
    expect(down).toContain("md5(p.prosrc) = '2cc3da6987e69ccd5a9204b1a2b7789c'");
  });

  it("D1: the down KEEPS waitlist_erase_records (it never drops it)", () => {
    expect(down).not.toMatch(/drop table[^;]*waitlist_erase_records/i);
    expect(down).toMatch(/drop table if exists public\.waitlist_decline_owner_emails;/);
    expect(down).toMatch(/drop table if exists public\.waitlist_decline_answers;/);
    expect(down).toMatch(/drop table if exists public\.waitlist_followups;/);
  });
});

describe("0325 up / down / up", () => {
  it("down REFUSES while an open follow-up or answer text exists, destroying nothing", async () => {
    try {
      const st = await seedStudio("rt");
      const studio = st.studioId;
      const ent = (await adminQuery(`select * from public.create_practitioner_waitlist_entry($1,$2,'RT',$3,null,null)`, [studio, st.userId, `rt-${studio.slice(0, 8)}@example.com`])).rows[0].entry_id;
      // Open follow-up, no answers: D2.
      const fu = (await q(`insert into public.waitlist_followups (studio_id, entry_id, kind) values ('${studio}','${ent}','withdrawal') returning id`))[0].id;
      await q(`update public.waitlist_followups set status='open' where id='${fu}'`);
      await expect(q(down)).rejects.toThrow(/open follow-ups exist/);
      // Answer text present: H1 (close the follow-up first so only the answers refuse).
      await q(`update public.waitlist_followups set status='kept', closed_at=now() where id='${fu}'`);
      const fu2 = (await q(`insert into public.waitlist_followups (studio_id, entry_id, kind, status, closed_at) values ('${studio}','${ent}','decline','handled',now()) returning id`))[0].id;
      await q(`insert into public.waitlist_decline_answers (followup_id, studio_id, why_not_work, better_times) values ('${fu2}','${studio}','x','y')`);
      await expect(q(down)).rejects.toThrow(/decline answers still exist/);
      expect(await tables()).toBe(4);
      expect((await q(`select count(*)::int n from public.waitlist_decline_answers where followup_id='${fu2}'`))[0].n).toBe(1);
      await q(`delete from public.studios where id='${studio}'`);
    } finally {
      await q(`select 1`);
    }
  });

  it("with nothing open and no answers, down restores 0324's admit, keeps the erase records, and up re-applies (re-applied in finally)", async () => {
    // Other suites' data: close what is open and drop answers so the down's own refusals do not apply.
    await q(`update public.waitlist_followups set status = case kind when 'decline' then 'handled' else 'kept' end, closed_at = now() where status = 'open'`);
    await q(`delete from public.waitlist_decline_answers`);
    const kept = (await q(`select count(*)::int n from public.waitlist_erase_records`))[0].n;
    try {
      await q(down);
      expect(await tables()).toBe(1); // only waitlist_erase_records survives
      expect((await q(`select count(*)::int n from public.waitlist_erase_records`))[0].n).toBe(kept);
      expect(await admitSrc()).not.toContain("pending_owner_review");
      expect(await admitSrc()).toContain("if v_competing + 1 > p_fit then");
    } finally {
      await q(up);
    }
    expect(await tables()).toBe(4);
    expect(await admitSrc()).toContain("pending_owner_review");
    expect((await q(`select count(*)::int n from public.waitlist_erase_records`))[0].n).toBe(kept);
  });
});
