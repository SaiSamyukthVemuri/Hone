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
const tables = () => q(`select count(*)::int n from pg_tables where schemaname='public' and tablename in
  ('waitlist_followups','waitlist_decline_answers','waitlist_decline_owner_emails','waitlist_erase_records')`).then((r) => r[0].n);
const admitSrc = () => q(`select prosrc from pg_proc where proname='admit_new_client_waitlist_entry' and pronamespace='public'::regnamespace`).then((r) => r[0].prosrc as string);

describe("0325 up / down / up (H1)", () => {
  it("down REFUSES while any answer text exists, destroying nothing", async () => {
    // Seed one live answer directly.
    const s = await q(`select 1`);
    expect(s).toHaveLength(1);
    const st = await seedStudio("rt");
    const studio = st.studioId;
    const ent = (await adminQuery(`select * from public.create_practitioner_waitlist_entry($1,$2,'RT',$3,null,null)`, [studio, st.userId, `rt-${studio.slice(0, 8)}@example.com`])).rows[0].entry_id;
    const fu = (await q(`insert into public.waitlist_followups (studio_id, entry_id, kind) values ('${studio}','${ent}','withdrawal') returning id`))[0].id;
    await q(`insert into public.waitlist_decline_answers (followup_id, studio_id, why_not_work, better_times) values ('${fu}','${studio}','x','y')`);
    await expect(q(down)).rejects.toThrow(/down refused/);
    expect(await tables()).toBe(4);
    expect((await q(`select count(*)::int n from public.waitlist_decline_answers where followup_id='${fu}'`))[0].n).toBe(1);
    await q(`delete from public.studios where id='${studio}'`);
  });

  it("with no answers, down restores 0324's admit, then up re-applies cleanly", async () => {
    await q(`delete from public.waitlist_decline_answers`);
    await q(down);
    expect(await tables()).toBe(0);
    expect(await admitSrc()).not.toContain("pending_owner_review");
    expect(await admitSrc()).toContain("if v_competing + 1 > p_fit then");
    await q(up);
    expect(await tables()).toBe(4);
    expect(await admitSrc()).toContain("pending_owner_review");
  });
});
