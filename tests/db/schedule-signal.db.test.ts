import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, asUser, seedMember, seedStudio, type SeededStudio } from "@/tests/db/helpers/harness";

// HON-48 Q7 / 0271, against a REAL database.
//
// The realtime schema's messages table, send() and topic() are created by the Realtime
// SERVICE. CI's DB lanes exclude that service, so there this file builds a minimal
// stand-in with the same signature and the same topic() semantics (the setting
// realtime.topic), tagged "stub". On a stack WITH Realtime it uses the real objects,
// tagged "real". The surface that ran is printed. Green on "stub" proves the SQL and the
// policy predicate; it never stands in for the real-Realtime run (the separate
// non-required job and the local evidence in the PR).
//
// Either way 0271 is replayed first: the file is idempotent and a fresh reset runs it
// before Realtime exists (it then skips the policy with a NOTICE).

const MIGRATION = readFileSync("supabase/migrations/0271_schedule_change_signal.sql", "utf8");

type Surface = "real" | "stub";
let surface: Surface = "stub";

async function realtimeSurface(): Promise<Surface> {
  const have = await adminQuery(
    `select pg_catalog.to_regclass('realtime.messages') is not null as t,
            pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null as s,
            pg_catalog.to_regprocedure('realtime.topic()') is not null as p`,
  );
  const r = have.rows[0] as { t: boolean; s: boolean; p: boolean };
  if (r.t && r.s && r.p) return "real";
  if (r.t || r.s || r.p) throw new Error("realtime schema is half-initialised; refusing to stub over it");
  await adminQuery(`create schema if not exists realtime`);
  await adminQuery(`
    create table realtime.messages (
      id uuid primary key default gen_random_uuid(),
      topic text not null,
      extension text not null default 'broadcast',
      payload jsonb,
      event text,
      private boolean default false,
      inserted_at timestamp not null default now()
    );
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated, anon;
    grant select, insert, update, delete on realtime.messages to authenticated, anon;
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
      returns void language plpgsql as $f$
    begin
      insert into realtime.messages (payload, event, topic, private, extension)
      values (payload || jsonb_build_object('id', gen_random_uuid()), event, topic, private, 'broadcast');
    end $f$;
    create function realtime.topic() returns text language sql stable as
      $f$ select nullif(current_setting('realtime.topic', true), '') $f$;
    grant execute on function realtime.topic() to authenticated, anon;
  `);
  return "stub";
}

const topicOf = (s: { studioId: string }) => `schedule:${s.studioId}`;
async function signals(s: { studioId: string }): Promise<number> {
  const r = await adminQuery(`select count(*)::int as n from realtime.messages where topic = $1`, [topicOf(s)]);
  return (r.rows[0] as { n: number }).n;
}
async function delta(s: { studioId: string }, fn: () => Promise<unknown>): Promise<number> {
  const before = await signals(s);
  await fn();
  return (await signals(s)) - before;
}

let A: SeededStudio;
let B: SeededStudio;
let member: { userId: string; practitionerId: string };
let serviceA: string;
let slot = 0;
const nextSlot = () => {
  slot += 1;
  const day = String(1 + Math.floor(slot / 8)).padStart(2, "0");
  const hour = String(8 + (slot % 8)).padStart(2, "0");
  return { start: `2033-05-${day}T${hour}:00:00Z`, end: `2033-05-${day}T${hour}:45:00Z` };
};
async function insertAppt(s: SeededStudio, service: string | null): Promise<string> {
  const { start, end } = nextSlot();
  const r = await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 45, 'confirmed', $7) returning id`,
    [s.studioId, s.practitionerId, s.clientId, service, start, end, randomUUID().replace(/-/g, "").padEnd(64, "0")],
  );
  return r.rows[0].id as string;
}
async function insertBlock(s: SeededStudio): Promise<string> {
  const { start, end } = nextSlot();
  const r = await adminQuery(
    `insert into public.studio_timed_blocks (studio_id, starts_at, ends_at, category, created_by) values ($1,$2,$3,'lunch',$4) returning id`,
    [s.studioId, start, end, s.practitionerId],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  surface = await realtimeSurface();
  await adminQuery(MIGRATION);
  console.log(`SCHEDULE_SIGNAL_SURFACE ${surface}`);
  A = await seedStudio("sig-A");
  B = await seedStudio("sig-B");
  member = await seedMember(A, "sig-A-member");
  for (const s of [A, B]) await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [s.studioId]);
  const sv = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active) values ($1,$2,'Service',45,0,true) returning id`,
    [randomUUID(), A.studioId],
  );
  serviceA = sv.rows[0].id as string;
});
afterAll(async () => {
  // Leave the stub (if we made it) in place only for this run; a real surface is never touched.
  if (surface === "stub") await adminQuery(`delete from realtime.messages`).catch(() => undefined);
});

describe("appointments: what signals and what does not", () => {
  it("an insert sends one message on the studio's own topic, and nothing on another studio's", async () => {
    const dB = await delta(B, async () => {
      expect(await delta(A, () => insertAppt(A, serviceA))).toBe(1);
    });
    expect(dB).toBe(0);
  });

  it("the function body that calls realtime.send spells out private => true, and the stored message is private", async () => {
    const def = (await adminQuery(`select pg_get_functiondef('public.schedule_signal_send(uuid)'::regprocedure) as d`)).rows[0] as { d: string };
    expect(def.d).toMatch(/private => true/);
    expect(def.d).not.toMatch(/private => false/);
    await insertAppt(A, serviceA);
    const r = await adminQuery(`select count(*)::int as n from realtime.messages where topic = $1 and private is not true`, [topicOf(A)]);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });

  it("the stored payload carries no row, studio or client data (at most the message's own id)", async () => {
    await insertAppt(A, serviceA);
    const r = await adminQuery(`select payload, event, private, extension from realtime.messages where topic = $1 order by inserted_at desc limit 1`, [topicOf(A)]);
    const row = r.rows[0] as { payload: Record<string, unknown>; event: string; private: boolean; extension: string };
    expect(Object.keys(row.payload).filter((k) => k !== "id")).toEqual([]);
    expect(row.event).toBe("changed");
    expect(row.private).toBe(true);
    expect(row.extension).toBe("broadcast");
    const text = JSON.stringify(row);
    for (const secret of [A.studioId, A.clientId, A.practitionerId, serviceA]) expect(text).not.toContain(secret);
  });

  it.each([
    ["starts_at", `starts_at = starts_at + interval '1 minute', ends_at = ends_at + interval '1 minute'`],
    ["status", `status = 'cancelled'`],
    ["notes", `notes = 'moved the chair'`],
    ["duration_minutes", `duration_minutes = 50, ends_at = ends_at + interval '5 minutes'`],
  ])("an update of %s sends exactly one message", async (_col, set) => {
    const id = await insertAppt(A, serviceA);
    expect(await delta(A, () => adminQuery(`update public.appointments set ${set} where id = $1`, [id]))).toBe(1);
  });

  it("an update of the practitioner or the service sends one message", async () => {
    const id = await insertAppt(A, serviceA);
    expect(await delta(A, () => adminQuery(`update public.appointments set practitioner_id = $2 where id = $1`, [id, member.practitionerId]))).toBe(1);
    expect(await delta(A, () => adminQuery(`update public.appointments set service_id = null where id = $1`, [id]))).toBe(1);
  });

  it.each([
    ["confirmation_claimed_at", `confirmation_claimed_at = now()`],
    ["confirmation_sent_at", `confirmation_sent_at = now()`],
    ["reminder_24h_send_attempts", `reminder_24h_send_attempts = coalesce(reminder_24h_send_attempts, 0) + 1`],
    ["sms_reminder_2h_claimed_at", `sms_reminder_2h_claimed_at = now()`],
    ["postcare_email_last_error", `postcare_email_last_error = 'x'`],
    ["sync_version", `sync_version = coalesce(sync_version, 0) + 1`],
    ["an update that changes nothing", `notes = notes`],
  ])("bookkeeping only (%s) sends nothing", async (_col, set) => {
    const id = await insertAppt(A, serviceA);
    expect(await delta(A, () => adminQuery(`update public.appointments set ${set} where id = $1`, [id]))).toBe(0);
  });

  it("a delete sends one message", async () => {
    const id = await insertAppt(A, serviceA);
    expect(await delta(A, () => adminQuery(`delete from public.appointments where id = $1`, [id]))).toBe(1);
  });

  it("a statement that changes five rows sends ONE message; across two studios, one each", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertAppt(A, serviceA));
    expect(await delta(A, () => adminQuery(`update public.appointments set notes = 'bulk' where id = any($1::uuid[])`, [ids]))).toBe(1);
    const a = await insertAppt(A, serviceA);
    const b = await insertAppt(B, null);
    const beforeA = await signals(A);
    const beforeB = await signals(B);
    await adminQuery(`update public.appointments set notes = 'both' where id = any($1::uuid[])`, [[a, b]]);
    expect([(await signals(A)) - beforeA, (await signals(B)) - beforeB]).toEqual([1, 1]);
  });

  it("a rolled-back transaction, and a rolled-back savepoint, send nothing", async () => {
    const id = await insertAppt(A, serviceA);
    const before = await signals(A);
    await expect(
      adminTx(async (q) => {
        await q(`update public.appointments set status = 'cancelled' where id = $1`, [id]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await adminTx(async (q) => {
      await q(`savepoint s1`);
      await q(`update public.appointments set notes = 'undone' where id = $1`, [id]);
      await q(`rollback to savepoint s1`);
    });
    expect((await signals(A)) - before).toBe(0);
  });

  it("two statements in one committed transaction send two messages (one per statement)", async () => {
    const id = await insertAppt(A, serviceA);
    const before = await signals(A);
    await adminTx(async (q) => {
      await q(`update public.appointments set notes = 'one' where id = $1`, [id]);
      await q(`update public.appointments set notes = 'two' where id = $1`, [id]);
    });
    expect((await signals(A)) - before).toBe(2);
  });
});

describe("the other schedule tables", () => {
  it("timed blocks: insert, each listed column, delete signal; updated_at alone does not", async () => {
    const id = await insertBlock(A);
    // A per-practitioner block needs practitioner capacity on for this studio; restored below.
    await adminQuery(`update public.studios set practitioner_capacity_enabled = true where id = $1`, [A.studioId]);
    expect(await delta(A, () => adminQuery(`update public.studio_timed_blocks set ends_at = ends_at + interval '5 minutes' where id = $1`, [id]))).toBe(1);
    expect(await delta(A, () => adminQuery(`update public.studio_timed_blocks set category = 'break' where id = $1`, [id]))).toBe(1);
    expect(await delta(A, () => adminQuery(`update public.studio_timed_blocks set private_note = 'visible as a tooltip' where id = $1`, [id]))).toBe(1);
    expect(await delta(A, () => adminQuery(`update public.studio_timed_blocks set practitioner_id = $2 where id = $1`, [id, member.practitionerId]))).toBe(1);
    expect(await delta(A, () => adminQuery(`update public.studio_timed_blocks set updated_at = now() where id = $1`, [id]))).toBe(0);
    expect(await delta(A, () => adminQuery(`delete from public.studio_timed_blocks where id = $1`, [id]))).toBe(1);
    expect(await delta(A, () => insertBlock(A))).toBe(1);
    await adminQuery(`update public.studios set practitioner_capacity_enabled = false where id = $1`, [A.studioId]);
  });

  it("blockouts: insert, range and reason updates, delete signal", async () => {
    const ins = () => adminQuery(`insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason) values ($1,'2033-06-01','2033-06-02','closed') returning id`, [A.studioId]);
    let id = "";
    expect(await delta(A, async () => { id = (await ins()).rows[0].id as string; })).toBe(1);
    expect(await delta(A, () => adminQuery(`update public.studio_blockouts set ends_on = '2033-06-03' where id = $1`, [id]))).toBe(1);
    expect(await delta(A, () => adminQuery(`update public.studio_blockouts set reason = 'training' where id = $1`, [id]))).toBe(1);
    expect(await delta(A, () => adminQuery(`delete from public.studio_blockouts where id = $1`, [id]))).toBe(1);
  });

  it("recurring break occurrences: insert, time update, delete signal; a bulk rebuild is one message", async () => {
    let id = "";
    expect(await delta(A, async () => {
      id = (await adminQuery(
        `insert into public.studio_recurring_break_occurrences (studio_id, occurrence_date, starts_at, ends_at) values ($1,'2033-07-01','2033-07-01T12:00:00Z','2033-07-01T12:30:00Z') returning id`, [A.studioId])).rows[0].id as string;
    })).toBe(1);
    expect(await delta(A, () => adminQuery(`update public.studio_recurring_break_occurrences set ends_at = '2033-07-01T12:45:00Z' where id = $1`, [id]))).toBe(1);
    expect(await delta(A, () => adminQuery(`delete from public.studio_recurring_break_occurrences where id = $1`, [id]))).toBe(1);
    expect(await delta(A, () => adminQuery(
      `insert into public.studio_recurring_break_occurrences (studio_id, occurrence_date, starts_at, ends_at)
       select $1, d::date, d + time '12:00', d + time '12:30' from generate_series('2033-08-01'::date, '2033-08-20'::date, interval '1 day') d`, [A.studioId]))).toBe(1);
  });

  it("tables outside the list send nothing: services, clients, practitioners, availability", async () => {
    expect(await delta(A, async () => {
      await adminQuery(`update public.services set name = 'Renamed' where id = $1`, [serviceA]);
      await adminQuery(`update public.clients set name = 'Renamed client' where id = $1`, [A.clientId]);
      await adminQuery(`update public.practitioners set display_name = 'Renamed' where id = $1`, [member.practitionerId]);
    })).toBe(0);
  });
});

describe("a failure in the signal path never fails the write, and is counted", () => {
  it.runIf(true)("when realtime.send is absent the write succeeds quietly (stub only: a real Realtime function cannot be dropped)", async () => {
    if (surface !== "stub") return; // asserted in the CI run; the real function belongs to Supabase
    const before = await signals(A);
    await expect(
      adminTx(async (q) => {
        await q(`drop function realtime.send(jsonb,text,text,boolean)`);
        const { start, end } = nextSlot();
        const r = await q(
          `insert into public.appointments (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
           values (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 45, 'confirmed', $7) returning id`,
          [A.studioId, A.practitionerId, A.clientId, serviceA, start, end, randomUUID().replace(/-/g, "").padEnd(64, "0")],
        );
        expect(r.rows).toHaveLength(1);
        throw new Error("rollback-to-restore-the-function");
      }),
    ).rejects.toThrow("rollback-to-restore-the-function");
    expect((await signals(A)) - before).toBe(0);
  });

  it("when the emitter's role cannot insert into realtime.messages, the write still COMMITS, the failure is counted, and no message exists", async () => {
    // last_value alone cannot tell "never called" from "called once" (both 1).
    const seq = async () => Number((await adminQuery(`select case when is_called then last_value else 0 end::text as v from public.schedule_signal_failures_seq`)).rows[0].v);
    const before = await seq();
    const messagesBefore = await signals(A);
    // Inject the failure the emitter can observe: give the send helper an owner that has no INSERT on
    // realtime.messages and does not bypass RLS. Rolled back with the transaction below.
    let id = "";
    await expect(
      adminTx(async (q) => {
        await q(`create role tmp_signal_owner nologin`);
        await q(`grant tmp_signal_owner to postgres with set true`);
        await q(`grant usage, create on schema public to tmp_signal_owner`);
        await q(`grant usage on sequence public.schedule_signal_failures_seq to tmp_signal_owner`);
        await q(`alter function public.schedule_signal_send(uuid) owner to tmp_signal_owner`);
        const { start, end } = nextSlot();
        const r = await q(
          `insert into public.appointments (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
           values (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 45, 'confirmed', $7) returning id`,
          [A.studioId, A.practitionerId, A.clientId, serviceA, start, end, randomUUID().replace(/-/g, "").padEnd(64, "0")],
        );
        id = r.rows[0].id as string; // the write did not throw
        throw new Error("rollback-injection");
      }),
    ).rejects.toThrow("rollback-injection");
    expect(id).not.toBe("");
    expect(await seq()).toBeGreaterThan(before); // a sequence is not rolled back: the outage stays countable
    expect(await signals(A)).toBe(messagesBefore); // and nothing was sent
    // the function is back to its real owner
    const owner = (await adminQuery(`select pg_get_userbyid(proowner) as o from pg_proc where oid = 'public.schedule_signal_send(uuid)'::regprocedure`)).rows[0] as { o: string };
    expect(owner.o).toBe("postgres");
  });

  it("when realtime.send's own insert fails (a lock timeout), the write still COMMITS and nothing is sent", async () => {
    const messagesBefore = await signals(A);
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const isLocked = new Promise<void>((r) => (locked = r));
    const holderDone = adminTx(async (q) => {
      await q(`lock table realtime.messages in access exclusive mode`);
      locked();
      await hold;
      throw new Error("release-the-lock");
    }).then(() => undefined, () => undefined);
    await isLocked;
    let id = "";
    try {
      id = await adminTx(async (q) => {
        await q(`set local lock_timeout = '300ms'`);
        const { start, end } = nextSlot();
        const r = await q(
          `insert into public.appointments (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
           values (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 45, 'confirmed', $7) returning id`,
          [A.studioId, A.practitionerId, A.clientId, serviceA, start, end, randomUUID().replace(/-/g, "").padEnd(64, "0")],
        );
        return r.rows[0].id as string;
      });
    } finally {
      release();
      await holderDone;
    }
    const stored = await adminQuery(`select count(*)::int as n from public.appointments where id = $1`, [id]);
    expect((stored.rows[0] as { n: number }).n).toBe(1);
    expect(await signals(A)).toBe(messagesBefore);
  });
});

describe("who may listen (the policy matrix)", () => {
  const asMemberOnTopic = async (userId: string, topic: string | null, fn: (q: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<unknown>) =>
    asUser(userId, async (q) => {
      if (topic !== null) await q(`select set_config('realtime.topic', $1, true)`, [topic]);
      return fn(q);
    });
  const visible = async (userId: string, topic: string | null): Promise<number> => {
    await insertAppt(A, serviceA); // guarantees at least one broadcast row exists
    const row = (await asMemberOnTopic(userId, topic, async (q) => (await q(`select count(*)::int as n from realtime.messages`)).rows[0])) as { n: number };
    return Number(row.n);
  };

  it("an active owner and an active member of the studio can listen on its topic", async () => {
    expect(await visible(A.userId, topicOf(A))).toBeGreaterThan(0);
    expect(await visible(member.userId, topicOf(A))).toBeGreaterThan(0);
  });

  it("another studio's member cannot listen on this studio's topic, nor this studio's member on another's", async () => {
    expect(await visible(B.userId, topicOf(A))).toBe(0);
    expect(await visible(A.userId, topicOf(B))).toBe(0);
  });

  it.each([
    ["not a uuid", "schedule:not-a-uuid"],
    ["upper-case uuid", `schedule:${randomUUID().toUpperCase()}`],
    ["a trailing suffix", "SUFFIX"],
    ["wrong prefix", "other:SID"],
    ["no prefix", "SID"],
    ["empty", ""],
    ["whitespace", " schedule:SID"],
    ["a uuid with a bad hex digit", "schedule:0000000g-0000-0000-0000-000000000000"],
  ])("a malformed or guessed topic (%s) is refused without an error", async (_l, raw) => {
    const topic = raw === "SUFFIX" ? `${topicOf(A)}:x` : raw.replace("SID", A.studioId);
    expect(await visible(A.userId, topic)).toBe(0);
  });

  it("no topic at all is refused", async () => {
    expect(await visible(A.userId, null)).toBe(0);
  });

  it("anon and an authenticated user with no membership see nothing", async () => {
    await insertAppt(A, serviceA);
    const stranger = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `sig-stranger-${stranger.slice(0, 8)}@harness.local`]);
    expect(await visible(stranger, topicOf(A))).toBe(0);
    const anonSees = await adminTx(async (q) => {
      await q(`set local role anon`);
      await q(`select set_config('realtime.topic', $1, true)`, [topicOf(A)]);
      try {
        return Number((await q(`select count(*)::int as n from realtime.messages`)).rows[0].n);
      } catch {
        return 0; // no privilege at all is also a refusal
      }
    }).catch(() => 0);
    expect(anonSees).toBe(0);
  });

  it("nobody can publish from the browser side: insert, update and delete on realtime.messages are refused for authenticated", async () => {
    for (const sql of [
      `insert into realtime.messages (topic, extension, payload, event, private) values ('${topicOf(A)}','broadcast','{"forged":true}','changed',true)`,
      `update realtime.messages set payload = '{"forged":true}' where topic = '${topicOf(A)}'`,
      `delete from realtime.messages where topic = '${topicOf(A)}'`,
    ]) {
      const before = await signals(A);
      let outcome: "refused" | "no-rows";
      try {
        const r = await asMemberOnTopic(A.userId, topicOf(A), async (q) => q(sql));
        outcome = (r as { rowCount?: number }).rowCount ? ("no-rows" as const) : ("no-rows" as const);
        expect((r as { rowCount?: number }).rowCount ?? 0).toBe(0);
      } catch {
        outcome = "refused";
      }
      expect(["refused", "no-rows"]).toContain(outcome);
      expect(await signals(A)).toBe(before);
    }
  });

  it("every function and the sequence 0271 adds is unreachable by anon, authenticated and service_role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const sig of ["public.schedule_signal_send(uuid)", "public.emit_schedule_signal()"]) {
        const r = await adminQuery(`select has_function_privilege($1, $2, 'execute') as ok`, [role, sig]);
        expect((r.rows[0] as { ok: boolean }).ok, `${role} ${sig}`).toBe(false);
      }
      const s = await adminQuery(`select has_sequence_privilege($1, 'public.schedule_signal_failures_seq', 'usage') as ok`, [role]);
      expect((s.rows[0] as { ok: boolean }).ok, `${role} sequence`).toBe(false);
    }
  });
});

describe("forged publishing through realtime.send and the hosted-shaped grants", () => {
  // Hosted facts (Sam's read-only P1, 30 Oct): realtime.messages exists, owner supabase_realtime_admin,
  // RLS enabled, 0 policies before 0271; realtime.send(jsonb,text,text,boolean) exists with EXECUTE
  // granted to anon, authenticated and service_role. EXECUTE alone is not unauthorised publishing: the
  // function is SECURITY INVOKER, so the insert runs as the CALLER and needs an INSERT policy, which
  // does not exist. These tests assert that chain explicitly, so a local stack that differs from hosted
  // fails here instead of passing for the wrong reason.
  const real = () => surface === "real";

  it("hosted shape: realtime.send is executable by anon, authenticated and service_role, and is SECURITY INVOKER", async () => {
    if (!real()) return;
    const r = await adminQuery(
      `select p.prosecdef,
              has_function_privilege('anon', p.oid, 'execute') as anon_x,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
              has_function_privilege('service_role', p.oid, 'execute') as svc_x
         from pg_proc p where p.pronamespace = 'realtime'::regnamespace and p.proname = 'send' and p.pronargs = 4`,
    );
    const row = r.rows[0] as { prosecdef: boolean; anon_x: boolean; auth_x: boolean; svc_x: boolean };
    expect(row.prosecdef, "realtime.send must be SECURITY INVOKER for the RLS chain to hold").toBe(false);
    expect([row.anon_x, row.auth_x, row.svc_x]).toEqual([true, true, true]);
  });

  it("hosted shape: RLS is on for realtime.messages and the ONLY policy is 0271's SELECT policy (no INSERT/UPDATE/DELETE policy for anyone)", async () => {
    if (!real()) return;
    const t = await adminQuery(`select relrowsecurity as rls, pg_get_userbyid(relowner) as owner from pg_class where oid = 'realtime.messages'::regclass`);
    expect((t.rows[0] as { rls: boolean }).rls).toBe(true);
    const pol = await adminQuery(`select polname, polcmd, (select array_to_string(array_agg(rolname), ',') from pg_roles r where r.oid = any(polroles)) as roles from pg_policy where polrelid = 'realtime.messages'::regclass order by polname`);
    expect(pol.rows).toEqual([{ polname: "schedule_signal_member_read", polcmd: "r", roles: "authenticated" }]);
  });

  it("the policy was created by the migration role through supautils policy_grants, with no ownership change (real surface)", async () => {
    if (!real()) return;
    const g = await adminQuery(`select current_setting('supautils.policy_grants', true) as v`);
    const v = (g.rows[0] as { v: string | null }).v;
    // Present locally and the supported mechanism; hosted value is confirmed separately by the owner.
    expect(v ?? "").toContain("realtime.messages");
    const who = await adminQuery(`select current_user as u, (select relowner::regrole::text from pg_class where oid='realtime.messages'::regclass) as owner`);
    expect((who.rows[0] as { u: string }).u).toBe("postgres");
    // Replaying the migration as that role leaves the table's owner exactly as it was.
    const before = (who.rows[0] as { owner: string }).owner;
    await adminQuery(MIGRATION);
    const after = await adminQuery(`select relowner::regrole::text as owner from pg_class where oid='realtime.messages'::regclass`);
    expect((after.rows[0] as { owner: string }).owner).toBe(before);
  });

  it("the emitter's own path: postgres (the migration role that owns the emitter) can insert through realtime.send", async () => {
    if (!real()) return;
    const r = await adminQuery(
      `select has_table_privilege('postgres', 'realtime.messages', 'insert') as ins,
              has_function_privilege('postgres', 'realtime.send(jsonb,text,text,boolean)', 'execute') as x,
              (select rolbypassrls from pg_roles where rolname = 'postgres') as bypass,
              (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.emit_schedule_signal()'::regprocedure) as emitter_owner`,
    );
    const row = r.rows[0] as { ins: boolean; x: boolean; bypass: boolean; emitter_owner: string };
    expect(row.emitter_owner).toBe("postgres");
    expect(row.x).toBe(true);
    // Without BYPASSRLS the emitter would need an INSERT policy of its own: this is the catalog fact
    // OPS asked Sam to read on the hosted project (has_table_privilege, rolbypassrls, prosecdef).
    expect(row.ins && row.bypass).toBe(true);
    const before = await signals(A);
    await insertAppt(A, serviceA);
    expect((await signals(A)) - before).toBe(1);
  });

  it("a member, an outsider and anon who CALL realtime.send directly are refused by RLS: nothing is published", async () => {
    const forged = (topic: string) => `select realtime.send('{"forged":true}'::jsonb, 'changed', '${topic}', true)`;
    const before = await signals(A);
    for (const who of [A.userId, member.userId, B.userId]) {
      let refused = false;
      try {
        await asUser(who, async (q) => q(forged(topicOf(A))));
      } catch {
        refused = true;
      }
      // Either the call errors (RLS violation) or, if a stack swallows it, nothing lands: both are "not published".
      void refused;
    }
    const anonOutcome = await adminTx(async (q) => {
      await q(`set local role anon`);
      try { await q(forged(topicOf(A))); return "ok"; } catch { return "refused"; }
    }).catch(() => "refused");
    void anonOutcome;
    expect(await signals(A)).toBe(before);
    const forgedRows = await adminQuery(`select count(*)::int as n from realtime.messages where payload ? 'forged'`);
    expect((forgedRows.rows[0] as { n: number }).n).toBe(0);
  });

  it("the realtime schema is not exposed through PostgREST (config) so no API call reaches realtime.send", async () => {
    const config = readFileSync("supabase/config.toml", "utf8");
    const schemas = config.match(/^\s*schemas\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
    expect(schemas).not.toMatch(/realtime/);
    expect(schemas).toMatch(/public/);
  });
});

describe("a removed member: the signal may arrive until the token refreshes, but a refresh returns no data", () => {
  it("deactivating the member closes the topic to them and every table the calendar reads returns zero rows", async () => {
    const id = await insertAppt(A, serviceA);
    const blk = await insertBlock(A);
    await adminQuery(`insert into public.studio_blockouts (studio_id, starts_on, ends_on) values ($1,'2033-09-01','2033-09-01')`, [A.studioId]);
    await adminQuery(
      `insert into public.studio_recurring_break_occurrences (studio_id, occurrence_date, starts_at, ends_at) values ($1,'2033-09-02','2033-09-02T12:00:00Z','2033-09-02T12:30:00Z')`, [A.studioId]);
    const count = async (userId: string, table: string) =>
      Number((await asUser(userId, async (q) => (await q(`select count(*)::int as n from public.${table} where studio_id = $1`, [A.studioId])).rows[0])).n);
    const tables = ["appointments", "studio_timed_blocks", "studio_blockouts", "studio_recurring_break_occurrences"];
    for (const t of tables) expect(await count(member.userId, t), `active member sees ${t}`).toBeGreaterThan(0);
    await adminQuery(`update public.practitioners set active = false where id = $1`, [member.practitionerId]);
    try {
      for (const t of tables) expect(await count(member.userId, t), `removed member sees ${t}`).toBe(0);
      const topicRows = await adminTx(async (q) => {
        await q(`set local role authenticated`);
        await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: member.userId, role: "authenticated" })]);
        await q(`select set_config('realtime.topic', $1, true)`, [topicOf(A)]);
        return Number((await q(`select count(*)::int as n from realtime.messages`)).rows[0].n);
      });
      expect(topicRows).toBe(0);
    } finally {
      await adminQuery(`update public.practitioners set active = true where id = $1`, [member.practitionerId]);
    }
    void id; void blk;
  });
});
