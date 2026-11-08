import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0319 — decline_waitlist_invitation_times_unsuitable: the recipient says the
// offered times do not work. The SAME entry returns to waiting with its join
// date and priority; the optional text is stored owner-only.
// ===========================================================================

const DECLINE = `select public.decline_waitlist_invitation_times_unsuitable($1,$2,$3) as r`;

afterAll(async () => {
  await closePool();
});

type Fixture = { studioId: string; userId: string; serviceId: string };

async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`b319-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}

async function invitedEntry(f: Fixture, label: string, prove = true) {
  const email = `b319-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect ${label}',$3,null,null)`,
    [f.studioId, f.userId, email],
  );
  expect(e[0].result).toBe("created");
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await q<any>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
    [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to],
  );
  expect(a[0].result).toBe("admitted");
  let cap = "0".repeat(64);
  if (prove) {
    const b = await q<any>(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
    const c = await q<any>(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge]);
    cap = c[0].raw_capability;
  }
  return { entryId: e[0].entry_id as string, token: a[0].raw_token as string, cap };
}

const entryRow = (id: string) =>
  q<{ status: string; joined_at: string }>(
    `select status, joined_at from public.new_client_waitlist_entries where id=$1`, [id],
  ).then((r) => r[0]);
const invitation = (entryId: string) =>
  q<{ declined_at: string | null; redeemed_at: string | null }>(
    `select declined_at, redeemed_at from public.new_client_waitlist_invitations where entry_id=$1`, [entryId],
  ).then((r) => r[0]);

describe("0319 decline_waitlist_invitation_times_unsuitable", () => {
  it("returns the SAME entry to waiting, keeping join date and queue priority, and stores the text", async () => {
    const f = await fixture("ok");
    const first = await invitedEntry(f, "first");
    const second = await invitedEntry(f, "second");
    const before = await entryRow(first.entryId);

    const r = await q<{ r: string }>(DECLINE, [first.token, first.cap, "  Weekday evenings only  "]);
    expect(r[0].r).toBe("returned_to_waiting");

    const after = await entryRow(first.entryId);
    expect(after.status).toBe("waiting");
    expect(new Date(after.joined_at).getTime()).toBe(new Date(before.joined_at).getTime());
    expect((await invitation(first.entryId)).declined_at).not.toBeNull();
    expect((await invitation(first.entryId)).redeemed_at).toBeNull();

    // No second entry was created for the person.
    const n = await q<{ n: number }>(
      `select count(*)::int as n from public.new_client_waitlist_entries where studio_id=$1 and name='Prospect first'`,
      [f.studioId],
    );
    expect(n[0].n).toBe(1);
    // The other invitee is untouched.
    expect((await entryRow(second.entryId)).status).toBe("invited");

    // PRIORITY: ordered by (joined_at, id), the returned entry is still ahead of the later one.
    const order = await q<{ id: string }>(
      `select id from public.new_client_waitlist_entries where studio_id=$1 and id = any($2::uuid[]) order by joined_at, id`,
      [f.studioId, [second.entryId, first.entryId]],
    );
    expect(order[0].id).toBe(first.entryId);

    const note = await q<{ note: string | null }>(
      `select note from public.waitlist_times_feedback where entry_id=$1`, [first.entryId],
    );
    expect(note).toEqual([{ note: "Weekday evenings only" }]);
  });

  it("a repeat is refused as not_live and the first text is kept", async () => {
    const f = await fixture("repeat");
    const p = await invitedEntry(f, "r");
    expect((await q<{ r: string }>(DECLINE, [p.token, p.cap, "first"]))[0].r).toBe("returned_to_waiting");
    expect((await q<{ r: string }>(DECLINE, [p.token, p.cap, "second"]))[0].r).toBe("not_live");
    const rows = await q<{ note: string }>(`select note from public.waitlist_times_feedback where entry_id=$1`, [p.entryId]);
    expect(rows).toEqual([{ note: "first" }]);
  });

  it("no text is allowed; the item still exists for the owner", async () => {
    const f = await fixture("blank");
    const p = await invitedEntry(f, "b");
    expect((await q<{ r: string }>(DECLINE, [p.token, p.cap, "   "]))[0].r).toBe("returned_to_waiting");
    const c = await q<any>(`select * from public.count_waitlist_times_feedback($1,$2)`, [f.studioId, f.userId]);
    expect(c[0]).toMatchObject({ result: "ok", n: 1 });
    const l = await q<any>(`select * from public.list_waitlist_times_feedback($1,$2)`, [f.studioId, f.userId]);
    expect(l).toHaveLength(1);
    expect(l[0].note).toBeNull();
  });

  it("refuses markup, control characters and over-long text, leaving the invitation live", async () => {
    const f = await fixture("bad");
    const p = await invitedEntry(f, "x");
    for (const bad of ["<b>hi</b>", "a\u0001b", "a\u007fb", "a\u0008b", "a\u202eb", "a\u200bb", "a\ufeffb", "x".repeat(501)]) {
      expect((await q<{ r: string }>(DECLINE, [p.token, p.cap, bad]))[0].r).toBe("invalid_note");
    }
    expect((await invitation(p.entryId)).declined_at).toBeNull();
    expect((await entryRow(p.entryId)).status).toBe("invited");
    expect((await q<{ r: string }>(DECLINE, [p.token, p.cap, "x".repeat(500)]))[0].r).toBe("returned_to_waiting");
  });

  it("a wrong capability changes nothing", async () => {
    const f = await fixture("cap");
    const p = await invitedEntry(f, "c");
    expect((await q<{ r: string }>(DECLINE, [p.token, "a".repeat(64), "x"]))[0].r).toBe("proof_invalid");
    expect((await q<{ r: string }>(DECLINE, ["b".repeat(64), p.cap, "x"]))[0].r).toBe("invalid_token");
    expect((await entryRow(p.entryId)).status).toBe("invited");
    const rows = await q(`select 1 from public.waitlist_times_feedback where entry_id=$1`, [p.entryId]);
    expect(rows).toHaveLength(0);
  });

  it("a redeemed invitation cannot use it", async () => {
    const f = await fixture("red");
    const p = await invitedEntry(f, "d");
    await q(`select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`, [p.token, p.cap]);
    expect((await q<{ r: string }>(DECLINE, [p.token, p.cap, "x"]))[0].r).toBe("not_live");
    expect((await entryRow(p.entryId)).status).toBe("invited");
  });

  it("owner commands are owner-gated and acknowledge clears the count", async () => {
    const f = await fixture("own");
    const other = await fixture("other");
    const p = await invitedEntry(f, "o");
    await q(DECLINE, [p.token, p.cap, "Mornings"]);

    const l0 = await q<any>(`select * from public.list_waitlist_times_feedback($1,$2)`, [f.studioId, f.userId]);
    const wrong = await q<any>(`select * from public.count_waitlist_times_feedback($1,$2)`, [f.studioId, other.userId]);
    expect(wrong[0].result).not.toBe("ok");
    const wrongList = await q<any>(`select * from public.list_waitlist_times_feedback($1,$2)`, [f.studioId, other.userId]);
    expect(wrongList[0].result).not.toBe("ok");
    expect(wrongList[0].note).toBeNull();
    expect(await q<{ r: string }>(
      `select public.acknowledge_waitlist_times_feedback($1,$2,$3) as r`, [f.studioId, l0[0].invitation_id, other.userId],
    )).not.toEqual([{ r: "acknowledged" }]);

    const l = await q<any>(`select * from public.list_waitlist_times_feedback($1,$2)`, [f.studioId, f.userId]);
    expect(l[0]).toMatchObject({ result: "ok", note: "Mornings", entry_id: p.entryId });
    const ack = await q<{ r: string }>(
      `select public.acknowledge_waitlist_times_feedback($1,$2,$3) as r`, [f.studioId, l[0].invitation_id, f.userId],
    );
    expect(ack[0].r).toBe("acknowledged");
    const c = await q<any>(`select * from public.count_waitlist_times_feedback($1,$2)`, [f.studioId, f.userId]);
    expect(c[0].n).toBe(0);
  });

  it("the person can be invited again after returning to waiting", async () => {
    const f = await fixture("again");
    const p = await invitedEntry(f, "a");
    await q(DECLINE, [p.token, p.cap, null]);
    const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const admit = (end: string) =>
      q<any>(
        `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
        [f.studioId, f.userId, p.entryId, f.serviceId, from, end],
      );
    // 0192 refuses only the IDENTICAL offer to an entry that declined it; the
    // person's return to waiting does not make the same offer reissuable.
    expect((await admit(to))[0].result).toBe("already_declined_offer");
    // A different window is a new offer and is admitted.
    const later = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10);
    expect((await admit(later))[0].result).toBe("admitted");
  });

  it("is service_role-only, table included, and erased with the studio", async () => {
    const g = await q<{ f: boolean; t: boolean; anon_t: boolean; auth_t: boolean; auth_f: boolean }>(
      `select has_function_privilege('service_role','public.decline_waitlist_invitation_times_unsuitable(text,text,text)','execute') as f,
              has_table_privilege('service_role','public.waitlist_times_feedback','select') as t,
              has_table_privilege('anon','public.waitlist_times_feedback','select') as anon_t,
              has_table_privilege('authenticated','public.waitlist_times_feedback','select') as auth_t,
              has_function_privilege('authenticated','public.decline_waitlist_invitation_times_unsuitable(text,text,text)','execute') as auth_f`,
    );
    expect(g[0]).toEqual({ f: true, t: false, anon_t: false, auth_t: false, auth_f: false });

    const f = await fixture("erase");
    const p = await invitedEntry(f, "e");
    await q(DECLINE, [p.token, p.cap, "note"]);
    await q(`delete from public.studios where id=$1`, [f.studioId]);
    const rows = await q(`select 1 from public.waitlist_times_feedback where entry_id=$1`, [p.entryId]);
    expect(rows).toHaveLength(0);
  });
});
