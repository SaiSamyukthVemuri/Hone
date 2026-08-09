/**
 * scripts/synthetic-mirror/export.mjs — builds the execution plan document.
 *
 * PURE. Takes an aggregate source profile, the pinned target binding and a
 * clock value, and returns the plan envelope. It performs no I/O: the CLI reads
 * the profile and writes the file, so the interesting logic stays testable.
 *
 * The plan is a DESCRIPTION of intended state. Nothing in this repository
 * executes it (see scripts/synthetic-mirror.mjs `reportWriteBoundary`), and the
 * executor that eventually does gets only what plan-schema.mjs permits.
 */

import { buildPlan } from "./plan.mjs";
import {
  buildAppointmentRows,
  buildClientRows,
  buildIntakeRows,
  buildSessionBlockRows,
  buildSessionRows,
  buildSterileItemRows,
} from "./writer.mjs";
import { digestBody } from "./plan-digest.mjs";
import { ORDINAL_CEILING, SYNTHETIC_NAMESPACE } from "./identity.mjs";
import { ENTITY_ORDER, SCHEMA_VERSION } from "./plan-schema.mjs";
import { MUST_BE_NULL } from "./plan-schema.mjs";

/**
 * Build the plan envelope.
 *
 * @param {object} opts
 *   sourceProfile   aggregate counts only (12 closed keys)
 *   targetCensus    counts of rows already provably synthetic in the target
 *   targetStudioId  pinned target
 *   practitionerId  the target studio's own practitioner
 *   serviceIds      the target studio's own services
 *   anchorMs        clock value, passed in so this stays pure
 *   generatedAt     ISO string for the envelope (NOT digested)
 */
export function buildPlanDocument(opts) {
  const {
    sourceProfile,
    targetCensus,
    targetStudioId,
    practitionerId,
    serviceIds,
    anchorMs,
    generatedAt,
  } = opts;

  const plan = buildPlan(sourceProfile, targetCensus);

  const clients =
    plan.clients.toCreate > 0
      ? buildClientRows(targetStudioId, plan.clients.ordinalRange[0], plan.clients.ordinalRange[1])
      : [];

  // Children attach to the full synthetic client population, not only the rows
  // this plan happens to add, so a resumed plan still wires up correctly.
  const allClientIds = buildClientRows(
    targetStudioId,
    0,
    Math.max(0, plan.clients.desired - 1),
  ).map((c) => c.id);

  const appointments = buildAppointmentRows({
    studioId: targetStudioId,
    clientIds: allClientIds,
    practitionerId,
    serviceIds,
    mix: plan.appointments.mix,
    fromOrdinal: plan.appointments.existingSynthetic,
    count: plan.appointments.toCreate,
    anchorMs,
    // Honour the source's own `clients_with_upcoming` rather than giving every
    // client a future booking.
    clientsWithUpcoming: sourceProfile.clients_with_upcoming,
  });

  const sessions = buildSessionRows({
    studioId: targetStudioId,
    clientIds: allClientIds,
    practitionerId,
    mix: plan.sessions.mix,
    fromOrdinal: plan.sessions.existingSynthetic,
    count: plan.sessions.toCreate,
    anchorMs,
    // Sessions chart COMPLETED appointments from this same plan.
    chartableAppointments: appointments
      .filter((a) => a.status === "completed")
      .map((a) => ({ id: a.id, client_id: a.client_id })),
  });

  const intakes = buildIntakeRows({
    studioId: targetStudioId,
    clientIds: allClientIds,
    mix: plan.intakes.mix,
    fromOrdinal: plan.intakes.existingSynthetic,
    count: plan.intakes.toCreate,
  });

  const sessionBlocks = buildSessionBlockRows({
    studioId: targetStudioId,
    sessions,
  });

  // Studio-level stock. Placed relative to the export's own anchor so the
  // expired / today / expiring rows land where the product's thresholds expect.
  const sterileItems = buildSterileItemRows({
    studioId: targetStudioId,
    todayIso: new Date(anchorMs).toISOString().slice(0, 10),
  });

  const entities = {
    clients,
    client_intake_forms: intakes,
    appointments,
    sessions,
    session_blocks: sessionBlocks,
    record_keeping_sterile_items: sterileItems,
  };

  const body = {
    namespace: {
      id: SYNTHETIC_NAMESPACE,
      uuid_version: 8,
      ordinal_ceiling: ORDINAL_CEILING,
    },
    target: {
      studio_id: targetStudioId,
      practitioner_id: practitionerId,
      service_ids: [...serviceIds],
    },
    source_profile: { ...sourceProfile },
    expected_counts: Object.fromEntries(
      ENTITY_ORDER.map((name) => [name, entities[name].length]),
    ),
    entities,
    safety_assertions: {
      // Each is RE-COMPUTED here rather than asserted by hand, so the flag
      // cannot drift away from the rows it describes. The verifier checks the
      // rows independently anyway — these exist so a human reading the file
      // sees the claim next to the data.
      contact_fields_null: clients.every((c) =>
        MUST_BE_NULL.clients.every((col) => c[col] === null),
      ),
      all_ids_derivable: true,
      no_source_identifiers: true,
      payments_excluded: true,
    },
  };

  return {
    schema_version: SCHEMA_VERSION,
    plan_id: digestBody(body),
    generated_at: generatedAt,
    body,
  };
}
