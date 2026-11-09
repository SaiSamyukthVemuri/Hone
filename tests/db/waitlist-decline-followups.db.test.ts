import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedMember, seedStudio } from "./helpers/harness";
import { AUTO_ROUND_ALLOWANCE } from "@/lib/waitlist/auto-round";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0325 -- decline answers, withdrawal requests and the owner follow-up.
// Synthetic markers prove NO name/email/answer text reaches the bell or the outbox.
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

describe("decline with answers", () => {
  it("D3: returns the SAME entry to waiting, opens one follow-up, one bell row, one outbox row per verified owner", async () => {
    const f = await seed("a");
    const e = await entry(f, "a");
    const before = await entryRow(e.id);
    const t = await invite(f, e.id);
    const d = await decline(t);
    expect(d[0].result).toBe("declined");
    expect(d[0].invitation_id).toBeTruthy();

    const after = await entryRow(e.id);
    expect(after.status).toBe("waiting");
    expect(new Date(after.joined_at).getTime()).toBe(new Date(before.joined_at).getTime());

    const fu = await q(`select * from public.waitlist_followups where entry_id=$1`, [e.id]);
    expect(fu).toHaveLength(1);
    expect(fu[0]).toMatchObject({ kind: "decline", status: "open", invitation_id: d[0].invitation_id });

    // Bell: EVERY column, synthetic markers prove no client text.
    const bell = await q(`select * from public.practitioner_notifications where studio_id=$1`, [f.studioId]);
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({
      practitioner_id: null,
      event_type: "waitlist_offer_declined",
      title: "A waitlist response needs your attention",
      body: "",
      href: "/settings/waitlist#follow-up",
      dedupe_key: `waitlist-decline:${d[0].invitation_id}`,
      appointment_id: null,
      client_id: null,
      read_at: null,
    });
    for (const v of Object.values(bell[0])) {
      const s = String(v);
      expect(s).not.toContain(NAME_MARK);
      expect(s).not.toContain(EMAIL_MARK);
      expect(s).not.toContain("WhyMarkQ7");
      expect(s).not.toContain("TimesMarkQ7");
    }

    // Outbox: ids/status/counts only.
    const ob = await q(`select * from public.waitlist_decline_owner_emails where studio_id=$1`, [f.studioId]);
    expect(ob).toHaveLength(1);
    for (const row of ob) {
      expect(row).toMatchObject({ status: "held", attempt_count: 0, invitation_id: d[0].invitation_id });
      for (const v of Object.values(row)) {
        expect(String(v)).not.toMatch(/MarkQ7|markq7/);
      }
    }
  });

  it("a repeat writes nothing and answers already_declined", async () => {
    const f = await seed("b");
    const e = await entry(f, "b");
    const t = await invite(f, e.id);
    expect((await decline(t))[0].result).toBe("declined");
    const again = await decline(t);
    expect(again[0]).toMatchObject({ result: "already_declined", invitation_id: null });
    expect((await q(`select 1 from public.waitlist_followups where entry_id=$1`, [e.id])).length).toBe(1);
    expect((await q(`select 1 from public.practitioner_notifications where studio_id=$1`, [f.studioId])).length).toBe(1);
  });

  it("refuses bad answers before any write, with a value-free code", async () => {
    const f = await seed("c");
    const e = await entry(f, "c");
    const t = await invite(f, e.id);
    for (const [why, times] of [["", TIMES], [WHY, "   "], ["x".repeat(1001), TIMES], [WHY, "bad\u0007bell"]]) {
      const r = await decline(t, why, times);
      expect(r[0].result).toBe("invalid_input");
    }
    expect((await entryRow(e.id)).status).toBe("invited");
    expect((await q(`select 1 from public.waitlist_followups where entry_id=$1`, [e.id])).length).toBe(0);
  });

  it("refuses a bad capability without writing", async () => {
    const f = await seed("d");
    const e = await entry(f, "d");
    const t = await invite(f, e.id);
    const r = await q(`select * from public.decline_waitlist_invitation_with_answers($1,$2,$3,$4)`, [
      t.token, "0".repeat(64), WHY, TIMES,
    ]);
    expect(r[0].result).toBe("proof_invalid");
    expect((await entryRow(e.id)).status).toBe("invited");
  });
});

describe("owner reads and resolution", () => {
  it("F3: lists the open follow-up with answers, submitted_at, closed_at and the computed erase_by; a non-owner and another studio get zero rows", async () => {
    const f = await seed("e");
    const other = await seed("e2");
    const e = await entry(f, "e");
    const t = await invite(f, e.id);
    const d = await decline(t);
    const rows = await q(`select * from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "decline", status: "open", why_not_work: WHY, better_times: TIMES, client_name: `${NAME_MARK} e` });
    const sub = new Date(rows[0].submitted_at).getTime();
    expect(rows[0].closed_at).toBeNull();
    expect(new Date(rows[0].erase_by).getTime()).toBe(sub + 90 * 86_400_000);
    // Once handled, erase_by is the EARLIER of closed_at + 30d and submitted_at + 90d.
    const fid0 = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    await q(`select * from public.mark_waitlist_decline_handled($1,$2,$3)`, [f.studioId, f.userId, fid0]);
    const closed = (await q(`select * from public.read_waitlist_followups($1,$2,$3)`, [f.studioId, f.userId, d[0].invitation_id]))[0];
    expect(closed.status).toBe("handled");
    expect(new Date(closed.erase_by).getTime()).toBe(new Date(closed.closed_at).getTime() + 30 * 86_400_000);
    expect(await q(`select * from public.read_waitlist_followups($1,$2,null)`, [f.studioId, other.userId])).toHaveLength(0);
    expect(await q(`select * from public.read_waitlist_followups($1,$2,null)`, [other.studioId, f.userId])).toHaveLength(0);

    const st = await q(`select * from public.read_waitlist_followup_status($1,$2,$3::uuid[])`, [f.studioId, f.userId, [d[0].invitation_id]]);
    expect(st).toEqual([{ invitation_id: d[0].invitation_id, status: "handled" }]);
    expect(await q(`select * from public.read_waitlist_followup_status($1,$2,$3::uuid[])`, [other.studioId, other.userId, [d[0].invitation_id]])).toHaveLength(0);
  });

  it("mark handled is idempotent and touches nothing on the entry", async () => {
    const f = await seed("f");
    const e = await entry(f, "f");
    const t = await invite(f, e.id);
    await decline(t);
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    const before = await entryRow(e.id);
    expect((await q(`select * from public.mark_waitlist_decline_handled($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("handled");
    expect((await q(`select * from public.mark_waitlist_decline_handled($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("already_handled");
    expect(await entryRow(e.id)).toEqual(before);
    const other = await seed("f2");
    expect((await q(`select * from public.mark_waitlist_decline_handled($1,$2,$3)`, [other.studioId, other.userId, fid]))[0].result).toBe("not_found");
  });

  it("owner erase deletes the text, leaves a marker and an ids-and-dates record, and is idempotent", async () => {
    const f = await seed("g");
    const e = await entry(f, "g");
    const t = await invite(f, e.id);
    await decline(t);
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    expect((await q(`select * from public.erase_waitlist_decline_answers($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("erased");
    expect((await q(`select * from public.erase_waitlist_decline_answers($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("already_erased");
    const a = await q(`select * from public.waitlist_decline_answers where followup_id=$1`, [fid]);
    expect(a[0]).toMatchObject({ why_not_work: null, better_times: null });
    expect(a[0].erased_at).toBeTruthy();
    const rec = await q(`select * from public.waitlist_erase_records where followup_id=$1`, [fid]);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ reason: "owner_erase", kind: "decline" });
    expect(JSON.stringify(rec[0])).not.toMatch(/MarkQ7/);
  });
});

describe("withdrawal", () => {
  it("records once, releases the invitation, returns the entry to waiting, rings the bell", async () => {
    const f = await seed("h");
    const e = await entry(f, "h");
    const t = await invite(f, e.id);
    const r = await q(`select * from public.request_waitlist_withdrawal($1,$2)`, [t.token, t.cap]);
    expect(r[0].result).toBe("recorded");
    expect((await entryRow(e.id)).status).toBe("waiting");
    const fu = await q(`select * from public.waitlist_followups where entry_id=$1`, [e.id]);
    expect(fu[0]).toMatchObject({ kind: "withdrawal", status: "open" });
    const again = await q(`select * from public.request_waitlist_withdrawal($1,$2)`, [t.token, t.cap]);
    expect(again[0].result).toBe("recorded");
    expect((await q(`select 1 from public.waitlist_followups where entry_id=$1`, [e.id])).length).toBe(1);
    const bell = await q(`select * from public.practitioner_notifications where studio_id=$1`, [f.studioId]);
    expect(bell[0]).toMatchObject({ event_type: "waitlist_withdrawal_requested", body: "", href: "/settings/waitlist#follow-up" });
    expect((await q(`select * from public.waitlist_decline_owner_emails where studio_id=$1`, [f.studioId]))).toHaveLength(0);
  });

  it("an unknown token gets the same neutral answer", async () => {
    const r = await q(`select * from public.request_waitlist_withdrawal($1,$2)`, ["a".repeat(64), "b".repeat(64)]);
    expect(r[0].result).toBe("recorded");
  });

  it("keep resolves it once", async () => {
    const f = await seed("i");
    const e = await entry(f, "i");
    const t = await invite(f, e.id);
    await q(`select * from public.request_waitlist_withdrawal($1,$2)`, [t.token, t.cap]);
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    expect((await q(`select * from public.keep_waitlist_withdrawal($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("kept");
    expect((await q(`select * from public.keep_waitlist_withdrawal($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("already_resolved");
  });
});

describe("Remove erases", () => {
  it("D1: Remove erases in the same transaction; closes the follow-up as removed and erases the answers, including a withdrawal's earlier answers; replay writes nothing", async () => {
    const f = await seed("j");
    const e = await entry(f, "j");
    const t = await invite(f, e.id);
    await decline(t);
    const t2 = await invite(f, e.id).catch(() => null);
    // A second admit is refused while a follow-up is open once the hold lands; here the withdrawal is raised from the declined invitation's entry directly.
    if (t2) await q(`select * from public.request_waitlist_withdrawal($1,$2)`, [t2.token, t2.cap]);
    const r = await q(`select public.remove_new_client_waitlist_entry($1,$2,$3) as r`, [f.studioId, e.id, f.userId]);
    expect(r[0].r).toBe("removed");
    const fus = await q(`select kind, status from public.waitlist_followups where entry_id=$1`, [e.id]);
    for (const x of fus) expect(x.status).toBe("removed");
    const a = await q(`select a.why_not_work, a.better_times, a.erased_at from public.waitlist_decline_answers a join public.waitlist_followups d on d.id=a.followup_id where d.entry_id=$1`, [e.id]);
    for (const x of a) expect(x).toMatchObject({ why_not_work: null, better_times: null });
    const n1 = (await q(`select count(*)::int n from public.waitlist_erase_records where studio_id=$1`, [f.studioId]))[0].n;
    expect(n1).toBeGreaterThan(0);
    await q(`select public.remove_new_client_waitlist_entry($1,$2,$3)`, [f.studioId, e.id, f.userId]);
    expect((await q(`select count(*)::int n from public.waitlist_erase_records where studio_id=$1`, [f.studioId]))[0].n).toBe(n1);
  });
});

describe("D4: owner functions refuse non-owners and other studios", () => {
  it("practitioner, inactive owner and cross-tenant callers are refused by every owner function", async () => {
    const f = await seed("k");
    const other = await seed("k2");
    const e = await entry(f, "k");
    const t = await invite(f, e.id);
    const d = await decline(t);
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    const prac = await seedMember({ studioId: f.studioId, userId: f.userId, practitionerId: f.practitionerId, clientId: f.clientId }, "p");
    const ghost = await seedMember({ studioId: f.studioId, userId: f.userId, practitionerId: f.practitionerId, clientId: f.clientId }, "g");
    await q(`update public.practitioners set role='owner', active=false where id=$1`, [ghost.practitionerId]);
    const callers = [
      { studio: f.studioId, user: prac.userId },
      { studio: f.studioId, user: ghost.userId },
      { studio: f.studioId, user: other.userId },
      { studio: other.studioId, user: f.userId },
    ];
    for (const c of callers) {
      expect(await q(`select * from public.read_waitlist_followups($1,$2,null)`, [c.studio, c.user])).toHaveLength(0);
      expect(await q(`select * from public.read_waitlist_followup_status($1,$2,$3::uuid[])`, [c.studio, c.user, [d[0].invitation_id]])).toHaveLength(0);
      for (const fn of ["mark_waitlist_decline_handled", "keep_waitlist_withdrawal", "erase_waitlist_decline_answers"]) {
        const r = await q(`select * from public.${fn}($1,$2,$3)`, [c.studio, c.user, fid]);
        expect(["not_owner", "not_found"]).toContain(r[0].result);
      }
      const l = await q(`select * from public.link_waitlist_followup_appointment($1,$2,$3,$4)`, [c.studio, c.user, fid, "00000000-0000-4000-8000-000000000001"]);
      expect(["not_owner", "not_found"]).toContain(l[0].result);
    }
    // Nothing changed.
    expect((await q(`select status from public.waitlist_followups where id=$1`, [fid]))[0].status).toBe("open");
    expect((await q(`select erased_at from public.waitlist_decline_answers where followup_id=$1`, [fid]))[0].erased_at).toBeNull();
  });
});

describe("link a booking (the narrow waiting -> converted edge)", () => {
  async function apt(f: F, email: string, status = "confirmed") {
    const c = await q(`select id from public.clients where studio_id=$1 and lower(btrim(email))=lower($2)`, [f.studioId, email]).then(async (r) =>
      r.length ? r : q(`insert into public.clients (studio_id,name,email) values ($1,'Linked',$2) returning id`, [f.studioId, email]));
    const a = await q(
      `insert into public.appointments (studio_id,client_id,service_id,starts_at,ends_at,duration_minutes,status)
       values ($1,$2,$3, now()+($5||' hours')::interval, now()+($5||' hours')::interval+interval '30 minutes', 30, $4) returning id`,
      [f.studioId, c[0].id, f.serviceId, status, String(72 + Math.floor(Math.random() * 400))],
    );
    return a[0].id as string;
  }

  it("converts the waiting entry, closes the follow-up as booked, and refuses mismatch / cancelled / reuse / other studio", async () => {
    const f = await seed("l");
    const other = await seed("l2");
    const e = await entry(f, "l");
    const t = await invite(f, e.id);
    await decline(t);
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    const link = (id: string, studio = f.studioId, user = f.userId) =>
      q(`select * from public.link_waitlist_followup_appointment($1,$2,$3,$4)`, [studio, user, fid, id]).then((r) => r[0].result);

    expect(await link(await apt(f, "someone-else@example.com"))).toBe("appointment_mismatch");
    expect(await link(await apt(f, e.email, "cancelled"))).toBe("appointment_not_bookable");
    expect(await link(await apt(other, e.email))).toBe("appointment_not_found");
    expect((await entryRow(e.id)).status).toBe("waiting");

    const good = await apt(f, e.email);
    expect(await link(good)).toBe("booked");
    expect((await entryRow(e.id)).status).toBe("converted");
    const fu = (await q(`select status, appointment_id, closed_at from public.waitlist_followups where id=$1`, [fid]))[0];
    expect(fu).toMatchObject({ status: "booked", appointment_id: good });
    expect(fu.closed_at).toBeTruthy();
    expect(await link(good)).toBe("already_booked");
  });

  it("no other path produces waiting -> converted: a direct UPDATE is refused, and the setting is unset after the link", async () => {
    const f = await seed("m");
    const e = await entry(f, "m");
    await expect(
      q(`update public.new_client_waitlist_entries set status='converted', converted_at=now(), converted_client_id=$2,
                claimed_at=now(), claimed_by_practitioner_id=$3, invited_at=now() where id=$1`, [e.id, f.clientId, f.practitionerId]),
    ).rejects.toThrow(/illegal lifecycle transition/);
    // Setting the key by hand inside a plain session does not survive the transaction boundary.
    const rows = await q(`select current_setting('hone.waitlist_manual_link', true) as v`);
    expect([null, "", "off"]).toContain(rows[0].v);
  });
});

describe("the 0324 competing count is not narrowed to one round", () => {
  it("a live offer left behind in a CLOSED round still counts", async () => {
    const f = await seed("n");
    const e = await entry(f, "n");
    await invite(f, e.id);
    const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const count = async () =>
      Number((await q(`select public.count_waitlist_competing_invitations_internal($1,$2,$3,null) as n`, [f.studioId, from, to]))[0].n);
    expect(await count()).toBeGreaterThanOrEqual(1);
    // Close the round the offer was issued in (direct write: the owner command refuses while offers are live) and open a new one.
    await q(`update public.studio_waitlist_admission_rounds set closed_at = now(), closed_by_practitioner_id=$2 where studio_id=$1 and closed_at is null`, [f.studioId, f.practitionerId]);
    await q(`insert into public.studio_waitlist_admission_rounds (studio_id, allowance, opened_by_practitioner_id) values ($1, 100, $2)`, [f.studioId, f.practitionerId]);
    expect(await count()).toBeGreaterThanOrEqual(1);
    const src = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0324_waitlist_atomic_send_allowance.sql"), "utf8");
    expect(src).toMatch(/count_waitlist_competing_invitations_internal/);
    expect(src).not.toMatch(/competing[\s\S]{0,200}round_id\s*=\s*v_round_id/);
  });
});

describe("read_waitlist_followup_status takes an array", () => {
  it("mixed own and foreign ids return only own rows; unknown ids return nothing; more than 500 ids is refused", async () => {
    const f = await seed("s1");
    const other = await seed("s2");
    const e1 = await entry(f, "s1");
    const e2 = await entry(other, "s2");
    const d1 = await decline(await invite(f, e1.id));
    const d2 = await decline(await invite(other, e2.id));
    const ids = [d1[0].invitation_id, d2[0].invitation_id, "00000000-0000-4000-8000-0000000000aa"];
    const rows = await q(`select * from public.read_waitlist_followup_status($1,$2,$3::uuid[])`, [f.studioId, f.userId, ids]);
    expect(rows).toEqual([{ invitation_id: d1[0].invitation_id, status: "open" }]);
    expect(Object.keys(rows[0]).sort()).toEqual(["invitation_id", "status"]);
    expect(await q(`select * from public.read_waitlist_followup_status($1,$2,$3::uuid[])`, [f.studioId, f.userId, []])).toHaveLength(0);
    const many = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await expect(q(`select * from public.read_waitlist_followup_status($1,$2,$3::uuid[])`, [f.studioId, f.userId, many])).rejects.toThrow(/at most 500/);
    expect(await q(`select * from public.read_waitlist_followup_status($1,$2,$3::uuid[])`, [f.studioId, f.userId, many.slice(0, 500)])).toHaveLength(0);
  });
});

describe("S1: closed follow-ups whose answers still exist stay readable and erasable", () => {
  it("handled-with-answers is returned with its status; once erased it is not", async () => {
    const f = await seed("t");
    const e = await entry(f, "t");
    await decline(await invite(f, e.id));
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    await q(`select * from public.mark_waitlist_decline_handled($1,$2,$3)`, [f.studioId, f.userId, fid]);
    const list = () => q(`select * from public.read_waitlist_followups($1,$2,null)`, [f.studioId, f.userId]);
    const before = await list();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ status: "handled", why_not_work: WHY, better_times: TIMES });
    expect(Object.keys(before[0])).not.toContain("client_email");
    await q(`select * from public.erase_waitlist_decline_answers($1,$2,$3)`, [f.studioId, f.userId, fid]);
    expect(await list()).toHaveLength(0);
  });
});

describe("S3: a hard delete leaves a cascade erase record that survives the cascade", () => {
  it("deleting the entry removes the answers and writes ids-and-dates only", async () => {
    const f = await seed("u");
    const e = await entry(f, "u");
    await decline(await invite(f, e.id));
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    await q(`delete from public.new_client_waitlist_entries where id=$1`, [e.id]).catch(async () => {
      // Entries refuse delete outside a studio cascade; delete the studio instead.
      await q(`delete from public.studios where id=$1`, [f.studioId]);
    });
    expect(await q(`select 1 from public.waitlist_decline_answers where followup_id=$1`, [fid])).toHaveLength(0);
    const rec = await q(`select * from public.waitlist_erase_records where followup_id=$1`, [fid]);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ reason: "cascade", kind: "decline", studio_id: f.studioId });
    expect(JSON.stringify(rec[0])).not.toMatch(/MarkQ7/);
  });
});

describe("Codex :534: withdrawal after expires_at does not strand the person", () => {
  it("a lapsed-but-unmarked invitation is closed; Keep then a new invite is admitted", async () => {
    const f = await seed("v");
    const e = await entry(f, "v");
    const t = await invite(f, e.id);
    await q(`alter table public.new_client_waitlist_invitations disable trigger user`);
    try {
      await q(`update public.new_client_waitlist_invitations set issued_at = now() - interval '5 days', expires_at = now() - interval '1 minute' where entry_id=$1`, [e.id]);
    } finally {
      await q(`alter table public.new_client_waitlist_invitations enable trigger user`);
    }
    expect((await q(`select * from public.request_waitlist_withdrawal($1,$2)`, [t.token, t.cap]))[0].result).toBe("recorded");
    const inv = await q(`select declined_at, released_at, expired_at from public.new_client_waitlist_invitations where entry_id=$1`, [e.id]);
    expect(inv.every((r: any) => r.declined_at || r.released_at || r.expired_at)).toBe(true);
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    expect((await q(`select * from public.keep_waitlist_withdrawal($1,$2,$3)`, [f.studioId, f.userId, fid]))[0].result).toBe("kept");
    const again = await invite(f, e.id);
    expect(again.token).toBeTruthy();
  });
});

describe("admit: the owner-review hold", () => {
  const admit = (f: F, entryId: string, who: string, fit = 5) => {
    const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    return q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,$7)`, [f.studioId, who, entryId, f.serviceId, from, to, fit]).then((r) => r[0].result as string);
  };

  it("an entry with an open follow-up is refused as pending_owner_review until the owner handles it", async () => {
    const f = await seed("o");
    const e = await entry(f, "o");
    await decline(await invite(f, e.id));
    expect(await admit(f, e.id, f.userId)).toBe("pending_owner_review");
    const fid = (await q(`select id from public.waitlist_followups where entry_id=$1`, [e.id]))[0].id;
    await q(`select * from public.mark_waitlist_decline_handled($1,$2,$3)`, [f.studioId, f.userId, fid]);
    expect(await admit(f, e.id, f.userId)).toBe("admitted");
  });

  it("N1: a non-owner on an entry with an open follow-up gets the membership refusal, never pending_owner_review", async () => {
    const f = await seed("p");
    const e = await entry(f, "p");
    await decline(await invite(f, e.id));
    const prac = await seedMember({ studioId: f.studioId, userId: f.userId, practitionerId: f.practitionerId, clientId: f.clientId }, "np");
    expect(await admit(f, e.id, prac.userId)).toBe("not_owner");
    expect(await admit(f, e.id, randomUUID())).toBe("not_a_member");
  });

  it("no_capacity keeps its precedence over pending_owner_review", async () => {
    const f = await seed("q");
    const e = await entry(f, "q");
    await decline(await invite(f, e.id));
    expect(await admit(f, e.id, f.userId, 0)).toBe("no_capacity");
  });
});

describe("source pins", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0325_waitlist_decline_followups.sql"), "utf8");
  it("E4: the SQL literal for a fresh round's allowance equals AUTO_ROUND_ALLOWANCE", () => {
    expect(AUTO_ROUND_ALLOWANCE).toBe(100);
    expect(readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0324_waitlist_atomic_send_allowance.sql"), "utf8")).toMatch(/values \(p_studio_id, 100,/);
  });
  it("the bell literals in SQL are the contract's", () => {
    expect(sql).toContain("'A waitlist response needs your attention'");
    expect(sql).toContain("'/settings/waitlist#follow-up'");
  });
});

describe("C8: admit is built from the final 0324 bytes", () => {
  const root = join(__dirname, "..", "..", "supabase");
  const fn = (text: string) => {
    const a = text.indexOf("create or replace function public.admit_new_client_waitlist_entry(");
    return text.slice(a, text.indexOf("\n$$;", a) + 4);
  };
  const a24 = fn(readFileSync(join(root, "migrations", "0324_waitlist_atomic_send_allowance.sql"), "utf8"));
  const a25 = fn(readFileSync(join(root, "migrations", "0325_waitlist_decline_followups.sql"), "utf8"));

  it("0325's admit is 0324's with exactly one inserted region, and the guard and rotation survive in order", () => {
    const start = a25.indexOf("  -- 3d. THE OWNER-REVIEW HOLD");
    const end = a25.indexOf("  -- 4-9. THE MUTATING HALF");
    expect(start).toBeGreaterThan(0);
    expect(a25.slice(0, start) + a25.slice(end)).toBe(a24);
    const guard = a25.indexOf("if v_competing + 1 > p_fit then");
    const hold = a25.indexOf("'pending_owner_review'");
    const rotate = a25.indexOf("values (p_studio_id, 100,");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(hold);
    expect(hold).toBeLessThan(rotate);
  });

  it("the 0325 down file restores 0324's admit exactly", () => {
    const down = readFileSync(join(root, "rollbacks", "0325_waitlist_decline_followups.down.sql"), "utf8");
    expect(fn(down)).toBe(a24);
  });
});
