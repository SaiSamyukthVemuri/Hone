import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";
import { waitUntilBlocked } from "./helpers/waitlist-concurrency";

// ===========================================================================
// 0256 (SEC-004) - an ordinary public new-client booking refuses, inside its
// own transaction, to adopt an existing ACTIVE client by email.
//
// Knowing an email is not proof of owning it. The application stopped
// attaching (PR #1132); this proves the DATABASE no longer adopts either, which
// closes the window where an ACTIVE client appears between the action's lookup
// and the commit (Insurance PEER-1132 F1).
//
// Asserted on ground-truth rows, never on copy:
//   1. an active client's email -> `existing_client_requires_confirmation`,
//      with zero appointments, zero new clients and the client's own consent
//      untouched; the email's case and whitespace make no difference;
//   2. a plain new client still books and gets a NEW client row;
//   3. an ARCHIVED client still answers archived_client_collision;
//   4. THE RACE, with two real sessions and a real lock wait: a client that
//      commits while the command is mid-insert is refused, not adopted;
//   5. an INVITATION booking (p_entry_id) still adopts the invited client's row.
// ===========================================================================

type Row = Record<string, unknown>;

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
const REFUSED = "existing_client_requires_confirmation";

type Fixture = { studioId: string; userId: string; serviceId: string };

/** A studio that takes public bookings: an active consultation + an open week. */
async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`adopt-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  for (let d = 0; d < 7; d += 1) {
    await q(
      `insert into public.studio_availability_default
         (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
       values ($1,$2,true,'08:00','20:00',null)`,
      [s.studioId, d],
    );
  }
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}

async function legalSlot(f: Fixture, nth: number): Promise<string> {
  for (let day = 2; day < 30; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await q<{ c: string }>(
      `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
      [f.studioId, when],
    );
    if (cands.length > nth) return cands[nth].c;
  }
  throw new Error("no legal slot");
}

const BOOK = `select * from public.create_public_appointment_for_new_client(
  $1, null, 'Booker', $2, '+15550100', now(), $3, $4::timestamptz, $5, false, null, null, $6)`;

async function book(f: Fixture, email: string, slot: string, entryId: string | null = null) {
  const r = await q<Row>(BOOK, [f.studioId, email, f.serviceId, slot, hash64(), entryId]);
  return r[0];
}

async function counts(studioId: string) {
  const r = await q<Row>(
    `select (select count(*) from public.appointments where studio_id = $1) as appointments,
            (select count(*) from public.clients where studio_id = $1) as clients`,
    [studioId],
  );
  return { appointments: Number(r[0].appointments), clients: Number(r[0].clients) };
}

async function addClient(studioId: string, email: string, archived = false): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into public.clients (id, studio_id, name, email, archived_at)
     values ($1,$2,'On File',$3, ${archived ? "now()" : "null"})`,
    [id, studioId, email],
  );
  return id;
}

const fresh = (p: string) => `${p}-${randomUUID().slice(0, 8)}@harness.local`;

afterAll(async () => {
  await closePool();
});

describe("0256: an ordinary public booking never adopts an ACTIVE client", () => {
  it("refuses an active client's email, writing nothing and leaving the client untouched", async () => {
    const f = await fixture("active");
    const email = fresh("active");
    const clientId = await addClient(f.studioId, email);
    const before = await counts(f.studioId);

    const r = await book(f, email, await legalSlot(f, 0));

    expect(r.result).toBe(REFUSED);
    expect(r.appointment_id).toBeNull();
    expect(await counts(f.studioId)).toEqual(before);
    const c = await q<Row>(
      `select name, sms_consent_at, sms_consent_source from public.clients where id = $1`,
      [clientId],
    );
    expect(c[0]).toMatchObject({ name: "On File", sms_consent_at: null, sms_consent_source: null });
  });

  it("matches on the normalized email, so case and surrounding whitespace do not get around it", async () => {
    const f = await fixture("norm");
    const email = fresh("norm");
    await addClient(f.studioId, email);
    const before = await counts(f.studioId);

    const r = await book(f, `  ${email.toUpperCase()}  `, await legalSlot(f, 0));

    expect(r.result).toBe(REFUSED);
    expect(await counts(f.studioId)).toEqual(before);
  });

  it("POSITIVE CONTROL: a plain new client still books and gets a NEW client row", async () => {
    const f = await fixture("plain");
    const email = fresh("plain");
    const before = await counts(f.studioId);

    const r = await book(f, email, await legalSlot(f, 0));

    expect(r.result).toBe("created");
    expect(r.client_id).not.toBeNull();
    expect(await counts(f.studioId)).toEqual({
      appointments: before.appointments + 1,
      clients: before.clients + 1,
    });
  });

  it("an ARCHIVED client still answers archived_client_collision (unchanged)", async () => {
    const f = await fixture("arch");
    const email = fresh("arch");
    await addClient(f.studioId, email, true);
    const before = await counts(f.studioId);

    const r = await book(f, email, await legalSlot(f, 0));

    expect(r.result).toBe("archived_client_collision");
    expect(await counts(f.studioId)).toEqual(before);
  });

  it("another studio's client with the same email does not matter", async () => {
    const a = await fixture("xs-a");
    const b = await fixture("xs-b");
    const email = fresh("xs");
    await addClient(a.studioId, email);

    const r = await book(b, email, await legalSlot(b, 0));

    expect(r.result).toBe("created");
  });
});

describe("0256: THE RACE - a client that appears while the command is mid-insert is refused, not adopted", () => {
  let staff: Client;
  beforeAll(async () => {
    staff = new Client({ connectionString: resolveLocalDbUrl() });
    await staff.connect();
  });
  afterAll(async () => {
    await staff.end().catch(() => undefined);
  });

  it("staff adds the client in an open transaction; the booking blocks on the unique email, then is refused after the commit", async () => {
    const f = await fixture("race");
    const email = fresh("race");
    const slot = await legalSlot(f, 0);
    const before = await counts(f.studioId);

    // "Add Client" inserts straight into clients and takes no studio lock.
    await staff.query("begin");
    await staff.query(
      `insert into public.clients (studio_id, name, email) values ($1,'Staff Added',$2)`,
      [f.studioId, email],
    );

    // The command's own lookup cannot see that uncommitted row, so it proceeds to
    // its insert and BLOCKS on the unique email index. A real lock wait.
    const booking = new Client({ connectionString: resolveLocalDbUrl() });
    await booking.connect();
    const pid = (await booking.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    const racing = booking.query(BOOK, [f.studioId, email, f.serviceId, slot, hash64(), null]);
    expect(await waitUntilBlocked(pid)).toBeTruthy();

    await staff.query("commit");
    const r = (await racing).rows[0];
    await booking.end();

    // 0204 adopted the staff-added client here and booked on it. Now it refuses.
    expect(r.result).toBe(REFUSED);
    expect(r.appointment_id).toBeNull();
    expect(await counts(f.studioId)).toEqual({
      appointments: before.appointments,
      clients: before.clients + 1, // only the staff-added row
    });
  });
});

describe("0256: an INVITATION booking keeps adopting the invited client's row", () => {
  it("books on the existing client whose address the invitation proved", async () => {
    const f = await fixture("invited");
    // Same recipe as waitlist-atomic-booking-conversion.db.test.ts: admit ->
    // proof -> redeem, so the entry is genuinely invited and redeemed.
    await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [f.studioId, f.userId]);
    const email = `w-inv-${f.studioId.slice(0, 8)}@example.com`;
    const e = await q<Row>(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
      [f.studioId, f.userId, email],
    );
    expect(e[0].result).toBe("created");
    const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const a = await q<Row>(
      `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
      [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to],
    );
    expect(a[0].result).toBe("admitted");
    const b = await q<Row>(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
    const c = await q<Row>(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [
      a[0].raw_token,
      b[0].raw_challenge,
    ]);
    const red = await q<Row>(`select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`, [
      a[0].raw_token,
      c[0].raw_capability,
    ]);
    expect(red[0].result).toBe("redeemed");

    // The invited address already belongs to a client on file.
    const clientId = await addClient(f.studioId, email);
    const before = await counts(f.studioId);

    const r = await book(f, email, await legalSlot(f, 0), red[0].entry_id as string);

    expect(r.result, "an invitation must not be refused as an unconfirmed identity").not.toBe(REFUSED);
    expect(String(r.result)).toMatch(/^created/);
    expect(r.client_id).toBe(clientId);
    expect(await counts(f.studioId)).toEqual({
      appointments: before.appointments + 1,
      clients: before.clients,
    });
  });
});
