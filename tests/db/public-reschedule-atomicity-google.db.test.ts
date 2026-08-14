import { afterAll, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { randomUUID } from "node:crypto";

// ===========================================================================
// 0171, FAILURE-INJECTION ATOMICITY + REAL GOOGLE LINK REBIND
// ===========================================================================
//
// WHY THIS FILE EXISTS. The concurrency suite proves that a caller-issued
// ROLLBACK undoes the command, which is ordinary Postgres, not evidence about
// the command. What matters is that a failure of a MANDATORY INTERNAL STEP,
// after earlier statements in the same command have already executed, rolls the
// whole thing back: original still confirmed, its reservation intact, no
// successor, no audits, no acknowledgement, no partial lineage, no Google churn.
//
// HOW THE FAILURES ARE INJECTED. Test-only triggers, created inside the test
// and dropped in afterEach. They fire only on a synthetic row belonging to the
// test's own fixture, raise a uniquely identifiable SQLSTATE, and touch nothing
// in the migration. No production GUC or bypass is introduced, and
// `snapshot_appointment_buffer`, which is DRIFTED in production and must never
// be redefined from repo source, is not touched.
//
// The Google half seeds a REAL outbound-intent configuration so
// `enqueue_calendar_outbound` runs its live branches for the first time: the
// deployed trigger suppresses the delete on cancellation_kind='rescheduled' and
// REBINDS the predecessor's calendar_event_links row onto a successor carrying
// rescheduled_from_appointment_id. Nothing calls Google; the worker stays off.

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
const INJECT_SQLSTATE = "HB999";

type Fixture = {
  studioId: string;
  ownerId: string;
  clientId: string;
  serviceId: string;
  originalId: string;
  originalHash: string;
  originalStart: string;
};

function at(days: number, hh: number, mm = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

async function seed(
  label: string,
  opts: { policy?: string | null } = {},
): Promise<Fixture> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const clientId = randomUUID();
  const serviceId = randomUUID();
  const originalId = randomUUID();
  const originalHash = hash64();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;

  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios
       (id, name, owner_email, timezone, buffer_minutes, slug,
        public_booking_horizon_months, cancellation_policy_text)
     values ($1,$2,$3,'UTC',15,$4,3,$5)`,
    [studioId, `Atom ${label}`, email, `${label}-${studioId.slice(0, 8)}`, opts.policy ?? null],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,'Owner',$4,'owner',true)`,
    [ownerId, studioId, userId, email],
  );
  await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1,$2,'C',$3)`, [
    clientId,
    studioId,
    `c-${studioId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1,$2,'S',45,true)`,
    [serviceId, studioId],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '00:00', '23:59', null from generate_series(0,6) g`,
    [studioId],
  );
  const originalStart = at(10, 14, 0);
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values ($1,$2,$3,$4,$5,$6, $6::timestamptz + make_interval(mins => 45), 45,
             'confirmed', $7)`,
    [originalId, studioId, ownerId, clientId, serviceId, originalStart, originalHash],
  );
  return { studioId, ownerId, clientId, serviceId, originalId, originalHash, originalStart };
}

async function call(f: Fixture, newStart: string, ack = true, presented: string | null = null) {
  const r = await adminQuery(
    `select * from public.reschedule_appointment_v2($1,$2,$3,$4,$5,$6)`,
    [f.originalId, f.originalHash, newStart, hash64(), ack, presented],
  );
  return r.rows[0];
}

// --- test-only failure injection -------------------------------------------

const injected: string[] = [];

/**
 * Installs a test-only trigger that raises INJECT_SQLSTATE, scoped to rows of
 * ONE studio so no other test is affected. Dropped in afterEach.
 */
async function inject(
  name: string,
  table: string,
  timing: "before" | "after",
  event: "insert" | "update",
  predicate: string,
): Promise<void> {
  await adminQuery(`
    create or replace function public.${name}_fn() returns trigger
    language plpgsql as $fn$
    begin
      if ${predicate} then
        raise exception 'injected failure: ${name}' using errcode = '${INJECT_SQLSTATE}';
      end if;
      return new;
    end $fn$;
  `);
  await adminQuery(
    `create trigger ${name} ${timing} ${event} on public.${table}
       for each row execute function public.${name}_fn()`,
  );
  injected.push(`${name}|${table}`);
}

afterEach(async () => {
  for (const entry of injected.splice(0)) {
    const [name, table] = entry.split("|");
    await adminQuery(`drop trigger if exists ${name} on public.${table}`);
    await adminQuery(`drop function if exists public.${name}_fn()`);
  }
});

afterAll(async () => {
  await closePool();
});

/** Full rollback invariant: nothing the command would have written survives. */
async function expectFullRollback(f: Fixture): Promise<void> {
  const orig = (
    await adminQuery(`select * from public.appointments where id = $1`, [f.originalId])
  ).rows[0];
  expect(orig.status).toBe("confirmed");
  expect(orig.cancellation_kind).toBeNull();
  expect(orig.cancelled_at).toBeNull();
  expect(orig.cancelled_by).toBeNull();
  expect(orig.rescheduled_to_appointment_id).toBeNull();
  expect(orig.cancellation_token_hash).toBe(f.originalHash);

  const successors = await adminQuery(
    `select count(*)::int n from public.appointments where rescheduled_from_appointment_id = $1`,
    [f.originalId],
  );
  expect(successors.rows[0].n).toBe(0);

  const total = await adminQuery(
    `select count(*)::int n from public.appointments where studio_id = $1`,
    [f.studioId],
  );
  expect(total.rows[0].n).toBe(1);

  const audits = await adminQuery(
    `select count(*)::int n from public.appointment_audit aa
       join public.appointments a on a.id = aa.appointment_id
      where a.studio_id = $1`,
    [f.studioId],
  );
  expect(audits.rows[0].n).toBe(0);

  const acks = await adminQuery(
    `select count(*)::int n from public.appointment_policy_acknowledgements where studio_id = $1`,
    [f.studioId],
  );
  expect(acks.rows[0].n).toBe(0);

  const res = await adminQuery(
    `select source_id from public.studio_calendar_reservations
      where source_kind = 'appointment' and studio_id = $1`,
    [f.studioId],
  );
  expect(res.rows).toHaveLength(1);
  expect(res.rows[0].source_id).toBe(f.originalId);

  const outbox = await adminQuery(
    `select count(*)::int n from public.calendar_sync_outbox where studio_id = $1`,
    [f.studioId],
  );
  expect(outbox.rows[0].n).toBe(0);
}

// ===========================================================================

describe("0171: mandatory-step failure injection rolls the whole command back", () => {
  it("STEP D: original cancellation UPDATE fails", async () => {
    const f = await seed("stepD");
    await inject(
      "t_fail_cancel",
      "appointments",
      "before",
      "update",
      `new.id = '${f.originalId}'::uuid and new.status = 'cancelled'`,
    );
    await expect(call(f, at(11, 10, 0))).rejects.toThrow(/injected failure: t_fail_cancel/);
    await expectFullRollback(f);
  });

  it("STEP E: successor INSERT fails AFTER the original was already cancelled", async () => {
    const f = await seed("stepE");
    await inject(
      "t_fail_insert",
      "appointments",
      "before",
      "insert",
      `new.rescheduled_from_appointment_id = '${f.originalId}'::uuid`,
    );
    await expect(call(f, at(11, 10, 0))).rejects.toThrow(/injected failure: t_fail_insert/);
    // Proof the earlier statement HAD executed before the injected failure:
    // the trigger only fires on an INSERT carrying the lineage the command sets
    // in step E, which is reachable only after step D's UPDATE ran.
    await expectFullRollback(f);
  });

  it("STEP G(1): the original's cancellation audit fails", async () => {
    const f = await seed("stepG1");
    await inject(
      "t_fail_audit_cancel",
      "appointment_audit",
      "before",
      "insert",
      `new.appointment_id = '${f.originalId}'::uuid and new.action = 'cancelled'`,
    );
    await expect(call(f, at(11, 10, 0))).rejects.toThrow(/injected failure: t_fail_audit_cancel/);
    await expectFullRollback(f);
  });

  it("STEP G(2): the successor's creation audit fails, after the first audit succeeded", async () => {
    const f = await seed("stepG2");
    await inject(
      "t_fail_audit_create",
      "appointment_audit",
      "before",
      "insert",
      `new.action = 'created' and new.details->>'source' = 'reschedule_link'
         and new.details->>'original_appointment_id' = '${f.originalId}'`,
    );
    await expect(call(f, at(11, 10, 0))).rejects.toThrow(/injected failure: t_fail_audit_create/);
    await expectFullRollback(f);
  });

  it("STEP F: the reverse-lineage UPDATE fails", async () => {
    const f = await seed("stepF");
    await inject(
      "t_fail_reverse_lineage",
      "appointments",
      "before",
      "update",
      `new.id = '${f.originalId}'::uuid and new.rescheduled_to_appointment_id is not null`,
    );
    await expect(call(f, at(11, 10, 0))).rejects.toThrow(/injected failure: t_fail_reverse_lineage/);
    // The successor existed at the moment this fired, it must be gone.
    await expectFullRollback(f);
  });

  it("STEP H: the policy acknowledgement INSERT fails", async () => {
    const f = await seed("stepH", { policy: "Cancel 24h ahead." });
    const presented = (
      await adminQuery(
        `select encode(extensions.digest(
                  coalesce(cancellation_policy_text,'') || E'\\n---\\n' ||
                  coalesce(no_show_policy_text,''), 'sha256'),'hex') h
           from public.studios where id = $1`,
        [f.studioId],
      )
    ).rows[0].h;

    await inject(
      "t_fail_ack",
      "appointment_policy_acknowledgements",
      "before",
      "insert",
      `new.studio_id = '${f.studioId}'::uuid`,
    );
    await expect(call(f, at(11, 10, 0), true, presented)).rejects.toThrow(
      /injected failure: t_fail_ack/,
    );
    await expectFullRollback(f);
  });

  it("TRIGGER: successor reservation synchronisation fails", async () => {
    const f = await seed("stepRes");
    await inject(
      "t_fail_reservation",
      "studio_calendar_reservations",
      "before",
      "insert",
      `new.studio_id = '${f.studioId}'::uuid and new.source_id <> '${f.originalId}'::uuid`,
    );
    await expect(call(f, at(11, 10, 0))).rejects.toThrow(/injected failure: t_fail_reservation/);
    await expectFullRollback(f);
  });

  it("CONTROL: with no injection the same fixture succeeds", async () => {
    const f = await seed("stepControl");
    const out = await call(f, at(11, 10, 0));
    expect(out.result).toBe("success");
  });
});

// ===========================================================================
// GOOGLE CALENDAR, the deployed transition, exercised for the first time.
// ===========================================================================

type GoogleFixture = Fixture & { connectionId: string; linkId: string | null };

/**
 * Seeds outbound INTENT (studio flag + owner connection + write calendar), and
 * optionally an active predecessor link. The WORKER stays off, enqueue intent
 * does not require worker execution, and nothing here contacts Google.
 */
async function seedGoogle(
  label: string,
  opts: { withPredecessorLink: boolean },
): Promise<GoogleFixture> {
  const f = await seed(label);
  await adminQuery(
    `update public.studios set google_calendar_outbound_sync_enabled = true where id = $1`,
    [f.studioId],
  );
  const connectionId = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, provider, connection_status,
        is_studio_calendar_owner, granted_scopes, write_calendar_id,
        sync_generation, reconcile_generation)
     values ($1,$2,$3,'google','connected',true,
             array['https://www.googleapis.com/auth/calendar.app.created'],
             'cal_harness', 1, 1)`,
    [connectionId, f.studioId, f.ownerId],
  );

  let linkId: string | null = null;
  if (opts.withPredecessorLink) {
    linkId = randomUUID();
    await adminQuery(
      `insert into public.calendar_event_links
         (id, studio_id, connection_id, hone_entity_type, hone_entity_id,
          google_calendar_id, google_event_id, last_hone_version, sync_status, source_system)
       values ($1,$2,$3,'appointment',$4,'cal_harness','hone1evt_predecessor',1,'synced','hone')`,
      [linkId, f.studioId, connectionId, f.originalId],
    );
  }
  return { ...f, connectionId, linkId };
}

describe("0171 Google, G1: the predecessor link is REBOUND onto the successor", () => {
  it("rebinds in place, keeps the provider identity, and enqueues no delete", async () => {
    const f = await seedGoogle("g1", { withPredecessorLink: true });
    const before = (
      await adminQuery(`select * from public.calendar_event_links where id = $1`, [f.linkId])
    ).rows[0];
    expect(before.hone_entity_id).toBe(f.originalId);
    expect(before.google_event_id).toBe("hone1evt_predecessor");

    const out = await call(f, at(11, 10, 0));
    expect(out.result).toBe("success");

    // The original is cancelled as a RESCHEDULE, which is what suppresses the
    // delete branch of enqueue_calendar_outbound.
    const orig = (
      await adminQuery(
        `select status, cancellation_kind from public.appointments where id = $1`,
        [f.originalId],
      )
    ).rows[0];
    expect(orig.status).toBe("cancelled");
    expect(orig.cancellation_kind).toBe("rescheduled");

    const deletes = await adminQuery(
      `select count(*)::int n from public.calendar_sync_outbox
        where studio_id = $1 and op_type = 'event.delete'`,
      [f.studioId],
    );
    expect(deletes.rows[0].n).toBe(0);

    // THE REBIND: same row id, now pointing at the successor.
    const links = await adminQuery(
      `select * from public.calendar_event_links where studio_id = $1`,
      [f.studioId],
    );
    expect(links.rows).toHaveLength(1);
    const after = links.rows[0];
    expect(after.id).toBe(f.linkId);
    expect(after.hone_entity_id).toBe(out.new_appointment_id);
    expect(after.deleted_at).toBeNull();
    // External identity preserved: the client's calendar event is not recreated.
    expect(after.google_event_id).toBe("hone1evt_predecessor");
    expect(after.google_calendar_id).toBe("cal_harness");
    expect(after.connection_id).toBe(f.connectionId);
  });
});

describe("0171 Google, G2: the exact successor operation", () => {
  it("enqueues exactly one event.update for the successor, with no delete+create pair", async () => {
    const f = await seedGoogle("g2", { withPredecessorLink: true });
    const out = await call(f, at(11, 10, 0));
    expect(out.result).toBe("success");

    const ops = await adminQuery(
      `select op_type, hone_entity_id, idempotency_key, payload
         from public.calendar_sync_outbox where studio_id = $1 order by created_at`,
      [f.studioId],
    );
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0].op_type).toBe("event.update");
    expect(ops.rows[0].hone_entity_id).toBe(out.new_appointment_id);

    const succ = (
      await adminQuery(`select sync_version from public.appointments where id = $1`, [
        out.new_appointment_id,
      ])
    ).rows[0];
    expect(ops.rows[0].idempotency_key).toBe(
      `appointment:${out.new_appointment_id}:event.update:${succ.sync_version}`,
    );
    expect(ops.rows[0].payload.sync_version).toBe(succ.sync_version);

    // No create for the successor and no delete for the original.
    const kinds = await adminQuery(
      `select op_type, count(*)::int n from public.calendar_sync_outbox
        where studio_id = $1 group by op_type`,
      [f.studioId],
    );
    expect(kinds.rows.map((r: { op_type: string }) => r.op_type).sort()).toEqual([
      "event.update",
    ]);
  });
});

describe("0171 Google, G3: no predecessor link", () => {
  it("follows the normal create path with no phantom rebind and no delete", async () => {
    const f = await seedGoogle("g3", { withPredecessorLink: false });
    const out = await call(f, at(11, 10, 0));
    expect(out.result).toBe("success");

    const links = await adminQuery(
      `select hone_entity_id, google_event_id, last_hone_version, sync_status
         from public.calendar_event_links where studio_id = $1`,
      [f.studioId],
    );
    // Exactly one placeholder link, for the SUCCESSOR, never for the original.
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0].hone_entity_id).toBe(out.new_appointment_id);
    expect(links.rows[0].google_event_id).toBeNull();

    const ops = await adminQuery(
      `select op_type from public.calendar_sync_outbox where studio_id = $1`,
      [f.studioId],
    );
    expect(ops.rows.map((r: { op_type: string }) => r.op_type)).toEqual(["event.create"]);
  });
});

describe("0171 Google, G4: rollback AFTER the rebind has happened", () => {
  it("restores the predecessor link and the outbox when a later mandatory step fails", async () => {
    const f = await seedGoogle("g4", { withPredecessorLink: true });

    // Fail the SECOND audit: which runs after the successor INSERT has already
    // driven the link rebind and the outbox insert.
    await inject(
      "t_fail_after_rebind",
      "appointment_audit",
      "before",
      "insert",
      `new.action = 'created' and new.details->>'original_appointment_id' = '${f.originalId}'`,
    );
    await expect(call(f, at(11, 10, 0))).rejects.toThrow(/injected failure: t_fail_after_rebind/);

    // The link is back on the ORIGINAL, at its original version.
    const link = (
      await adminQuery(`select * from public.calendar_event_links where id = $1`, [f.linkId])
    ).rows[0];
    expect(link.hone_entity_id).toBe(f.originalId);
    expect(Number(link.last_hone_version)).toBe(1);
    expect(link.sync_status).toBe("synced");
    expect(link.google_event_id).toBe("hone1evt_predecessor");

    const outbox = await adminQuery(
      `select count(*)::int n from public.calendar_sync_outbox where studio_id = $1`,
      [f.studioId],
    );
    expect(outbox.rows[0].n).toBe(0);

    await expectFullRollback(f);
  });
});

describe("0171 Google, G5: outbound intent OFF", () => {
  it("creates no outbox row and no link", async () => {
    const f = await seed("g5"); // flag stays false, no connection
    const out = await call(f, at(11, 10, 0));
    expect(out.result).toBe("success");

    const outbox = await adminQuery(
      `select count(*)::int n from public.calendar_sync_outbox where studio_id = $1`,
      [f.studioId],
    );
    expect(outbox.rows[0].n).toBe(0);
    const links = await adminQuery(
      `select count(*)::int n from public.calendar_event_links where studio_id = $1`,
      [f.studioId],
    );
    expect(links.rows[0].n).toBe(0);
  });
});
