import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { adminQuery, adminTx, asRole, closePool, seedStudio } from "./helpers/harness";

// ===========================================================================
// APPOINTMENT BOUNDARY B6 — migration 0175 behavioural proof, fresh chain.
// ===========================================================================
//
// The static contract lives in
// tests/migrations/0175-appointment-transition-integrity.test.ts. This suite
// proves the things only a real migrated database can show:
//
//   * the completion boundary is starts_at, and INCLUSIVE;
//   * completing early does not shrink the booking or release its capacity;
//   * no-show still needs the visit to have fully elapsed;
//   * the transition guard refuses every illegal lifecycle edge;
//   * updated_at is the database's, not the caller's;
//   * capacity_enabled stops following lifecycle;
//   * the three retired RPCs are actually gone.
//
// TIME IS EXPRESSED RELATIVE TO now(), never as a literal, so the suite cannot
// rot into "passes because 2026 is in the past".

type Fx = Awaited<ReturnType<typeof seedStudio>>;

const tokenHash = () => createHash("sha256").update(randomUUID()).digest("hex");

/** An appointment whose interval is placed relative to now(). */
async function seedAppointment(
  f: Fx,
  startsInSql: string,
  durationMinutes = 60,
  status = "confirmed",
): Promise<string> {
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash,
        buffer_minutes_snapshot, blocked_ends_at)
     values (gen_random_uuid(), $1, $2, $3,
             now() + ($4)::interval,
             now() + ($4)::interval + ($5::text || ' minutes')::interval,
             $5::int, $6, $7,
             15,
             now() + ($4)::interval + ($5::text || ' minutes')::interval + interval '15 minutes')
     returning id`,
    [f.studioId, f.practitionerId, f.clientId, startsInSql, durationMinutes, status, tokenHash()],
  );
  return r.rows[0].id as string;
}

async function row(id: string) {
  const r = await adminQuery(
    `select status, starts_at, ends_at, duration_minutes,
            buffer_minutes_snapshot, blocked_ends_at, capacity_enabled, updated_at
       from public.appointments where id = $1`,
    [id],
  );
  return r.rows[0];
}

async function markComplete(f: Fx, id: string) {
  return adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [
    id, f.studioId, f.practitionerId,
  ]);
}

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe("T1-T3 — explicit completion is gated on starts_at, inclusively", () => {
  it("T1 — one second BEFORE starts_at is refused", async () => {
    const f = await seedStudio("b6-t1");
    const a = await seedAppointment(f, "1 second");
    await expect(markComplete(f, a)).rejects.toThrow(/has not started yet/i);
    expect((await row(a)).status).toBe("confirmed");
  });

  it("T2 — a moment AFTER starts_at is allowed", async () => {
    // Honest about its own reach: starts_at = now() at INSERT, and by the time
    // the RPC runs the clock has advanced, so this proves the just-past case.
    // Exact boundary equality is T2b's job, not this test's.
    const f = await seedStudio("b6-t2");
    const a = await seedAppointment(f, "0 seconds");
    await markComplete(f, a);
    expect((await row(a)).status).toBe("completed");
  });

  it("T2b — EXACTLY starts_at is allowed, proven by transaction-time equality", async () => {
    // The inclusive boundary can only be tested where starts_at is genuinely
    // EQUAL to the now() the function observes. Inside one transaction now() is
    // transaction_timestamp() and does not advance between statements, so the
    // insert and mark_appointment_complete see the same instant — real equality
    // rather than "a few milliseconds ago".
    //
    // This is the test that distinguishes `starts_at > now()` from
    // `starts_at >= now()`; every other completion test would stay green if the
    // boundary silently became exclusive.
    const f = await seedStudio("b6-t2b");
    const id = randomUUID();
    const { onBoundary, status } = await adminTx(async (q) => {
      const ins = await q(
        `insert into public.appointments
           (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
            duration_minutes, status, cancellation_token_hash,
            buffer_minutes_snapshot, blocked_ends_at)
         values ($1, $2, $3, $4, now(), now() + interval '60 minutes',
                 60, 'confirmed', $5, 15, now() + interval '75 minutes')
         returning (starts_at = now()) as on_boundary`,
        [id, f.studioId, f.practitionerId, f.clientId, tokenHash()],
      );
      await q(`select public.mark_appointment_complete($1, $2, $3)`, [
        id,
        f.studioId,
        f.practitionerId,
      ]);
      const st = await q(`select status from public.appointments where id = $1`, [id]);
      return {
        onBoundary: ins.rows[0].on_boundary as boolean,
        status: st.rows[0].status as string,
      };
    });

    // Guard against a vacuous pass: if the fixture were not exactly on the
    // boundary, "completed" would prove nothing about inclusivity.
    expect(onBoundary, "fixture must sit EXACTLY on starts_at").toBe(true);
    expect(status).toBe("completed");
  });

  it("T3 — started but NOT ended is allowed — the point of B6", async () => {
    const f = await seedStudio("b6-t3");
    const a = await seedAppointment(f, "-10 minutes", 60); // began 10m ago, ends in 50m
    await markComplete(f, a);
    expect((await row(a)).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
describe("T4-T7 — completing early does not touch the booking", () => {
  it("T4/T5 — interval, duration, buffer and blocked_ends_at are byte-identical", async () => {
    const f = await seedStudio("b6-t4");
    const a = await seedAppointment(f, "-10 minutes", 60);
    const before = await row(a);
    await markComplete(f, a);
    const after = await row(a);

    expect(after.status).toBe("completed");
    for (const col of [
      "starts_at",
      "ends_at",
      "duration_minutes",
      "buffer_minutes_snapshot",
      "blocked_ends_at",
    ] as const) {
      expect(String(after[col]), `${col} must not move`).toBe(String(before[col]));
    }
  });

  it("T6/T7 — the reservation survives early completion and REALLY refuses a conflicting booking in the remaining tail", async () => {
    // Timestamps surviving on the appointment row prove nothing about capacity:
    // capacity is held by public.studio_calendar_reservations, and the row that
    // holds it is rewritten by appointments_sync_calendar_reservation_trg on
    // every status change. That trigger keeps the reservation for
    // status in ('confirmed','completed') and DELETES it otherwise, so early
    // completion sits one word away from silently releasing the booked tail.
    // This asserts the tail by making a real competing booking fail on it.
    const f = await seedStudio("b6-t6");
    const a = await seedAppointment(f, "-10 minutes", 90); // started, 80 min left

    // (2) Capture the appointment AND the actual reservation representing it.
    const before = await row(a);
    const resBefore = (
      await adminQuery(
        `select id, studio_id, practitioner_id, resource_key, source_kind,
                starts_at, ends_at
           from public.studio_calendar_reservations
          where source_kind = 'appointment' and source_id = $1`,
        [a],
      )
    ).rows;
    expect(resBefore, "the booking must hold exactly one reservation").toHaveLength(1);
    const rk = String(resBefore[0].resource_key);

    // (3) Complete it early.
    await markComplete(f, a);

    // (4) The SAME reservation row still exists, on the same resource, over the
    // same interval. Same id — not deleted and re-created, which would also
    // have surrendered ordering/identity.
    const resAfter = (
      await adminQuery(
        `select id, studio_id, practitioner_id, resource_key, source_kind,
                starts_at, ends_at
           from public.studio_calendar_reservations
          where source_kind = 'appointment' and source_id = $1`,
        [a],
      )
    ).rows;
    expect(resAfter).toHaveLength(1);
    for (const col of [
      "id",
      "studio_id",
      "practitioner_id",
      "resource_key",
      "starts_at",
      "ends_at",
    ] as const) {
      expect(String(resAfter[0][col]), `reservation.${col} must not move`).toBe(
        String(resBefore[0][col]),
      );
    }
    // ...and it still covers the FUTURE portion of the booked interval.
    const covers = await adminQuery(
      `select (ends_at > now()) as tail_is_future from public.studio_calendar_reservations where id = $1`,
      [resAfter[0].id],
    );
    expect(covers.rows[0].tail_is_future).toBe(true);

    // (5)+(6) A competing reservation for the SAME resource, overlapping the
    // future part of the tail, must be refused by the real conflict mechanism —
    // the GiST exclusion constraint, named explicitly so a future schema change
    // that drops it cannot leave this test passing for the wrong reason.
    let resErr: { code?: string; constraint?: string } = {};
    try {
      await adminQuery(
        `insert into public.studio_calendar_reservations
           (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
         values ($1, $2, $3, 'timed_block', gen_random_uuid(),
                 now() + interval '20 minutes', now() + interval '40 minutes')`,
        [f.studioId, f.practitionerId, rk],
      );
      throw new Error("competing reservation was ACCEPTED — the tail was released");
    } catch (e) {
      resErr = e as { code?: string; constraint?: string };
    }
    expect(resErr.code, "must be an exclusion violation").toBe("23P01");
    expect(resErr.constraint).toBe(
      "no_overlapping_calendar_reservations_per_resource",
    );

    // ...and a competing APPOINTMENT over the same tail is refused too, so the
    // defence holds end-to-end and not merely in the reservation table.
    //
    // MEASURED, and the reason matters: it is refused by the RESERVATION
    // exclusion, not by an appointment-level one. Both appointment exclusions
    // (no_overlapping_appointments_studio_wide / _per_practitioner) carry
    // `WHERE status = 'confirmed'`, so they stop covering this row the instant
    // it completes. After an early completion the calendar reservation is the
    // ONLY thing still holding the booked tail — which is exactly why B6 had to
    // be checked here. Had sync_appointment_to_calendar_reservation() not
    // listed 'completed' alongside 'confirmed', completing early would have
    // released the tail outright and no appointment-level constraint would
    // have noticed.
    let apptErr: { code?: string; constraint?: string } = {};
    try {
      await seedAppointment(f, "20 minutes", 20);
      throw new Error("competing appointment was ACCEPTED — the tail was released");
    } catch (e) {
      apptErr = e as { code?: string; constraint?: string };
    }
    expect(apptErr.code).toBe("23P01");
    expect(apptErr.constraint).toBe(
      "no_overlapping_calendar_reservations_per_resource",
    );

    // (7) The completed appointment and its reservation are untouched by the
    // two refused attempts.
    const after = await row(a);
    expect(after.status).toBe("completed");
    for (const col of [
      "starts_at",
      "ends_at",
      "duration_minutes",
      "buffer_minutes_snapshot",
      "blocked_ends_at",
    ] as const) {
      expect(String(after[col]), `${col} must not move`).toBe(String(before[col]));
    }
    const resFinal = (
      await adminQuery(
        `select id, resource_key, starts_at, ends_at
           from public.studio_calendar_reservations
          where source_kind = 'appointment' and source_id = $1`,
        [a],
      )
    ).rows;
    expect(resFinal).toHaveLength(1);
    expect(String(resFinal[0].id)).toBe(String(resBefore[0].id));
    expect(String(resFinal[0].ends_at)).toBe(String(resBefore[0].ends_at));
  });
});

// ---------------------------------------------------------------------------
describe("T10 — no-show keeps its own, later clock", () => {
  it("a started-but-not-ended appointment cannot be marked no-show", async () => {
    // THE ASYMMETRY. Completion asks "has treatment finished?" — the
    // practitioner decides. No-show asks "has the booked opportunity fully
    // elapsed?" — only the clock decides.
    const f = await seedStudio("b6-t10");
    const a = await seedAppointment(f, "-10 minutes", 60);
    // The command RETURNS a refusal code; it does not raise. Asserting a throw
    // here would have passed for the wrong reason the moment the command
    // started succeeding.
    const r = await adminQuery(`select public.mark_appointment_no_show($1,$2,$3) as outcome`, [
      a, f.studioId, f.practitionerId,
    ]);
    expect(r.rows[0].outcome).toBe("too_early");
    expect((await row(a)).status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
describe("T11/T12 — the transition matrix", () => {
  const TERMINALS = ["completed", "cancelled", "no_show"] as const;

  it("all three confirmed -> terminal edges are ALLOWED", async () => {
    for (const target of TERMINALS) {
      const f = await seedStudio(`b6-allow-${target}`);
      const a = await seedAppointment(f, "-2 hours", 60);
      await adminQuery(`update public.appointments set status = $2 where id = $1`, [a, target]);
      expect((await row(a)).status).toBe(target);
    }
  });

  it("all three terminal -> confirmed edges are ALLOWED (for the repair command)", async () => {
    for (const from of TERMINALS) {
      const f = await seedStudio(`b6-revert-${from}`);
      const a = await seedAppointment(f, "-2 hours", 60, from);
      await adminQuery(`update public.appointments set status = 'confirmed' where id = $1`, [a]);
      expect((await row(a)).status).toBe("confirmed");
    }
  });

  it("T11 — every terminal -> OTHER terminal edge is REFUSED", async () => {
    for (const from of TERMINALS) {
      for (const to of TERMINALS) {
        if (from === to) continue;
        const f = await seedStudio(`b6-deny-${from}-${to}`);
        const a = await seedAppointment(f, "-2 hours", 60, from);
        await expect(
          adminQuery(`update public.appointments set status = $2 where id = $1`, [a, to]),
          `${from} -> ${to} must be refused`,
        ).rejects.toThrow(/illegal appointment status transition/i);
        expect((await row(a)).status).toBe(from);
      }
    }
  });

  it("T12 — a same-status rewrite is REFUSED, including confirmed -> confirmed", async () => {
    for (const s of ["confirmed", ...TERMINALS] as const) {
      const f = await seedStudio(`b6-same-${s}`);
      const a = await seedAppointment(f, "-2 hours", 60, s);
      await expect(
        adminQuery(`update public.appointments set status = $2 where id = $1`, [a, s]),
        `${s} -> ${s} must be refused`,
      ).rejects.toThrow(/illegal appointment status transition/i);
    }
  });

  it("an INSERT of a confirmed appointment is unaffected by the guard", async () => {
    // BEFORE UPDATE OF status only — creating a booking must never be blocked.
    const f = await seedStudio("b6-insert");
    const a = await seedAppointment(f, "2 hours");
    expect((await row(a)).status).toBe("confirmed");
  });

  it("an UPDATE that does not touch status is unaffected", async () => {
    const f = await seedStudio("b6-notouch");
    const a = await seedAppointment(f, "2 hours");
    await adminQuery(`update public.appointments set notes = 'ok' where id = $1`, [a]);
    expect((await row(a)).status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
describe("T13 — revert still works after an early completion", () => {
  it("marked_complete remains the audit baseline the repair command reads", async () => {
    const f = await seedStudio("b6-t13");
    const a = await seedAppointment(f, "-10 minutes", 60);
    await markComplete(f, a);

    const audit = await adminQuery(
      `select count(*)::int n from public.appointment_audit
        where appointment_id = $1 and action = 'marked_complete'`,
      [a],
    );
    expect(audit.rows[0].n).toBe(1);

    // Signature read from pg_proc rather than guessed:
    //   (p_appointment_id, p_studio_id, p_actor_user_id, p_expected_status, p_reason) -> text
    // p_actor_user_id is the AUTH USER id (resolved through
    // appointment_actor_role, owner-only) — NOT a practitioner id — and
    // p_expected_status is optimistic concurrency on the status being reverted
    // FROM, so it must be the terminal status the row currently holds.
    const rv = await adminQuery(
      `select public.revert_appointment_outcome($1,$2,$3,$4,$5) as outcome`,
      [a, f.studioId, f.userId, "completed", "b6 test revert of an early completion"],
    );
    expect(rv.rows[0].outcome).toBe("ok");
    expect((await row(a)).status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
describe("T16 — the B3/B5 privilege boundary is unchanged by B6", () => {
  it("raw service_role lifecycle UPDATE is still refused", async () => {
    const f = await seedStudio("b6-t16");
    const a = await seedAppointment(f, "-2 hours", 60);
    await expect(
      asRole("service_role", (q) =>
        q(`update public.appointments set status = 'completed' where id = $1`, [a]),
      ),
    ).rejects.toThrow();
    expect((await row(a)).status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
describe("T17 — updated_at is the database's", () => {
  it("advances on an ordinary UPDATE, and a stale caller value cannot suppress it", async () => {
    const f = await seedStudio("b6-t17");
    const a = await seedAppointment(f, "2 hours");
    const before = await row(a);

    // The caller deliberately supplies an ancient timestamp. A BEFORE trigger
    // must overwrite it; without one, the row would keep the caller's value.
    await adminQuery(
      `update public.appointments
          set notes = 'touched', updated_at = timestamptz '2000-01-01T00:00:00Z'
        where id = $1`,
      [a],
    );
    const after = await row(a);

    expect(new Date(String(after.updated_at)).getFullYear()).toBeGreaterThan(2000);
    expect(new Date(String(after.updated_at)).getTime()).toBeGreaterThanOrEqual(
      new Date(String(before.updated_at)).getTime(),
    );
  });

  it("there is exactly ONE updated_at trigger on appointments", async () => {
    const r = await adminQuery(
      `select count(*)::int n from pg_trigger t
        where t.tgrelid = 'public.appointments'::regclass
          and not t.tgisinternal
          and t.tgname = 'appointments_set_updated_at_trg'`,
    );
    expect(r.rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("T18 — capacity_enabled is booking state, not lifecycle state", () => {
  it("a status change does NOT re-derive it from the studio's current setting", async () => {
    // WHAT THIS TEST LEARNED THE HARD WAY. The obvious fixture — book with the
    // studio OFF, flip the studio ON, then complete — does NOT isolate B6:
    // `studios_capacity_flag_change_trg` deliberately propagates a studio-level
    // capacity flip onto that studio's existing appointments, so the value had
    // already changed BEFORE completion. Measured directly: appointment false
    // at booking, true immediately after the studio flip, still true after
    // completion — i.e. completion changed nothing, and the original fixture
    // would have stayed green even with `status` back in the trigger's
    // UPDATE OF list. It was vacuous.
    //
    // So the divergence is created WITHOUT touching the studio: set the row's
    // snapshot to differ from the studio's live setting, then change status.
    // If the appointments trigger still fired on status, it would re-derive
    // from the studio and overwrite the snapshot.
    const f = await seedStudio("b6-t18");
    await adminQuery(
      `update public.studios set practitioner_capacity_enabled = true where id = $1`,
      [f.studioId],
    );
    const a = await seedAppointment(f, "-2 hours", 60);

    // The booked snapshot deliberately differs from the studio's live value.
    await adminQuery(
      `update public.appointments set capacity_enabled = false where id = $1`,
      [a],
    );
    const booked = (await row(a)).capacity_enabled;
    expect(booked).toBe(false);

    await markComplete(f, a);

    const after = await row(a);
    expect(after.status).toBe("completed");
    // THE INVARIANT: unchanged across the transition, whatever the studio says.
    expect(after.capacity_enabled).toBe(booked);
    expect(after.capacity_enabled).toBe(false);
  });

  it("the appointments trigger no longer lists status among its UPDATE OF columns", async () => {
    const r = await adminQuery(
      `select pg_get_triggerdef(t.oid) as def from pg_trigger t
        where t.tgrelid = 'public.appointments'::regclass
          and t.tgname = 'appointments_set_capacity_enabled_trg'`,
    );
    const def = String(r.rows[0].def);
    expect(def).toMatch(/UPDATE OF studio_id, practitioner_id/i);
    expect(def).not.toMatch(/status/i);
  });
});

// ---------------------------------------------------------------------------
describe("E — the three legacy RPCs are gone, successors intact", () => {
  it("the retired signatures no longer exist", async () => {
    const r = await adminQuery(
      `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('reschedule_appointment','practitioner_move_appointment','create_internal_appointment')`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual([]);
  });

  it("their successors survive — this was a retirement, not a purge", async () => {
    const r = await adminQuery(
      `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('reschedule_appointment_v2','move_or_reassign_appointment','create_internal_appointment_v2')
        order by p.proname`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual([
      "create_internal_appointment_v2",
      "move_or_reassign_appointment",
      "reschedule_appointment_v2",
    ]);
  });

  it("payment charge-attempt functions are untouched — B6 owns no payment code", async () => {
    // NOTE: the brief named `create_or_claim_charge_attempt` as the dormant
    // RPC to leave alone. That name does NOT exist in the current schema — it
    // was superseded long before B6 by the per-flow claim functions below, so
    // there is nothing for B6 to avoid dropping under that name. Asserting the
    // functions that ACTUALLY exist keeps this a real scope guard rather than
    // a tautology about an absent object.
    const r = await adminQuery(
      `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('claim_session_payment_charge_attempt','claim_manual_fee_charge_attempt')
        order by p.proname`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual([
      "claim_manual_fee_charge_attempt",
      "claim_session_payment_charge_attempt",
    ]);
  });
});
