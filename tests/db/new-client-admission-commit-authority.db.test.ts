import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  adminTx,
  asUser,
  closePool,
  resolveLocalDbUrl,
} from "./helpers/harness";

// ===========================================================================
// COMMIT-TIME NEW-CLIENT ADMISSION AUTHORITY — the TOCTOU repair.
//
// The application read is presentation, fast refusal and work avoidance. It is
// NOT commit-time authority: between that read and the writes the owner can
// change the mode, and the writes travel as SEPARATE PostgREST requests, so a
// request that began under `open` could create a client and an appointment after
// the studio had been closed.
//
// A SECOND APPLICATION READ CANNOT FIX THAT - it only narrows the window. The
// repair is a serial order, taken under the studios row lock inside the same
// transaction as the write:
//
//   A. mutation takes the lock first -> it commits under the mode it saw, and
//      the owner's change applies afterwards;
//   B. owner takes the lock first    -> the mutation WAITS, then observes the
//      NEW mode, and refuses with zero writes.
//
// Both orders are proved below for all three new-client mutations, with two
// independent database sessions and a real lock wait - not a sleep.
// ===========================================================================

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

async function conn(): Promise<Client> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}

async function pidOf(c: Client): Promise<number> {
  const r = await c.query("select pg_backend_pid() as pid");
  return r.rows[0].pid as number;
}

/** Poll pg_stat_activity until `pid` is genuinely waiting on a lock. */
async function waitUntilBlocked(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await adminQuery(
      `select wait_event_type from pg_stat_activity where pid = $1`,
      [pid],
    );
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

type Fixture = {
  studioId: string;
  userId: string;
  ownerId: string;
  serviceId: string;
  existingClientId: string;
  existingClientEmail: string;
  slot: string;
  altSlot: string;
};

async function seed(label: string): Promise<Fixture> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const serviceId = randomUUID();
  const existingClientId = randomUUID();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;
  const clientEmail = `c-${studioId.slice(0, 8)}@harness.local`;

  await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios (id,name,owner_email,timezone,buffer_minutes,slug,public_booking_horizon_months)
     values ($1,$2,$3,'UTC',0,$4,3)`,
    [studioId, `CT ${label}`, email, `${label}-${studioId.slice(0, 8)}`],
  );
  await adminQuery(
    `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
     values ($1,$2,$3,'Owner',$4,'owner',true)`,
    [ownerId, studioId, userId, email],
  );
  await adminQuery(
    `insert into public.services (id,studio_id,name,default_duration_minutes,active)
     values ($1,$2,'Consultation',60,true)`,
    [serviceId, studioId],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
     select $1,g,true,'09:00','17:00',null from generate_series(0,6) g`,
    [studioId],
  );
  await adminQuery(
    `insert into public.clients (id,studio_id,name,email) values ($1,$2,'Existing',$3)`,
    [existingClientId, studioId, clientEmail],
  );

  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 6);
  const at = (h: number) => {
    const d = new Date(day);
    d.setUTCHours(h, 0, 0, 0);
    return d.toISOString();
  };
  return {
    studioId,
    userId,
    ownerId,
    serviceId,
    existingClientId,
    existingClientEmail: clientEmail,
    slot: at(11),
    altSlot: at(15),
  };
}

/**
 * Set a studio's mode the way the supported command does — permit-armed, so the
 * BEFORE UPDATE guard allows it — and COMMIT, giving a stamped studio.
 */
async function stamp(studioId: string, mode: string): Promise<void> {
  await adminTx(async (q) => {
    await q("select set_config('hone.admission_mode_studio_id', $1, true)", [studioId]);
    await q(
      `update public.studios
          set new_client_admission_mode = $2,
              new_client_admission_mode_set_at = now()
        where id = $1`,
      [studioId, mode],
    );
  });
}

/** Begin an owner mode change in `c` and HOLD the row lock, uncommitted. */
async function ownerHoldsLock(c: Client, studioId: string, mode: string): Promise<void> {
  await c.query("begin");
  await c.query("select set_config('hone.admission_mode_studio_id', $1, true)", [studioId]);
  await c.query(
    `update public.studios set new_client_admission_mode = $2 where id = $1`,
    [studioId, mode],
  );
}

const countsFor = async (studioId: string) => {
  const r = await adminQuery(
    `select
       (select count(*) from public.appointments where studio_id = $1)                as appointments,
       (select count(*) from public.clients where studio_id = $1)                     as clients,
       (select count(*) from public.new_client_waitlist_entries where studio_id = $1)  as entries`,
    [studioId],
  );
  return {
    appointments: Number(r.rows[0].appointments),
    clients: Number(r.rows[0].clients),
    entries: Number(r.rows[0].entries),
  };
};

const modeOf = async (studioId: string) => {
  const r = await adminQuery(
    `select new_client_admission_mode as m from public.studios where id = $1`,
    [studioId],
  );
  return r.rows[0].m as string;
};

let A: Client;
let B: Client;

beforeAll(async () => {
  A = await conn();
  B = await conn();
});

afterAll(async () => {
  await A.end().catch(() => undefined);
  await B.end().catch(() => undefined);
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. ORDINARY NEW-CLIENT BOOKING racing owner -> CLOSED
// ---------------------------------------------------------------------------
describe("1. ordinary new-client booking vs owner -> CLOSED", () => {
  const book = (f: Fixture, startsAt: string) =>
    `select * from public.create_public_appointment_for_new_client(
       '${f.studioId}'::uuid, null, 'New Person', 'new-${randomUUID().slice(0, 8)}@harness.local',
       '+15550100', null, '${f.serviceId}'::uuid, '${startsAt}'::timestamptz,
       '${hash64()}', false, null, null)`;

  it("A. mutation first -> it COMMITS under OPEN, then the owner change applies", async () => {
    const f = await seed("ord-a");
    await stamp(f.studioId, "open");
    const before = await countsFor(f.studioId);

    // The mutation takes the lock and writes, holding its transaction open.
    await A.query("begin");
    const booked = await A.query(book(f, f.slot));
    expect(booked.rows[0].result).toBe("created");
    expect(booked.rows[0].client_id).not.toBeNull();

    // The owner now tries to close, and must WAIT on the row lock.
    const ownerPid = await pidOf(B);
    const owner = ownerHoldsLock(B, f.studioId, "closed");
    expect(
      await waitUntilBlocked(ownerPid),
      "the owner change must wait for the mutation's row lock",
    ).toBe(true);

    await A.query("commit");
    await owner;
    await B.query("commit");

    // The permitted old-state commit stands, and the owner's change follows it.
    const after = await countsFor(f.studioId);
    expect(after.appointments).toBe(before.appointments + 1);
    expect(after.clients).toBe(before.clients + 1);
    expect(await modeOf(f.studioId)).toBe("closed");
  });

  it("B. owner first -> the mutation WAITS, then REFUSES with zero writes", async () => {
    const f = await seed("ord-b");
    await stamp(f.studioId, "open");
    const before = await countsFor(f.studioId);

    // The owner takes the lock first and holds it.
    await ownerHoldsLock(B, f.studioId, "closed");

    // The mutation begins under a stale `open` read and must block on the lock.
    await A.query("begin");
    const aPid = await pidOf(A);
    const pending = A.query(book(f, f.slot));
    expect(
      await waitUntilBlocked(aPid),
      "the mutation must wait for the owner's row lock",
    ).toBe(true);

    await B.query("commit");
    const refused = await pending;
    await A.query("commit");

    // It observed the NEW mode and refused. NO client row, NO appointment -
    // which is why the admission decision has to precede the insert.
    expect(refused.rows[0].result).toBe("new_client_admission_refused");
    expect(refused.rows[0].appointment_id).toBeNull();
    expect(refused.rows[0].client_id).toBeNull();
    expect(await countsFor(f.studioId)).toEqual(before);
    expect(await modeOf(f.studioId)).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// 2. DURABLE WAITLIST JOIN racing owner -> CLOSED
// ---------------------------------------------------------------------------
describe("2. durable waitlist join vs owner -> CLOSED", () => {
  const join = (f: Fixture) =>
    `select * from public.join_new_client_waitlist_guarded(
       '${f.studioId}'::uuid, 'Joiner', 'j-${randomUUID().slice(0, 8)}@harness.local',
       '+15550111', false)`;

  it("A. join first -> it COMMITS under WAITLIST, then the owner change applies", async () => {
    const f = await seed("join-a");
    await stamp(f.studioId, "waitlist");
    const before = await countsFor(f.studioId);

    await A.query("begin");
    const joined = await A.query(join(f));
    expect(joined.rows[0].result).toBe("created");
    expect(joined.rows[0].entry_id).not.toBeNull();

    const ownerPid = await pidOf(B);
    const owner = ownerHoldsLock(B, f.studioId, "closed");
    expect(await waitUntilBlocked(ownerPid)).toBe(true);

    await A.query("commit");
    await owner;
    await B.query("commit");

    expect((await countsFor(f.studioId)).entries).toBe(before.entries + 1);
    expect(await modeOf(f.studioId)).toBe("closed");
  });

  it("B. owner first -> the join WAITS, then REFUSES and writes no entry", async () => {
    const f = await seed("join-b");
    await stamp(f.studioId, "waitlist");
    const before = await countsFor(f.studioId);

    await ownerHoldsLock(B, f.studioId, "closed");

    await A.query("begin");
    const aPid = await pidOf(A);
    const pending = A.query(join(f));
    expect(await waitUntilBlocked(aPid)).toBe(true);

    await B.query("commit");
    const refused = await pending;
    await A.query("commit");

    expect(refused.rows[0].result).toBe("new_client_admission_refused");
    expect(refused.rows[0].entry_id).toBeNull();
    expect(await countsFor(f.studioId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 3. INVITATION BOOKING racing owner -> CLOSED
// ---------------------------------------------------------------------------
describe("3. invitation booking vs owner -> CLOSED", () => {
  /** An entry whose invitation is REDEEMED, which is what the 0195 command needs. */
  async function seedRedeemedInvitation(f: Fixture): Promise<string> {
    const entryId = randomUUID();
    await adminQuery(
      // `invited` carries its whole cycle evidence, which 0185's CHECK enforces:
      // claimed_at + claimed_by + invited_at, and nothing past that.
      `insert into public.new_client_waitlist_entries
         (id,studio_id,name,email,status,claimed_at,claimed_by_practitioner_id,invited_at)
       values ($1,$2,'Invited',$3,'invited',now(),$4,now())`,
      [entryId, f.studioId, f.existingClientEmail, f.ownerId],
    );
    await adminQuery(
      `insert into public.new_client_waitlist_invitations
         (studio_id,entry_id,token_hash,expires_at,issued_by_practitioner_id,redeemed_at)
       values ($1,$2,$3, now() + interval '7 days', $4, now())`,
      [f.studioId, entryId, hash64(), f.ownerId],
    );
    return entryId;
  }

  // ONE composed command for both commit paths, branching on the server-derived
  // entry id exactly as the application already did. The client is passed here
  // because the invitation requires an email match with the entry.
  const invitedBook = (f: Fixture, entryId: string, startsAt: string) =>
    `select * from public.create_public_appointment_for_new_client(
       '${f.studioId}'::uuid, '${f.existingClientId}'::uuid, null, null, null, null,
       '${f.serviceId}'::uuid, '${startsAt}'::timestamptz, '${hash64()}',
       false, null, null, '${entryId}'::uuid)`;

  it("A. invited booking first -> it COMMITS under WAITLIST, then the owner change applies", async () => {
    const f = await seed("inv-a");
    await stamp(f.studioId, "waitlist");
    const entryId = await seedRedeemedInvitation(f);
    const before = await countsFor(f.studioId);

    await A.query("begin");
    const booked = await A.query(invitedBook(f, entryId, f.slot));
    expect(
      booked.rows[0].result,
      `invited booking should commit; got ${booked.rows[0].result}`,
    ).toBe("created_and_converted");

    const ownerPid = await pidOf(B);
    const owner = ownerHoldsLock(B, f.studioId, "closed");
    expect(await waitUntilBlocked(ownerPid)).toBe(true);

    await A.query("commit");
    await owner;
    await B.query("commit");

    expect((await countsFor(f.studioId)).appointments).toBe(before.appointments + 1);
    expect(await modeOf(f.studioId)).toBe("closed");
  });

  it("B. owner first -> a VALID invitation still REFUSES, and spends nothing", async () => {
    const f = await seed("inv-b");
    await stamp(f.studioId, "waitlist");
    const entryId = await seedRedeemedInvitation(f);
    const before = await countsFor(f.studioId);

    await ownerHoldsLock(B, f.studioId, "closed");

    await A.query("begin");
    const aPid = await pidOf(A);
    const pending = A.query(invitedBook(f, entryId, f.slot));
    expect(await waitUntilBlocked(aPid)).toBe(true);

    await B.query("commit");
    const refused = await pending;
    await A.query("commit");

    // CLOSED beats a valid invitation, and the entry is not converted - the
    // refusal happens before the inner command can spend anything.
    expect(refused.rows[0].result).toBe("new_client_admission_refused");
    expect(refused.rows[0].appointment_id).toBeNull();
    expect(await countsFor(f.studioId)).toEqual(before);
    const entry = await adminQuery(
      `select status, converted_at from public.new_client_waitlist_entries where id = $1`,
      [entryId],
    );
    expect(entry.rows[0].converted_at).toBeNull();
    expect(entry.rows[0].status).toBe("invited");
  });
});

// ---------------------------------------------------------------------------
// The authority's other required properties, at the DB boundary.
// ---------------------------------------------------------------------------
describe("the commit-time authority's shape", () => {
  it("EXISTING-client ordinary booking is untouched by any mode", async () => {
    const f = await seed("existing");
    for (const mode of ["open", "waitlist", "closed"]) {
      await stamp(f.studioId, mode);
      // The command existing clients use, called exactly as it always was.
      const r = await adminQuery(
        `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
        [f.studioId, f.existingClientId, f.serviceId, f.altSlot, hash64()],
      );
      expect(
        r.rows[0].result,
        `existing-client booking must not consult admission (mode=${mode})`,
      ).toBe("created");
      await adminQuery(`delete from public.appointments where id = $1`, [
        r.rows[0].appointment_id,
      ]);
    }
  });

  it("a STAMPED mode overrides the legacy bridge input", async () => {
    const f = await seed("stamped-wins");
    await stamp(f.studioId, "closed");
    // Caller insists the legacy list says waitlist; the stamp says closed.
    const r = await adminQuery(
      `select public.effective_new_client_admission($1, true) as mode`,
      [f.studioId],
    );
    expect(r.rows[0].mode).toBe("closed");
  });

  it("an UNSTAMPED row keeps the supported bridge semantics", async () => {
    const f = await seed("unstamped");
    // 0204 backfills `open` with no stamp, which is what a pre-cutover row is.
    const bridged = await adminQuery(
      `select public.effective_new_client_admission($1, true) as mode`,
      [f.studioId],
    );
    expect(bridged.rows[0].mode).toBe("waitlist");
    const plain = await adminQuery(
      `select public.effective_new_client_admission($1, false) as mode`,
      [f.studioId],
    );
    expect(plain.rows[0].mode).toBe("open");
    // And an absent transition fact is UNKNOWN, never a guess.
    const unknown = await adminQuery(
      `select public.effective_new_client_admission($1, null) as mode`,
      [f.studioId],
    );
    expect(unknown.rows[0].mode).toBe("unknown");
  });

  it("a studio that does not exist is UNKNOWN, not the bridge default", async () => {
    const r = await adminQuery(
      `select public.effective_new_client_admission($1, true) as mode`,
      [randomUUID()],
    );
    expect(r.rows[0].mode).toBe("unknown");
  });

  it("the internal resolver and gate are granted to NOBODY", async () => {
    const r = await adminQuery(
      `select p.proname, coalesce(array_length(p.proacl, 1), 0) as acl_entries
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('effective_new_client_admission','assert_new_client_admission')
        order by p.proname`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const has = await adminQuery(
          `select has_function_privilege($1, $2 || '(uuid, boolean)', 'execute') as ok`,
          [role, `public.${row.proname}`],
        ).catch(() => null);
        if (has) expect(has.rows[0].ok).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE 23505 RACE IS REAL, BECAUSE NOT EVERY CLIENT WRITER TAKES THIS LOCK.
//
// The studios row lock serialises this command against transactions that acquire
// it. The practitioner "Add Client" surface does not: it inserts straight into
// `clients`. So it can land between the command's lookup and its insert, and the
// unique email index raises 23505. An uncaught exception would abort the whole
// RPC - and on the invitation path the redemption is already committed from an
// earlier request, leaving an invitation spent with no booking outcome.
// ---------------------------------------------------------------------------
describe("a client created WITHOUT the studio lock cannot abort the command", () => {
  it("returns one valid ACTIVE client, not a raw 23505", async () => {
    const f = await seed("race-active");
    await stamp(f.studioId, "open");
    const email = `race-${randomUUID().slice(0, 8)}@harness.local`;

    // Simulate the unlocked writer winning the index: the row exists by the time
    // the command inserts. The command's own lookup-then-insert, and its
    // unique-violation re-read, must both land on this row.
    const other = randomUUID();
    await adminQuery(
      `insert into public.clients (id,studio_id,name,email) values ($1,$2,'Added By Practitioner',$3)`,
      [other, f.studioId, email],
    );

    const r = await adminQuery(
      `select * from public.create_public_appointment_for_new_client(
         $1, null, 'Booker', $2, '+15550133', null, $3, $4::timestamptz, $5, false, null, null)`,
      [f.studioId, email, f.serviceId, f.slot, hash64()],
    );
    expect(r.rows[0].result).toBe("created");
    expect(r.rows[0].client_id).toBe(other);

    // ONE client for that email, and the appointment belongs to it.
    const clients = await adminQuery(
      `select count(*)::int as n from public.clients where studio_id = $1 and normalized_email = lower($2)`,
      [f.studioId, email],
    );
    expect(clients.rows[0].n).toBe(1);
    const appt = await adminQuery(
      `select client_id from public.appointments where id = $1`,
      [r.rows[0].appointment_id],
    );
    expect(appt.rows[0].client_id).toBe(other);
  });

  it("an ARCHIVED winner is refused generically, and writes nothing", async () => {
    const f = await seed("race-archived");
    await stamp(f.studioId, "open");
    const email = `arch-${randomUUID().slice(0, 8)}@harness.local`;
    await adminQuery(
      `insert into public.clients (id,studio_id,name,email,archived_at)
       values ($1,$2,'Archived',$3, now())`,
      [randomUUID(), f.studioId, email],
    );
    const before = await countsFor(f.studioId);

    const r = await adminQuery(
      `select * from public.create_public_appointment_for_new_client(
         $1, null, 'Booker', $2, '+15550134', null, $3, $4::timestamptz, $5, false, null, null)`,
      [f.studioId, email, f.serviceId, f.slot, hash64()],
    );
    expect(r.rows[0].result).toBe("archived_client_collision");
    expect(r.rows[0].appointment_id).toBeNull();
    expect(r.rows[0].client_id).toBeNull();
    expect(await countsFor(f.studioId)).toEqual(before);
  });

  it("an invited booking answers DEFINITELY on a collision, never by raising", async () => {
    // The invitation is already redeemed when this runs, so an exception would
    // leave it spent with no outcome. A defined answer is what lets the caller
    // tell "spent, not booked" apart from "unknown".
    const f = await seed("race-invited");
    await stamp(f.studioId, "waitlist");
    const entryId = randomUUID();
    await adminQuery(
      `insert into public.new_client_waitlist_entries
         (id,studio_id,name,email,status,claimed_at,claimed_by_practitioner_id,invited_at)
       values ($1,$2,'Invited',$3,'invited',now(),$4,now())`,
      [entryId, f.studioId, f.existingClientEmail, f.ownerId],
    );
    await adminQuery(
      `insert into public.new_client_waitlist_invitations
         (studio_id,entry_id,token_hash,expires_at,issued_by_practitioner_id,redeemed_at)
       values ($1,$2,$3, now() + interval '7 days', $4, now())`,
      [f.studioId, entryId, hash64(), f.ownerId],
    );
    await adminQuery(
      `update public.clients set archived_at = now() where id = $1`,
      [f.existingClientId],
    );

    const r = await adminQuery(
      `select * from public.create_public_appointment_for_new_client(
         $1, null, 'Invited', $2, '+15550135', null, $3, $4::timestamptz, $5, false, null, null, $6)`,
      [f.studioId, f.existingClientEmail, f.serviceId, f.slot, hash64(), entryId],
    );
    // A definite outcome, not an exception - and the entry is NOT converted.
    expect(["archived_client_collision", "client_not_created"]).toContain(
      r.rows[0].result,
    );
    const entry = await adminQuery(
      `select converted_at from public.new_client_waitlist_entries where id = $1`,
      [entryId],
    );
    expect(entry.rows[0].converted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE LEGACY EMAIL-ONLY TRANSITION BLOCK.
//
// That path commits through an external provider, so no check can make an owner
// mode change and an in-flight join mutually exclusive. Rather than fake
// atomicity, the concurrent transition is removed until the studio is durable.
// ---------------------------------------------------------------------------
describe("an email-only studio cannot be switched OPEN or CLOSED", () => {
  // AS THE OWNER, because the command re-derives `auth.uid()` and refuses anyone
  // who is not an ACTIVE OWNER of this studio - which `adminQuery` is not.
  const setMode = (f: Fixture, mode: string, legacyEmailOnly: boolean) =>
    asUser(f.userId, (q) =>
      q(`select * from public.set_new_client_admission_mode($1, $2, $3)`, [
        f.studioId,
        mode,
        legacyEmailOnly,
      ]),
    );

  it.each([["open"], ["closed"]])(
    "refuses %s while the studio still commits by email",
    async (mode) => {
      const f = await seed(`block-${mode}`);
      const r = await setMode(f, mode, true);
      expect(r.rows[0].outcome).toBe("legacy_waitlist_cutover_required");
      expect(r.rows[0].mode).toBeNull();
      // Nothing was written: the row is still unstamped.
      const row = await adminQuery(
        `select new_client_admission_mode as m, new_client_admission_mode_set_at as a
           from public.studios where id = $1`,
        [f.studioId],
      );
      expect(row.rows[0].a).toBeNull();
      expect(row.rows[0].m).toBe("open");
    },
  );

  it("WAITLIST is still allowed, and it IS the way out", async () => {
    const f = await seed("block-waitlist");
    // The cutover write itself, made while the studio is still email-only.
    const cut = await setMode(f, "waitlist", true);
    expect(cut.rows[0].outcome).toBe("ok");

    const row = await adminQuery(
      `select new_client_admission_mode as m, new_client_admission_mode_set_at as a
         from public.studios where id = $1`,
      [f.studioId],
    );
    expect(row.rows[0].m).toBe("waitlist");
    expect(row.rows[0].a).not.toBeNull();

    // Now persisted, so its commit is durable and full control is available.
    const a = await adminQuery(
      `select public.effective_new_client_admission($1, true) as mode`,
      [f.studioId],
    );
    expect(a.rows[0].mode).toBe("waitlist");
    for (const mode of ["open", "closed", "waitlist"]) {
      const r = await setMode(f, mode, false);
      expect(r.rows[0].outcome, `${mode} must be available after cutover`).toBe("ok");
    }
  });

  it("the block does not touch ordinary durable admission authority", async () => {
    // A durable studio - legacyEmailOnly false - keeps every transition.
    const f = await seed("block-none");
    for (const mode of ["waitlist", "closed", "open"]) {
      const r = await setMode(f, mode, false);
      expect(r.rows[0].outcome).toBe("ok");
    }
  });
});
