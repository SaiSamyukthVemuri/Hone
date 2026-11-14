import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await adminQuery(text, params)).rows as T[];
afterAll(async () => {
  await closePool();
});

// A withdrawal after an earlier decline with a different scope is reachable: the already-declined rule (already_declined_offer, 0192)
// is per scope, so the same offer cannot be re-issued after a decline, but a different scope can.
// Synthetic data only.

const WHY = "WhyMarkB14 the times clash";
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("withdrawal after an earlier decline (different scope)", () => {
  it("a second, different offer after a decline can be issued, and withdrawing from it is recorded without touching the earlier answers", async () => {
    const s = await seedStudio("b14");
    const svc = await q<{ id: string }>(
      `insert into public.services (studio_id,name,default_duration_minutes,active,modality) values ($1,'Consultation',30,true,'consultation') returning id`,
      [s.studioId],
    );
    await q(`update auth.users set email_confirmed_at = now() where id = $1`, [s.userId]);
    await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
    const e = await q(`select * from public.create_practitioner_waitlist_entry($1,$2,'B14 Person',$3,null,null)`, [s.studioId, s.userId, `b14-${s.studioId.slice(0, 8)}@example.com`]);
    const entryId = e[0].entry_id as string;

    const issue = async (from: number, to: number) => {
      const a = await q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,5)`, [s.studioId, s.userId, entryId, svc[0].id, day(from), day(to)]);
      return a[0];
    };
    const proof = async (raw: string) => {
      const b = await q(`select * from public.begin_waitlist_invitation_proof($1,20)`, [raw]);
      const c = await q(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [raw, b[0].raw_challenge]);
      return c[0].raw_capability as string;
    };

    // Offer A, declined with answers.
    const a1 = await issue(1, 30);
    expect(a1.result).toBe("admitted");
    const capA = await proof(a1.raw_token);
    const d = await q(`select * from public.decline_waitlist_invitation_with_answers($1,$2,$3,'TimesMarkB14')`, [a1.raw_token, capA, WHY]);
    expect(d[0].result).toBe("declined");

    // While the decline follow-up is open, a new offer waits for the owner; the owner closes it (Mark handled), which returns the entry to the normal flow.
    const pending = await issue(2, 40);
    expect(pending.result).toBe("pending_owner_review");
    const fu = await q<{ id: string }>(`select id from public.waitlist_followups where entry_id = $1 and kind = 'decline'`, [entryId]);
    const h = await q(`select * from public.mark_waitlist_decline_handled($1,$2,$3)`, [s.studioId, s.userId, fu[0].id]);
    expect(h[0].result).toBe("handled");

    // The SAME scope is refused (the already-declined rule) ...
    const same = await issue(1, 30);
    expect(same.result).toBe("already_declined_offer");
    // ... a DIFFERENT scope is allowed.
    const a2 = await issue(2, 40);
    expect(a2.result).toBe("admitted");
    const capB = await proof(a2.raw_token);

    const w = await q(`select * from public.request_waitlist_withdrawal($1,$2)`, [a2.raw_token, capB]);
    expect(w[0].result).toBe("recorded");

    // Two follow-ups for the entry: the decline (with answers, still unerased) and the new withdrawal.
    const fus = await q<{ kind: string; status: string }>(`select kind, status from public.waitlist_followups where entry_id = $1 order by opened_at`, [entryId]);
    expect(fus.map((f) => f.kind)).toEqual(["decline", "withdrawal"]);
    const ans = await q(`select why_not_work, erased_at from public.waitlist_decline_answers where studio_id = $1`, [s.studioId]);
    expect(ans).toHaveLength(1);
    expect(ans[0].why_not_work).toBe(WHY);
    expect(ans[0].erased_at).toBeNull();
    await q(`delete from public.studios where id = $1`, [s.studioId]);
  });

  it("a random well-formed token with any capability gets the neutral 'recorded'", async () => {
    const r = await q(`select * from public.request_waitlist_withdrawal($1,$2)`, ["c".repeat(64), "d".repeat(64)]);
    expect(r[0].result).toBe("recorded");
  });
});
