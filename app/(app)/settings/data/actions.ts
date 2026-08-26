"use server";

import JSZip from "jszip";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { rowsToCsv } from "@/lib/csv";
// The clinical-notes filename and header row are still owned by this module;
// the export registry imports them from here, and this module reaches them
// through the registry like every other file. One definition, one consumer.
import {
  buildClinicalNoteExportRows,
  type ClinicalNoteExportSource,
} from "@/lib/export/clinical-notes";
import { fetchAllRows, EXPORT_PAGE_SIZE } from "@/lib/export/paginate";
import {
  fetchExportRows,
  mapExportRows,
  rowsForResource,
  selectedColumnsByResource,
  type ExportRead,
} from "@/lib/export/provenance";
// TRUTH-01A. The canonical export resource registry: one declaration per
// studio-owned resource, and the ONLY place a filename, a header row, a
// source-count expectation or a file description lives. Everything this module
// used to hard-code — the CSV names, the README file list, the audit metadata
// file list, the manifest's count-check coverage — is derived from it now.
import {
  auditEmissionParity,
  auditExportedFilenames,
  auditSelectedColumns,
  auditSourceCountCoverage,
  duplicateFilenameError,
  emissionParityError,
  excludedResources,
  selectedColumnError,
  exportedResources,
  exportSpec,
  pendingResources,
} from "@/lib/export/resource-registry";
// One decision point for the budget read, backed by the SAME narrow
// migration-skew classifier the Consultation page uses, so the two surfaces
// cannot drift into tolerating different sets of errors.
import {
  decideBudgetExportRead,
  type BudgetExportReadResult,
} from "@/lib/budget/export-read";
import { mergeReactionIntoChips } from "@/lib/observation-chips";
import {
  blockAreasLabel,
  type BlockArea,
  type Laterality,
} from "@/lib/sessions/block-areas";

export type ExportResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; error: string };

function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "studio";
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function exportStudioDataAction(): Promise<ExportResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot export data." };
  }
  // PR #189 (pilot safety): the export is the entire studio dataset
  // (every client's contact info, health notes, charting history).
  // Only the studio owner may pull it. The refusal copy is generic;
  // it does not explain the role model to a non-owner.
  if (practitioner.role !== "owner") {
    return { ok: false, error: "You do not have permission to export data." };
  }

  const supabase = await createClient();

  // ---------------------------------------------------------------------
  // F7. THE SELECT THAT IS EXECUTED IS THE SELECT THAT IS AUDITED — and it is
  // now read off the REQUEST, not off a wrapper.
  //
  // Three earlier attempts failed, each closer than the last. Unioning observed
  // selects BY TABLE let the practitioners display-name LOOKUP satisfy the
  // practitioners EXPORT contract. A static per-resource map fixed the union
  // but not the substance: a declaration says what a query SHOULD select, so
  // swapping a call site to an inline literal left the map correct and the CSV
  // column blank. Recording the literal AT `.select()` was closer still, and
  // Codex found the remaining gap: postgrest-js keeps `select` in the request
  // URL and a LATER `.select()` REPLACES it, so the recorder could hold
  // "id, name, email" while the request asked for "id".
  //
  // `fetchExportRows` reads `select` off the built request instead — the only
  // copy PostgREST can act on — and returns the rows in an envelope carrying
  // both that select and the resource whose CSV they become. The audit reads
  // the envelope's select; `writeCsv` reads its resource. One object, so the
  // two halves cannot drift the way a declaration and its call site did.
  //
  // A read that does not feed an exported CSV — the practitioners lookup, the
  // session_blocks and services reads — uses plain `fetchAllRows`, carries no
  // envelope, and therefore can neither satisfy an export's select contract nor
  // be written as an exported resource.
  // ---------------------------------------------------------------------

  // electrolysis_entries and laser_entries don't carry studio_id directly;
  // RLS scopes them through the parent session, so a plain select is safe.
  const [
    clientsRes,
    sessionsRes,
    electRes,
    laserRes,
    practitionersRes,
    pricingRes,
    blocksRes,
    appointmentsRes,
    treatmentPlansRes,
    treatmentPlanStagesRes,
    servicesRes,
    allPractitionersRes,
    // PR #312: record-keeping / inspection tables.
    sterileItemsRes,
    disinfectantsRes,
    exposureIncidentsRes,
    auditEventsRes,
    // The authoritative append-only clinical narrative (0126/0127):
    // consultation + skin_hair_analysis. Visible and printable in the product
    // but absent from this export until now.
    clinicalNotesRes,
    // Migration 0183: CURRENT client budget context. Practitioner-held client
    // data, so it is exported for portability alongside every comparable
    // practitioner record. Deliberately EXCLUDED from the all-or-nothing error
    // guard below — see the comment there.
    // TRUTH-01B-1: four studio-owned resources become first-class files.
    consentSignaturesRes,
    probeLotsRes,
    servicePractitionersRes,
    treatmentGoalsRes,
    budgetContextRes,
  ] = await Promise.all([
    fetchExportRows("clients", (from, to) =>
      supabase
        .from("clients")
        .select(
          "id, name, pronouns, date_of_birth, fitzpatrick_type, allergies, skin_notes, emergency_contact_name, emergency_contact_phone, email, phone, created_at, address, contraindications, photo_consent, sms_consent_at, sms_consent_source, sms_opted_out_at, sms_opt_out_source, archived_at",
        )
        .eq("studio_id", studio.id)
        .order("name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("sessions", (from, to) =>
      supabase
        .from("sessions")
        .select(
          "id, client_id, practitioner_id, performed_by_practitioner_id, modality, started_at, ended_at, price_paid_cents, session_notes, created_at, appointment_id, treatment_plan_id, started_at_original, next_session_note, aftercare_and_risks_explained_at, record_origin, legacy_classification",
        )
        .eq("studio_id", studio.id)
        .is("deleted_at", null)
        .order("started_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("electrolysis_entries", (from, to) =>
      supabase
        .from("electrolysis_entries")
        .select(
          "id, session_id, area, areas, probe_size, probe_lot_id, mode, intensity, duration_seconds, pulse_count, pulse_delay_seconds, comments, observation_chips, created_at, block_id, energy_level, apilus_modality, machine_frequency, minutes_performed, probe_type, hairs_treated, galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent, thermolysis_intensity_percent, thermolysis_duration_seconds, units_of_lye, deleted_at",
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("laser_entries", (from, to) =>
      supabase
        .from("laser_entries")
        .select(
          "id, session_id, zone, session_number, equipment_params, observation_notes, created_at, ejection_results, deleted_at",
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("practitioners", (from, to) =>
      supabase
        .from("practitioners")
        .select(
          "id, display_name, email, role, active, created_at, color, default_machine_frequency",
        )
        .eq("studio_id", studio.id)
        .eq("active", true)
        .order("display_name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("client_pricing", (from, to) =>
      supabase
        .from("client_pricing")
        .select(
          "id, client_id, service_name, price_cents, notes, effective_from",
        )
        .eq("studio_id", studio.id)
        .order("effective_from", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Read-only lookup of the structured area + probe metadata that lives on
    // session_blocks (migrations 0039 / 0041). Merged onto each electrolysis
    // entry by block_id below so the export carries the structured probe and
    // area now collected by the one-page charting form. Includes deleted
    // blocks so any entry's block_id still resolves.
    fetchAllRows((from, to) =>
      supabase
        .from("session_blocks")
        .select(
          "id, primary_area, side, custom_area_detail, probe_key, probe_brand, probe_material, probe_piece_type, probe_shank, probe_size_value, probe_length, probe_label, reaction_type",
        )
        .eq("studio_id", studio.id)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Appointments (read-only). Studio-scoped. cancellation_token and the
    // internal scheduling snapshots (buffer_minutes_snapshot,
    // blocked_ends_at) are deliberately NOT selected: backup of human
    // booking data only, never opaque tokens or trigger-managed mechanics.
    fetchExportRows("appointments", (from, to) =>
      supabase
        .from("appointments")
        .select(
          "id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, status, notes, cancellation_reason, cancelled_at, cancelled_by, created_at, updated_at, referral_source, rescheduled_from_appointment_id, rescheduled_to_appointment_id, cancellation_kind, booked_outside_availability",
        )
        .eq("studio_id", studio.id)
        .order("starts_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Treatment plans (read-only). Studio-scoped. budget_notes /
    // practitioner_notes live on this table and ARE plan data; private
    // warnings + personal notes live on the separate client_personal_notes
    // table and are never read here.
    fetchExportRows("treatment_plans", (from, to) =>
      supabase
        .from("treatment_plans")
        .select(
          "id, client_id, name, primary_area, treatment_areas, estimated_timeline_months_min, estimated_timeline_months_max, status, suggested_visit_count, treatment_goal_minutes_override, budget_notes, practitioner_notes, created_by_practitioner_id, closed_by_practitioner_id, created_at, closed_at",
        )
        .eq("studio_id", studio.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Treatment plan stages (read-only). studio_id is denormalized on this
    // child table (migration 0034), so a direct studio-scoped read is safe.
    fetchExportRows("treatment_plan_stages", (from, to) =>
      supabase
        .from("treatment_plan_stages")
        .select(
          "id, plan_id, sort_order, name, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit, notes, created_at, updated_at",
        )
        .eq("studio_id", studio.id)
        .order("plan_id", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Name-resolution maps (read-only). All services and ALL practitioners
    // (including inactive) so appointment/plan rows can show a readable
    // name beside the stored ID even when the referenced row is inactive.
    fetchExportRows("services", (from, to) =>
      supabase
        .from("services")
        .select(
          "id, name, description, default_duration_minutes, price_cents, active, modality, sort_order, pre_care_instructions, calendar_color, created_at, updated_at",
        )
        .eq("studio_id", studio.id)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("practitioners")
        .select("id, display_name")
        .eq("studio_id", studio.id)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // PR #312: record-keeping / inspection tables (read-only). Studio-scoped
    // + read through the SAME RLS client, so exposure incidents (and their
    // audit rows) remain OWNER-ONLY per migration 0088, enforced twice: the
    // action's role==="owner" gate above AND the owner-only RLS SELECT policy.
    // No image binaries / storage paths / payment tables here.
    fetchExportRows("record_keeping_sterile_items", (from, to) =>
      supabase
        .from("record_keeping_sterile_items")
        // 0182: date_discarded is part of the inspection record. The export is
        // HISTORICAL and is deliberately NOT filtered on it — a discarded item
        // stays in the export, now carrying the lifecycle fact that explains
        // why an expired row needs no action.
        .select(
          "id, date_purchased, item_description, manufacturer_name, amount_purchased, lot_number, expiry_date, date_discarded, notes, created_by_practitioner_id, created_at, updated_at, probe_key",
        )
        .eq("studio_id", studio.id)
        .order("date_purchased", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("record_keeping_disinfectants", (from, to) =>
      supabase
        .from("record_keeping_disinfectants")
        .select(
          "id, date_prepared, disinfectant_name, concentration, date_discarded, discard_due_date, operator_practitioner_id, operator_name, notes, created_by_practitioner_id, created_at, updated_at",
        )
        .eq("studio_id", studio.id)
        .order("date_prepared", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Exposure incidents carry sensitive PII (exposed-person name/address/
    // phone). SELECT is owner-only (0088); the RLS client returns them ONLY
    // because this action runs as the owner. Never switch to the admin client.
    fetchExportRows("record_keeping_exposure_incidents", (from, to) =>
      supabase
        .from("record_keeping_exposure_incidents")
        .select(
          "id, incident_date, exposed_person_full_name, exposed_person_address, exposed_person_phone, exposure_details, action_taken, staff_involved_name, notes, created_by_practitioner_id, created_at, updated_at",
        )
        .eq("studio_id", studio.id)
        .order("incident_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Audit events: REDUCED export (PR #312). We export the record identity +
    // action + changed-field NAMES + actor + timestamp only. The full `changes`
    // value-snapshot JSON and free-form `metadata` are DELIBERATELY NOT selected
    // that avoids duplicating exposure-incident PII into a second file.
    fetchExportRows("record_keeping_audit_events", (from, to) =>
      supabase
        .from("record_keeping_audit_events")
        .select(
          "id, record_type, record_id, action, changed_fields, actor_practitioner_id, actor_display_name, created_at",
        )
        .eq("studio_id", studio.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // client_clinical_notes, consultation + skin_hair_analysis.
    //
    // TENANCY, twice: the explicit studio filter below AND the 0126
    // `client_clinical_notes_member_select` RLS policy
    // (`is_studio_member(studio_id)`), because this read goes through the same
    // authenticated `createClient()` every other table above uses. No
    // service-role client, no cross-studio lookup, no widening.
    //
    // EVERY ROW, deliberately. The table is append-only and a correction is a
    // NEW row pointing at the one it supersedes, so `.limit()` or any
    // latest-per-client collapse would drop real clinical history. There is no
    // deleted_at / withdrawn column to filter: unlike `sessions` above.
    //
    // Ordered by the clinical event time, with `id` as a deterministic
    // tiebreak so two notes sharing a backdated occurred_at export in a stable
    // order rather than whatever the planner returns.
    fetchExportRows("client_clinical_notes", (from, to) =>
      supabase
        .from("client_clinical_notes")
        .select(
          "id, client_id, practitioner_id, kind, body, areas, occurred_at, supersedes_note_id, created_at",
        )
        .eq("studio_id", studio.id)
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Current client budget context (0183). One row per client, so this is
    // small; still paginated to exhaustion like every other read. `id` is the
    // deterministic tiebreak.
    fetchExportRows("client_consent_signatures", (from, to) =>
      supabase
        .from("client_consent_signatures")
        .select(
          "id, client_id, template_id, template_title_snapshot, template_body_snapshot, template_version, signature_name, signed_at, response, response_label_snapshot, created_at",
        )
        .eq("studio_id", studio.id)
        .order("signed_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("probe_lots", (from, to) =>
      supabase
        .from("probe_lots")
        .select(
          "id, probe_size, lot_number, expiry_date, active, notes, created_at",
        )
        .eq("studio_id", studio.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("service_practitioners", (from, to) =>
      supabase
        .from("service_practitioners")
        .select("id, service_id, practitioner_id, created_at")
        .eq("studio_id", studio.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("treatment_goals", (from, to) =>
      supabase
        .from("treatment_goals")
        .select(
          "id, client_id, estimated_total_minutes, notes, status, created_at, updated_at",
        )
        .eq("studio_id", studio.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchExportRows("client_budget_context", (from, to) =>
      supabase
        .from("client_budget_context")
        .select(
          "client_id, budget_level, budget_notes, updated_by_practitioner_id, created_at, updated_at",
        )
        .eq("studio_id", studio.id)
        // client_id is the PRIMARY KEY (one row per client), so ordering on
        // it alone is already unique and deterministic — no tiebreak needed.
        .order("client_id", { ascending: true })
        .range(from, to),
    ),
  ]);

  for (const r of [
    clientsRes,
    sessionsRes,
    electRes,
    laserRes,
    practitionersRes,
    pricingRes,
    blocksRes,
    appointmentsRes,
    treatmentPlansRes,
    treatmentPlanStagesRes,
    servicesRes,
    allPractitionersRes,
    sterileItemsRes,
    disinfectantsRes,
    exposureIncidentsRes,
    auditEventsRes,
    clinicalNotesRes,
    consentSignaturesRes,
    probeLotsRes,
    servicePractitionersRes,
    treatmentGoalsRes,
    // budgetContextRes is handled SEPARATELY, immediately below — not
    // excluded from failing the export.
  ]) {
    if (r.error) {
      return {
        ok: false,
        error: `Failed to load data for export: ${r.error.message}`,
      };
    }
  }

  // F7. THE EXECUTED QUERY MUST ASK FOR EVERY COLUMN THE REGISTRY SAYS ITS FILE
  // CARRIES — and "executed" means the select on the request PostgREST received.
  //
  // Each envelope carries the select read off its OWN built request, keyed by
  // the resource whose CSV its rows become. Nothing else contributes: the
  // practitioners lookup, the session_blocks read and the services read use
  // plain `fetchAllRows`, produce no envelope, and so cannot stand in for an
  // export query. A resource that was never read has no entry at all, so the
  // audit refuses on the ABSENCE rather than on a mismatch.
  //
  // Run here, after every read has executed and before a single row is
  // serialized. A column declared included but never asked for produces a blank
  // cell, and a blank cell is indistinguishable from a studio that recorded
  // nothing there.
  const exportReads: ReadonlyArray<ExportRead<unknown>> = [
    clientsRes,
    sessionsRes,
    electRes,
    laserRes,
    practitionersRes,
    pricingRes,
    appointmentsRes,
    treatmentPlansRes,
    treatmentPlanStagesRes,
    sterileItemsRes,
    disinfectantsRes,
    exposureIncidentsRes,
    auditEventsRes,
    clinicalNotesRes,
    servicesRes,
    consentSignaturesRes,
    probeLotsRes,
    servicePractitionersRes,
    treatmentGoalsRes,
    budgetContextRes,
  ];
  const selected = auditSelectedColumns(selectedColumnsByResource(exportReads));
  if (!selected.ok) {
    return { ok: false, error: selectedColumnError(selected) };
  }

  // client_budget_context (0183) gets exactly ONE tolerated failure: the
  // proven "this relation does not exist" condition, which is the
  // migration-first window where the new application runs against a database
  // that has not yet had 0183 applied. Failing the whole export then would
  // take out portability for sixteen perfectly readable tables.
  //
  // EVERY other failure rejoins the all-or-nothing guard above. An earlier
  // version tolerated all of them, which meant a permission denial, an RLS
  // refusal, a network fault, a failed later pagination page, or
  // fetchAllRows' own "refusing to return a partial table" refusal each
  // produced an ok:true ZIP that was silently missing known data. A
  // portability export that quietly omits records is worse than one that
  // fails: the owner cannot tell it happened.
  const budgetDecision = decideBudgetExportRead(
    budgetContextRes as BudgetExportReadResult,
  );
  if (budgetDecision.kind === "fail") {
    return {
      ok: false,
      error: `Failed to load data for export: ${budgetDecision.message}`,
    };
  }
  const budgetContextExported = budgetDecision.kind === "export";

  // Entries are fetched in parallel with sessions, so they may contain rows
  // belonging to soft-deleted sessions. Filter them out using the set of
  // active session IDs returned above.
  const activeSessionIds = new Set(
    ((sessionsRes.data ?? []) as { id: string }[]).map((s) => s.id),
  );
  const filteredElectrolysis = mapExportRows(electRes, (rows) =>
    (rows as { session_id: string }[]).filter((e) =>
      activeSessionIds.has(e.session_id),
    ),
  );
  const filteredLaser = mapExportRows(laserRes, (rows) =>
    (rows as { session_id: string }[]).filter((e) =>
      activeSessionIds.has(e.session_id),
    ),
  );

  // Flatten the laser equipment_params JSON into top-level CSV columns so
  // spreadsheets show fluence / pulse_width / spot_size as plain fields.
  type LaserRow = {
    id: string;
    session_id: string;
    zone: string;
    session_number: number | null;
    equipment_params: Record<string, unknown> | null;
    observation_notes: string | null;
    created_at: string;
    ejection_results: string | null;
    deleted_at: string | null;
  };
  const laserRows = mapExportRows(filteredLaser, (rows) =>
    (rows as unknown as LaserRow[]).map((e) => {
      const params = (e.equipment_params ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        session_id: e.session_id,
        zone: e.zone,
        treatment_number: e.session_number,
        fluence: typeof params.fluence === "string" ? params.fluence : null,
        pulse_width:
          typeof params.pulse_width === "string" ? params.pulse_width : null,
        spot_size:
          typeof params.spot_size === "string" ? params.spot_size : null,
        observation_notes: e.observation_notes,
        created_at: e.created_at,
        ejection_results: e.ejection_results,
        // SOFT-DELETE HONESTY. Entries are exported regardless of their own
        // delete state (only the parent session is filtered), so without this
        // a deleted entry was indistinguishable from a live one in the archive.
        deleted_at: e.deleted_at,
      };
    }),
  );

  const zip = new JSZip();

  // Manifest row counts, taken from the EXACT row collection handed to
  // rowsToCsv, never from the serialized bytes.
  //
  // `csvCell` deliberately emits RFC-4180 quoted fields that PRESERVE embedded
  // CR/LF, so one multiline clinical note, session note or comment is a single
  // logical record spanning several physical lines. Counting newlines would
  // therefore over-report every file containing a multiline note, and it would
  // over-report it in the very artifact whose job is to tell the owner how much
  // data they have. `rows.length` is the record count by construction, so this
  // needs no CSV parser and cannot disagree with what was written.
  //
  // TRUTH-01A: the filename and the header row are no longer written here.
  // Both come from the export resource registry, so the file the ZIP contains,
  // the file the manifest counts, the file the audit row names and the file the
  // Data settings page advertises are all the same declaration. There is no
  // second list to fall behind.
  // TWO RESOURCES MAY NEVER DECLARE THE SAME FILENAME, and it is checked HERE -
  // before the first write, before any Set collapses them, and before JSZip
  // keeps one entry per path. A collision would otherwise be invisible: the
  // second writeCsv overwrites the first's rows AND its manifest count, and
  // emission parity, the manifest and the audit row would all agree on a file
  // whose data is simply gone.
  const filenames = auditExportedFilenames();
  if (!filenames.ok) {
    return { ok: false, error: duplicateFilenameError(filenames) };
  }

  const manifestCounts: Record<string, number> = {};
  const writeCsv = (
    resource: string,
    read: ExportRead<Record<string, unknown>>,
  ): void => {
    // The second half of the chain, and the answer to "bind written rows to
    // their recorded query". Rows may only be serialized for the resource whose
    // query produced them. The envelope is branded with a symbol, so neither a
    // bare array nor rows fetched for a different resource can satisfy it —
    // previously any array was accepted as long as the DESTINATION happened to
    // have a recorded select, which is exactly the swap this now refuses.
    // `mapExportRows` carries the brand across the display-name joins that sit
    // between reading and writing.
    const rows = rowsForResource(resource, read);
    const spec = exportSpec(resource);
    manifestCounts[spec.file] = rows.length;
    zip.file(spec.file, rowsToCsv(spec.csvHeaders, rows));
  };

  writeCsv("clients", clientsRes);

  writeCsv("sessions", sessionsRes);

  // Block-level structured area + probe metadata, keyed by id for an
  // in-app merge onto each entry via block_id (no SQL join needed).
  type BlockExportRow = {
    id: string;
    primary_area: string | null;
    side: string | null;
    custom_area_detail: string | null;
    probe_key: string | null;
    probe_brand: string | null;
    probe_material: string | null;
    probe_piece_type: string | null;
    probe_shank: string | null;
    probe_size_value: string | null;
    probe_length: string | null;
    probe_label: string | null;
    reaction_type: string | null;
  };
  const blocksById = new Map<string, BlockExportRow>();
  for (const b of (blocksRes.data ?? []) as BlockExportRow[]) {
    blocksById.set(b.id, b);
  }

  // Migration 0128: the structured multi-area set per block, so the export
  // records EVERY treated area + laterality, not just the legacy first-area
  // projection in block_primary_area/block_side. Studio-scoped, ordered.
  const areaRowsRes = await fetchAllRows<{
    session_block_id: string;
    area: string;
    laterality: Laterality;
    display_order: number;
  }>((from, to) =>
    supabase
      .from("session_block_areas")
      .select("session_block_id, area, laterality, display_order")
      .eq("studio_id", studio.id)
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: true })
      // `id` is not selected, but ordering by it is still valid and is what
      // makes the page boundary deterministic: display_order + created_at
      // repeat freely across blocks.
      .order("id", { ascending: true })
      .range(from, to),
  );
  // F5. FAIL CLOSED.
  //
  // This read is issued separately, AFTER the all-or-nothing guard above, and
  // its error was never checked — so `?? []` turned a failed read into "this
  // studio recorded no treatment areas". Every block_areas cell then came back
  // blank or fell back to the legacy primary-area projection, the archive still
  // built, the manifest still declared electrolysis completeness as following
  // the sessions count, and the README still said a failed page aborts the
  // export. All three were false together, and the owner had no way to tell.
  //
  // A derived column is still charting data. It gets the same all-or-nothing
  // treatment as the sources it is derived from: no warning, no fallback, no
  // partial archive, and no successful manifest or audit claim for the run.
  if (areaRowsRes.error) {
    return {
      ok: false,
      error:
        "Could not read the treatment areas recorded against your session blocks, " +
        "so the export was not produced. Nothing partial was written. Please try again.",
    };
  }

  const areasByBlock = new Map<string, BlockArea[]>();
  for (const r of (areaRowsRes.data ?? []) as Array<{
    session_block_id: string;
    area: string;
    laterality: Laterality;
  }>) {
    const list = areasByBlock.get(r.session_block_id) ?? [];
    list.push({ area: r.area, laterality: r.laterality });
    areasByBlock.set(r.session_block_id, list);
  }

  // Flatten the `areas` text[] to a semicolon-separated string so it renders
  // cleanly in spreadsheets (CSV's own delimiter is a comma), and merge the
  // structured area + probe columns from the entry's block. Null/missing
  // values render as blank cells via csvCell.
  type ElectRow = {
    id: string;
    session_id: string;
    area: string | null;
    areas: string[] | null;
    block_id: string | null;
    [k: string]: unknown;
  };
  const electRows = mapExportRows(filteredElectrolysis, (rows) =>
    (rows as unknown as ElectRow[]).map((e) => {
      const b = e.block_id ? blocksById.get(e.block_id) : undefined;
      return {
        ...e,
        areas: Array.isArray(e.areas) ? e.areas.join("; ") : "",
        // Migration 0108 + charting unification: flatten the UNIFIED findings,
        // observation chips PLUS a folded legacy reaction_type from the entry's
        // block: to a semicolon-separated string (CSV's own delimiter is a comma),
        // so the export presents the reaction as one concept.
        observation_chips: mergeReactionIntoChips(
          e.observation_chips,
          b?.reaction_type ?? null,
        ).join("; "),
        block_primary_area: b?.primary_area ?? null,
        block_side: b?.side ?? null,
        // Migration 0128: the full ordered multi-area label ("Left cheek; Right
        // sideburn"). Legacy single-area blocks fall back to primary_area + side,
        // so no exported record ever collapses to only the first of several areas.
        block_areas: b
          ? blockAreasLabel(areasByBlock.get(b.id) ?? null, {
              primary_area: b.primary_area,
              side: b.side,
            })?.replace(/ · /g, "; ") ?? null
          : null,
        block_custom_area_detail: b?.custom_area_detail ?? null,
        probe_key: b?.probe_key ?? null,
        probe_brand: b?.probe_brand ?? null,
        probe_material: b?.probe_material ?? null,
        probe_piece_type: b?.probe_piece_type ?? null,
        probe_shank: b?.probe_shank ?? null,
        probe_size_value: b?.probe_size_value ?? null,
        probe_length: b?.probe_length ?? null,
        probe_label: b?.probe_label ?? null,
      };
    }),
  );

  writeCsv("electrolysis_entries", electRows);

  writeCsv("laser_entries", laserRows);

  writeCsv("practitioners", practitionersRes);

  writeCsv("client_pricing", pricingRes);

  // ---------------------------------------------------------------------
  // Appointments + treatment plans + stages (export/backup readiness).
  // Human-readable name fields are resolved from in-memory maps built from
  // the studio-scoped reads above, no per-row (N+1) queries. A missing or
  // deleted reference keeps the ID and leaves the name blank (never errors).
  // ---------------------------------------------------------------------
  const clientNameById = new Map<string, string>();
  for (const c of (clientsRes.data ?? []) as { id: string; name: string }[]) {
    clientNameById.set(c.id, c.name);
  }
  const practitionerNameById = new Map<string, string>();
  for (const p of (allPractitionersRes.data ?? []) as {
    id: string;
    display_name: string;
  }[]) {
    practitionerNameById.set(p.id, p.display_name);
  }
  const serviceNameById = new Map<string, string>();
  for (const s of (servicesRes.data ?? []) as { id: string; name: string }[]) {
    serviceNameById.set(s.id, s.name);
  }

  type AppointmentExportRow = {
    id: string;
    client_id: string | null;
    practitioner_id: string | null;
    service_id: string | null;
    [k: string]: unknown;
  };
  const appointmentRows = mapExportRows(appointmentsRes, (rows) =>
    (rows as AppointmentExportRow[]).map((a) => ({
      ...a,
      client_name: a.client_id ? clientNameById.get(a.client_id) ?? null : null,
      practitioner_name: a.practitioner_id
        ? practitionerNameById.get(a.practitioner_id) ?? null
        : null,
      service_name: a.service_id
        ? serviceNameById.get(a.service_id) ?? null
        : null,
    })),
  );

  writeCsv("appointments", appointmentRows);

  // Plan lookup for the stages file (plan_name + client_id/client_name).
  type PlanExportRow = {
    id: string;
    client_id: string | null;
    name: string;
    [k: string]: unknown;
  };
  const plansById = new Map<string, PlanExportRow>();
  for (const p of (treatmentPlansRes.data ?? []) as PlanExportRow[]) {
    plansById.set(p.id, p);
  }

  const treatmentPlanRows = mapExportRows(treatmentPlansRes, (rows) =>
    (rows as PlanExportRow[]).map((p) => {
      // Migration 0051: treatment_areas is a text[] on the row, which
      // rowsToCsv would coerce to "Chin,Jawline" without quoting. Flatten
      // explicitly here so the column shows up as a pipe-joined list,
      // which round-trips cleanly through any spreadsheet tool ("Chin |
      // Jawline").
      const rawAreas = (p as PlanExportRow & {
        treatment_areas?: string[] | null;
      }).treatment_areas;
      const treatment_areas_joined =
        Array.isArray(rawAreas) && rawAreas.length > 0
          ? rawAreas.join(" | ")
          : null;
      return {
        ...p,
        client_name: p.client_id ? clientNameById.get(p.client_id) ?? null : null,
        treatment_areas: treatment_areas_joined,
      };
    }),
  );

  writeCsv("treatment_plans", treatmentPlanRows);

  type StageExportRow = {
    id: string;
    plan_id: string;
    [k: string]: unknown;
  };
  const treatmentPlanStageRows = mapExportRows(treatmentPlanStagesRes, (rows) =>
    (rows as StageExportRow[]).map((st) => {
      const plan = plansById.get(st.plan_id);
      const planClientId = plan?.client_id ?? null;
      return {
        ...st,
        plan_name: plan?.name ?? null,
        client_id: planClientId,
        client_name: planClientId
          ? clientNameById.get(planClientId) ?? null
          : null,
      };
    }),
  );

  writeCsv("treatment_plan_stages", treatmentPlanStageRows);

  // PR #312: record-keeping / inspection CSVs. Each is studio-scoped + read
  // through the owner's RLS client (see loads above). Column lists are explicit
  // so no image path / binary / payment field can slip in.
  writeCsv("record_keeping_sterile_items", sterileItemsRes);

  writeCsv("record_keeping_disinfectants", disinfectantsRes);

  // Owner-only (0088 RLS + the action's owner gate). Contains sensitive PII.
  writeCsv("record_keeping_exposure_incidents", exposureIncidentsRes);

  // Reduced: identity + action + changed-field NAMES + actor + timestamp only.
  // No `changes` value-snapshot JSON, no free-form `metadata` (see load above).
  writeCsv("record_keeping_audit_events", auditEventsRes);

  // TRUTH-01B-1. Studio-owned resources that were pending until now. Each is
  // studio_id-scoped at the query; service_practitioners additionally cannot
  // cross studios because both its foreign keys are composite on studio_id.
  writeCsv("services", servicesRes);

  writeCsv("client_consent_signatures", consentSignaturesRes);

  writeCsv("probe_lots", probeLotsRes);

  writeCsv("service_practitioners", servicePractitionersRes);

  writeCsv("treatment_goals", treatmentGoalsRes);

  // The clinical narrative. Shaped by the pure builder so history retention,
  // lineage and author attribution are unit-testable; serialized through the
  // SAME rowsToCsv chokepoint as every other file, so the formula-injection
  // neutralization and RFC-4180 quoting in lib/csv.ts apply unchanged. Note
  // bodies routinely contain commas, quotation marks and line breaks.
  writeCsv(
    "client_clinical_notes",
    mapExportRows(clinicalNotesRes, (rows) =>
      buildClinicalNoteExportRows(rows as ClinicalNoteExportSource[], {
        clientNameById,
        practitionerNameById,
      }),
    ),
  );

  // Current client budget context (0183). Practitioner-held client data, so it
  // travels with the export rather than being silently dropped from
  // portability. Serialized through the same rowsToCsv chokepoint (budget
  // notes are free text and routinely contain commas and line breaks).
  //
  // Reaching here with budgetContextExported === false means the ONE tolerated
  // condition above: 0183 is not applied. A successful read of an EMPTY table
  // is a different thing entirely and still writes a valid header-only CSV
  // with a manifest count of 0 — "zero rows" must never be conflated with
  // "could not read rows".
  if (budgetDecision.kind === "export") {
    const budgetContextRows = mapExportRows(budgetContextRes, (rows) =>
      (rows as typeof budgetDecision.rows).map((row) => ({
        ...row,
        client_name:
          typeof row.client_id === "string"
            ? clientNameById.get(row.client_id) ?? null
            : null,
      })),
    );
    writeCsv("client_budget_context", budgetContextRows);
  }

  // ---------------------------------------------------------------------
  // COMPLETENESS VERIFICATION
  //
  // `fetchAllRows` already loops to exhaustion, so truncation is structurally
  // impossible rather than merely unlikely. This is the independent second
  // opinion: a HEAD count (`count: "exact", head: true` transfers no rows) for
  // every studio-scoped source, compared against what we actually fetched. A
  // mismatch means something changed underneath the export or a page was lost,
  // and we REFUSE rather than hand over a plausible-looking ZIP.
  //
  // `electrolysis_entries` and `laser_entries` are deliberately absent: neither
  // carries `studio_id` (RLS reaches them through the parent session), so there
  // is no safe studio-scoped count to compare against. Their completeness is
  // instead protected by the sessions count below. They are filtered against
  // the session id set, which is the amplification this whole change fixes.
  // ---------------------------------------------------------------------
  const [clientsCount, sessionsCount, appointmentsCount, notesCount] =
    await Promise.all([
      supabase
        .from("clients")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studio.id),
      supabase
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studio.id)
        .is("deleted_at", null),
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studio.id),
      supabase
        .from("client_clinical_notes")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studio.id),
    ]);

  const countChecks: Array<{
    table: string;
    fetched: number;
    expected: number | null;
    error?: string;
  }> = [
    {
      table: "clients",
      fetched: (clientsRes.data ?? []).length,
      expected: clientsCount.error ? null : clientsCount.count,
      error: clientsCount.error?.message,
    },
    {
      table: "sessions",
      fetched: (sessionsRes.data ?? []).length,
      expected: sessionsCount.error ? null : sessionsCount.count,
      error: sessionsCount.error?.message,
    },
    {
      table: "appointments",
      fetched: (appointmentsRes.data ?? []).length,
      expected: appointmentsCount.error ? null : appointmentsCount.count,
      error: appointmentsCount.error?.message,
    },
    {
      table: "client_clinical_notes",
      fetched: (clinicalNotesRes.data ?? []).length,
      expected: notesCount.error ? null : notesCount.count,
      error: notesCount.error?.message,
    },
  ];

  // R2 — COUNT COVERAGE PARITY.
  //
  // The checks performed above must be exactly the ones the registry declares
  // `studio_scoped`. Without this the coverage drifts the quiet way: a file is
  // added, the manifest lists it with a row count, and nothing anywhere says
  // that count was never compared against the database. Declaring a check and
  // not running it fails here; running one nothing declares fails here too.
  const coverage = auditSourceCountCoverage(countChecks.map((c) => c.table));
  if (!coverage.ok) {
    return {
      ok: false,
      error:
        "Export aborted: the source-count checks performed do not match the export " +
        "registry's declared coverage" +
        (coverage.uncovered.length > 0
          ? `; declared but not checked: ${coverage.uncovered.join(", ")}`
          : "") +
        (coverage.undeclared.length > 0
          ? `; checked but not declared: ${coverage.undeclared.join(", ")}`
          : "") +
        ". No partial export was produced.",
    };
  }

  const countMismatch = countChecks.find(
    (c) => c.expected !== null && c.expected !== c.fetched,
  );
  if (countMismatch) {
    return {
      ok: false,
      error:
        `Export aborted: ${countMismatch.table} returned ${countMismatch.fetched} rows ` +
        `but the studio holds ${countMismatch.expected}. No partial export was produced. ` +
        `Please try again.`,
    };
  }

  const generatedAt = new Date().toISOString();

  // ---------------------------------------------------------------------
  // MANIFEST
  //
  // Counts come from `countedCsv`, i.e. the exact row collection handed to
  // rowsToCsv for each file. An earlier version counted newlines in the
  // serialized bytes, which is wrong: csvCell emits RFC-4180 quoted fields that
  // KEEP embedded CR/LF, so one multiline clinical note is a single record
  // spread over several physical lines and every affected file was
  // over-reported.
  //
  // GUARD 3 — EMISSION PARITY, BOTH DIRECTIONS.
  //
  // This REPLACES the older "was every written file counted?" check, which
  // looked only one way. A file the registry promised and the archive never
  // contained passed it happily, and so did a file nothing had declared. Two
  // half-checks against two authorities are now one check against one:
  //
  //   registry declares it, archive lacks it  -> refuse
  //   archive holds it, registry declares it nowhere -> refuse
  //
  // The single tolerated omission is client_budget_context.csv when migration
  // 0183 is not applied, and it is passed in per-RUN rather than exempted in
  // the registry, so on a migrated database its absence is still a failure.
  // ---------------------------------------------------------------------
  const writtenCsvNames = Object.entries(zip.files)
    .filter(([name, entry]) => name.endsWith(".csv") && !entry.dir)
    .map(([name]) => name);
  const toleratedOmissions = budgetContextExported
    ? []
    : [exportSpec("client_budget_context").file];
  const parity = auditEmissionParity(writtenCsvNames, toleratedOmissions);
  if (!parity.ok) {
    return { ok: false, error: emissionParityError(parity) };
  }

  const manifest = {
    export_format: "hone.studio-export",
    export_format_version: 1,
    generated_at: generatedAt,
    studio_id: studio.id,
    studio_name: studio.name,
    page_size: EXPORT_PAGE_SIZE,
    // Rows ACTUALLY EXPORTED into each file. This is a record of what was
    // written: on its own it does not prove the file matches the database.
    files: manifestCounts,
    // Source-side checks, recorded SEPARATELY from the counts above and never
    // merged into them. `status` is explicit in every direction so a failed
    // count query can never read as a passed one.
    //
    // TRUTH-01A: this now covers EVERY exported file, not only the four the
    // export happens to count. Nine files carried a row count here with nothing
    // saying the count was never compared against the database, which reads as
    // verification and is not. `not_checked` says so in the artifact itself,
    // and the reason comes from the registry entry that declares it.
    source_count_checks: exportedResources().map(({ resource, disposition }) => {
      const performed = countChecks.find((c) => c.table === resource);
      const exportedRows = manifestCounts[disposition.file] ?? null;
      if (!performed) {
        const check = disposition.sourceCountCheck;
        return {
          table: resource,
          file: disposition.file,
          exported_rows: exportedRows,
          studio_row_count: null,
          status: check.kind === "via_parent" ? "follows_parent" : "not_checked",
          not_checked_reason: check.kind === "none" ? check.reason : undefined,
          follows_parent: check.kind === "via_parent" ? check.parent : undefined,
          follows_parent_reason: check.kind === "via_parent" ? check.reason : undefined,
        };
      }
      return {
        table: resource,
        file: disposition.file,
        exported_rows: performed.fetched,
        studio_row_count: performed.expected,
        status:
          performed.expected === null
            ? "unavailable"
            : performed.expected === performed.fetched
              ? "matched"
              : "mismatched",
        ...(performed.expected === null
          ? {
              unavailable_reason:
                performed.error ??
                "The source count query did not return a count; completeness was NOT verified against the database for this table.",
            }
          : {}),
      };
    }),
    // Derived from the same registry declarations as the checks above, so the
    // list of tables with no studio-scoped count cannot fall out of step with
    // the entries that say why.
    source_count_not_available: {
      tables: exportedResources()
        .filter(({ disposition }) => disposition.sourceCountCheck.kind !== "studio_scoped")
        .map(({ resource }) => resource),
      reason:
        "These files carry no studio-scoped source count. See each entry's status in " +
        "source_count_checks: `follows_parent` means the table has no studio_id and its " +
        "completeness follows its parent's check; `not_checked` means no count query is " +
        "issued for it today and its row count is therefore recorded but unverified.",
    },
    // WHAT THIS ARCHIVE DOES NOT CONTAIN, stated inside the archive.
    //
    // The ZIP outlives the settings page that described it. A studio reading it
    // a year after leaving cannot consult a web page to learn what it never
    // received, so the omissions travel with the export - and they come from
    // the same registry that decides what the export writes, so the two cannot
    // disagree.
    not_exported: pendingResources().map(({ resource, disposition }) => ({
      resource,
      ticket: disposition.ticket,
      tier: disposition.tier,
      reason: disposition.reason,
    })),
    ...(budgetContextExported
      ? {}
      : {
          omitted_files: {
            files: [exportSpec("client_budget_context").file],
            reason:
              "The client_budget_context table does not exist in this database, which " +
              "means migration 0183 has not been applied yet. This is the ONLY read " +
              "failure the export tolerates: any other failure on this source (permission, " +
              "network, a failed pagination page, a partial-read refusal) fails the whole " +
              "export instead of producing this ZIP. The file was OMITTED rather than " +
              "written empty, because an empty file would falsely assert that this studio " +
              "holds no budget context. No other file is affected.",
          },
        }),
    completeness_contract: [
      "Every supported source is read with pagination to exhaustion; a failed page fails the whole export rather than producing a partial file.",
      "`files` records the number of rows actually exported to each CSV.",
      "`source_count_checks` covers EVERY file above and states, per file, whether its row count was compared against the database (`matched`), could not be (`unavailable`), follows its parent table's check (`follows_parent`), or is simply not checked today (`not_checked`).",
      "`not_exported` lists the studio-owned resources this export does NOT contain. It is generated from the same registry that decides what the export writes, so this archive can be read on its own without trusting a web page to be current.",
      "This export is NOT point-in-time transactionally consistent: each table is read independently, so rows written during the export may appear in some files and not others.",
      "It is therefore not a transactional database backup and does not replace Hone's or our infrastructure provider's disaster-recovery backups.",
    ],
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  // TRUTH-01A. The file list and the omission list are GENERATED from the export
  // resource registry. They used to be two hand-maintained prose blocks in this
  // template, which is how the README came to describe thirteen files while the
  // ZIP contained fifteen, and to name three omitted categories where the real
  // answer is forty resources.
  const includedLines = exportedResources()
    .filter(({ disposition }) => disposition.file in manifestCounts)
    .map(({ disposition }) => `- ${disposition.file}: ${disposition.description}`)
    .join("\n");
  const notExportedLines = pendingResources()
    .map(({ resource, disposition }) => `- ${resource} (${disposition.ticket}): ${disposition.reason}`)
    .join("\n");
  const withheldLines = excludedResources()
    .map(({ resource, disposition }) => `- ${resource} (${disposition.category}): ${disposition.reason}`)
    .join("\n");

  const readme = `Hone Data Export
Generated: ${generatedAt}
Studio: ${studio.name}

This is a portable copy of the Hone studio records listed under FILES INCLUDED
below, and only those. Every listed source is exported in full: reads are
paginated, and the export refuses rather than hand over a partial file.

IT IS NOT EVERYTHING HONE HOLDS FOR YOUR STUDIO. The NOT INCLUDED section below
lists, by name, every studio-owned record type this export does not yet carry -
most importantly your treatment photos, your intake forms, your signed consents,
your service menu and your payment records. That list is generated from the same
source that decides what gets written here, so it cannot quietly fall behind.

WHAT THIS IS NOT: it is not a transactional database backup and it is NOT
point-in-time consistent. Each table is read independently, so records written
while the export runs may appear in some files and not others. It does not
replace Hone's or our infrastructure provider's disaster-recovery backups.

FILES INCLUDED
- manifest.json: Export format/version, generation time, studio, the number of rows actually exported to each CSV, the per-file source-count status, and the machine-readable list of what is NOT included. It records what was exported; it is not by itself proof that the export matches the database at any single instant.
${includedLines}

NOT INCLUDED - studio-owned records this export does not yet carry
${notExportedLines}

DELIBERATELY WITHHELD - not studio content, or unsafe to hand over
${withheldLines}

IMPORTANT: SENSITIVE DATA: This ZIP includes record-keeping / inspection data,
including an exposure-incident log with personal information about exposed
individuals. Store, transmit, and dispose of this export securely, and only
share it with parties who are authorized to receive it (e.g. an inspector). Only
a studio owner can generate this export.

Your data is yours. This export can be opened in Excel, Numbers, Google Sheets,
or any spreadsheet tool. If you are leaving Hone, read the NOT INCLUDED list
first and contact hello@hone.care for the records it names.

Hone
hone.care
hello@hone.care
`;

  zip.file("README.txt", readme);

  const bytes = await zip.generateAsync({ type: "uint8array" });
  const base64 = Buffer.from(bytes).toString("base64");
  const filename = `hone-export-${slugify(studio.name)}-${todayStamp()}.zip`;

  // PR #189 (pilot safety): every successful export leaves an audit
  // trail. Inserted with the user-scoped client (audit_logs RLS from
  // 0001 allows member insert, never update/delete). Fail closed: if
  // the audit row cannot be written, the export is not handed out.
  const { error: auditError } = await supabase.from("audit_logs").insert({
    studio_id: studio.id,
    actor_id: practitioner.id,
    action: "studio_export",
    entity_type: "studio",
    entity_id: studio.id,
    metadata: {
      filename,
      // R2. THE AUDIT ROW AND THE ARCHIVE NOW COME FROM ONE SOURCE.
      //
      // This used to be a hand-written literal, and it had drifted: it named
      // ten CSVs while the ZIP held fifteen, omitting all four
      // record_keeping_*.csv files and manifest.json. The studio's own audit
      // trail therefore UNDERSTATED what left the building — and the file it
      // failed to record was the exposure-incident log, the most sensitive
      // thing in the archive and the one carrying a third party's name,
      // address and phone number.
      //
      // `writtenCsvNames` is read back off the built archive, so this cannot
      // describe a file the ZIP does not contain, and the emission-parity
      // guard above has already proved that set equals the registry's.
      files: [...writtenCsvNames, "manifest.json", "README.txt"],
      // Keyed by RESOURCE, valued from the same manifestCounts the archive and
      // manifest were built from. No per-table expression to forget to add.
      row_counts: Object.fromEntries(
        exportedResources()
          .filter(({ disposition }) => disposition.file in manifestCounts)
          .map(({ resource, disposition }) => [
            resource,
            manifestCounts[disposition.file],
          ]),
      ),
    },
  });
  if (auditError) {
    return {
      ok: false,
      error: "Could not record the export audit entry. Try again.",
    };
  }

  return { ok: true, filename, base64 };
}
