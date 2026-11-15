import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0327 -- the owner read shows a WITHDRAWAL row exactly the answer waitlist_answer_erase_by binds it to.
// ===========================================================================
//
// THE BUG (found in Sam's production retest): withdraw -> Keep on the waitlist -> invite again (new window) -> decline with answers. The
// later decline's answers ALSO appeared on the earlier withdrawal card, because the read took the entry's newest decline answer for any
// withdrawal row with no bound on when it opened. waitlist_answer_erase_by binds a withdrawal to the latest decline answer submitted at or
// before the withdrawal opened (submitted_at desc, followup_id desc).
//
// THE ORACLE IS NOT THE ROW'S OWN DATE. A check that "the printed erase_by equals the shown answer's erase_by" passes with the bug (the read
// prints the date of whatever answer it chose). So, for EVERY withdrawal row the read returns, this file computes the binding independently
// (the helper's own subquery, run here) and asserts (1) the answer shown is that answer, by its unique text, (2) the printed erase_by is
// waitlist_answer_erase_by(that answer), and (3) with no binding there is no answer, no submitted_at and no erase_by.
//
// Re-run after 0328 so a rebuilt read cannot regress it.

// The 0325 round-trip and 0326 suites re-apply their own reads depending on file order; make sure the read under test is 0327's.
beforeAll(async () => {
  await adminQuery(readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0327_waitlist_followup_read_bound.sql"), "utf8"));
});

afterAll(async () => {
  await closePool();
});

let seq = 0;

async function seed(label: string) {
  const s = await seedStudio(`wb-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [s.userId]);
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}
type F = Awaited<ReturnType<typeof seed>>;

async function entry(f: F, label: string) {
  const e = await q(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [
    f.studioId, f.userId, `WbName ${label}`, `wb-${label}-${f.studioId.slice(0, 8)}@example.com`,
  ]);
  expect(e[0].result).toBe("created");
  return e[0].entry_id as string;
}

/** A NEW window every time: the same window declined twice is refused at issue (0192), which is a different rule. */
async function invite(f: F, entryId: string) {
  const days = 20 + seq++;
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

const latest = async (entryId: string, kind: "decline" | "withdrawal") =>
  (await q<{ id: string }>(`select id from public.waitlist_followups where entry_id=$1 and kind=$2 order by opened_at desc, id desc limit 1`, [entryId, kind]))[0].id;

/** Decline with answers carrying a unique text, then the owner marks it handled so the entry can be invited again. */
async function declineThenHandle(f: F, entryId: string, label: string, handle = true) {
  const t = await invite(f, entryId);
  const d = await q(`select * from public.decline_waitlist_invitation_with_answers($1,$2,$3,$4)`, [t.token, t.cap, `WHY-${label}`, `TIMES-${label}`]);
  expect(d[0].result).toBe("declined");
  const fid = await latest(entryId, "decline");
  if (handle) expect((await q(`select * from public.mark_waitlist_decline_handled($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("handled");
  return fid;
}

/** Withdraw, optionally Keep so the entry can be invited again. */
async function withdraw(f: F, entryId: string, keep = true) {
  const t = await invite(f, entryId);
  expect((await q(`select * from public.request_waitlist_withdrawal($1,$2)`, [t.token, t.cap]))[0].result).toBe("recorded");
  const fid = await latest(entryId, "withdrawal");
  if (keep) expect((await q(`select * from public.keep_waitlist_withdrawal($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("kept");
  return fid;
}

/** Pin the clock of one answer / one follow-up, in days before now, so order and ties are exactly what a case says. */
const answerAt = (fid: string, ago: string) => q(`update public.waitlist_decline_answers set submitted_at = now() - $2::interval where followup_id=$1`, [fid, ago]);
const openedAt = (fid: string, ago: string) => q(`update public.waitlist_followups set opened_at = now() - $2::interval where id=$1`, [fid, ago]);
const closedAt = (fid: string, ago: string) => q(`update public.waitlist_followups set closed_at = now() - $2::interval where id=$1 and closed_at is not null`, [fid, ago]);

/** The helper's own binding for a withdrawal, computed here with the helper's a3 subquery (0326 waitlist_answer_erase_by). */
const binding = async (withdrawalFid: string) =>
  (await q<{ followup_id: string }>(
    `select a3.followup_id
       from public.waitlist_decline_answers a3
       join public.waitlist_followups d3 on d3.id = a3.followup_id
       join public.waitlist_followups g on g.id = $1
      where d3.entry_id = g.entry_id and d3.studio_id = g.studio_id and d3.kind = 'decline'
        and a3.submitted_at <= g.opened_at
      order by a3.submitted_at desc, a3.followup_id desc
      limit 1`,
    [withdrawalFid],
  ))[0]?.followup_id ?? null;

const rowFor = async (f: F, fid: string) => {
  const inv = (await q<{ invitation_id: string }>(`select invitation_id from public.waitlist_followups where id=$1`, [fid]))[0].invitation_id;
  return (await q(`select * from public.read_waitlist_followups($1,$2,$3)`, [f.studioId, f.userId, inv])).find((r: any) => r.followup_id === fid);
};

/** THE ASSERTION: the row for this withdrawal shows the bound answer (by text), prints that answer's erase date, or shows nothing at all. */
async function expectBound(f: F, withdrawalFid: string) {
  const row = await rowFor(f, withdrawalFid);
  expect(row, "the withdrawal row was not returned").toBeTruthy();
  const bound = await binding(withdrawalFid);
  if (bound === null) {
    expect(row).toMatchObject({ why_not_work: null, better_times: null, submitted_at: null, erase_by: null });
    return;
  }
  const a = (await q(`select why_not_work, better_times, submitted_at from public.waitlist_decline_answers where followup_id=$1`, [bound]))[0];
  const eb = (await q(`select public.waitlist_answer_erase_by($1) as eb`, [bound]))[0].eb;
  expect(row.why_not_work).toBe(a.why_not_work);
  expect(row.better_times).toBe(a.better_times);
  expect(new Date(row.submitted_at).getTime()).toBe(new Date(a.submitted_at).getTime());
  expect(new Date(row.erase_by).getTime()).toBe(new Date(eb).getTime());
}

/** A decline row always shows its own answer. */
async function expectOwn(f: F, declineFid: string, label: string) {
  const row = await rowFor(f, declineFid);
  expect(row.why_not_work).toBe(`WHY-${label}`);
  expect(row.better_times).toBe(`TIMES-${label}`);
}

describe("0327: a withdrawal row shows the answer the retention helper binds it to", () => {
  it("1. THE BUG SEQUENCE: withdraw -> Keep -> invite again (new window) -> decline: the old withdrawal does NOT show the later answers", async () => {
    const f = await seed("s1");
    const e = await entry(f, "s1");
    const w = await withdraw(f, e); // a withdrawal with no earlier decline
    const d = await declineThenHandle(f, e, "s1d", false);
    await openedAt(w, "10 days");
    await closedAt(w, "9 days");
    await answerAt(d, "1 day");
    expect(await binding(w)).toBeNull();
    await expectBound(f, w);
    await expectOwn(f, d, "s1d");
    // 4 (folded in). The closed withdrawal has no answer to keep it visible, so it drops from the default list; the decline stays.
    const list = await q(`select followup_id from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]);
    expect(list.map((r: any) => r.followup_id)).not.toContain(w);
    expect(list.map((r: any) => r.followup_id)).toContain(d);
  });

  it("2. two declines before one withdrawal: the withdrawal shows the LATER of the two, each decline its own", async () => {
    const f = await seed("s2");
    const e = await entry(f, "s2");
    const d1 = await declineThenHandle(f, e, "s2a");
    const d2 = await declineThenHandle(f, e, "s2b");
    const w = await withdraw(f, e, false);
    await answerAt(d1, "20 days");
    await answerAt(d2, "15 days");
    await openedAt(w, "5 days");
    expect(await binding(w)).toBe(d2);
    await expectBound(f, w);
    expect((await rowFor(f, w)).why_not_work).toBe("WHY-s2b");
    await expectOwn(f, d1, "s2a");
    await expectOwn(f, d2, "s2b");
  });

  it("3. an equal submitted_at tie: the read and the helper pick the same answer (followup_id desc)", async () => {
    const f = await seed("s3");
    const e = await entry(f, "s3");
    const d1 = await declineThenHandle(f, e, "s3a");
    const d2 = await declineThenHandle(f, e, "s3b");
    const w = await withdraw(f, e, false);
    await q(`update public.waitlist_decline_answers set submitted_at = date_trunc('second', now() - interval '12 days') where followup_id in ($1,$2)`, [d1, d2]);
    await openedAt(w, "5 days");
    const b = await binding(w);
    expect(b).toBe([d1, d2].sort().reverse()[0]); // followup_id desc
    await expectBound(f, w);
    expect((await rowFor(f, w)).why_not_work).toBe(b === d1 ? "WHY-s3a" : "WHY-s3b");
  });

  it("4. a withdrawal with no earlier decline: no answer, null submitted_at and erase_by (open row stays; closed row drops from the default list)", async () => {
    const f = await seed("s4");
    const e = await entry(f, "s4");
    const w = await withdraw(f, e, false);
    await expectBound(f, w);
    expect(await binding(w)).toBeNull();
    let list = await q(`select followup_id from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]);
    expect(list.map((r: any) => r.followup_id)).toContain(w); // open: always listed
    await q(`select * from public.keep_waitlist_withdrawal($1,$2,$3)`, [f.studioId, f.userId, w]);
    await expectBound(f, w);
    list = await q(`select followup_id from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]);
    expect(list.map((r: any) => r.followup_id)).not.toContain(w);
  });

  it("5. a decline submitted AFTER the withdrawal opened is not shown on it, while an earlier one is", async () => {
    const f = await seed("s5");
    const e = await entry(f, "s5");
    const d0 = await declineThenHandle(f, e, "s5early");
    const w = await withdraw(f, e);
    const d1 = await declineThenHandle(f, e, "s5late", false);
    await answerAt(d0, "30 days");
    await openedAt(w, "10 days");
    await closedAt(w, "9 days");
    await answerAt(d1, "2 days");
    expect(await binding(w)).toBe(d0);
    await expectBound(f, w);
    expect((await rowFor(f, w)).why_not_work).toBe("WHY-s5early");
    await expectOwn(f, d1, "s5late");
  });
});

describe("0327: erased answers and decline rows", () => {
  it("N3. the bound EARLIER answer is erased: the withdrawal shows the erased marker, never the later decline's answers", async () => {
    const f = await seed("n3");
    const e = await entry(f, "n3");
    const d0 = await declineThenHandle(f, e, "n3early");
    const w = await withdraw(f, e);
    const d1 = await declineThenHandle(f, e, "n3late", false);
    await answerAt(d0, "30 days");
    await openedAt(w, "10 days");
    await closedAt(w, "9 days");
    await answerAt(d1, "2 days");
    // Erase ONLY the earlier answer (the owner's erase is entry-wide; this isolates the display rule).
    await q(`update public.waitlist_decline_answers set why_not_work = null, better_times = null, erased_at = now() - interval '1 day' where followup_id = $1`, [d0]);
    expect(await binding(w)).toBe(d0);
    const row = await rowFor(f, w);
    expect(row.why_not_work).toBeNull();
    expect(row.better_times).toBeNull();
    expect(row.answers_erased_at).not.toBeNull();
    expect(row.erase_by).toBeNull();
    expect(new Date(row.submitted_at).getTime()).toBe(new Date((await q(`select submitted_at from public.waitlist_decline_answers where followup_id=$1`, [d0]))[0].submitted_at).getTime());
    // The later decline still shows its own answers, unaffected.
    await expectOwn(f, d1, "n3late");
  });

  it("N2. DECLINE rows are identical before and after 0327, on the same fixture (only withdrawal rows can change)", async () => {
    const f = await seed("n2");
    const e = await entry(f, "n2");
    const d1 = await declineThenHandle(f, e, "n2a");
    const w1 = await withdraw(f, e);
    const d2 = await declineThenHandle(f, e, "n2b");
    const w2 = await withdraw(f, e); // Kept: an open withdrawal would hold the entry back from the next invitation
    const d3 = await declineThenHandle(f, e, "n2c", false);
    await answerAt(d1, "40 days");
    await openedAt(w1, "30 days");
    await closedAt(w1, "29 days");
    await answerAt(d2, "20 days");
    await openedAt(w2, "10 days");
    await closedAt(w2, "9 days");
    await answerAt(d3, "2 days");
    const all = () =>
      q(`select * from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]).then((r: any[]) => r.sort((x, y) => (x.followup_id < y.followup_id ? -1 : 1)));
    const declines = (rows: any[]) => rows.filter((r) => r.kind === "decline");
    const withdrawals = (rows: any[]) => rows.filter((r) => r.kind === "withdrawal");
    const after = await all();
    try {
      await adminQuery(downSql); // 0326's read
      const before = await all();
      expect(declines(before).length).toBe(3);
      expect(declines(after)).toEqual(declines(before)); // every column of every decline row
      // The change is real and confined to withdrawals: at least one withdrawal row differs.
      expect(JSON.stringify(withdrawals(after))).not.toBe(JSON.stringify(withdrawals(before)));
    } finally {
      await adminQuery(upSql);
    }
    expect(await all()).toEqual(after);
  });
});

// ---------------------------------------------------------------------------
// The files: one clause, ACL by name, md5 pins, the down restores 0326 byte for byte, and up / down / up on the real database.
// ---------------------------------------------------------------------------
const MIGRATIONS = join(__dirname, "..", "..", "supabase");
const upSql = readFileSync(join(MIGRATIONS, "migrations", "0327_waitlist_followup_read_bound.sql"), "utf8");
const downSql = readFileSync(join(MIGRATIONS, "rollbacks", "0327_waitlist_followup_read_bound.down.sql"), "utf8");
const sql0326 = readFileSync(join(MIGRATIONS, "migrations", "0326_waitlist_retention_cleanup.sql"), "utf8");
const LIVE_0326_MD5 = "bfff39742592fb6b4a3f43f9e2429417";
// Pinned as a LITERAL, not derived from the file, so a changed body cannot quietly move its own pin.
const NEW_0327_MD5 = "a1943da8ebdb12d8beb2be6f71ad8117";
const fnOf = (text: string) => {
  const a = text.indexOf("create or replace function public.read_waitlist_followups(");
  const b = text.indexOf("$$;", a) + 3;
  return text.slice(a, b);
};
const readMd5 = async () => (await q(`select md5(prosrc) as m from pg_proc where proname='read_waitlist_followups' and pronamespace='public'::regnamespace`))[0].m as string;

describe("0327 files", () => {
  it("the new body is 0326's body plus exactly one clause", () => {
    const a = fnOf(sql0326).split("\n");
    const b = fnOf(upSql).split("\n");
    expect(b.length).toBe(a.length);
    const changed = a.map((line, i) => [line, b[i]] as const).filter(([x, y]) => x !== y);
    expect(changed).toHaveLength(1);
    expect(changed[0][0]).toBe("           and (f.kind = 'decline' and d.id = f.id or f.kind = 'withdrawal')");
    expect(changed[0][1]).toBe("           and (f.kind = 'decline' and d.id = f.id or f.kind = 'withdrawal' and a2.submitted_at <= f.opened_at)");
  });

  it("the down restores 0326's function text byte for byte and pins its md5", () => {
    expect(fnOf(downSql)).toBe(fnOf(sql0326));
    expect(downSql).toContain(LIVE_0326_MD5);
    expect(upSql).toContain(LIVE_0326_MD5); // named in the header as the body being replaced
    expect(upSql).toContain(NEW_0327_MD5); // the self-check pins the new body
  });

  it("opens its own transaction with the lock timeout inside it, and restates the ACL by name (all four roles revoked, service_role granted)", () => {
    for (const text of [upSql, downSql]) {
      const begin = text.indexOf("\nbegin;");
      const lock = text.indexOf("set local lock_timeout = '5s';");
      const fn = text.indexOf("create or replace function public.read_waitlist_followups(");
      const commit = text.lastIndexOf("\ncommit;");
      expect(begin).toBeGreaterThan(-1);
      expect(lock).toBeGreaterThan(begin);
      expect(fn).toBeGreaterThan(lock);
      expect(commit).toBeGreaterThan(fn);
      expect(text).toContain("revoke all on function public.read_waitlist_followups(uuid, uuid, uuid) from public, anon, authenticated, service_role;");
      expect(text).toContain("grant execute on function public.read_waitlist_followups(uuid, uuid, uuid) to service_role;");
    }
  });

  it("statement inventory: one function replace, no DDL on tables, no DML, outside the function body", () => {
    const outside = upSql.replace(fnOf(upSql), "").replace(/do \$\$[\s\S]*?end \$\$;/, "");
    expect(outside).not.toMatch(/\b(insert|update|delete|truncate|alter\s+table|create\s+table|drop|create\s+index|create\s+trigger)\b/i);
    expect((upSql.match(/create or replace function/g) ?? []).length).toBe(1);
    expect(upSql).not.toContain("waitlist_answer_erase_by(uuid)\n"); // the retention helper is not redefined here
    expect(upSql).not.toMatch(/create or replace function public\.waitlist_answer_erase_by/);
  });
});

describe("0327 up / down / up on the real database", () => {
  it("the live read is 0327's after up, 0326's byte for byte after down, and 0327's again after the re-up; the ACL survives each", async () => {
    const aclOk = async () => {
      const r = (await q(
        `select has_function_privilege('anon', f, 'execute') as a, has_function_privilege('authenticated', f, 'execute') as u,
                has_function_privilege('service_role', f, 'execute') as s, has_function_privilege('public', f, 'execute') as p,
                (select prosecdef from pg_proc where oid = f) as d
           from (select to_regprocedure('public.read_waitlist_followups(uuid,uuid,uuid)') as f) x`,
      ))[0];
      expect(r).toMatchObject({ a: false, u: false, s: true, p: false, d: true });
    };
    const newMd5 = await readMd5();
    expect(newMd5).toBe(NEW_0327_MD5);
    expect(newMd5).not.toBe(LIVE_0326_MD5);
    await aclOk();
    try {
      await adminQuery(downSql);
      expect(await readMd5()).toBe(LIVE_0326_MD5);
      await aclOk();
    } finally {
      await adminQuery(upSql);
    }
    expect(await readMd5()).toBe(newMd5);
    await aclOk();
  });
});
