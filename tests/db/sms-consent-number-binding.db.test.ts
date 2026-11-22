import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// SMS consent is bound to the number it was given for. BEHAVIOUR against the migrated database: the binding trigger on clients,
// the write-once evidence, the lazy binding of a legacy consent at the first number change, and the eligibility view.

const DENIED = { code: "42501" };
const REFUSED = { code: "23514" };
let A: SeededStudio;
let slot = 0;

beforeAll(async () => {
  A = await seedStudio("sms-bind");
});
afterAll(async () => {
  await closePool();
});

const asService = (text: string, params: unknown[] = []) =>
  adminTx(async (q) => {
    await q("set local role service_role");
    return q(text, params);
  });

/** A client written by a trusted path. */
async function client(phone: string | null, consent: boolean, extra = ""): Promise<string> {
  const id = randomUUID();
  await asService(
    `insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source ${extra ? ", " + extra.split("=")[0] : ""})
     values ($1, $2, 'Bind Client', $3, ${consent ? "now()" : "null"}, ${consent ? "'public_booking'" : "null"} ${extra ? ", " + extra.split("=")[1] : ""})`,
    [id, A.studioId, phone],
  );
  return id;
}

/** A LEGACY consent: recorded before the binding existed (triggers off for the insert only, as a restore would). */
async function legacy(phone: string | null): Promise<string> {
  const id = randomUUID();
  await adminTx(async (q) => {
    await q("set local session_replication_role = replica");
    await q(
      `insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source)
       values ($1, $2, 'Legacy Client', $3, now(), 'public_booking')`,
      [id, A.studioId, phone],
    );
  });
  return id;
}

const ev = async (id: string) =>
  (await adminQuery(`select sms_consent_phone p, sms_consent_text_version v, sms_phone from public.clients where id = $1`, [id])).rows[0] as {
    p: string | null;
    v: string | null;
    sms_phone: string | null;
  };

async function appointment(clientId: string): Promise<string> {
  slot += 1;
  const start = new Date(Date.UTC(2031, 0, 1 + slot, 15, 0, 0)).toISOString();
  const end = new Date(Date.UTC(2031, 0, 1 + slot, 16, 0, 0)).toISOString();
  const r = await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, null, $2, null, $3::timestamptz, $4::timestamptz, 60, 'confirmed', $5) returning id`,
    [A.studioId, clientId, start, end, (randomUUID() + randomUUID()).replace(/-/g, "")],
  );
  return r.rows[0].id as string;
}
const eligible = async (apptId: string) =>
  Number((await adminQuery(`select count(*)::int n from public.reminder_sms_eligible_appointments where id = $1`, [apptId])).rows[0].n) === 1;

describe("consent is bound to the number in the statement that records it", () => {
  it("an insert with consent stores the normalized number, however it was typed", async () => {
    const id = await client("(416) 555-0100", true);
    expect((await ev(id)).p).toBe("+14165550100");
  });
  it("an insert with consent and NO number is refused and creates no row", async () => {
    const id = randomUUID();
    await expect(
      asService(`insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source) values ($1,$2,'x',null,now(),'public_booking')`, [id, A.studioId]),
    ).rejects.toMatchObject(REFUSED);
    await expect(
      asService(`insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source) values ($1,$2,'x','abc',now(),'public_booking')`, [id, A.studioId]),
    ).rejects.toMatchObject(REFUSED);
    expect(Number((await adminQuery(`select count(*)::int n from public.clients where id=$1`, [id])).rows[0].n)).toBe(0);
  });
  it("a consent recorded on an existing client binds the number the same statement leaves on the row", async () => {
    const id = await client("+14165550101", false);
    await asService(`update public.clients set sms_consent_at = now(), sms_consent_source = 'public_booking', phone = '+14165550102' where id = $1`, [id]);
    expect((await ev(id)).p).toBe("+14165550102");
  });
  it("recording consent on an existing client with no sendable number is refused", async () => {
    const id = await client(null, false);
    await expect(asService(`update public.clients set sms_consent_at = now(), sms_consent_source = 'public_booking' where id = $1`, [id])).rejects.toMatchObject(REFUSED);
  });
  it("the wording version is stored when the governed writer supplies it, and only then", async () => {
    const id = randomUUID();
    await asService(
      `insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source, sms_consent_text_version) values ($1,$2,'v','+14165550103',now(),'public_booking','booking_sms_v1')`,
      [id, A.studioId],
    );
    expect((await ev(id)).v).toBe("booking_sms_v1");
    const bare = await client("+14165550104", true);
    expect((await ev(bare)).v).toBeNull();
    await expect(
      asService(`insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source, sms_consent_text_version) values ($1,$2,'v','+14165550105',now(),'public_booking','Bad Value')`, [randomUUID(), A.studioId]),
    ).rejects.toMatchObject(REFUSED);
  });
});

describe("a raw member can never set the evidence, and it is write-once for everyone", () => {
  it("a member insert or update naming the evidence is refused", async () => {
    await expect(
      asUser(A.userId, (q) => q(`insert into public.clients (id, studio_id, name, phone, sms_consent_phone) values ($1,$2,'m','+14165550106','+14165550106')`, [randomUUID(), A.studioId])),
    ).rejects.toMatchObject(DENIED);
    const id = await client("+14165550107", false);
    await expect(asUser(A.userId, (q) => q(`update public.clients set sms_consent_phone = '+14165550107' where id = $1`, [id]))).rejects.toMatchObject(DENIED);
    await expect(asUser(A.userId, (q) => q(`update public.clients set sms_consent_text_version = 'x_v1' where id = $1`, [id]))).rejects.toMatchObject(DENIED);
  });
  it("the table grant lets a member UPDATE the column, so the trigger is the guard: a member update is refused on a consented client, to another number or to the same one", async () => {
    const g = await adminQuery(`select has_column_privilege('authenticated', 'public.clients', 'sms_consent_phone', 'update') as u`);
    expect(g.rows[0].u).toBe(true);
    const id = await client("+14165550108", true);
    await expect(asUser(A.userId, (q) => q(`update public.clients set sms_consent_phone = '+14165550199' where id = $1`, [id]))).rejects.toMatchObject(DENIED);
    await expect(asUser(A.userId, (q) => q(`update public.clients set sms_consent_phone = null where id = $1`, [id]))).rejects.toMatchObject(DENIED);
    expect((await ev(id)).p).toBe("+14165550108");
  });
  it("the bound number and the wording version cannot be changed afterwards, even by a trusted writer", async () => {
    const id = randomUUID();
    await asService(
      `insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source, sms_consent_text_version) values ($1,$2,'w','+14165550108',now(),'public_booking','booking_sms_v1')`,
      [id, A.studioId],
    );
    await expect(asService(`update public.clients set sms_consent_phone = '+14165550199' where id = $1`, [id])).rejects.toMatchObject(REFUSED);
    await expect(asService(`update public.clients set sms_consent_text_version = 'booking_sms_v2' where id = $1`, [id])).rejects.toMatchObject(REFUSED);
    const e = await ev(id);
    expect([e.p, e.v]).toEqual(["+14165550108", "booking_sms_v1"]);
  });
  it("evidence cannot exist without a consent", async () => {
    await expect(
      asService(`insert into public.clients (id, studio_id, name, phone, sms_consent_phone) values ($1,$2,'e','+14165550109','+14165550109')`, [randomUUID(), A.studioId]),
    ).rejects.toMatchObject(REFUSED);
  });
});

describe("the number changes after consent: the old consent does not authorize the new number", () => {
  it("a formatting-only edit keeps the consent (same normalized number); the appointment stays eligible", async () => {
    const id = await client("+14165550110", true);
    const appt = await appointment(id);
    expect(await eligible(appt)).toBe(true);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '(416) 555-0110' where id = $1`, [id]));
    expect((await ev(id)).p).toBe("+14165550110");
    expect(await eligible(appt)).toBe(true);
  });
  it("a real change by a member leaves the bound number, so the appointment is no longer eligible", async () => {
    const id = await client("+14165550111", true);
    const appt = await appointment(id);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550112' where id = $1`, [id]));
    const e = await ev(id);
    expect([e.p, e.sms_phone]).toEqual(["+14165550111", "+14165550112"]);
    expect(await eligible(appt)).toBe(false);
  });
  it("changing the number back restores eligibility (the consent was for that number)", async () => {
    const id = await client("+14165550113", true);
    const appt = await appointment(id);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550114' where id = $1`, [id]));
    expect(await eligible(appt)).toBe(false);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550113' where id = $1`, [id]));
    expect(await eligible(appt)).toBe(true);
  });
  it("removing the number and adding another does not carry the consent over", async () => {
    const id = await client("+14165550115", true);
    const appt = await appointment(id);
    await asUser(A.userId, (q) => q(`update public.clients set phone = null where id = $1`, [id]));
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550116' where id = $1`, [id]));
    expect(await eligible(appt)).toBe(false);
  });
});

describe("a LEGACY consent (no bound number): allowed as before, bound at the first change of the number", () => {
  it("is eligible while its number is unchanged, and a formatting-only edit binds nothing", async () => {
    const id = await legacy("+14165550120");
    const appt = await appointment(id);
    expect((await ev(id)).p).toBeNull();
    expect(await eligible(appt)).toBe(true);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '416-555-0120' where id = $1`, [id]));
    expect((await ev(id)).p).toBeNull();
    expect(await eligible(appt)).toBe(true);
  });
  it("the first real change binds the number it held BEFORE, and the new number is not covered", async () => {
    const id = await legacy("+14165550121");
    const appt = await appointment(id);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550122' where id = $1`, [id]));
    expect((await ev(id)).p).toBe("+14165550121");
    expect(await eligible(appt)).toBe(false);
  });
  it("a legacy consent with no number is bound to the no-number marker, so a number added later is not covered", async () => {
    const id = await legacy(null);
    const appt = await appointment(id);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550123' where id = $1`, [id]));
    expect((await ev(id)).p).toBe("-");
    expect(await eligible(appt)).toBe(false);
  });
  it("a caller cannot claim a number for a legacy consent", async () => {
    const id = await legacy("+14165550124");
    await expect(asService(`update public.clients set sms_consent_phone = '+14165550124' where id = $1`, [id])).rejects.toMatchObject(REFUSED);
    await expect(asUser(A.userId, (q) => q(`update public.clients set sms_consent_phone = '+14165550124' where id = $1`, [id]))).rejects.toMatchObject(DENIED);
    expect((await ev(id)).p).toBeNull();
  });
});


const events = async (id: string) =>
  (await adminQuery(`select kind, source, number_changed_from_previous_consent ch, text_version v from public.client_sms_consent_events where client_id = $1 order by recorded_at, kind desc`, [id])).rows as {
    kind: string;
    source: string | null;
    ch: boolean;
    v: string | null;
  }[];
const later = "now() + interval '1 second'";
const replaceVia = async (id: string, bound: string, version: string | null, at = later) =>
  (await asService(`select public.replace_client_sms_consent($1, $2, ${at}, $3) as ok`, [id, bound, version])).rows[0].ok as boolean;

describe("every consent is kept in an append-only record", () => {
  it("a consent recorded at insert writes one event with the number fingerprint and the wording version", async () => {
    const id = randomUUID();
    await asService(
      `insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source, sms_consent_text_version) values ($1,$2,'ev','+14165550130',now(),'public_booking','booking_sms_v1')`,
      [id, A.studioId],
    );
    expect(await events(id)).toEqual([{ kind: "recorded", source: "public_booking", ch: false, v: "booking_sms_v1" }]);
  });
  it("no API role can read or write the record, and nobody can change or delete a row", async () => {
    const id = await client("+14165550131", true);
    await expect(asUser(A.userId, (q) => q(`select * from public.client_sms_consent_events where client_id = $1`, [id]))).rejects.toMatchObject(DENIED);
    await expect(asService(`select * from public.client_sms_consent_events where client_id = $1`, [id])).rejects.toMatchObject(DENIED);
    await expect(adminQuery(`update public.client_sms_consent_events set source = 'x' where client_id = $1`, [id])).rejects.toMatchObject(REFUSED);
    await expect(adminQuery(`delete from public.client_sms_consent_events where client_id = $1`, [id])).rejects.toMatchObject(REFUSED);
    await expect(adminQuery(`truncate public.client_sms_consent_events`)).rejects.toMatchObject(REFUSED);
  });
});

describe("the record holds no number and goes only with its client", () => {
  it("has no phone or fingerprint column", async () => {
    const r = await adminQuery(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'client_sms_consent_events' and (column_name like '%phone%' or column_name like '%sha%')`);
    expect(r.rows).toEqual([]);
  });
  it("is deleted with its client row, and in no other way", async () => {
    const id = await client("+14165550150", true);
    expect((await events(id)).length).toBe(1);
    await expect(adminQuery(`delete from public.client_sms_consent_events where client_id = $1`, [id])).rejects.toMatchObject(REFUSED);
    await adminQuery(`delete from public.clients where id = $1`, [id]);
    expect((await events(id)).length).toBe(0);
  });
});

describe("fresh consent for the number now on file replaces the old consent and keeps it", () => {
  it("a trusted writer can replace a consent whose number changed: the new number is bound, the old consent is kept", async () => {
    const id = await client("+14165550132", true);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550133' where id = $1`, [id]));
    expect((await ev(id)).p).toBe("+14165550132");
    expect(await replaceVia(id, "+14165550132", "booking_sms_v1")).toBe(true);
    const e = await ev(id);
    expect([e.p, e.v]).toEqual(["+14165550133", "booking_sms_v1"]);
    const rows = await events(id);
    expect(rows.map((r) => r.kind)).toEqual(["recorded", "recorded"]);
    expect(rows.map((r) => r.ch)).toEqual([false, true]);
  });
  it("the wording version of a replacement is the one supplied with it: v2 over v2 stays v2, none supplied gives NULL, null over v2 gives v2", async () => {
    const mk = async (phone: string, version: string | null) => {
      const id = randomUUID();
      await asService(`insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source, sms_consent_text_version) values ($1,$2,'tv',$3,now(),'public_booking',$4)`, [id, A.studioId, phone, version]);
      await asUser(A.userId, (q) => q(`update public.clients set phone = $2 where id = $1`, [id, phone.replace(/.$/, "9")]));
      return id;
    };
    const same = await mk("+14165550160", "booking_sms_v2");
    expect(await replaceVia(same, "+14165550160", "booking_sms_v2")).toBe(true);
    expect((await ev(same)).v).toBe("booking_sms_v2");
    const none = await mk("+14165550161", "booking_sms_v2");
    expect(await replaceVia(none, "+14165550161", null)).toBe(true);
    expect((await ev(none)).v).toBeNull();
    const fromNull = await mk("+14165550162", null);
    expect(await replaceVia(fromNull, "+14165550162", "booking_sms_v2")).toBe(true);
    expect((await ev(fromNull)).v).toBe("booking_sms_v2");
    expect((await events(same)).map((r) => r.v)).toEqual(["booking_sms_v2", "booking_sms_v2"]);
  });
  it("a replacement made by a plain update, even one that names a version, records no version (the function is the only carrier)", async () => {
    const id = randomUUID();
    await asService(`insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_consent_source, sms_consent_text_version) values ($1,$2,'raw','+14165550163',now(),'public_booking','booking_sms_v1')`, [id, A.studioId]);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550164' where id = $1`, [id]));
    await asService(`update public.clients set sms_consent_at = ${later}, sms_consent_source = 'public_booking', sms_consent_text_version = 'booking_sms_v9' where id = $1`, [id]);
    expect((await ev(id)).v).toBeNull();
  });
  it("the replacement function matches on the bound number and refuses for a STOP, and no API role can call it", async () => {
    const id = await client("+14165550165", true);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550166' where id = $1`, [id]));
    expect(await replaceVia(id, "+14165550999", "booking_sms_v1")).toBe(false);
    await expect(asUser(A.userId, (q) => q(`select public.replace_client_sms_consent($1, '+14165550165', now(), null)`, [id]))).rejects.toMatchObject(DENIED);
    await asService(`update public.clients set sms_opted_out_at = now(), sms_opt_out_source = 'twilio_stop' where id = $1`, [id]);
    expect(await replaceVia(id, "+14165550165", "booking_sms_v1")).toBe(false);
    expect((await ev(id)).p).toBe("+14165550165");
  });
  it("a LEGACY consent that was edited, then replaced, keeps a snapshot of the consent it replaced", async () => {
    const id = await legacy("+14165550134");
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550135' where id = $1`, [id]));
    expect((await ev(id)).p).toBe("+14165550134");
    await asService(`update public.clients set sms_consent_at = ${later}, sms_consent_source = 'public_booking' where id = $1`, [id]);
    expect((await ev(id)).p).toBe("+14165550135");
    const rows = await events(id);
    expect(rows.map((r) => r.kind).sort()).toEqual(["recorded", "superseded"]);
    expect(rows.find((r) => r.kind === "recorded")?.ch).toBe(true);
    expect(rows.find((r) => r.kind === "superseded")?.ch).toBe(false);
  });
  it("is refused when the number is the same, when a STOP exists, when the time is not later, for an unbound legacy row, and for a member", async () => {
    const same = await client("+14165550136", true);
    await expect(asService(`update public.clients set sms_consent_at = ${later}, sms_consent_source = 'public_booking' where id = $1`, [same])).rejects.toMatchObject(REFUSED);

    const stopped = await client("+14165550137", true);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550138' where id = $1`, [stopped]));
    await asService(`update public.clients set sms_opted_out_at = now(), sms_opt_out_source = 'twilio_stop' where id = $1`, [stopped]);
    await expect(asService(`update public.clients set sms_consent_at = ${later}, sms_consent_source = 'public_booking' where id = $1`, [stopped])).rejects.toMatchObject(REFUSED);

    const old = await client("+14165550139", true);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550140' where id = $1`, [old]));
    await expect(asService(`update public.clients set sms_consent_at = now() - interval '1 day', sms_consent_source = 'public_booking' where id = $1`, [old])).rejects.toMatchObject(REFUSED);
    await expect(asUser(A.userId, (q) => q(`update public.clients set sms_consent_at = ${later}, sms_consent_source = 'public_booking' where id = $1`, [old]))).rejects.toMatchObject(DENIED);

    const unbound = await legacy("+14165550141");
    await expect(asService(`update public.clients set sms_consent_at = ${later}, sms_consent_source = 'public_booking' where id = $1`, [unbound])).rejects.toMatchObject(REFUSED);
    expect((await events(old)).length).toBe(1);
  });
  it("a replaced consent makes the appointment eligible again for the new number", async () => {
    const id = await client("+14165550142", true);
    const appt = await appointment(id);
    await asUser(A.userId, (q) => q(`update public.clients set phone = '+14165550143' where id = $1`, [id]));
    expect(await eligible(appt)).toBe(false);
    await asService(`update public.clients set sms_consent_at = ${later}, sms_consent_source = 'public_booking' where id = $1`, [id]);
    expect(await eligible(appt)).toBe(true);
  });
});

describe("the down", () => {
  it("restores the previous view text and refuses while evidence exists (read from the files)", async () => {
    const down = readFileSync("supabase/rollbacks/0368_sms_consent_number_binding.down.sql", "utf8");
    expect(down).toMatch(/refusing: SMS consent binding evidence or consent events exist/);
    expect(down).not.toMatch(/sms_consent_phone = c\.sms_phone/);
    const body = (t: string) => {
      const a = t.indexOf("create or replace function public.clients_sms_permission_guard()");
      const b = t.indexOf("as $$", a) + 5;
      return t.slice(b, t.indexOf("$$;", b));
    };
    expect(body(down)).toBe(body(readFileSync("supabase/migrations/0211_client_sms_permission_guard.sql", "utf8")));
    expect(down).toContain("534c7e27a810ea277e6d437a7b3d7eea");
    const viewText = (t: string) => {
      const a = t.indexOf("create or replace view public.reminder_sms_eligible_appointments");
      return t.slice(a, t.indexOf(";", a)).replace(/\s+/g, " ").trim();
    };
    expect(viewText(down)).toBe(viewText(readFileSync("supabase/migrations/0199_reminder_sms_candidate_selection.sql", "utf8")));
    expect(down).toMatch(/restored view column list/);
  });
});
