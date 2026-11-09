import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool, seedStudio } from "./helpers/harness";
import { runRetentionCleanup, type RetentionRpcClient } from "@/lib/waitlist/retention-cleanup";
import { evaluateRetentionHealth, parseRetentionHealth } from "@/lib/waitlist/retention-health";

// #1413: the APP's calls against the REAL 0326 functions. Willow's suite proves what the functions do; this proves the app's loop, its row parsing,
// its alert rules and its failure record accept what they really return. Synthetic data only. Each case drains first so its counts are its own.

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await adminQuery(text, params)).rows as T[];
afterAll(async () => {
  await closePool();
});

const ARG: Record<string, string[]> = { run_waitlist_retention_cleanup: ["p_batch_size"], record_waitlist_retention_failure: ["p_error_class"] };
/** The admin client's rpc, over SQL: named arguments, one row set back, a Postgres error code on failure (as PostgREST reports it). */
const rpc: RetentionRpcClient["rpc"] = async (fn, args = {}) => {
  try {
    const names = ARG[fn] ?? [];
    const rows = await q(`select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`, names.map((n) => args[n]));
    // pg returns timestamptz as a Date; PostgREST returns the ISO string the app reads
    return { data: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), error: null };
  } catch (e) {
    return { data: null, error: { code: (e as { code?: string }).code } };
  }
};
const client: RetentionRpcClient = { rpc };

async function seed(label: string) {
  const s = await seedStudio(`app-${label}`);
  const svc = await q<{ id: string }>(`insert into public.services (studio_id,name,default_duration_minutes,active,modality) values ($1,'Consultation',30,true,'consultation') returning id`, [s.studioId]);
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [s.userId]);
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}
async function declined(f: Awaited<ReturnType<typeof seed>>, label: string, submittedAgo: string) {
  const e = await q(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [f.studioId, f.userId, `AppMark ${label}`, `appmark-${label}-${f.studioId.slice(0, 8)}@example.com`]);
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,5)`, [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to]);
  const b = await q(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
  const c = await q(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge]);
  await q(`select * from public.decline_waitlist_invitation_with_answers($1,$2,$3,$4)`, [a[0].raw_token, c[0].raw_capability, "WhyMarkApp clash", "TimesMarkApp mornings"]);
  const fid = (await q(`select id from public.waitlist_followups where entry_id=$1 and kind='decline'`, [e[0].entry_id]))[0].id as string;
  await q(`update public.waitlist_decline_answers set submitted_at = now() - $2::interval where followup_id=$1`, [fid, submittedAgo]);
  return fid;
}
const answer = async (fid: string) => (await q(`select why_not_work, erased_at from public.waitlist_decline_answers where followup_id=$1`, [fid]))[0];
const health = async () => parseRetentionHealth((await rpc("waitlist_retention_health")).data);
const drain = () => runRetentionCleanup(client);

describe("the app's calls against the real 0326 functions", () => {
  it("the health read parses (numeric arrives as a string), and an answer 2 days overdue raises the overdue alert and nothing else", async () => {
    await drain();
    const f = await seed("h1");
    await declined(f, "h1", "92 days");
    const h = await health();
    expect(h).not.toBeNull();
    expect(h!.overdueUnerasedCount).toBeGreaterThanOrEqual(1);
    expect(h!.oldestOverdueAgeHours).toBeGreaterThan(24);
    const found = evaluateRetentionHealth({ ...h!, lastSuccessAt: new Date().toISOString(), lastOutcome: "success" }, Date.now(), { stuckOwnerEmails: null }).findings;
    expect(found.map((x) => x.kind)).toEqual(["overdue"]);
    await drain();
  });

  it("an answer 3 hours overdue is NOT an alert (the pre-10:00 normal case)", async () => {
    await drain();
    const f = await seed("h2");
    await declined(f, "h2", "90 days 3 hours");
    const h = await health();
    expect(h!.overdueUnerasedCount).toBeGreaterThanOrEqual(1);
    expect(h!.oldestOverdueAgeHours!).toBeLessThan(24);
    expect(evaluateRetentionHealth({ ...h!, lastSuccessAt: new Date().toISOString(), lastOutcome: "success" }, Date.now(), { stuckOwnerEmails: null }).findings).toEqual([]);
    await drain();
  });

  it("the loop erases an overdue row through the real function, reports counts only, and leaves nothing overdue", async () => {
    await drain();
    const f = await seed("c1");
    const fid = await declined(f, "c1", "95 days");
    const tick = await runRetentionCleanup(client);
    expect(tick).toMatchObject({ ok: true, partialFailure: false, remaining: 0, stoppedEarly: false });
    expect(tick.ok && "counts" in tick && tick.counts.erasedAnswers).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(tick)).not.toMatch(/AppMark|WhyMark|TimesMark/);
    expect(await answer(fid)).toMatchObject({ why_not_work: null });
    expect((await answer(fid)).erased_at).not.toBeNull();
    const h = await health();
    expect(h).toMatchObject({ overdueUnerasedCount: 0, lastOutcome: "success", lastFailedCount: 0 });
    expect(h!.lastSuccessAt).not.toBeNull();
  });

  it("a read of an overdue, not-yet-erased answer shows no text; the owner export returns the same suppression", async () => {
    await drain();
    const f = await seed("r1");
    const fid = await declined(f, "r1", "95 days");
    const rows = await q(`select * from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]);
    const mine = rows.find((r) => r.followup_id === fid);
    expect(mine).toBeDefined();
    expect(JSON.stringify(mine)).not.toMatch(/WhyMarkApp|TimesMarkApp/);
    expect(mine.answers_erased_at).not.toBeNull(); // the X5 shape: set to the deadline although the job has not run
    expect((await answer(fid)).erased_at).toBeNull(); // ...so "erased" would overclaim, and the owner copy says "removed from view"
    const exp = await q(`select * from public.export_waitlist_decline_answers($1,$2,null,1000)`, [f.studioId, f.userId]);
    expect(JSON.stringify(exp)).not.toMatch(/WhyMarkApp|TimesMarkApp/);
    await drain();
  });

  it("a row that will not erase gives partial_failure through the loop: counted, accepted, retried next tick", async () => {
    await drain();
    const f = await seed("p1");
    const bad = await declined(f, "p1b", "95 days");
    await declined(f, "p1g", "95 days");
    await q(`create or replace function public.test_1413_block_one() returns trigger language plpgsql as $$
             begin if old.followup_id = '${bad}' then raise exception 'blocked for test'; end if; return new; end $$`);
    await q(`create trigger test_1413_block_one before update on public.waitlist_decline_answers for each row execute function public.test_1413_block_one()`);
    try {
      const tick = await runRetentionCleanup(client);
      expect(tick).toMatchObject({ ok: true, partialFailure: true, stoppedEarly: true });
      expect(tick.ok && "counts" in tick && tick.counts.failedAnswers).toBe(1);
      expect(tick.ok && "counts" in tick && tick.counts.erasedAnswers).toBeGreaterThanOrEqual(1);
      const h = await health();
      expect(h).toMatchObject({ lastOutcome: "partial_failure", lastFailedCount: 1 });
      expect(evaluateRetentionHealth(h!, Date.now(), { stuckOwnerEmails: null }).findings.map((x) => x.kind)).toContain("failed");
    } finally {
      await q(`drop trigger if exists test_1413_block_one on public.waitlist_decline_answers`);
      await q(`drop function if exists public.test_1413_block_one()`);
    }
    expect(await runRetentionCleanup(client)).toMatchObject({ ok: true, partialFailure: false });
    expect((await answer(bad)).erased_at).not.toBeNull();
  });

  it("the failure record: each class the app sends is accepted, shows as a failed last outcome, and a bad class is refused", async () => {
    await drain();
    for (const cls of ["exception", "timeout", "route_error", "unknown"]) {
      expect((await rpc("record_waitlist_retention_failure", { p_error_class: cls })).error).toBeNull();
      const h = await health();
      expect(h).toMatchObject({ lastOutcome: "failed" });
      expect(evaluateRetentionHealth({ ...h!, lastSuccessAt: new Date().toISOString() }, Date.now(), { stuckOwnerEmails: null }).findings.map((x) => x.kind)).toEqual(["failed"]);
    }
    expect((await rpc("record_waitlist_retention_failure", { p_error_class: "free text with a name" })).error).not.toBeNull();
    await drain(); // a successful run clears the failed last outcome
    expect(await health()).toMatchObject({ lastOutcome: "success" });
  });

  it("only service_role can call the three functions the app uses", async () => {
    await asRole("service_role", async (query) => {
      expect((await query(`select * from public.waitlist_retention_health()`)).rows).toHaveLength(1);
    });
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(role, (query) => query(`select * from public.waitlist_retention_health()`))).rejects.toMatchObject({ code: "42501" });
    }
  });
});
