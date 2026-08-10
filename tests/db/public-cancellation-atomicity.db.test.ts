import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { buildPolicySnapshot } from "@/lib/booking/policy-acknowledgement";

// B7 / 0176 — public cancellation + policy acknowledgement atomicity.
//
// The property under test is not "cancellation works". It is that the
// cancellation and the EVIDENCE that the client saw the policy they were
// charged under commit together, and that a policy which changed between render
// and submit fails closed instead of producing evidence for unseen text.

const POLICY_A = "Cancel 24h ahead or a fee applies.";
const POLICY_A_NS = "No-shows are billed in full.";
const POLICY_B = "Cancel 48h ahead or a fee applies.";

const tokenHash = () => createHash("sha256").update(randomUUID()).digest("hex");

/** The canonical presented hash, from the SAME helper the page uses. */
const hashOf = (cancel: string | null, noShow: string | null) =>
  buildPolicySnapshot({
    cancellationPolicyText: cancel,
    noShowPolicyText: noShow,
  }).policySnapshotHash;

async function setPolicy(
  studioId: string,
  cancel: string | null,
  noShow: string | null,
) {
  await adminQuery(
    `update public.studios
        set cancellation_policy_text = $2, no_show_policy_text = $3
      where id = $1`,
    [studioId, cancel, noShow],
  );
}

/** A confirmed, FUTURE appointment carrying a cancellation token hash. */
async function seedCancelable(
  f: SeededStudio,
  startsInSql = "3 days",
): Promise<{ apptId: string; token: string }> {
  const token = tokenHash();
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash,
        buffer_minutes_snapshot, blocked_ends_at)
     values (gen_random_uuid(), $1, $2, $3,
             now() + ($4)::interval,
             now() + ($4)::interval + interval '60 minutes',
             60, 'confirmed', $5, 15,
             now() + ($4)::interval + interval '75 minutes')
     returning id`,
    [f.studioId, f.practitionerId, f.clientId, startsInSql, token],
  );
  return { apptId: r.rows[0].id as string, token };
}

type CancelOut = {
  result: string;
  appointment_id: string | null;
  studio_id: string | null;
  policy_acknowledgement_id: string | null;
};

/** The B7 seven-argument command. */
async function cancelV7(
  token: string,
  opts: {
    acknowledged?: boolean;
    presentedHash?: string | null;
    reason?: string;
    reasonLabel?: string;
    note?: string;
    followUp?: boolean;
  } = {},
): Promise<CancelOut> {
  const r = await adminQuery(
    `select * from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5,$6,$7)`,
    [
      token,
      opts.reason ?? "schedule_conflict",
      opts.reasonLabel ?? "Schedule conflict",
      opts.note ?? "",
      opts.followUp ?? false,
      opts.acknowledged ?? false,
      opts.presentedHash === undefined ? null : opts.presentedHash,
    ],
  );
  return r.rows[0] as CancelOut;
}

/** The legacy five-argument entry point. */
async function cancelLegacy(token: string) {
  const r = await adminQuery(
    `select * from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
    [token, "schedule_conflict", "Schedule conflict", "", false],
  );
  return r.rows[0] as { result: string; appointment_id: string | null; studio_id: string | null };
}

async function apptRow(id: string) {
  const r = await adminQuery(
    `select status, cancelled_at, cancelled_by, cancelled_by_practitioner_id,
            cancellation_reason, updated_at
       from public.appointments where id = $1`,
    [id],
  );
  return r.rows[0];
}

const countAudit = async (id: string) =>
  Number(
    (
      await adminQuery(
        `select count(*)::int as n from public.appointment_audit
          where appointment_id = $1 and action = 'cancelled'`,
        [id],
      )
    ).rows[0].n,
  );

const countAck = async (id: string) =>
  Number(
    (
      await adminQuery(
        `select count(*)::int as n from public.appointment_policy_acknowledgements
          where appointment_id = $1`,
        [id],
      )
    ).rows[0].n,
  );

const countReservation = async (id: string) =>
  Number(
    (
      await adminQuery(
        `select count(*)::int as n from public.studio_calendar_reservations
          where source_kind = 'appointment' and source_id = $1`,
        [id],
      )
    ).rows[0].n,
  );

const countOutbox = async (id: string) =>
  Number(
    (
      await adminQuery(
        `select count(*)::int as n from public.calendar_sync_outbox
          where hone_entity_type = 'appointment' and hone_entity_id = $1`,
        [id],
      )
    ).rows[0].n,
  );

/**
 * A GENUINELY outbound-enabled Google fixture.
 *
 * enqueue_calendar_outbound() only enqueues a cancellation when ALL of these
 * hold, so a fixture missing any one of them makes the outbox assertion vacuous
 * — it would "pass" by enqueueing nothing:
 *   1. a calendar_connections row that is_studio_calendar_owner with a
 *      write_calendar_id;
 *   2. studios.google_calendar_outbound_sync_enabled;
 *   3. a live calendar_event_links row for the appointment (no link = nothing
 *      to delete upstream).
 */
async function enableGoogleOutbound(
  studioId: string,
  practitionerId: string,
  apptId: string,
) {
  const conn = await adminQuery(
    `insert into public.calendar_connections
       (studio_id, practitioner_id, provider, google_account_id, google_account_email,
        write_calendar_id, connection_status, is_studio_calendar_owner)
     values ($1, $2, 'google', $3, $4, 'primary', 'connected', true)
     returning id`,
    [studioId, practitionerId, `acct-${randomUUID()}`, `b7-${randomUUID()}@harness.local`],
  );
  const connectionId = conn.rows[0].id as string;
  await adminQuery(
    `update public.studios set google_calendar_outbound_sync_enabled = true where id = $1`,
    [studioId],
  );
  await adminQuery(
    `insert into public.calendar_event_links
       (studio_id, connection_id, hone_entity_type, hone_entity_id,
        google_calendar_id, google_event_id)
     values ($1, $2, 'appointment', $3, 'primary', $4)`,
    [studioId, connectionId, apptId, `evt-${randomUUID()}`],
  );
  return connectionId;
}

/** Nothing moved: status, audit, acknowledgement, reservation, outbox. */
async function expectZeroMutation(apptId: string, reservationsBefore: number) {
  const a = await apptRow(apptId);
  expect(a.status, "status must not move").toBe("confirmed");
  expect(a.cancelled_at, "cancelled_at must stay null").toBeNull();
  expect(await countAudit(apptId), "no cancellation audit").toBe(0);
  expect(await countAck(apptId), "no acknowledgement").toBe(0);
  expect(await countReservation(apptId), "reservation intact").toBe(reservationsBefore);
}

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe("T1/T7 — the happy paths", () => {
  it("T1 — policy + correct presented hash + acknowledged => cancelled", async () => {
    const f = await seedStudio("b7-t1");
    await setPolicy(f.studioId, POLICY_A, POLICY_A_NS);
    const { apptId, token } = await seedCancelable(f);

    const out = await cancelV7(token, {
      acknowledged: true,
      presentedHash: hashOf(POLICY_A, POLICY_A_NS),
    });

    expect(out.result).toBe("cancelled");
    expect(out.appointment_id).toBe(apptId);
    expect(out.policy_acknowledgement_id).not.toBeNull();
    expect((await apptRow(apptId)).status).toBe("cancelled");
  });

  it("T7 — no policy at render AND at submit => cancelled with NO acknowledgement row", async () => {
    const f = await seedStudio("b7-t7");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f);

    const out = await cancelV7(token, {
      acknowledged: false,
      // The page still posts a hash — of the EMPTY snapshot.
      presentedHash: hashOf(null, null),
    });

    expect(out.result).toBe("cancelled");
    expect(out.policy_acknowledgement_id).toBeNull();
    expect(await countAck(apptId)).toBe(0);
    expect(await countAudit(apptId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("T2-T6 — every way the policy evidence can be wrong fails CLOSED", () => {
  it("T2 — policy configured, acknowledged=false => ack_required, zero mutation", async () => {
    const f = await seedStudio("b7-t2");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);
    const res = await countReservation(apptId);

    const out = await cancelV7(token, {
      acknowledged: false,
      presentedHash: hashOf(POLICY_A, null),
    });

    expect(out.result).toBe("ack_required");
    await expectZeroMutation(apptId, res);
  });

  it("T3 — presented hash differs from current => policy_changed, zero mutation", async () => {
    const f = await seedStudio("b7-t3");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);
    const res = await countReservation(apptId);

    const out = await cancelV7(token, {
      acknowledged: true,
      presentedHash: hashOf("something the studio never published", null),
    });

    expect(out.result).toBe("policy_changed");
    await expectZeroMutation(apptId, res);
  });

  it("T3b — a MISSING presented hash is a mismatch, never consent", async () => {
    // An older client that posts only the checkbox must not be able to
    // acknowledge text it never displayed.
    const f = await seedStudio("b7-t3b");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);
    const res = await countReservation(apptId);

    const out = await cancelV7(token, { acknowledged: true, presentedHash: null });

    expect(out.result).toBe("policy_changed");
    await expectZeroMutation(apptId, res);
  });

  it("T4 — policy EDITED after render => policy_changed", async () => {
    const f = await seedStudio("b7-t4");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);
    const presented = hashOf(POLICY_A, null); // what the page rendered
    const res = await countReservation(apptId);

    await setPolicy(f.studioId, POLICY_B, null); // studio edits mid-flight

    const out = await cancelV7(token, { acknowledged: true, presentedHash: presented });
    expect(out.result).toBe("policy_changed");
    await expectZeroMutation(apptId, res);
  });

  it("T5 — policy ADDED after a no-policy render => policy_changed", async () => {
    const f = await seedStudio("b7-t5");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f);
    const presented = hashOf(null, null); // page saw no policy
    const res = await countReservation(apptId);

    await setPolicy(f.studioId, POLICY_A, null); // studio adds one

    const out = await cancelV7(token, { acknowledged: true, presentedHash: presented });
    expect(out.result).toBe("policy_changed");
    await expectZeroMutation(apptId, res);
  });

  it("T6 — policy REMOVED after a policy render => policy_changed", async () => {
    // THE CASE 0171'S SHAPE WOULD HAVE MISSED. With the hash comparison nested
    // inside "does this studio need an acknowledgement", a studio that DELETES
    // its policy makes the check evaporate and the cancellation commits as
    // though nothing changed — the client reviewed a policy that no longer
    // exists and no evidence records it. B7 compares unconditionally.
    const f = await seedStudio("b7-t6");
    await setPolicy(f.studioId, POLICY_A, POLICY_A_NS);
    const { apptId, token } = await seedCancelable(f);
    const presented = hashOf(POLICY_A, POLICY_A_NS);
    const res = await countReservation(apptId);

    await setPolicy(f.studioId, null, null); // studio removes it

    const out = await cancelV7(token, { acknowledged: true, presentedHash: presented });
    expect(out.result).toBe("policy_changed");
    await expectZeroMutation(apptId, res);
  });
});

// ---------------------------------------------------------------------------
describe("T8-T11 — what a successful cancellation records", () => {
  it("T8 — exactly ONE cancellation audit row and exactly ONE acknowledgement", async () => {
    const f = await seedStudio("b7-t8");
    await setPolicy(f.studioId, POLICY_A, POLICY_A_NS);
    const { apptId, token } = await seedCancelable(f);

    await cancelV7(token, {
      acknowledged: true,
      presentedHash: hashOf(POLICY_A, POLICY_A_NS),
    });

    expect(await countAudit(apptId)).toBe(1);
    expect(await countAck(apptId)).toBe(1);
  });

  it("T9 — the stored snapshot and hash are the EXACT live policy", async () => {
    const f = await seedStudio("b7-t9");
    // Untrimmed on purpose: the snapshot must be the column content, not a
    // tidied rendering of it.
    const cancel = `  ${POLICY_A}\n`;
    const noShow = `${POLICY_A_NS}  `;
    await setPolicy(f.studioId, cancel, noShow);
    const { apptId, token } = await seedCancelable(f);

    await cancelV7(token, { acknowledged: true, presentedHash: hashOf(cancel, noShow) });

    const row = (
      await adminQuery(
        `select cancellation_policy_text_snapshot, no_show_policy_text_snapshot,
                policy_snapshot_hash, action, studio_id, client_id
           from public.appointment_policy_acknowledgements where appointment_id = $1`,
        [apptId],
      )
    ).rows[0];

    expect(row.cancellation_policy_text_snapshot).toBe(cancel);
    expect(row.no_show_policy_text_snapshot).toBe(noShow);
    expect(row.policy_snapshot_hash).toBe(hashOf(cancel, noShow));
    expect(row.action).toBe("cancel");
    expect(row.studio_id).toBe(f.studioId);
    expect(row.client_id).toBe(f.clientId);
  });

  it("T10 — CLIENT actor semantics: no fabricated practitioner attribution", async () => {
    const f = await seedStudio("b7-t10");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);

    await cancelV7(token, { acknowledged: true, presentedHash: hashOf(POLICY_A, null) });

    const audit = (
      await adminQuery(
        `select actor_type, actor_id, actor_practitioner_id
           from public.appointment_audit
          where appointment_id = $1 and action = 'cancelled'`,
        [apptId],
      )
    ).rows[0];
    expect(audit.actor_type).toBe("client");
    expect(audit.actor_id).toBeNull();
    expect(audit.actor_practitioner_id).toBeNull();

    const a = await apptRow(apptId);
    expect(a.cancelled_by).toBe("client");
    expect(a.cancelled_by_practitioner_id, "must NOT invent a practitioner").toBeNull();
  });

  it("T11 — reason, label, note and follow_up_allowed are preserved exactly", async () => {
    const f = await seedStudio("b7-t11");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);

    await cancelV7(token, {
      acknowledged: true,
      presentedHash: hashOf(POLICY_A, null),
      reason: "illness",
      reasonLabel: "Illness",
      note: "feeling unwell",
      followUp: true,
    });

    const d = (
      await adminQuery(
        `select details from public.appointment_audit
          where appointment_id = $1 and action = 'cancelled'`,
        [apptId],
      )
    ).rows[0].details;
    expect(d.source).toBe("public_token");
    expect(d.reason).toBe("illness");
    expect(d.reason_label).toBe("Illness");
    expect(d.note).toBe("feeling unwell");
    expect(d.follow_up_allowed).toBe(true);
    // The label, not the machine value, is the human-facing column.
    expect((await apptRow(apptId)).cancellation_reason).toBe("Illness");
  });
});

// ---------------------------------------------------------------------------
describe("T12/T13 — lifecycle gates are unchanged", () => {
  it("T12 — a terminal appointment cannot be cancelled", async () => {
    const f = await seedStudio("b7-t12");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f);
    await adminQuery(`update public.appointments set status = 'completed' where id = $1`, [
      apptId,
    ]);

    const out = await cancelV7(token, { presentedHash: hashOf(null, null) });
    expect(out.result).toBe("not_cancelable");
    expect((await apptRow(apptId)).status).toBe("completed");
  });

  it("T13 — an appointment at/past starts_at cannot be cancelled", async () => {
    const f = await seedStudio("b7-t13");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f, "-1 hours");

    const out = await cancelV7(token, { presentedHash: hashOf(null, null) });
    expect(out.result).toBe("not_cancelable");
    expect((await apptRow(apptId)).status).toBe("confirmed");
  });

  it("a second cancellation of an already-cancelled appointment is refused", async () => {
    const f = await seedStudio("b7-dbl");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f);
    const h = hashOf(null, null);

    expect((await cancelV7(token, { presentedHash: h })).result).toBe("cancelled");
    expect((await cancelV7(token, { presentedHash: h })).result).toBe("already_cancelled");
    expect(await countAudit(apptId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("T14/T15 — concurrency", () => {
  async function conn(): Promise<Client> {
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    return c;
  }

  it("T14 — concurrent double-submit: exactly ONE success, ONE audit, ONE acknowledgement", async () => {
    const f = await seedStudio("b7-t14");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);
    const h = hashOf(POLICY_A, null);

    const a = await conn();
    const b = await conn();
    try {
      const sql = `select result from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5,$6,$7)`;
      const args = [token, "r", "R", "", false, true, h];
      const [ra, rb] = await Promise.all([a.query(sql, args), b.query(sql, args)]);
      const results = [ra.rows[0].result, rb.rows[0].result].sort();
      // One wins; the other sees the committed terminal state.
      expect(results).toEqual(["already_cancelled", "cancelled"]);
    } finally {
      await a.end();
      await b.end();
    }

    expect(await countAudit(apptId)).toBe(1);
    expect(await countAck(apptId)).toBe(1);
  });

  it("T15 — a policy edit cannot race through: the studio lock serializes it", async () => {
    // Deterministic, not sleep-based. The editor takes the studio row lock and
    // HOLDS it; the cancellation must block on that lock rather than reading a
    // stale policy. When the editor commits its change, the cancellation
    // proceeds against the NEW policy and refuses the old presented hash.
    const f = await seedStudio("b7-t15");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);
    const presented = hashOf(POLICY_A, null); // what the page rendered
    const res = await countReservation(apptId);

    const editor = await conn();
    const canceller = await conn();
    try {
      await editor.query("begin");
      await editor.query(
        `update public.studios set cancellation_policy_text = $2 where id = $1`,
        [f.studioId, POLICY_B],
      );

      // Starts now, must BLOCK on the studio row lock the editor holds.
      const pending = canceller.query(
        `select result from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5,$6,$7)`,
        [token, "r", "R", "", false, true, presented],
      );

      // Prove it is genuinely blocked rather than racing ahead: wait for the
      // lock wait to appear in pg_locks instead of sleeping and hoping.
      let blocked = false;
      for (let i = 0; i < 50 && !blocked; i++) {
        const w = await adminQuery(
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and state = 'active' and query like '%public_cancel_appointment_with_token%'`,
        );
        blocked = Number(w.rows[0].n) > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 100));
      }
      expect(blocked, "cancellation must block on the studio lock").toBe(true);

      await editor.query("commit");
      const out = await pending;
      expect(out.rows[0].result).toBe("policy_changed");
    } finally {
      await editor.end().catch(() => undefined);
      await canceller.end().catch(() => undefined);
    }

    await expectZeroMutation(apptId, res);
  });
});

// ---------------------------------------------------------------------------
describe("T16 — rollback: a failing acknowledgement takes the whole cancellation with it", () => {
  it("T16 — appointment, audit, ack, reservation and outbox all roll back", async () => {
    const f = await seedStudio("b7-t16");
    await setPolicy(f.studioId, POLICY_A, null);
    const { apptId, token } = await seedCancelable(f);
    const resBefore = await countReservation(apptId);
    const outboxBefore = await countOutbox(apptId);

    // TEST-ONLY fault: a trigger that raises on acknowledgement insert. The
    // PRODUCT ships no fault-injection parameter — a runtime hook that can
    // abort a cancellation is itself a defect. Installed and dropped here.
    await adminQuery(`
      create or replace function public.b7_test_fail_ack() returns trigger
      language plpgsql as $fn$
      begin
        raise exception 'B7 TEST FAULT: acknowledgement insert failed' using errcode = 'P0001';
      end;
      $fn$;
    `);
    await adminQuery(`
      create trigger b7_test_fail_ack_trg
        before insert on public.appointment_policy_acknowledgements
        for each row execute function public.b7_test_fail_ack();
    `);

    try {
      await expect(
        cancelV7(token, { acknowledged: true, presentedHash: hashOf(POLICY_A, null) }),
      ).rejects.toThrow(/B7 TEST FAULT/);
    } finally {
      await adminQuery(
        `drop trigger if exists b7_test_fail_ack_trg on public.appointment_policy_acknowledgements`,
      );
      await adminQuery(`drop function if exists public.b7_test_fail_ack()`);
    }

    // EVERYTHING rolled back — including the status flip that had already run.
    const a = await apptRow(apptId);
    expect(a.status, "appointment must still be confirmed").toBe("confirmed");
    expect(a.cancelled_at).toBeNull();
    expect(a.cancelled_by).toBeNull();
    expect(await countAudit(apptId), "audit rolled back").toBe(0);
    expect(await countAck(apptId), "no acknowledgement").toBe(0);
    expect(await countReservation(apptId), "reservation intact").toBe(resBefore);
    expect(await countOutbox(apptId), "outbox unchanged").toBe(outboxBefore);

    // And the fault really was removed, so the same call now succeeds.
    const ok = await cancelV7(token, {
      acknowledged: true,
      presentedHash: hashOf(POLICY_A, null),
    });
    expect(ok.result).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
describe("T17/T18 — trigger-owned side effects are transactional", () => {
  it("T17 — the appointment-backed calendar reservation is released by the SAME transaction", async () => {
    const f = await seedStudio("b7-t17");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f);
    // A confirmed appointment holds a reservation (0152 sync trigger).
    expect(await countReservation(apptId)).toBe(1);

    const out = await cancelV7(token, { presentedHash: hashOf(null, null) });
    expect(out.result).toBe("cancelled");

    // sync_appointment_to_calendar_reservation keeps reservations only for
    // confirmed/completed, so cancelling releases the capacity — and it did so
    // inside the command's transaction, with no manual DELETE anywhere in 0176.
    expect(await countReservation(apptId), "cancelled => reservation released").toBe(0);
  });

  it("T18 — the Google outbox enqueues under a NON-VACUOUS Google-enabled fixture", async () => {
    const f = await seedStudio("b7-t18");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f);
    await enableGoogleOutbound(f.studioId, f.practitionerId, apptId);

    // NON-VACUITY: assert every precondition the enqueue trigger reads. Without
    // this, "the outbox grew" and "the trigger was disabled" look identical.
    const pre = (
      await adminQuery(
        `select
           (select count(*)::int from public.calendar_connections c
             where c.studio_id = $1 and c.is_studio_calendar_owner
               and c.write_calendar_id is not null) as conn,
           (select google_calendar_outbound_sync_enabled from public.studios where id = $1) as studio_flag,
           (select count(*)::int from public.calendar_event_links
             where studio_id = $1 and hone_entity_type = 'appointment'
               and hone_entity_id = $2 and deleted_at is null) as link`,
        [f.studioId, apptId],
      )
    ).rows[0];
    expect(pre.conn, "owner connection with a write calendar").toBe(1);
    expect(pre.studio_flag, "studio outbound flag").toBe(true);
    expect(pre.link, "live event link").toBe(1);

    const before = await countOutbox(apptId);
    const out = await cancelV7(token, { presentedHash: hashOf(null, null) });
    expect(out.result).toBe("cancelled");

    // 0176 writes no outbox row itself: the status change is what the existing
    // trigger watches, and it fired inside the command's transaction.
    const after = await countOutbox(apptId);
    expect(after).toBe(before + 1);
    const op = (
      await adminQuery(
        `select op_type from public.calendar_sync_outbox
          where hone_entity_type = 'appointment' and hone_entity_id = $1
          order by created_at desc limit 1`,
        [apptId],
      )
    ).rows[0];
    expect(op.op_type).toBe("event.delete");

    // CLEAN UP THE GLOBAL QUEUE. calendar_sync_outbox is read UNSCOPED by the
    // Google suites (claim_calendar_sync_op orders and caps across the whole
    // queue, and the reconcile pager walks every candidate), so a row left here
    // changes their results — a fixture in this file would otherwise fail a
    // test in another. Namespacing cannot help against a global count; removing
    // exactly the rows this test created can.
    await adminQuery(
      `delete from public.calendar_sync_outbox
        where hone_entity_type = 'appointment' and hone_entity_id = $1`,
      [apptId],
    );
    await adminQuery(
      `delete from public.calendar_event_links
        where hone_entity_type = 'appointment' and hone_entity_id = $1`,
      [apptId],
    );
    await adminQuery(`delete from public.calendar_connections where studio_id = $1`, [
      f.studioId,
    ]);
    await adminQuery(
      `update public.studios set google_calendar_outbound_sync_enabled = false where id = $1`,
      [f.studioId],
    );
  });
});

// ---------------------------------------------------------------------------
describe("T19/T20 — B6 inheritance", () => {
  it("T19 — the confirmed -> cancelled edge really travels through B6's guard", async () => {
    // Positive control: the guard is installed and enabled on this database, so
    // the successful cancellation above passed THROUGH it rather than round it.
    const trg = (
      await adminQuery(
        `select tgenabled from pg_trigger
          where tgrelid = 'public.appointments'::regclass
            and tgname = 'appointments_enforce_transition_trg'`,
      )
    ).rows[0];
    expect(trg?.tgenabled).toBe("O");

    // Negative control on the DOMAIN: the guard refuses an illegal edge, which
    // is what makes "cancellation succeeded" evidence that the edge is legal.
    const f = await seedStudio("b7-t19");
    const { apptId } = await seedCancelable(f);
    await adminQuery(`update public.appointments set status = 'cancelled' where id = $1`, [
      apptId,
    ]);
    await expect(
      adminQuery(`update public.appointments set status = 'completed' where id = $1`, [apptId]),
    ).rejects.toThrow(/illegal appointment status transition/i);
  });

  it("T20 — updated_at stays DB-authoritative across the cancellation", async () => {
    const f = await seedStudio("b7-t20");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f);

    // Try to pin a stale value. B6's BEFORE trigger must overwrite it — that
    // backdating is IMPOSSIBLE is the property, and it is why 0176 deliberately
    // does not assign updated_at by hand.
    await adminQuery(
      `update public.appointments set updated_at = now() - interval '10 days' where id = $1`,
      [apptId],
    );
    const stale = (
      await adminQuery(
        `select (updated_at < now() - interval '1 hour') as is_stale from public.appointments where id = $1`,
        [apptId],
      )
    ).rows[0];
    expect(stale.is_stale, "a caller must not be able to backdate updated_at").toBe(false);

    const before = (await apptRow(apptId)).updated_at;
    await cancelV7(token, { presentedHash: hashOf(null, null) });
    const after = (await apptRow(apptId)).updated_at;

    expect(new Date(String(after)).getTime()).toBeGreaterThanOrEqual(
      new Date(String(before)).getTime(),
    );
    const fresh = (
      await adminQuery(
        `select (updated_at > now() - interval '1 minute') as recent from public.appointments where id = $1`,
        [apptId],
      )
    ).rows[0];
    expect(fresh.recent, "server clock owns updated_at after the cancellation").toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("T21/T22/T24 — the legacy 5-argument entry point cannot bypass the policy", () => {
  it("T21/T24 — legacy caller CANNOT cancel a policy-bearing appointment, and writes nothing", async () => {
    const f = await seedStudio("b7-t21");
    await setPolicy(f.studioId, POLICY_A, POLICY_A_NS);
    const { apptId, token } = await seedCancelable(f);
    const res = await countReservation(apptId);

    const out = await cancelLegacy(token);

    expect(out.result).toBe("ack_required");
    await expectZeroMutation(apptId, res);
  });

  it("T22 — legacy caller remains safe for a genuinely no-policy studio", async () => {
    const f = await seedStudio("b7-t22");
    await setPolicy(f.studioId, null, null);
    const { apptId, token } = await seedCancelable(f);

    const out = await cancelLegacy(token);

    expect(out.result).toBe("cancelled");
    expect((await apptRow(apptId)).status).toBe("cancelled");
    expect(await countAudit(apptId)).toBe(1);
    expect(await countAck(apptId), "no policy => no acknowledgement").toBe(0);
  });

  it("whitespace-only policy needs no acknowledgement, so the legacy path still works", async () => {
    // The requirement predicate TRIMS. This is the asymmetry 0171 established.
    const f = await seedStudio("b7-ws");
    await setPolicy(f.studioId, "   \n\t  ", null);
    const { apptId, token } = await seedCancelable(f);

    expect((await cancelLegacy(token)).result).toBe("cancelled");
    expect(await countAck(apptId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("T23 — privilege posture", () => {
  it("T23 — both commands are service_role only", async () => {
    for (const sig of [
      "public.public_cancel_appointment_with_token(text,text,text,text,boolean,boolean,text)",
      "public.public_cancel_appointment_with_token(text,text,text,text,boolean)",
    ]) {
      const r = await adminQuery(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                has_function_privilege('service_role', $1, 'EXECUTE') as svc`,
        [sig],
      );
      expect(r.rows[0].anon, `${sig} anon`).toBe(false);
      expect(r.rows[0].auth, `${sig} authenticated`).toBe(false);
      expect(r.rows[0].svc, `${sig} service_role`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("T25 — TS and SQL derive byte-identical hashes", () => {
  const CASES: Array<[string, string | null, string | null]> = [
    ["both null", null, null],
    ["both empty", "", ""],
    ["whitespace only", "   ", "\t\n "],
    ["embedded newlines", "line one\nline two", "a\nb\nc"],
    ["unicode", "Café — 24h préavis ✂️", "No-show → 100% 💇"],
    ["ordinary text", POLICY_A, POLICY_A_NS],
    ["cancel only", POLICY_A, null],
    ["no-show only", null, POLICY_A_NS],
    ["separator lookalike in the text", "a\n---\nb", "c"],
  ];

  it.each(CASES)("T25 — %s", async (_label, cancel, noShow) => {
    const sql = await adminQuery(
      `select encode(extensions.digest(coalesce($1::text,'') || E'\\n---\\n' || coalesce($2::text,''), 'sha256'), 'hex') as h`,
      [cancel, noShow],
    );
    expect(sql.rows[0].h).toBe(hashOf(cancel, noShow));
  });
});
