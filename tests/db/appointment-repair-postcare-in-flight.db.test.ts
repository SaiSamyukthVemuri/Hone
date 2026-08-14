// APPOINTMENT BOUNDARY B8 × B4, the cross-command invariant.
//
// B8/0177 introduces a state B4/0173 has never seen: an appointment with an
// external email IN FLIGHT. The two commands are independently correct and
// still compose into a wrong outcome:
//
//     1. the appointment is `completed`
//     2. claim_postcare_send wins and COMMITS
//     3. postcare_email_claimed_at is populated
//     4. the provider call is in flight
//     5. the owner invokes revert_appointment_outcome
//     6. appointment_has_blocking_dependents checked sent_at but NOT claimed_at
//     7. completed -> confirmed succeeds
//     8. the provider accepts
//     9. settle_postcare_send still holds the EXACT token and stamps sent_at
//
// Result: an appointment at `confirmed` for which aftercare has been emailed.
//
// THE FIX IS AT STEP 6, NOT STEP 9. Refusing the settlement after the provider
// has accepted would discard evidence of a real email and make Hone LESS
// truthful. The lifecycle change is blocked before it can happen.
//
// WHAT THIS FILE IS BUILT AROUND. Every case drives the REAL commands,
// claim_postcare_send, settle_postcare_send, revert_appointment_outcome, and
// never hand-writes a postcare column to fake a state. A test that seeded
// `postcare_email_claimed_at` with an UPDATE would prove the new predicate
// fires, but not that the CLAIM COMMAND produces a state the REPAIR COMMAND
// then refuses, which is the actual integration claim. A refusal is also
// asserted as a TOTAL no-op (byte-identical row, unchanged audit count), the
// 0173 convention, so a command that writes first and validates second is
// caught.

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedHistoricalAppointmentAudit,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

afterAll(async () => {
  await closePool();
});

const VALID_REASON = "Marked complete by mistake, client rebooked";

/**
 * A COMPLETED appointment with the audit baseline the 72-hour repair window is
 * measured from, and nothing else, no session, no payment, no fee, no
 * successor. Everything that could block a repair is therefore attributable to
 * postcare alone.
 */
async function seedCompletedRepairable(
  studio: SeededStudio,
  // Studio-wide reservations carry an exclusion constraint, so two fixtures in
  // ONE studio must not share an interval. Callers that seed a second
  // appointment (the reschedule successor) pass their own offset.
  startsAgo = "2 hours",
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id,
        starts_at, ends_at, duration_minutes, status)
     values ($1, $2, $3, $4,
             now() - ($5)::interval,
             now() - ($5)::interval + interval '60 minutes', 60, 'completed')`,
    [id, studio.studioId, studio.practitionerId, studio.clientId, startsAgo],
  );
  // 0174 derives appointment_audit.created_at at INSERT, so a historical
  // baseline can only be built through the owner-only harness fixture.
  await seedHistoricalAppointmentAudit({
    appointmentId: id,
    actorType: "practitioner",
    actorId: studio.practitionerId,
    action: "marked_complete",
    createdAtSql: "now() - interval '1 hour'",
  });
  return id;
}

type ClaimOut = { result: string; claimed_at: string | null };

async function claim(
  studio: SeededStudio,
  apptId: string,
  isResend = false,
): Promise<ClaimOut> {
  const r = await adminQuery(
    `select result, claimed_at from public.claim_postcare_send($1,$2,$3,$4)`,
    [apptId, studio.studioId, studio.practitionerId, isResend],
  );
  return r.rows[0] as ClaimOut;
}

async function settle(
  studio: SeededStudio,
  apptId: string,
  claimedAt: string | null,
  success: boolean,
  retryable = false,
): Promise<{ result: string }> {
  const r = await adminQuery(
    `select result from public.settle_postcare_send($1,$2,$3,$4,$5)`,
    [apptId, studio.studioId, claimedAt, success, retryable],
  );
  return r.rows[0] as { result: string };
}

async function revert(
  studio: SeededStudio,
  apptId: string,
  expected = "completed",
): Promise<string> {
  const r = await adminQuery(
    `select public.revert_appointment_outcome($1,$2,$3,$4,$5) code`,
    [apptId, studio.studioId, studio.userId, expected, VALID_REASON],
  );
  return r.rows[0].code as string;
}

/** The SAME helper the repair UI loader calls, so both surfaces are covered. */
async function blockingClass(
  studio: SeededStudio,
  apptId: string,
): Promise<string | null> {
  const r = await adminQuery(
    `select public.appointment_has_blocking_dependents($1,$2) c`,
    [apptId, studio.studioId],
  );
  return r.rows[0].c as string | null;
}

async function snapshot(id: string): Promise<string> {
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

async function postcareState(id: string) {
  const r = await adminQuery(
    `select status, postcare_email_claimed_at, postcare_email_sent_at,
            postcare_email_failed_at
       from public.appointments where id = $1`,
    [id],
  );
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// R1, the race itself
// ---------------------------------------------------------------------------
describe("R1: an unresolved postcare claim blocks outcome repair", () => {
  it("refuses with blocked_postcare_in_flight and changes NOTHING", async () => {
    const studio = await seedStudio("b8b4-inflight");
    const appt = await seedCompletedRepairable(studio);

    // Control: before any claim this appointment is genuinely repairable, so a
    // later refusal is attributable to the claim and not to some other blocker
    // the fixture happened to create.
    expect(await blockingClass(studio, appt)).toBeNull();

    const won = await claim(studio, appt);
    expect(won.result).toBe("claimed");
    expect(won.claimed_at).not.toBeNull();

    // The helper the repair UI reads and the command's own gate must agree.
    expect(await blockingClass(studio, appt)).toBe("postcare_in_flight");

    const before = await snapshot(appt);
    const beforeAudit = await auditCount(appt);

    expect(await revert(studio, appt)).toBe("blocked_postcare_in_flight");

    // TOTAL no-op: the appointment stays completed, the token the in-flight
    // sender is holding is untouched (settlement must still be able to match
    // it), and no repair audit row was written.
    const after = await postcareState(appt);
    expect(after.status).toBe("completed");
    expect(new Date(after.postcare_email_claimed_at).toISOString()).toBe(
      new Date(won.claimed_at as string).toISOString(),
    );
    expect(await snapshot(appt), "row must be byte-identical").toBe(before);
    expect(await auditCount(appt), "no repair audit row").toBe(beforeAudit);
  });

  it("the in-flight sender can still settle afterwards, under its original token", async () => {
    // The refusal must not have cost the real send its ability to be recorded.
    const studio = await seedStudio("b8b4-inflight-settles");
    const appt = await seedCompletedRepairable(studio);

    const won = await claim(studio, appt);
    expect(await revert(studio, appt)).toBe("blocked_postcare_in_flight");

    expect((await settle(studio, appt, won.claimed_at, true)).result).toBe(
      "settled",
    );
    const after = await postcareState(appt);
    expect(after.postcare_email_sent_at).not.toBeNull();
    // ...and the appointment the aftercare refers to is still the completed
    // visit it was sent for. That is the whole point.
    expect(after.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// R2, the block lifts when the send RESOLVES
// ---------------------------------------------------------------------------
describe("R2: a settled FAILURE releases the appointment for repair", () => {
  it("stops blocking once settlement clears the claim, when nothing else blocks", async () => {
    const studio = await seedStudio("b8b4-failed");
    const appt = await seedCompletedRepairable(studio);

    const won = await claim(studio, appt);
    expect(await blockingClass(studio, appt)).toBe("postcare_in_flight");

    expect((await settle(studio, appt, won.claimed_at, false, true)).result).toBe(
      "settled",
    );

    // The failure settlement clears claimed_at and never touches sent_at, so
    // neither postcare class applies any more.
    const state = await postcareState(appt);
    expect(state.postcare_email_claimed_at).toBeNull();
    expect(state.postcare_email_sent_at).toBeNull();
    expect(state.postcare_email_failed_at).not.toBeNull();

    expect(await blockingClass(studio, appt)).toBeNull();
    expect(await revert(studio, appt)).toBe("ok");
    expect((await postcareState(appt)).status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// R3, precedence: a SETTLED SUCCESS is still postcare_sent
// ---------------------------------------------------------------------------
describe("R3: a successful send keeps reporting blocked_postcare_sent", () => {
  it("does not get relabelled by the new class", async () => {
    const studio = await seedStudio("b8b4-sent");
    const appt = await seedCompletedRepairable(studio);

    const won = await claim(studio, appt);
    expect((await settle(studio, appt, won.claimed_at, true)).result).toBe(
      "settled",
    );

    const state = await postcareState(appt);
    expect(state.postcare_email_sent_at).not.toBeNull();
    expect(state.postcare_email_claimed_at).toBeNull();

    // The pre-existing class, unchanged: the practitioner is told the
    // authoritative thing: aftercare has already been emailed.
    expect(await blockingClass(studio, appt)).toBe("postcare_sent");
    expect(await revert(studio, appt)).toBe("blocked_postcare_sent");
    expect((await postcareState(appt)).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// R4, precedence under a RESEND, where BOTH conditions are true at once
// ---------------------------------------------------------------------------
describe("R4: a resend claim over a historical send stays postcare_sent", () => {
  it("postcare_sent remains authoritative when both classes apply", async () => {
    // This is the ordering assertion. A resend sets claimed_at while sent_at is
    // already non-null, so both branches match; appending postcare_in_flight
    // LAST is what keeps the older, stronger fact winning. Reordering the two
    // would silently downgrade "aftercare has already been emailed" to
    // "postcare is currently being sent".
    const studio = await seedStudio("b8b4-resend");
    const appt = await seedCompletedRepairable(studio);

    const first = await claim(studio, appt);
    expect((await settle(studio, appt, first.claimed_at, true)).result).toBe(
      "settled",
    );

    const resend = await claim(studio, appt, true);
    expect(resend.result).toBe("claimed");

    const state = await postcareState(appt);
    expect(state.postcare_email_sent_at).not.toBeNull();
    expect(state.postcare_email_claimed_at).not.toBeNull();

    expect(await blockingClass(studio, appt)).toBe("postcare_sent");
    expect(await revert(studio, appt)).toBe("blocked_postcare_sent");
  });
});

// ---------------------------------------------------------------------------
// R5, the other four classes are untouched by this migration
// ---------------------------------------------------------------------------
describe("R5: the replacement preserves the 0173 helper's existing behaviour", () => {
  it("still returns NULL for a plain repairable appointment", async () => {
    const studio = await seedStudio("b8b4-null");
    const appt = await seedCompletedRepairable(studio);
    expect(await blockingClass(studio, appt)).toBeNull();
  });

  it("still reports linked_session, and it still outranks postcare", async () => {
    // Order is fixed so the code is deterministic when several classes apply.
    // linked_session is checked second and postcare last, so a claimed send on
    // an appointment with a session must still read linked_session.
    const studio = await seedStudio("b8b4-session");
    const appt = await seedCompletedRepairable(studio);
    await adminQuery(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, appointment_id)
       values (gen_random_uuid(), $1, $2, $3, 'electrolysis', $4)`,
      [studio.studioId, studio.clientId, studio.practitionerId, appt],
    );
    expect(await blockingClass(studio, appt)).toBe("linked_session");

    await claim(studio, appt);
    expect(await blockingClass(studio, appt)).toBe("linked_session");
    expect(await revert(studio, appt)).toBe("blocked_linked_session");
  });

  it("still reports rescheduled for a successor", async () => {
    const studio = await seedStudio("b8b4-resched");
    const appt = await seedCompletedRepairable(studio);
    const successor = await seedCompletedRepairable(studio, "6 hours");
    await adminQuery(
      `update public.appointments set rescheduled_to_appointment_id = $2 where id = $1`,
      [appt, successor],
    );
    expect(await blockingClass(studio, appt)).toBe("rescheduled");
  });

  it("is studio-scoped: another studio's caller sees no blocker", async () => {
    // The helper takes both keys and every branch filters on studio_id, so a
    // cross-studio probe must not be able to read the postcare state.
    const studio = await seedStudio("b8b4-scope");
    const other = await seedStudio("b8b4-scope-other");
    const appt = await seedCompletedRepairable(studio);
    await claim(studio, appt);

    expect(await blockingClass(studio, appt)).toBe("postcare_in_flight");
    expect(await blockingClass(other, appt)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R6, privilege posture survives CREATE OR REPLACE
// ---------------------------------------------------------------------------
describe("R6: the replaced helper keeps its service-role-only posture", () => {
  it("is executable by service_role and by nobody else", async () => {
    const r = await adminQuery(
      `select
         has_function_privilege('service_role',   $1, 'EXECUTE') as svc,
         has_function_privilege('authenticated',  $1, 'EXECUTE') as auth,
         has_function_privilege('anon',           $1, 'EXECUTE') as anon,
         has_function_privilege('public',         $1, 'EXECUTE') as pub`,
      ["public.appointment_has_blocking_dependents(uuid, uuid)"],
    );
    expect(r.rows[0].svc).toBe(true);
    expect(r.rows[0].auth).toBe(false);
    expect(r.rows[0].anon).toBe(false);
    expect(r.rows[0].pub).toBe(false);
  });

  it("is still STABLE and SECURITY DEFINER with a pinned search_path", async () => {
    const r = await adminQuery(
      `select p.provolatile, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'appointment_has_blocking_dependents'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].provolatile).toBe("s");
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
  });
});
