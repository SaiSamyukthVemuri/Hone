import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, seedStudio } from "./helpers/harness";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0326 -- waitlist retention cleanup: the scheduled erase, read-time suppression, the run log and the purges.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

const NAME_MARK = "NameMarkQ7";
const EMAIL_MARK = "emailmarkq7";
const WHY = "WhyMarkQ7 the times clash with school pickup";
const TIMES = "TimesMarkQ7 weekday mornings";

async function seed(label: string) {
  const s = await seedStudio(`fu-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [s.userId]);
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id, clientId: s.clientId, practitionerId: s.practitionerId };
}
type F = Awaited<ReturnType<typeof seed>>;

async function entry(f: F, label: string) {
  const email = `${EMAIL_MARK}-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await q(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [
    f.studioId, f.userId, `${NAME_MARK} ${label}`, email,
  ]);
  expect(e[0].result).toBe("created");
  return { id: e[0].entry_id as string, email };
}

async function invite(f: F, entryId: string, days = 30) {
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const a = await q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,5)`, [
    f.studioId, f.userId, entryId, f.serviceId, from, to,
  ]);
  expect(a[0].result).toBe("admitted");
  const b = await q(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
  const c = await q(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge]);
  return { token: a[0].raw_token as string, cap: c[0].raw_capability as string };
}

const decline = (t: { token: string; cap: string }, why = WHY, times = TIMES) =>
  q(`select * from public.decline_waitlist_invitation_with_answers($1,$2,$3,$4)`, [t.token, t.cap, why, times]);

const entryRow = (id: string) =>
  q(`select id, status, joined_at from public.new_client_waitlist_entries where id=$1`, [id]).then((r) => r[0]);


const DAY = "interval '1 day'";
const fidOf = async (entryId: string) => (await q(`select id from public.waitlist_followups where entry_id=$1 and kind='decline'`, [entryId]))[0].id as string;
/** A declined entry whose answer was submitted `submittedAgo` ago. */
async function declined(f: F, label: string, submittedAgo: string) {
  const e = await entry(f, label);
  await decline(await invite(f, e.id));
  const fid = await fidOf(e.id);
  await q(`update public.waitlist_decline_answers set submitted_at = now() - $2::interval where followup_id=$1`, [fid, submittedAgo]);
  return { ...e, fid };
}
const close = (fid: string, ago: string) =>
  q(`update public.waitlist_followups set status='handled', closed_at = now() - $2::interval where id=$1`, [fid, ago]);
const answer = async (fid: string) => (await q(`select why_not_work, better_times, erased_at from public.waitlist_decline_answers where followup_id=$1`, [fid]))[0];
const records = (fid: string) => q(`select * from public.waitlist_erase_records where followup_id=$1 and reason='retention'`, [fid]);
const run = async (n = 1000) => (await q(`select * from public.run_waitlist_retention_cleanup($1)`, [n]))[0];
/** Drain everything already overdue in the shared test database so a test's counts are its own. */
const drain = async () => { for (let i = 0; i < 20; i++) { const r = await run(1000); if (r.remaining_answers + r.remaining_erase_records + r.remaining_outbox === 0) return; } };

describe("the deadline: min(submitted + 90d, closed + 30d)", () => {
  it("an OPEN request is erased at submitted + 90d, not before", async () => {
    const f = await seed("r1");
    const early = await declined(f, "r1a", "89 days 23 hours");
    const due = await declined(f, "r1b", "90 days 1 hour");
    await run();
    expect((await answer(early.fid)).erased_at).toBeNull();
    expect((await answer(early.fid)).why_not_work).toBe(WHY);
    const a = await answer(due.fid);
    expect(a).toMatchObject({ why_not_work: null, better_times: null });
    expect(a.erased_at).not.toBeNull();
    const rec = await records(due.fid);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ kind: "decline", studio_id: f.studioId, reason: "retention" });
    expect(new Date(rec[0].erased_at).getTime()).toBe(new Date(a.erased_at).getTime()); // one clock, one transaction
    expect(JSON.stringify(rec[0])).not.toMatch(/MarkQ7/);
    expect(await records(early.fid)).toHaveLength(0);
  });

  it("a CLOSED request is erased 30 days after it closed, even though the answer is recent", async () => {
    const f = await seed("r2");
    const notYet = await declined(f, "r2a", "2 days");
    await close(notYet.fid, "29 days 23 hours");
    const due = await declined(f, "r2b", "2 days");
    await close(due.fid, "30 days 1 hour");
    await run();
    expect((await answer(notYet.fid)).erased_at).toBeNull();
    expect((await answer(due.fid)).erased_at).not.toBeNull();
    expect(await records(due.fid)).toHaveLength(1);
  });

  it("the EARLIER clock wins: closed 31d ago beats an answer submitted 10d ago; submitted 91d ago beats a close 1d ago", async () => {
    const f = await seed("r3");
    const a = await declined(f, "r3a", "10 days");
    await close(a.fid, "31 days");
    const b = await declined(f, "r3b", "91 days");
    await close(b.fid, "1 day");
    await run();
    expect((await answer(a.fid)).erased_at).not.toBeNull();
    expect((await answer(b.fid)).erased_at).not.toBeNull();
  });

  it("a WITHDRAWAL that shows the earlier decline's answer starts its own 30-day clock on that answer", async () => {
    const f = await seed("r4");
    const due = await declined(f, "r4a", "10 days");
    const notYet = await declined(f, "r4b", "10 days");
    await q(`insert into public.waitlist_followups (studio_id, entry_id, kind, status, closed_at) values ($1,$2,'withdrawal','kept', now() - interval '31 days')`, [f.studioId, due.id]);
    await q(`insert into public.waitlist_followups (studio_id, entry_id, kind, status, closed_at) values ($1,$2,'withdrawal','kept', now() - interval '29 days')`, [f.studioId, notYet.id]);
    const eb = await q(`select public.waitlist_answer_erase_by($1) as d`, [due.fid]);
    expect(new Date(eb[0].d).getTime()).toBeLessThan(Date.now());
    await run();
    expect((await answer(due.fid)).erased_at).not.toBeNull();
    expect((await answer(notYet.fid)).erased_at).toBeNull();
  });
});

describe("a late job never serves overdue text", () => {
  it("the owner read and the export return NULL text plus the erased marker before the job runs; a not-yet-due row is untouched", async () => {
    await drain();
    const f = await seed("r5");
    const late = await declined(f, "r5a", "91 days");
    const fresh = await declined(f, "r5b", "1 day");
    const rows = await q(`select * from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]);
    const lateRow = rows.find((r: any) => r.followup_id === late.fid)!;
    expect(lateRow).toMatchObject({ why_not_work: null, better_times: null, erase_by: null });
    expect(lateRow.answers_erased_at).not.toBeNull();
    expect(rows.find((r: any) => r.followup_id === fresh.fid)).toMatchObject({ why_not_work: WHY, better_times: TIMES, answers_erased_at: null });
    const exp = await q(`select * from public.export_waitlist_decline_answers($1,$2,null,1000)`, [f.studioId, f.userId]);
    expect(exp).toHaveLength(2);
    const lateExp = exp.find((r: any) => r.answer_id === late.fid)!;
    expect(lateExp).toMatchObject({ why_not_work: null, better_times: null });
    expect(lateExp.answers_erased_at).not.toBeNull();
    expect(exp.find((r: any) => r.answer_id === fresh.fid)).toMatchObject({ why_not_work: WHY, answers_erased_at: null });
    // The text is still physically there until the job runs (suppression is computed at read time).
    expect((await answer(late.fid)).why_not_work).toBe(WHY);
    await run();
    expect((await answer(late.fid)).why_not_work).toBeNull();
    // Closed and overdue: no longer listed, same as erased.
    const closedLate = await declined(f, "r5c", "2 days");
    await close(closedLate.fid, "31 days");
    const after = await q(`select * from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]);
    expect(after.find((r: any) => r.followup_id === closedLate.fid)).toBeUndefined();
  });

  it("non-owner and other-studio callers still get nothing", async () => {
    const f = await seed("r6");
    const g = await seed("r6b");
    await declined(f, "r6a", "91 days");
    expect(await q(`select * from public.read_waitlist_followups($1,$2,null)`, [f.studioId, g.userId])).toHaveLength(0);
    expect(await q(`select * from public.export_waitlist_decline_answers($1,$2,null,1000)`, [f.studioId, g.userId])).toHaveLength(0);
  });
});

describe("the job: idempotent, bounded, one bad row never blocks the rest", () => {
  it("a retry changes nothing and writes no second record", async () => {
    const f = await seed("r7");
    const d = await declined(f, "r7a", "95 days");
    await run();
    const first = await answer(d.fid);
    const again = await run();
    expect(again.erased_answers).toBeGreaterThanOrEqual(0);
    expect((await answer(d.fid)).erased_at).toEqual(first.erased_at);
    expect(await records(d.fid)).toHaveLength(1);
  });

  it("batches are bounded and report what remains; a bad batch size is refused value-free", async () => {
    await drain();
    const f = await seed("r8");
    const ds = [];
    for (let i = 0; i < 3; i++) ds.push(await declined(f, `r8-${i}`, "95 days"));
    const r1 = await run(2);
    expect(r1.erased_answers).toBe(2);
    expect(r1.remaining_answers).toBe(1);
    const r2 = await run(2);
    expect(r2.erased_answers).toBe(1);
    expect(r2.remaining_answers).toBe(0);
    for (const bad of [0, 1001, -5]) await expect(run(bad)).rejects.toMatchObject({ code: "22023" });
    await expect(q(`select * from public.run_waitlist_retention_cleanup(null)`)).rejects.toMatchObject({ code: "22023" });
  });

  it("one row that fails is skipped and counted; the others are erased; the bad row keeps its text and gets no record; the next run retries it", async () => {
    await drain();
    const f = await seed("r9");
    const good1 = await declined(f, "r9a", "95 days");
    const bad = await declined(f, "r9b", "95 days");
    const good2 = await declined(f, "r9c", "95 days");
    await q(`create or replace function public.test_0326_block_one() returns trigger language plpgsql as $$
             begin if old.followup_id = '${bad.fid}' then raise exception 'blocked for test'; end if; return new; end $$`);
    await q(`create trigger test_0326_block_one before update on public.waitlist_decline_answers for each row execute function public.test_0326_block_one()`);
    try {
      const r = await run();
      expect(r.failed_answers).toBe(1);
      expect(r.outcome).toBe("partial_failure");
      expect((await answer(good1.fid)).erased_at).not.toBeNull();
      expect((await answer(good2.fid)).erased_at).not.toBeNull();
      const b = await answer(bad.fid);
      expect(b.erased_at).toBeNull();
      expect(b.why_not_work).toBe(WHY);
      expect(await records(bad.fid)).toHaveLength(0);
    } finally {
      await q(`drop trigger if exists test_0326_block_one on public.waitlist_decline_answers`);
      await q(`drop function if exists public.test_0326_block_one()`);
    }
    const retry = await run();
    expect(retry.failed_answers).toBe(0);
    expect((await answer(bad.fid)).erased_at).not.toBeNull();
    expect(await records(bad.fid)).toHaveLength(1);
  });

  it("a studio deleted before the job removes its answers and the job still runs clean", async () => {
    const f = await seed("r10");
    const d = await declined(f, "r10a", "95 days");
    await q(`delete from public.studios where id=$1`, [f.studioId]);
    expect(await q(`select 1 from public.waitlist_decline_answers where followup_id=$1`, [d.fid])).toHaveLength(0);
    const r = await run();
    expect(r.failed_answers).toBe(0);
  });
});

describe("purges: erase records, terminal outbox rows, run rows", () => {
  it("erase records are purged past 30 days (the PITR floor), not before", async () => {
    await drain();
    const f = await seed("p1");
    const mk = (ago: string) => q(`insert into public.waitlist_erase_records (studio_id, followup_id, kind, erased_at, reason)
      values ($1, gen_random_uuid(), 'decline', now() - $2::interval, 'retention') returning followup_id`, [f.studioId, ago]).then((r) => r[0].followup_id as string);
    const keep = await mk("29 days 23 hours");
    const gone = await mk("30 days 1 hour");
    const r = await run();
    expect(r.purged_erase_records).toBeGreaterThanOrEqual(1);
    expect(await q(`select 1 from public.waitlist_erase_records where followup_id=$1`, [keep])).toHaveLength(1);
    expect(await q(`select 1 from public.waitlist_erase_records where followup_id=$1`, [gone])).toHaveLength(0);
  });

  it("outbox rows: terminal states older than 90 days are purged; held and sending never are", async () => {
    await drain();
    const f = await seed("p2");
    const mkOut = async (label: string, status: string, ago: string) => {
      const e = await entry(f, label);
      await decline(await invite(f, e.id));
      const row = (await q(`select o.id from public.waitlist_decline_owner_emails o join public.waitlist_followups d on d.invitation_id = o.invitation_id where d.entry_id=$1`, [e.id]))[0];
      await q(`update public.waitlist_decline_owner_emails set status=$2, created_at = now() - $3::interval, sent_at = case when $2='sent' then now() - $3::interval end where id=$1`, [row.id, status, ago]);
      return row.id as string;
    };
    const sentOld = await mkOut("p2a", "sent", "91 days");
    const failedOld = await mkOut("p2b", "failed", "91 days");
    const sentNew = await mkOut("p2c", "sent", "89 days");
    const heldOld = await mkOut("p2d", "held", "200 days");
    const sendingOld = await mkOut("p2e", "sending", "200 days");
    await run();
    const present = async (id: string) => (await q(`select 1 from public.waitlist_decline_owner_emails where id=$1`, [id])).length === 1;
    expect(await present(sentOld)).toBe(false);
    expect(await present(failedOld)).toBe(false);
    expect(await present(sentNew)).toBe(true);
    expect(await present(heldOld)).toBe(true);
    expect(await present(sendingOld)).toBe(true);
  });
});

describe("the run log and the health read", () => {
  it("records a success run, a failure on request, and reports both; refuses an unknown class value-free", async () => {
    await drain();
    const r = await run();
    expect(r.outcome).toBe("success");
    const h1 = (await q(`select * from public.waitlist_retention_health()`))[0];
    expect(h1.last_outcome).toBe("success");
    expect(h1.last_success_at).not.toBeNull();
    expect(h1.overdue_unerased_count).toBe(0);
    expect(h1.oldest_overdue_age_hours).toBeNull();
    const fid = (await q(`select public.record_waitlist_retention_failure('route_error') as id`))[0].id;
    expect(fid).toBeTruthy();
    const h2 = (await q(`select * from public.waitlist_retention_health()`))[0];
    expect(h2.last_outcome).toBe("failed");
    expect(new Date(h2.last_success_at).getTime()).toBeLessThanOrEqual(new Date(h2.last_run_at).getTime());
    await expect(q(`select public.record_waitlist_retention_failure('some free text')`)).rejects.toMatchObject({ code: "22023" });
    const row = (await q(`select * from public.waitlist_retention_runs where id=$1`, [fid]))[0];
    expect(row).toMatchObject({ outcome: "failed", error_class: "route_error", erased_answers: 0 });
    // Counts and class codes only: no free-text column exists.
    const cols = (await q(`select column_name from information_schema.columns where table_name='waitlist_retention_runs'`)).map((c: any) => c.column_name);
    expect(cols.sort()).toEqual(["erased_answers","error_class","failed_answers","finished_at","id","outcome","purged_erase_records","purged_outbox","purged_runs","remaining_answers","remaining_erase_records","remaining_outbox","started_at"]);
  });

  it("health counts held or sending outbox rows older than 24 hours, as a number only", async () => {
    const f = await seed("h2");
    const before = (await q(`select stuck_held_outbox_count c from public.waitlist_retention_health()`))[0].c;
    const e = await entry(f, "h2a");
    await decline(await invite(f, e.id));
    const id = (await q(`select o.id from public.waitlist_decline_owner_emails o join public.waitlist_followups d on d.invitation_id = o.invitation_id where d.entry_id=$1`, [e.id]))[0].id;
    expect((await q(`select stuck_held_outbox_count c from public.waitlist_retention_health()`))[0].c).toBe(before); // fresh: not stuck
    await q(`update public.waitlist_decline_owner_emails set created_at = now() - interval '25 hours' where id=$1`, [id]);
    expect((await q(`select stuck_held_outbox_count c from public.waitlist_retention_health()`))[0].c).toBe(before + 1);
    await q(`update public.waitlist_decline_owner_emails set status='sent', sent_at=now() where id=$1`, [id]);
    expect((await q(`select stuck_held_outbox_count c from public.waitlist_retention_health()`))[0].c).toBe(before);
  });

  it("health counts an overdue answer and its age before the job runs", async () => {
    await drain();
    const f = await seed("h1");
    await declined(f, "h1a", "91 days");
    const h = (await q(`select * from public.waitlist_retention_health()`))[0];
    expect(h.overdue_unerased_count).toBeGreaterThanOrEqual(1);
    expect(Number(h.oldest_overdue_age_hours)).toBeGreaterThan(0);
  });
});

describe("grants", () => {
  it("only service_role executes the three commands and the two reads; nobody executes the helper; the log table is unreachable", async () => {
    const fns = [
      "run_waitlist_retention_cleanup(integer)", "record_waitlist_retention_failure(text)", "waitlist_retention_health()",
      "read_waitlist_followups(uuid,uuid,uuid)", "export_waitlist_decline_answers(uuid,uuid,uuid,integer)",
    ];
    for (const fn of fns) {
      const r = await q(`select has_function_privilege('anon', $1::regprocedure, 'execute') a, has_function_privilege('authenticated', $1::regprocedure, 'execute') u,
                                 has_function_privilege('service_role', $1::regprocedure, 'execute') s, has_function_privilege('public', $1::regprocedure, 'execute') p`, ["public." + fn]);
      expect(r[0], fn).toEqual({ a: false, u: false, s: true, p: false });
    }
    const h = await q(`select has_function_privilege('service_role', 'public.waitlist_answer_erase_by(uuid)'::regprocedure, 'execute') s,
                              has_function_privilege('authenticated', 'public.waitlist_answer_erase_by(uuid)'::regprocedure, 'execute') u`);
    expect(h[0]).toEqual({ s: false, u: false });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const t = await q(`select has_table_privilege($1, 'public.waitlist_retention_runs', 'select,insert,update,delete') x`, [role]);
      expect(t[0].x).toBe(false);
    }
    // And it works as service_role end to end.
    const out = await adminTx(async (tq) => {
      await tq("set local role service_role");
      return tq(`select outcome from public.run_waitlist_retention_cleanup(10)`);
    });
    expect(out.rows[0].outcome).toMatch(/success|partial_failure/);
  });
});

const root = join(__dirname, "..", "..", "supabase");
const up = readFileSync(join(root, "migrations", "0326_waitlist_retention_cleanup.sql"), "utf8");
const down = readFileSync(join(root, "rollbacks", "0326_waitlist_retention_cleanup.down.sql"), "utf8");
const bodyMd5 = (name: string) => q(`select md5(prosrc) m from pg_proc where proname=$1 and pronamespace='public'::regnamespace`, [name]).then((r) => r[0]?.m as string | undefined);

describe("the down file", () => {
  it("restores 0325's two reads exactly, keeps every erase record and the run log, and up re-applies cleanly", async () => {
    const m25 = readFileSync(join(root, "migrations", "0325_waitlist_decline_followups.sql"), "utf8");
    expect(down).not.toMatch(/drop table/i);
    expect(down).not.toMatch(/delete from/i);
    expect(m25).toContain("create or replace function public.read_waitlist_followups(");
    const keptBefore = (await q(`select count(*)::int n from public.waitlist_erase_records`))[0].n;
    const readNew = await bodyMd5("read_waitlist_followups");
    try {
      await q(down);
      expect(await bodyMd5("read_waitlist_followups")).not.toBe(readNew);
      expect(await bodyMd5("run_waitlist_retention_cleanup")).toBeUndefined();
      expect((await q(`select count(*)::int n from public.waitlist_erase_records`))[0].n).toBe(keptBefore);
      expect((await q(`select to_regclass('public.waitlist_retention_runs') is not null as t`))[0].t).toBe(true);
    } finally {
      await q(up);
    }
    expect(await bodyMd5("read_waitlist_followups")).toBe(readNew);
    expect(await bodyMd5("run_waitlist_retention_cleanup")).toBeDefined();
  });
});
