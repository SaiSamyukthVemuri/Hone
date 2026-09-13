import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";

/** `adminQuery` returns a QueryResult; every assertion here works on rows. */
const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];
import { waitUntilBlocked } from "./helpers/waitlist-concurrency";

// ===========================================================================
// 0195 — ATOMIC INVITATION BOOKING + CONVERSION
// ===========================================================================
//
// WHAT THIS PROVES. `create_waitlist_public_appointment` creates the
// appointment, its mandatory audit row and the waitlist conversion in ONE
// transaction, so the state "appointment exists AND entry.status = 'invited'"
// is unreachable. Before 0195 the application ran three transactions and a
// process death between the second and third left that state permanently.
//
// HOW THE CONCURRENCY CASES ARE SCHEDULED, AND ONE RULE THAT MATTERS.
// A harness may pre-take a lock for a participant ONLY if it is the first lock
// that participant's own command takes. For a standalone conversion the entry
// qualifies (its statements are entry -> invitation). For THIS command it does
// NOT, because this command takes the studio first. Applying an entry-first
// prefix to it manufactures a cycle no caller can produce — that mistake was
// made once and reported as a lock-policy defect it was not.
//
// Each participant also owns BEGIN -> work -> COMMIT/ROLLBACK. Deferring both
// commits until after a race resolves makes a blocked participant wait on a
// transaction that cannot end until it returns; that reports as a timeout and
// proves nothing.
// ===========================================================================

const BOOK = `select * from public.create_waitlist_public_appointment($1,$2,$3,$4::timestamptz,$5,$6,null,null)`;
const CONVERT = `select public.record_new_client_waitlist_conversion($1,$2,$3) as r`;

afterAll(async () => {
  await closePool();
});

type Fixture = {
  studioId: string; userId: string; clientId: string; serviceId: string;
};

/** A studio that can actually take a public booking: active service + open week. */
async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`atomic-${label}`);
  const svc = await q<any>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  for (let d = 0; d < 7; d += 1) {
    await q<any>(
      `insert into public.studio_availability_default
         (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
       values ($1,$2,true,'08:00','20:00',null)`,
      [s.studioId, d],
    );
  }
  await q<any>(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,20)`,
    [s.studioId, s.userId],
  );
  return { studioId: s.studioId, userId: s.userId, clientId: s.clientId, serviceId: svc[0].id };
}

/** A legal slot, taken from the booking path's own candidate generator. */
async function legalSlot(f: Fixture, nth: number): Promise<string> {
  for (let day = 2; day < 30; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await q<any>(
      `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
      [f.studioId, when],
    );
    if (cands.length > nth) return cands[nth].c;
  }
  throw new Error("no legal slot");
}

const tokenHash = (seed: string): string =>
  Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(seed.charCodeAt(i % seed.length) + i) % 16]).join("");

/** Drive the REAL chain to an invited + redeemed entry: admit -> proof -> redeem. */
async function redeemedEntry(f: Fixture, label: string): Promise<string> {
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, `w-${label}-${f.studioId.slice(0, 8)}@example.com`],
  );
  expect(e[0].result).toBe("created");
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await q<any>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
    [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to],
  );
  expect(a[0].result).toBe("admitted");
  const b = await q<any>(
    `select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token],
  );
  const c = await q<any>(
    `select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge],
  );
  const r = await q<any>(
    `select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
    [a[0].raw_token, c[0].raw_capability],
  );
  expect(r[0].result).toBe("redeemed");
  return r[0].entry_id;
}

const apptById = (id: string) =>
  q<any>(`select id, client_id from public.appointments where id=$1`, [id]);
const auditFor = (id: string) =>
  q<any>(`select count(*)::int as n from public.appointment_audit where appointment_id=$1`, [id]);
const apptCount = (sid: string) =>
  q<any>(`select count(*)::int as n from public.appointments where studio_id=$1`, [sid])
    .then((r) => r[0].n);
const entryRow = (id: string) =>
  q<any>(
    `select status, converted_at, converted_client_id from public.new_client_waitlist_entries where id=$1`, [id],
  ).then((r) => r[0]);

describe("0195 — one transaction: appointment, audit and conversion", () => {
  it("commits all three, and the entry converts to the resolved client", async () => {
    const f = await fixture("ok");
    const entryId = await redeemedEntry(f, "ok");
    const slot = await legalSlot(f, 0);

    const r = await q<any>(
      BOOK, [f.studioId, f.clientId, f.serviceId, slot, tokenHash("ok"), entryId],
    );
    expect(r[0].result).toBe("created_and_converted");
    expect(r[0].appointment_id).not.toBeNull();

    // Verified by the RETURNED id, never by email or client association.
    const appt = await apptById(r[0].appointment_id as string);
    expect(appt).toHaveLength(1);
    expect(appt[0].client_id).toBe(f.clientId);
    expect((await auditFor(r[0].appointment_id as string))[0].n).toBe(1);

    const e = await entryRow(entryId);
    expect(e.status).toBe("converted");
    expect(e.converted_at).not.toBeNull();
    expect(e.converted_client_id).toBe(f.clientId);
  });

  it("a conversion refusal rolls back THIS invocation's appointment and audit", async () => {
    const f = await fixture("rollback");
    const entryId = await redeemedEntry(f, "rollback");

    const first = await q<any>(
      BOOK, [f.studioId, f.clientId, f.serviceId, await legalSlot(f, 0), tokenHash("r1"), entryId],
    );
    expect(first[0].result).toBe("created_and_converted");

    const before = await apptCount(f.studioId);
    // The entry is terminal now, so the appointment work is reached and the
    // conversion then refuses. The caller commits the RETURNED result normally.
    const second = await q<any>(
      BOOK, [f.studioId, f.clientId, f.serviceId, await legalSlot(f, 3), tokenHash("r2"), entryId],
    );
    expect(second[0].result).toMatch(/^conversion:/);
    expect(second[0].appointment_id).toBeNull();
    // No SQLSTATE or raw database text crosses the boundary.
    expect(second[0].result).not.toMatch(/^\d{5}$/);

    expect(await apptCount(f.studioId)).toBe(before);
    const orphans = await q<any>(
      `select count(*)::int as n from public.appointment_audit au
         left join public.appointments a on a.id = au.appointment_id
        where a.id is null`,
    );
    expect(orphans[0].n).toBe(0);
    expect((await entryRow(entryId)).status).toBe("converted");
  });

  it("an appointment refusal converts nothing", async () => {
    const f = await fixture("apt-refuse");
    const entryId = await redeemedEntry(f, "apt-refuse");
    const before = await apptCount(f.studioId);

    const r = await q<any>(
      BOOK,
      [f.studioId, f.clientId, "00000000-0000-0000-0000-000000000000",
       await legalSlot(f, 0), tokenHash("ar"), entryId],
    );
    expect(r[0].result).toMatch(/^appointment:/);
    const e = await entryRow(entryId);
    expect(e.status).toBe("invited");
    expect(e.converted_at).toBeNull();
    expect(await apptCount(f.studioId)).toBe(before);
  });

  it("refuses an entry belonging to another studio, and books nothing", async () => {
    const a = await fixture("tenant-a");
    const b = await fixture("tenant-b");
    const foreign = await redeemedEntry(b, "tenant-b");
    const before = await apptCount(a.studioId);

    const r = await q<any>(
      BOOK, [a.studioId, a.clientId, a.serviceId, await legalSlot(a, 0), tokenHash("fx"), foreign],
    );
    expect(r[0].result).not.toBe("created_and_converted");
    expect(await apptCount(a.studioId)).toBe(before);
    expect((await entryRow(foreign)).status).toBe("invited");
  });

  it("leaves ordinary public booking unchanged", async () => {
    const f = await fixture("ordinary");
    const r = await q<any>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, f.clientId, f.serviceId, await legalSlot(f, 0), tokenHash("ord")],
    );
    expect(r[0].result).toBe("created");
    expect((await auditFor(r[0].appointment_id))[0].n).toBe(1);
  });
});

describe("0195 — concurrency", () => {
  /** Each participant owns its own transaction lifecycle. */
  async function inTx<T>(
    client: Client, work: (c: Client) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; code: string; where: string }> {
    await client.query("set statement_timeout = 15000");
    await client.query("begin");
    try {
      const value = await work(client);
      await client.query("commit");
      return { ok: true, value };
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      const err = e as { code?: string; where?: string };
      return { ok: false, code: err.code ?? "?", where: (err.where ?? "").split("\n")[0] };
    }
  }
  const connect = async (): Promise<Client> => {
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    return c;
  };

  it("two bookings for one redeemed entry: one converts, one refuses, ONE appointment", async () => {
    const f = await fixture("two-book");
    const entryId = await redeemedEntry(f, "two-book");
    const [s1, s2] = [await legalSlot(f, 0), await legalSlot(f, 3)];
    const A = await connect(); const B = await connect(); const obs = await connect();
    try {
      const pidB = (await B.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      // NO harness prefix on either side: both are studio-first commands, so an
      // entry-first prefix would be a lock neither command takes first.
      const ra = inTx(A, (c) => c.query(BOOK, [f.studioId, f.clientId, f.serviceId, s1, tokenHash("t1"), entryId]).then((x) => x.rows[0]));
      const rb = inTx(B, (c) => c.query(BOOK, [f.studioId, f.clientId, f.serviceId, s2, tokenHash("t2"), entryId]).then((x) => x.rows[0]));
      await waitUntilBlocked(pidB, 3000).catch(() => null);
      const [xa, xb] = await Promise.all([ra, rb]);
      const results = [xa, xb].map((x) => (x.ok ? (x.value as { result: string }).result : `ERR:${x.code}`));
      expect(results.filter((r) => r === "created_and_converted")).toHaveLength(1);
      expect(results.filter((r) => r.startsWith("conversion:"))).toHaveLength(1);
      expect(results.filter((r) => r.startsWith("ERR:"))).toHaveLength(0);
    } finally {
      await Promise.all([A.end(), B.end(), obs.end()].map((p) => p.catch(() => undefined)));
    }
    expect(await apptCount(f.studioId)).toBe(1);
    expect((await entryRow(entryId)).status).toBe("converted");
  });

  it("booking versus a standalone conversion on the same entry does NOT deadlock", async () => {
    // THE REGRESSION. The pre-0195 lock order produced a reproducible 40P01
    // here: the booking held studios FOR UPDATE and wanted the entry, while the
    // conversion held the entry and wanted the studio KEY SHARE its event
    // trigger's FK requires.
    const f = await fixture("vs-conv");
    const entryId = await redeemedEntry(f, "vs-conv");
    const slot = await legalSlot(f, 0);
    const A = await connect(); const B = await connect();
    try {
      const pidA = (await A.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      // B's prefix IS conversion's own first lock — command-reachable.
      await B.query("set statement_timeout = 15000");
      await B.query("begin");
      await B.query(`select 1 from public.new_client_waitlist_entries where id=$1 for update`, [entryId]);

      const ra = inTx(A, (c) => c.query(BOOK, [f.studioId, f.clientId, f.serviceId, slot, tokenHash("vc"), entryId]).then((x) => x.rows[0]));
      await waitUntilBlocked(pidA, 6000);
      const rbRows = await B.query<{ r: string }>(CONVERT, [f.studioId, entryId, f.clientId]);
      await B.query("commit");
      const xa = await ra;
      expect(rbRows.rows[0].r).toBe("converted");
      expect(xa.ok).toBe(true);
      if (xa.ok) expect((xa.value as { result: string }).result).toMatch(/^conversion:/);
    } finally {
      await Promise.all([A.end(), B.end()].map((p) => p.catch(() => undefined)));
    }
    expect(await apptCount(f.studioId)).toBe(0);
    expect((await entryRow(entryId)).status).toBe("converted");
  });
});

describe("0195 — privileges", () => {
  it("is executable by service_role only; no browser role holds EXECUTE", async () => {
    const acl = await q<any>(
      `select coalesce(array_to_string(p.proacl,' '),'(default)') as acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='create_waitlist_public_appointment'`,
    );
    expect(acl).toHaveLength(1);
    expect(acl[0].acl).toContain("service_role=X");
    expect(acl[0].acl).not.toMatch(/(^|\s)anon=/);
    expect(acl[0].acl).not.toMatch(/authenticated=/);
  });
});
