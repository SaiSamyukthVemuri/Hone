import { randomUUID } from "node:crypto";
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

describe("the down", () => {
  it("restores the previous view text and refuses while evidence exists (read from the files)", async () => {
    const { readFileSync } = await import("node:fs");
    const down = readFileSync("supabase/rollbacks/0368_sms_consent_number_binding.down.sql", "utf8");
    expect(down).toMatch(/refusing: clients hold SMS consent binding evidence/);
    expect(down).not.toMatch(/sms_consent_phone = c\.sms_phone/);
  });
});
