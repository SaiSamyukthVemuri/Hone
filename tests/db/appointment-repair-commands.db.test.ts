// APPOINTMENT BOUNDARY B4: behavioural suite for migration 0173.
//
// 0173 adds the two governed repair commands that replace the operational
// hatch 0172 removed: `revert_appointment_outcome` (owner-only terminal ->
// confirmed) and `set_appointment_notes` (member notes correction).
//
// THREE TRAPS THIS FILE IS BUILT AROUND
//
//  1. A REFUSAL THAT MUTATES. The whole point of a closed result code is that
//     the appointment is untouched when it is returned. Asserting only the code
//     would pass even if the command had already written the row and then
//     bailed. Every refusal test therefore snapshots the ENTIRE appointment row
//     before and after and compares it, and separately asserts the audit row
//     count for that appointment is unchanged.
//
//  2. A SUCCESS THAT WRITES TWO AUDIT ROWS, OR NONE. The count is asserted
//     exactly, scoped to the appointment, never globally.
//
//  3. AN EXACT BOUNDARY THAT IS NOT ACTUALLY EXACT. `now()` is stable within a
//     transaction, so the 72-hour tests set the baseline's `created_at` to
//     `now() - interval '72 hours'` and call the command IN THE SAME
//     TRANSACTION. The elapsed interval is then exactly 72 hours rather than
//     "72 hours and however long the test took", which is what makes the
//     `>` / `>=` distinction genuinely testable.

import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  closePool,
  adminTx,
  seedStudio,
  seedMember,
  seedHistoricalAppointmentAudit,
  type SeededStudio,
} from "./helpers/harness";

afterAll(async () => {
  await closePool();
});

type TerminalStatus = "completed" | "no_show" | "cancelled";

const BASELINE_ACTION: Record<TerminalStatus, string> = {
  completed: "marked_complete",
  no_show: "marked_no_show",
  cancelled: "cancelled",
};

const VALID_REASON = "Marked complete by mistake, client rebooked";

// A service is required only where the test cares about one; appointments
// permit a null service_id.
async function seedService(studio: SeededStudio): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1, $2, 'Harness service', 60, true)`,
    [id, studio.studioId],
  );
  return id;
}

// `studio_payment_settings` is the FK target the whole card chain hangs off.
// `stripe_account_id` is globally UNIQUE, so callers pass their own.
async function seedPaymentSettings(
  studio: SeededStudio,
  stripeAccountId: string,
): Promise<void> {
  await adminQuery(
    `insert into public.studio_payment_settings
       (studio_id, stripe_account_id, stripe_livemode)
     values ($1, $2, false)`,
    [studio.studioId, stripeAccountId],
  );
}

// Seed an appointment in a given status, with the audit baseline that the
// repair window is anchored to. `baselineAgo` is a Postgres interval literal;
// pass null to seed NO baseline (the no_audit_baseline case).
async function seedAppointment(
  studio: SeededStudio,
  opts: {
    status: TerminalStatus | "confirmed";
    startsAt?: string;
    baselineAgo?: string | null;
    serviceId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const startsAt = opts.startsAt ?? "now() + interval '30 days'";
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id,
        starts_at, ends_at, duration_minutes, status)
     values ($1, $2, $3, $4, $5,
        ${startsAt}, ${startsAt} + interval '60 minutes', 60, $6)`,
    [
      id,
      studio.studioId,
      studio.practitionerId,
      studio.clientId,
      opts.serviceId ?? null,
      opts.status,
    ],
  );
  if (opts.status !== "confirmed" && opts.baselineAgo !== null) {
    // B5/0174: appointment_audit.created_at is now derived from the database
    // clock at INSERT, so a plain INSERT can no longer seed a HISTORICAL
    // baseline, the value would be silently replaced by now() and every
    // window test would measure zero elapsed time. The owner-only harness
    // fixture is the sanctioned way to build that state; it ships in no
    // migration and no runtime role can reach it.
    await seedHistoricalAppointmentAudit({
      appointmentId: id,
      actorType: "practitioner",
      actorId: studio.practitionerId,
      action: BASELINE_ACTION[opts.status],
      createdAtSql: `now() - interval '${opts.baselineAgo ?? "1 hour"}'`,
    });
  }
  return id;
}

async function snapshotAppointment(id: string): Promise<string> {
  const r = await adminQuery(
    `select to_jsonb(a.*) j from public.appointments a where a.id = $1`,
    [id],
  );
  return JSON.stringify(r.rows[0]?.j ?? null);
}

async function auditCount(id: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int n from public.appointment_audit where appointment_id = $1`,
    [id],
  );
  return r.rows[0].n as number;
}

async function revert(
  appointmentId: string,
  studioId: string,
  actorUserId: string,
  expected: string,
  reason: string = VALID_REASON,
): Promise<string> {
  const r = await adminQuery(
    `select public.revert_appointment_outcome($1, $2, $3, $4, $5) code`,
    [appointmentId, studioId, actorUserId, expected, reason],
  );
  return r.rows[0].code as string;
}

// Assert a refusal is a TOTAL no-op: same code, byte-identical row, unchanged
// audit count. This is the assertion that would catch a command that writes
// first and validates second.
async function expectRefusal(
  appointmentId: string,
  run: () => Promise<string>,
  expectedCode: string,
) {
  const before = await snapshotAppointment(appointmentId);
  const beforeAudit = await auditCount(appointmentId);
  const code = await run();
  expect(code, "result code").toBe(expectedCode);
  expect(await snapshotAppointment(appointmentId), "row must be untouched").toBe(
    before,
  );
  expect(await auditCount(appointmentId), "audit must be untouched").toBe(
    beforeAudit,
  );
}

// ---------------------------------------------------------------------------

describe("0173, revert_appointment_outcome: actor gates", () => {
  it("a non-member is refused, and cannot use the command as an existence oracle", async () => {
    const studio = await seedStudio("b4-nonmember");
    const outsider = await seedStudio("b4-outsider");
    const appt = await seedAppointment(studio, { status: "completed" });

    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, outsider.userId, "completed"),
      "not_a_member",
    );

    // The SAME code comes back for an appointment that does not exist at all,
    // so a non-member learns nothing about whether the id is real.
    const code = await revert(
      randomUUID(),
      studio.studioId,
      outsider.userId,
      "completed",
    );
    expect(code).toBe("not_a_member");
  });

  it("an INACTIVE member is refused exactly like a non-member", async () => {
    const studio = await seedStudio("b4-inactive");
    const appt = await seedAppointment(studio, { status: "completed" });
    await adminQuery(
      `update public.practitioners set active = false where id = $1`,
      [studio.practitionerId],
    );
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed"),
      "not_a_member",
    );
  });

  it("a non-owner member cannot reverse an outcome", async () => {
    const studio = await seedStudio("b4-member");
    const member = await seedMember(studio, "b4-plain");
    const appt = await seedAppointment(studio, { status: "completed" });
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, member.userId, "completed"),
      "not_owner",
    );
  });

  it("the browser cannot forge a role: the command reads it from the database", async () => {
    // The command takes NO role parameter at all, there is nothing to forge.
    // Proven structurally: promoting the same user to owner flips the outcome
    // with an otherwise identical call.
    const studio = await seedStudio("b4-forge");
    const member = await seedMember(studio, "b4-forge-m");
    const appt = await seedAppointment(studio, { status: "completed" });

    expect(await revert(appt, studio.studioId, member.userId, "completed")).toBe(
      "not_owner",
    );
    await adminQuery(
      `update public.practitioners set role = 'owner' where id = $1`,
      [member.practitionerId],
    );
    expect(await revert(appt, studio.studioId, member.userId, "completed")).toBe(
      "ok",
    );
  });
});

describe("0173, revert_appointment_outcome: scoping and existence", () => {
  it("a wrong studio id is refused as not-found, not as a cross-studio repair", async () => {
    const studio = await seedStudio("b4-wrongstudio");
    const other = await seedStudio("b4-wrongstudio-2");
    const appt = await seedAppointment(studio, { status: "completed" });

    // `other`'s owner asking about `studio`'s appointment under `other`'s
    // studio id: the appointment is real, but scoped lookup finds nothing.
    await expectRefusal(
      appt,
      () => revert(appt, other.studioId, other.userId, "completed"),
      "appointment_not_found",
    );
  });

  it("an unknown appointment id is refused", async () => {
    const studio = await seedStudio("b4-unknown");
    const code = await revert(
      randomUUID(),
      studio.studioId,
      studio.userId,
      "completed",
    );
    expect(code).toBe("appointment_not_found");
  });

  it("a cross-studio appointment is indistinguishable from a nonexistent one", async () => {
    const studio = await seedStudio("b4-oracle");
    const other = await seedStudio("b4-oracle-2");
    const realElsewhere = await seedAppointment(other, { status: "completed" });

    const realCode = await revert(
      realElsewhere,
      studio.studioId,
      studio.userId,
      "completed",
    );
    const fakeCode = await revert(
      randomUUID(),
      studio.studioId,
      studio.userId,
      "completed",
    );
    expect(realCode).toBe("appointment_not_found");
    expect(fakeCode).toBe("appointment_not_found");
    expect(realCode).toBe(fakeCode);
  });
});

describe("0173, revert_appointment_outcome: status gates", () => {
  for (const status of ["completed", "no_show", "cancelled"] as const) {
    it(`restores a ${status} appointment to confirmed`, async () => {
      const studio = await seedStudio(`b4-ok-${status}`);
      const appt = await seedAppointment(studio, { status });
      const before = await auditCount(appt);

      expect(await revert(appt, studio.studioId, studio.userId, status)).toBe(
        "ok",
      );

      const row = await adminQuery(
        `select status, cancelled_at, cancelled_by, cancellation_reason
           from public.appointments where id = $1`,
        [appt],
      );
      expect(row.rows[0].status).toBe("confirmed");
      // The cancellation triplet is cleared, so a restored appointment does not
      // read as "confirmed but cancelled by the client".
      expect(row.rows[0].cancelled_at).toBeNull();
      expect(row.rows[0].cancelled_by).toBeNull();
      expect(row.rows[0].cancellation_reason).toBeNull();
      expect(await auditCount(appt)).toBe(before + 1);
    });
  }

  // MUTATION-CONTROL RESULT, recorded because it is a real limit of this file.
  //
  // Neutering the owner check (`v_role <> 'owner'` -> `false`) turns 2 tests
  // red. Widening the window comparison (`>` -> `>=`) turns the exact-72h test
  // red. But REMOVING `and a.status = p_expected_status` from the UPDATE's own
  // predicate turns NOTHING red here.
  //
  // That is not a hole in the command, it is a property of the lock protocol.
  // `lock_appointment_for_command` holds the row FOR UPDATE from GATE 4, so no
  // concurrent writer can change `status` between GATE 5's check and the
  // UPDATE; a competing transaction blocks instead. The predicate is therefore
  // genuine defence-in-depth whose failure mode is unreachable while the lock
  // is correct, which is exactly why it cannot be driven from here.
  //
  // It is NOT unguarded: `tests/migrations/0173-appointment-repair-commands.test.ts`
  // ("the UPDATE carries the expected status in its own predicate") fails if it
  // is removed from the migration, which is the edit a developer would actually
  // make. Verified by mutating the file and watching that test go red.
  it("a stale expected status cannot overwrite a concurrent real change", async () => {
    const studio = await seedStudio("b4-stale");
    const appt = await seedAppointment(studio, { status: "completed" });
    // Someone else already reverted it after the page was rendered.
    //
    // B6 / 0175 NOTE: this fixture used to simulate the concurrent change as
    // completed -> cancelled. That edge is now REFUSED by the transition guard
    // (it can no longer occur in production at all), so the fixture was
    // manufacturing an impossible state to test a real rule. Reverting to
    // confirmed is a LEGAL concurrent change and exercises exactly the same
    // optimistic-concurrency property: a caller holding a stale
    // expected_status must be refused rather than overwrite what happened.
    await adminQuery(
      `update public.appointments set status = 'confirmed' where id = $1`,
      [appt],
    );
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed"),
      "status_mismatch",
    );
  });

  it("an already-confirmed appointment has no outcome to correct", async () => {
    const studio = await seedStudio("b4-confirmed");
    const appt = await seedAppointment(studio, { status: "confirmed" });
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "confirmed"),
      "not_terminal",
    );
  });

  it("a second identical invocation is refused truthfully, not silently re-applied", async () => {
    const studio = await seedStudio("b4-idem");
    const appt = await seedAppointment(studio, { status: "completed" });

    expect(await revert(appt, studio.studioId, studio.userId, "completed")).toBe(
      "ok",
    );
    const afterFirst = await snapshotAppointment(appt);
    const auditAfterFirst = await auditCount(appt);

    // The row is now 'confirmed', so the expected status no longer matches.
    expect(await revert(appt, studio.studioId, studio.userId, "completed")).toBe(
      "status_mismatch",
    );
    expect(await snapshotAppointment(appt)).toBe(afterFirst);
    expect(await auditCount(appt)).toBe(auditAfterFirst);
  });
});

describe("0173, revert_appointment_outcome: reason", () => {
  it("an empty reason is refused", async () => {
    const studio = await seedStudio("b4-reason-empty");
    const appt = await seedAppointment(studio, { status: "completed" });
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed", ""),
      "reason_too_short",
    );
  });

  it("a whitespace-only reason cannot satisfy the minimum, SQL owns the trim", async () => {
    const studio = await seedStudio("b4-reason-ws");
    const appt = await seedAppointment(studio, { status: "completed" });
    await expectRefusal(
      appt,
      () =>
        revert(appt, studio.studioId, studio.userId, "completed", "          "),
      "reason_too_short",
    );
  });

  it("a too-short reason is refused", async () => {
    const studio = await seedStudio("b4-reason-short");
    const appt = await seedAppointment(studio, { status: "completed" });
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed", "oops"),
      "reason_too_short",
    );
  });

  it("the stored reason is the TRIMMED text", async () => {
    const studio = await seedStudio("b4-reason-trim");
    const appt = await seedAppointment(studio, { status: "completed" });
    expect(
      await revert(
        appt,
        studio.studioId,
        studio.userId,
        "completed",
        `   ${VALID_REASON}   `,
      ),
    ).toBe("ok");
    const r = await adminQuery(
      `select details->>'reason' reason from public.appointment_audit
        where appointment_id = $1 and action = 'outcome_reverted'`,
      [appt],
    );
    expect(r.rows[0].reason).toBe(VALID_REASON);
  });
});

describe("0173, revert_appointment_outcome: the repair window", () => {
  it("refuses when the establishing audit event is absent", async () => {
    const studio = await seedStudio("b4-nobaseline");
    const appt = await seedAppointment(studio, {
      status: "completed",
      baselineAgo: null,
    });
    // Absence must REFUSE, never fall through to permitted.
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed"),
      "no_audit_baseline",
    );
  });

  it("an audit row for a DIFFERENT action is not a baseline", async () => {
    const studio = await seedStudio("b4-wrongaction");
    const appt = await seedAppointment(studio, {
      status: "completed",
      baselineAgo: null,
    });
    // B5/0174: a 'practitioner' row must name its actor
    // (appointment_audit_actor_id_type_ck). The point of the test is the
    // ACTION being wrong, not the actor being absent.
    await adminQuery(
      `insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
       values ($1, 'practitioner', $2, 'created', '{}'::jsonb)`,
      [appt, studio.practitionerId],
    );
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed"),
      "no_audit_baseline",
    );
  });

  it("EXACTLY 72 hours is still inside the window (the boundary is inclusive)", async () => {
    const studio = await seedStudio("b4-boundary-in");
    const appt = await seedAppointment(studio, { status: "completed" });
    // Same transaction => now() is identical for the UPDATE and the command,
    // so the elapsed interval is exactly 72 hours.
    //
    // B5/0174: the UPDATE is the append-only trigger's business now, so the
    // backdate runs with that trigger disabled as the table OWNER (harness
    // fixture, no runtime path). `adminTx` keeps both statements on one
    // connection in one transaction, without that the backdate and the
    // command would observe two different clocks and "exactly 72 hours" would
    // silently become "72 hours plus a few milliseconds".
    const code = await adminTx(async (q) => {
      await q(
        `alter table public.appointment_audit disable trigger appointment_audit_append_only`,
      );
      await q(
        `update public.appointment_audit set created_at = now() - interval '72 hours'
          where appointment_id = $1 and action = 'marked_complete'`,
        [appt],
      );
      await q(
        `alter table public.appointment_audit enable trigger appointment_audit_append_only`,
      );
      const r = await q(
        `select public.revert_appointment_outcome($1, $2, $3, 'completed', $4) code`,
        [appt, studio.studioId, studio.userId, VALID_REASON],
      );
      return r.rows[0].code as string;
    });
    expect(code).toBe("ok");
  });

  it("one microsecond past 72 hours is outside the window", async () => {
    const studio = await seedStudio("b4-boundary-out");
    const appt = await seedAppointment(studio, { status: "completed" });
    const code = await adminTx(async (q) => {
      await q(
        `alter table public.appointment_audit disable trigger appointment_audit_append_only`,
      );
      await q(
        `update public.appointment_audit
            set created_at = now() - interval '72 hours' - interval '1 microsecond'
          where appointment_id = $1 and action = 'marked_complete'`,
        [appt],
      );
      await q(
        `alter table public.appointment_audit enable trigger appointment_audit_append_only`,
      );
      const r = await q(
        `select public.revert_appointment_outcome($1, $2, $3, 'completed', $4) code`,
        [appt, studio.studioId, studio.userId, VALID_REASON],
      );
      return r.rows[0].code as string;
    });
    expect(code).toBe("repair_window_expired");
  });

  it("a clearly expired outcome is refused and untouched", async () => {
    const studio = await seedStudio("b4-expired");
    const appt = await seedAppointment(studio, {
      status: "completed",
      baselineAgo: "10 days",
    });
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed"),
      "repair_window_expired",
    );
  });

  it("the NEWEST establishing event wins when an outcome was set more than once", async () => {
    const studio = await seedStudio("b4-newest");
    // An ancient baseline would expire the window; a recent one must win.
    const appt = await seedAppointment(studio, {
      status: "completed",
      baselineAgo: "30 days",
    });
    // B5/0174: a 'practitioner' audit row must now name its actor
    // (appointment_audit_actor_id_type_ck), and created_at is derived at INSERT,
    // so the recent baseline is seeded through the owner-only fixture.
    await seedHistoricalAppointmentAudit({
      appointmentId: appt,
      actorType: "practitioner",
      actorId: studio.practitionerId,
      action: "marked_complete",
      createdAtSql: "now() - interval '1 hour'",
    });
    expect(
      await revert(appt, studio.studioId, studio.userId, "completed"),
    ).toBe("ok");
  });
});

describe("0173, revert_appointment_outcome: blocking dependents", () => {
  it("blocks when the appointment was rescheduled to a successor", async () => {
    const studio = await seedStudio("b4-block-resched");
    const appt = await seedAppointment(studio, { status: "cancelled" });
    const successor = await seedAppointment(studio, {
      status: "confirmed",
      startsAt: "now() + interval '60 days'",
    });
    await adminQuery(
      `update public.appointments set rescheduled_to_appointment_id = $2 where id = $1`,
      [appt, successor],
    );
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "cancelled"),
      "blocked_rescheduled",
    );
  });

  it("blocks when an undeleted treatment session is linked", async () => {
    const studio = await seedStudio("b4-block-session");
    const appt = await seedAppointment(studio, { status: "completed" });
    await adminQuery(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, appointment_id)
       values (gen_random_uuid(), $1, $2, $3, 'electrolysis', $4)`,
      [studio.studioId, studio.clientId, studio.practitionerId, appt],
    );
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed"),
      "blocked_linked_session",
    );
  });

  it("a SOFT-DELETED session does not block", async () => {
    const studio = await seedStudio("b4-block-session-soft");
    const appt = await seedAppointment(studio, { status: "completed" });
    await adminQuery(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, appointment_id, deleted_at)
       values (gen_random_uuid(), $1, $2, $3, 'electrolysis', $4, now())`,
      [studio.studioId, studio.clientId, studio.practitionerId, appt],
    );
    expect(
      await revert(appt, studio.studioId, studio.userId, "completed"),
    ).toBe("ok");
  });

  it("blocks when aftercare has already been emailed", async () => {
    const studio = await seedStudio("b4-block-postcare");
    const appt = await seedAppointment(studio, { status: "completed" });
    await adminQuery(
      `update public.appointments set postcare_email_sent_at = now() where id = $1`,
      [appt],
    );
    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed"),
      "blocked_postcare_sent",
    );
  });

  it("blocks when a manual fee has been attempted", async () => {
    const studio = await seedStudio("b4-block-fee");
    const appt = await seedAppointment(studio, { status: "no_show" });

    // `stripe_account_id` is globally UNIQUE on studio_payment_settings, so
    // every seeded studio needs its own.
    const acct = `acct_fee_${randomUUID().slice(0, 8)}`;
    await seedPaymentSettings(studio, acct);
    await adminQuery(
      `insert into public.client_stripe_customers
         (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
       values ($1, $2, $3, false, $4)`,
      [studio.clientId, studio.studioId, acct, "cus_fee"],
    );

    const pmId = randomUUID();
    await adminQuery(
      `insert into public.client_payment_methods
         (id, studio_id, client_id, stripe_account_id, stripe_livemode,
          stripe_customer_id, stripe_payment_method_id, stripe_setup_intent_id,
          brand, last4, exp_month, exp_year)
       values ($1, $2, $3, $4, false, 'cus_fee', 'pm_h', 'seti_h', 'visa', '4242', 12, 2030)`,
      [pmId, studio.studioId, studio.clientId, acct],
    );

    const tmplId = randomUUID();
    await adminQuery(
      `insert into public.consent_form_templates
         (id, studio_id, title, body, version)
       values ($1, $2, 'Card authorization', 'body', 1)`,
      [tmplId, studio.studioId],
    );
    const sigId = randomUUID();
    await adminQuery(
      `insert into public.client_consent_signatures
         (id, studio_id, client_id, template_id, template_title_snapshot,
          template_body_snapshot, template_version, template_hash, signature_name)
       values ($1, $2, $3, $4, 'Card authorization', 'body', 1, 'hash-h', 'Harness Client')`,
      [sigId, studio.studioId, studio.clientId, tmplId],
    );

    const ackId = randomUUID();
    await adminQuery(
      `insert into public.appointment_policy_acknowledgements
         (id, studio_id, appointment_id, client_id, action, policy_snapshot_hash)
       values ($1, $2, $3, $4, 'cancel', 'policy-hash-h')`,
      [ackId, studio.studioId, appt, studio.clientId],
    );

    await adminQuery(
      `insert into public.manual_fee_charge_attempts
         (studio_id, appointment_id, client_id, confirmed_by_practitioner_id,
          charge_type, amount_cents, client_payment_method_id,
          card_authorization_signature_id, appointment_policy_acknowledgement_id,
          policy_snapshot_hash, internal_note)
       values ($1, $2, $3, $4, 'no_show', 5000, $5, $6, $7, 'policy-hash-h', 'harness')`,
      [
        studio.studioId,
        appt,
        studio.clientId,
        studio.practitionerId,
        pmId,
        sigId,
        ackId,
      ],
    );

    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "no_show"),
      "blocked_manual_fee",
    );
  });

  it("blocks when a payment has moved past method_saved", async () => {
    const studio = await seedStudio("b4-block-pay");
    const serviceId = await seedService(studio);
    const appt = await seedAppointment(studio, {
      status: "completed",
      serviceId,
    });

    const acct = `acct_pay_${randomUUID().slice(0, 8)}`;
    await seedPaymentSettings(studio, acct);
    await adminQuery(
      `insert into public.client_stripe_customers
         (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
       values ($1, $2, $3, false, 'cus_pay')`,
      [studio.clientId, studio.studioId, acct],
    );

    const sessionId = randomUUID();
    await adminQuery(
      `insert into public.pending_booking_payment_sessions
         (id, token_hash, studio_id, service_id, client_id,
          requested_starts_at, requested_ends_at, requested_duration_minutes,
          stripe_account_id, stripe_livemode, stripe_customer_id)
       values ($1, $6, $2, $3, $4,
               now() + interval '30 days', now() + interval '30 days' + interval '60 minutes', 60,
               $5, false, 'cus_pay')`,
      [
        sessionId,
        studio.studioId,
        serviceId,
        studio.clientId,
        acct,
        `tok-${randomUUID().slice(0, 8)}`,
      ],
    );

    const consentId = randomUUID();
    await adminQuery(
      `insert into public.payment_consents
         (id, pending_booking_payment_session_id, studio_id, client_id,
          consent_type, policy_version, rendered_consent_text_hash,
          studio_name_snapshot, accepted_at)
       values ($1, $2, $3, $4, 'card_on_file_and_treatment_charge',
               'v1', 'chash', 'Harness', now())`,
      [consentId, sessionId, studio.studioId, studio.clientId],
    );

    await adminQuery(
      `insert into public.appointment_payments
         (appointment_id, studio_id, client_id, pending_booking_payment_session_id,
          payment_consent_id, stripe_account_id, stripe_livemode, stripe_customer_id,
          stripe_setup_intent_id, stripe_payment_method_id, payment_status)
       values ($1, $2, $3, $4, $5, $6, false, 'cus_pay',
               $7, 'pm_pay', 'charged')`,
      [
        appt,
        studio.studioId,
        studio.clientId,
        sessionId,
        consentId,
        acct,
        `seti_${randomUUID().slice(0, 8)}`,
      ],
    );

    await expectRefusal(
      appt,
      () => revert(appt, studio.studioId, studio.userId, "completed"),
      "blocked_payment_state",
    );
  });
});

describe("0173, revert_appointment_outcome: slot collision (23P01)", () => {
  it("refuses with slot_conflict when the freed interval was re-let", async () => {
    const studio = await seedStudio("b4-collide");
    // A cancelled appointment at a fixed future instant...
    const cancelled = await seedAppointment(studio, {
      status: "cancelled",
      startsAt: "date_trunc('hour', now() + interval '45 days')",
    });
    // ...whose slot is subsequently taken by a real confirmed booking. The
    // exclusion constraint only covers status='confirmed', so this insert is
    // legal precisely because the first appointment is cancelled.
    const replacement = await seedAppointment(studio, {
      status: "confirmed",
      startsAt: "date_trunc('hour', now() + interval '45 days')",
    });
    expect(replacement).toBeTruthy();

    await expectRefusal(
      cancelled,
      () => revert(cancelled, studio.studioId, studio.userId, "cancelled"),
      "slot_conflict",
    );
  });

  it("the collision is real: the same restore succeeds once the occupier is gone", async () => {
    // Negative control. Without this, `slot_conflict` above could be produced
    // by any unrelated failure and the test would still pass.
    const studio = await seedStudio("b4-collide-control");
    const cancelled = await seedAppointment(studio, {
      status: "cancelled",
      startsAt: "date_trunc('hour', now() + interval '46 days')",
    });
    const replacement = await seedAppointment(studio, {
      status: "confirmed",
      startsAt: "date_trunc('hour', now() + interval '46 days')",
    });

    expect(
      await revert(cancelled, studio.studioId, studio.userId, "cancelled"),
    ).toBe("slot_conflict");

    await adminQuery(
      `update public.appointments set status = 'cancelled' where id = $1`,
      [replacement],
    );
    expect(
      await revert(cancelled, studio.studioId, studio.userId, "cancelled"),
    ).toBe("ok");
  });
});

describe("0173: set_appointment_notes", () => {
  async function setNotes(
    appointmentId: string,
    studioId: string,
    actorUserId: string,
    notes: string,
  ): Promise<string> {
    const r = await adminQuery(
      `select public.set_appointment_notes($1, $2, $3, $4) code`,
      [appointmentId, studioId, actorUserId, notes],
    );
    return r.rows[0].code as string;
  }

  it("an ordinary ACTIVE member may correct notes", async () => {
    const studio = await seedStudio("b4-notes-member");
    const member = await seedMember(studio, "b4-notes-m");
    const appt = await seedAppointment(studio, { status: "confirmed" });

    expect(
      await setNotes(appt, studio.studioId, member.userId, "Parking round back"),
    ).toBe("ok");
    const r = await adminQuery(
      `select notes from public.appointments where id = $1`,
      [appt],
    );
    expect(r.rows[0].notes).toBe("Parking round back");
  });

  it("a non-member and an inactive member are both refused", async () => {
    const studio = await seedStudio("b4-notes-foreign");
    const outsider = await seedStudio("b4-notes-outsider");
    const appt = await seedAppointment(studio, { status: "confirmed" });

    await expectRefusal(
      appt,
      () => setNotes(appt, studio.studioId, outsider.userId, "nope"),
      "not_a_member",
    );

    await adminQuery(
      `update public.practitioners set active = false where id = $1`,
      [studio.practitionerId],
    );
    await expectRefusal(
      appt,
      () => setNotes(appt, studio.studioId, studio.userId, "nope"),
      "not_a_member",
    );
  });

  it("a cross-studio appointment is not found", async () => {
    const studio = await seedStudio("b4-notes-cross");
    const other = await seedStudio("b4-notes-cross-2");
    const appt = await seedAppointment(studio, { status: "confirmed" });
    await expectRefusal(
      appt,
      () => setNotes(appt, other.studioId, other.userId, "nope"),
      "appointment_not_found",
    );
  });

  it("SQL owns the trim, and blank clears to NULL", async () => {
    const studio = await seedStudio("b4-notes-trim");
    const appt = await seedAppointment(studio, { status: "confirmed" });

    expect(
      await setNotes(appt, studio.studioId, studio.userId, "   spaced   "),
    ).toBe("ok");
    let r = await adminQuery(
      `select notes from public.appointments where id = $1`,
      [appt],
    );
    expect(r.rows[0].notes).toBe("spaced");

    expect(await setNotes(appt, studio.studioId, studio.userId, "      ")).toBe(
      "ok",
    );
    r = await adminQuery(`select notes from public.appointments where id = $1`, [
      appt,
    ]);
    expect(r.rows[0].notes).toBeNull();
  });

  it("exactly 2000 characters is accepted; 2001 is refused and is a total no-op", async () => {
    const studio = await seedStudio("b4-notes-len");
    const appt = await seedAppointment(studio, { status: "confirmed" });

    expect(
      await setNotes(appt, studio.studioId, studio.userId, "x".repeat(2000)),
    ).toBe("ok");
    const r = await adminQuery(
      `select length(notes) n from public.appointments where id = $1`,
      [appt],
    );
    expect(r.rows[0].n).toBe(2000);

    await expectRefusal(
      appt,
      () => setNotes(appt, studio.studioId, studio.userId, "x".repeat(2001)),
      "notes_too_long",
    );
  });

  it("the ceiling is measured AFTER the trim", async () => {
    const studio = await seedStudio("b4-notes-len-trim");
    const appt = await seedAppointment(studio, { status: "confirmed" });
    // 2000 real characters wrapped in whitespace is 2010 raw but 2000 trimmed.
    expect(
      await setNotes(
        appt,
        studio.studioId,
        studio.userId,
        `     ${"y".repeat(2000)}     `,
      ),
    ).toBe("ok");
  });

  it("the audit records LENGTHS, never the note text", async () => {
    const studio = await seedStudio("b4-notes-audit");
    const appt = await seedAppointment(studio, { status: "confirmed" });
    const secret = "CLIENT SECRET NOTE 12345";

    await setNotes(appt, studio.studioId, studio.userId, "before");
    expect(await setNotes(appt, studio.studioId, studio.userId, secret)).toBe(
      "ok",
    );

    const r = await adminQuery(
      `select details from public.appointment_audit
        where appointment_id = $1 and action = 'notes_corrected'
        order by created_at desc limit 1`,
      [appt],
    );
    const details = r.rows[0].details as Record<string, unknown>;
    expect(details.previous_length).toBe(6);
    expect(details.new_length).toBe(secret.length);
    expect(details.cleared).toBe(false);

    // The whole audit payload for this appointment must not contain the text.
    const all = await adminQuery(
      `select coalesce(string_agg(details::text, ' '), '') blob
         from public.appointment_audit where appointment_id = $1`,
      [appt],
    );
    expect(all.rows[0].blob).not.toContain(secret);
    expect(all.rows[0].blob).not.toContain("before");
  });

  it("writes exactly one audit row per successful correction", async () => {
    const studio = await seedStudio("b4-notes-count");
    const appt = await seedAppointment(studio, { status: "confirmed" });
    const before = await auditCount(appt);
    expect(await setNotes(appt, studio.studioId, studio.userId, "one")).toBe(
      "ok",
    );
    expect(await auditCount(appt)).toBe(before + 1);
  });

  it("does not disturb scheduling fields", async () => {
    const studio = await seedStudio("b4-notes-sched");
    const appt = await seedAppointment(studio, { status: "confirmed" });
    const before = await adminQuery(
      `select starts_at, ends_at, duration_minutes, status, practitioner_id,
              service_id, blocked_ends_at
         from public.appointments where id = $1`,
      [appt],
    );
    expect(
      await setNotes(appt, studio.studioId, studio.userId, "no scheduling change"),
    ).toBe("ok");
    const after = await adminQuery(
      `select starts_at, ends_at, duration_minutes, status, practitioner_id,
              service_id, blocked_ends_at
         from public.appointments where id = $1`,
      [appt],
    );
    expect(JSON.stringify(after.rows[0])).toBe(JSON.stringify(before.rows[0]));
  });
});

describe("0173: EXECUTE grant matrix", () => {
  const FUNCTIONS = [
    "public.revert_appointment_outcome(uuid, uuid, uuid, text, text)",
    "public.set_appointment_notes(uuid, uuid, uuid, text)",
    "public.lock_appointment_for_command(uuid, uuid)",
    "public.appointment_actor_role(uuid, uuid)",
    "public.appointment_has_blocking_dependents(uuid, uuid)",
  ];

  for (const fn of FUNCTIONS) {
    it(`${fn.split("(")[0]}: service_role only`, async () => {
      const r = await adminQuery(
        `select has_function_privilege('service_role', $1, 'EXECUTE') svc,
                has_function_privilege('authenticated', $1, 'EXECUTE') auth,
                has_function_privilege('anon', $1, 'EXECUTE') anon,
                has_function_privilege('public', $1, 'EXECUTE') pub`,
        [fn],
      );
      expect(r.rows[0].svc, "service_role must execute").toBe(true);
      expect(r.rows[0].auth, "authenticated must NOT execute").toBe(false);
      expect(r.rows[0].anon, "anon must NOT execute").toBe(false);
      expect(r.rows[0].pub, "PUBLIC must NOT execute").toBe(false);
    });
  }

  // write_appointment_audit MOVED OUT of the list above at B5/0174, and the
  // move is the assertion. 0173 created it service_role-executable alongside
  // the two repair commands; B5 revoked that because the census proved it has
  // ZERO application callers and exactly two callers anywhere, B4's own
  // revert_appointment_outcome and set_appointment_notes, both postgres-owned
  // SECURITY DEFINER commands that reach it as their OWNER, not as
  // service_role.
  //
  // Left service_role-executable it is a forgery primitive that survives every
  // other control in 0174: it takes actor_type, actor_id, action and details as
  // PARAMETERS, so a service caller could mint an audit event naming any
  // colleague as the actor of any action. That is exactly P1-3.
  it("public.write_appointment_audit is INTERNAL: no role may execute it directly", async () => {
    const r = await adminQuery(
      `select has_function_privilege('service_role', $1, 'EXECUTE') svc,
              has_function_privilege('authenticated', $1, 'EXECUTE') auth,
              has_function_privilege('anon', $1, 'EXECUTE') anon,
              has_function_privilege('public', $1, 'EXECUTE') pub`,
      ["public.write_appointment_audit(uuid, text, uuid, text, jsonb)"],
    );
    expect(r.rows[0].svc, "service_role must NOT execute (B5/0174)").toBe(false);
    expect(r.rows[0].auth, "authenticated must NOT execute").toBe(false);
    expect(r.rows[0].anon, "anon must NOT execute").toBe(false);
    expect(r.rows[0].pub, "PUBLIC must NOT execute").toBe(false);
  });

  it("...and its B4 internal callers still audit successfully through it", async () => {
    // The positive control that makes the revoke meaningful. If EXECUTE were
    // load-bearing for B4, this is where it would show up as a failure rather
    // than as a silently-missing audit row.
    const studio = await seedStudio("b5-wab-internal");
    const appt = await seedAppointment(studio, { status: "completed" });
    const before = await auditCount(appt);

    // The delta MUST be read inside the same transaction: asRole always rolls
    // back (harness.ts), so an audit count taken after it returns would observe
    // the pre-command state and this test would pass while proving nothing.
    const observed = await asRole("service_role", async (q) => {
      const r = await q(
        `select public.revert_appointment_outcome($1, $2, $3, 'completed', $4) code`,
        [appt, studio.studioId, studio.userId, VALID_REASON],
      );
      const n = await q(
        `select count(*)::int n from public.appointment_audit where appointment_id = $1`,
        [appt],
      );
      return { code: r.rows[0].code as string, audit: n.rows[0].n as number };
    });

    expect(observed.code, "B4 repair must still succeed").toBe("ok");
    expect(
      observed.audit,
      "the internal helper still wrote exactly one audit row",
    ).toBe(before + 1);
  });

  it("a browser role calling the command is refused at the privilege layer", async () => {
    const studio = await seedStudio("b4-exec");
    const appt = await seedAppointment(studio, { status: "completed" });
    for (const role of ["anon", "authenticated"] as const) {
      const failure = await asRole(role, async (q) => {
        try {
          await q(
            `select public.revert_appointment_outcome($1, $2, $3, 'completed', $4)`,
            [appt, studio.studioId, studio.userId, VALID_REASON],
          );
          return null;
        } catch (e) {
          return e as { code?: string; message?: string };
        }
      });
      expect(failure, `${role} must not execute the command`).not.toBeNull();
      // 42501 is shared with RLS, so the message is what discriminates.
      expect(failure?.code).toBe("42501");
      expect(failure?.message ?? "").toMatch(/permission denied for function/i);
    }
  });

  it("B4 does not re-open direct appointment DML for the browser roles", async () => {
    // 0173 must not have re-granted anything 0172 took away.
    const r = await adminQuery(
      `select r.rolname::text role,
              has_table_privilege(r.rolname, 'public.appointments', 'INSERT') ins,
              has_table_privilege(r.rolname, 'public.appointments', 'UPDATE') upd,
              has_table_privilege(r.rolname, 'public.appointments', 'DELETE') del,
              has_table_privilege(r.rolname, 'public.appointments', 'SELECT') sel
         from (values ('anon'),('authenticated')) r(rolname)`,
    );
    for (const row of r.rows) {
      expect(row.ins, `${row.role} INSERT`).toBe(false);
      expect(row.upd, `${row.role} UPDATE`).toBe(false);
      expect(row.del, `${row.role} DELETE`).toBe(false);
      expect(row.sel, `${row.role} SELECT is retained`).toBe(true);
    }
  });
});
