/**
 * scripts/synthetic-mirror/plan.mjs — the pure reconciliation planner.
 *
 * Takes an aggregate SOURCE profile and an aggregate TARGET census and returns
 * the work required to make the target's SYNTHETIC population resemble the
 * source's shape. Pure: no clock, no I/O, no randomness.
 *
 * STATISTICAL TWIN, NEVER A ROW TWIN
 * ----------------------------------
 * Every decision here is made from counts. The planner cannot express "make
 * synthetic client 7 look like source client 7" because it never receives a
 * source row — only totals. Synthetic clients are chosen by ordinal to satisfy
 * a count, independently of which real client caused the count to change.
 *
 * GROW-ONLY
 * ---------
 * The planner never plans a deletion. If the source shrinks (a client is
 * deleted at Willow) the mirror simply stops growing; it does not reach into
 * the target and remove anything. Deletion happens only through the explicit,
 * separately-authorized `reset` command. This is what makes a count DECREASE
 * safe, and it removes the whole class of "reconciler deleted my fixtures"
 * failures.
 *
 * IDEMPOTENCY
 * -----------
 * "Create N clients" means "ensure ordinals 0..N-1 exist". Ordinal -> id is
 * deterministic (identity.mjs), so a re-run derives the same ids and the insert
 * is a no-op via `on conflict do nothing`. There is no watermark to advance,
 * nothing to roll back, and no partial-failure state: a crashed run simply
 * leaves some ordinals uncreated, and the next run creates exactly those.
 */

import { PROFILE_KEYS } from "./profile.mjs";

/** Sum of the four appointment status buckets. */
export function totalAppointments(profile) {
  return (
    profile.appt_confirmed +
    profile.appt_completed +
    profile.appt_cancelled +
    profile.appt_no_show
  );
}

/**
 * Build the reconciliation plan.
 *
 * @param {object} source  aggregate profile of the source studio
 * @param {object} target  census of the target's PROVABLY SYNTHETIC rows only
 * @returns {object} plan
 */
export function buildPlan(source, target) {
  for (const k of PROFILE_KEYS) {
    if (!Number.isInteger(source[k])) {
      throw new TypeError(`buildPlan: source.${k} must be an integer`);
    }
  }

  const desiredClients = source.clients_total;
  const haveClients = target.syntheticClients ?? 0;
  const clientsToCreate = Math.max(0, desiredClients - haveClients);

  const desiredAppointments = totalAppointments(source);
  const haveAppointments = target.syntheticAppointments ?? 0;
  const appointmentsToCreate = Math.max(0, desiredAppointments - haveAppointments);

  const desiredSessions = source.sessions_total;
  const haveSessions = target.syntheticSessions ?? 0;
  const sessionsToCreate = Math.max(0, desiredSessions - haveSessions);

  const desiredIntakes =
    source.intake_in_progress + source.intake_submitted + source.intake_reviewed;
  const haveIntakes = target.syntheticIntakes ?? 0;
  const intakesToCreate = Math.max(0, desiredIntakes - haveIntakes);

  // Status mix is expressed as target COUNTS, applied to synthetic ordinals in
  // a fixed order, so the same plan always paints the same distribution.
  const appointmentMix = {
    confirmed: source.appt_confirmed,
    completed: source.appt_completed,
    cancelled: source.appt_cancelled,
    no_show: source.appt_no_show,
  };

  const intakeMix = {
    in_progress: source.intake_in_progress,
    submitted: source.intake_submitted,
    reviewed: source.intake_reviewed,
  };

  const sessionMix = {
    missingAftercare: source.sessions_missing_aftercare,
    withNextNote: source.sessions_with_next_note,
  };

  return {
    clients: {
      desired: desiredClients,
      existingSynthetic: haveClients,
      toCreate: clientsToCreate,
      ordinalRange: clientsToCreate > 0 ? [haveClients, desiredClients - 1] : null,
    },
    appointments: {
      desired: desiredAppointments,
      existingSynthetic: haveAppointments,
      toCreate: appointmentsToCreate,
      mix: appointmentMix,
    },
    sessions: {
      desired: desiredSessions,
      existingSynthetic: haveSessions,
      toCreate: sessionsToCreate,
      mix: sessionMix,
    },
    intakes: {
      desired: desiredIntakes,
      existingSynthetic: haveIntakes,
      toCreate: intakesToCreate,
      mix: intakeMix,
    },
    // Recorded in the dry-run so a reviewer sees what was deliberately not done
    // rather than having to infer it from silence.
    skipped: [
      {
        what: "payment / ledger fixtures",
        why:
          "Production Stripe runs in LIVE mode (STRIPE_SECRET_KEY starts sk_live_), " +
          "and stripe_livemode is simultaneously the safety gate and the dashboard " +
          "visibility filter — a row that the dashboard would display is by " +
          "definition a live-mode row. Payment-state testing stays local/E2E.",
      },
      {
        what: "no_services studio blocker",
        why:
          "Firing it requires zero active services, which would break booking for " +
          "the whole target studio and prevent testing everything else.",
      },
      {
        what: "client email / phone",
        why:
          "Left NULL so every outbound email and SMS path short-circuits " +
          "structurally, independent of studio toggles.",
      },
    ],
  };
}

/** True if the plan would write nothing. */
export function isNoOpPlan(plan) {
  return (
    plan.clients.toCreate === 0 &&
    plan.appointments.toCreate === 0 &&
    plan.sessions.toCreate === 0 &&
    plan.intakes.toCreate === 0
  );
}
