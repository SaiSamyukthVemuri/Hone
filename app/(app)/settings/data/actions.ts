"use server";

import JSZip from "jszip";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { rowsToCsv } from "@/lib/csv";
import {
  buildClinicalNoteExportRows,
  CLINICAL_NOTES_CSV_FILENAME,
  CLINICAL_NOTES_CSV_HEADERS,
  type ClinicalNoteExportSource,
} from "@/lib/export/clinical-notes";
import { fetchAllRows, EXPORT_PAGE_SIZE } from "@/lib/export/paginate";
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
    budgetContextRes,
  ] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("clients")
        .select(
          "id, name, pronouns, date_of_birth, fitzpatrick_type, allergies, skin_notes, emergency_contact_name, emergency_contact_phone, email, phone, created_at",
        )
        .eq("studio_id", studio.id)
        .order("name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("sessions")
        .select(
          "id, client_id, practitioner_id, performed_by_practitioner_id, modality, started_at, ended_at, price_paid_cents, session_notes, created_at",
        )
        .eq("studio_id", studio.id)
        .is("deleted_at", null)
        .order("started_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("electrolysis_entries")
        .select(
          "id, session_id, area, areas, probe_size, probe_lot_id, mode, intensity, duration_seconds, pulse_count, pulse_delay_seconds, comments, observation_chips, created_at, block_id, energy_level, apilus_modality, machine_frequency, minutes_performed, probe_type, hairs_treated, galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent, thermolysis_intensity_percent, thermolysis_duration_seconds, units_of_lye",
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("laser_entries")
        .select(
          "id, session_id, zone, session_number, equipment_params, observation_notes, created_at",
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("practitioners")
        .select("id, display_name, email, role, active, created_at")
        .eq("studio_id", studio.id)
        .eq("active", true)
        .order("display_name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("client_pricing")
        .select("id, client_id, service_name, price_cents, notes, effective_from")
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
    fetchAllRows((from, to) =>
      supabase
        .from("appointments")
        .select(
          "id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, status, notes, cancellation_reason, cancelled_at, cancelled_by, created_at, updated_at",
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
    fetchAllRows((from, to) =>
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
    fetchAllRows((from, to) =>
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
    fetchAllRows((from, to) =>
      supabase
        .from("services")
        .select("id, name")
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
    fetchAllRows((from, to) =>
      supabase
        .from("record_keeping_sterile_items")
        // 0182: date_discarded is part of the inspection record. The export is
        // HISTORICAL and is deliberately NOT filtered on it — a discarded item
        // stays in the export, now carrying the lifecycle fact that explains
        // why an expired row needs no action.
        .select(
          "id, date_purchased, item_description, manufacturer_name, amount_purchased, lot_number, expiry_date, date_discarded, notes, created_by_practitioner_id, created_at, updated_at",
        )
        .eq("studio_id", studio.id)
        .order("date_purchased", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
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
    fetchAllRows((from, to) =>
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
    fetchAllRows((from, to) =>
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
    fetchAllRows((from, to) =>
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
    fetchAllRows((from, to) =>
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
  const filteredElectrolysis = (
    (electRes.data ?? []) as { session_id: string }[]
  ).filter((e) => activeSessionIds.has(e.session_id));
  const filteredLaser = (
    (laserRes.data ?? []) as { session_id: string }[]
  ).filter((e) => activeSessionIds.has(e.session_id));

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
  };
  const laserRows = (filteredLaser as unknown as LaserRow[]).map((e) => {
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
    };
  });

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
  const manifestCounts: Record<string, number> = {};
  const countedCsv = (
    name: string,
    headers: ReadonlyArray<string>,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): string => {
    manifestCounts[name] = rows.length;
    return rowsToCsv(headers, rows);
  };

  zip.file(
    "clients.csv",
    countedCsv(
      "clients.csv",
      [
        "id",
        "name",
        "pronouns",
        "date_of_birth",
        "fitzpatrick_type",
        "allergies",
        "skin_notes",
        "emergency_contact_name",
        "emergency_contact_phone",
        "email",
        "phone",
        "created_at",
      ],
      clientsRes.data ?? [],
    ),
  );

  zip.file(
    "sessions.csv",
    countedCsv(
      "sessions.csv",
      [
        "id",
        "client_id",
        "practitioner_id",
        "performed_by_practitioner_id",
        "modality",
        "started_at",
        "ended_at",
        "price_paid_cents",
        "session_notes",
        "created_at",
      ],
      sessionsRes.data ?? [],
    ),
  );

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
  const electRows = (filteredElectrolysis as unknown as ElectRow[]).map((e) => {
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
  });

  zip.file(
    "electrolysis_entries.csv",
    countedCsv(
      "electrolysis_entries.csv",
      [
        // Existing columns kept in their original order for compatibility.
        "id",
        "session_id",
        "area",
        "areas",
        "probe_size",
        "probe_lot_id",
        "mode",
        "intensity",
        "duration_seconds",
        "pulse_count",
        "comments",
        "created_at",
        // Appended: existing entry-level charting fields that weren't exported.
        "block_id",
        "energy_level",
        "apilus_modality",
        "machine_frequency",
        "minutes_performed",
        "probe_type",
        "hairs_treated",
        // Appended: blend / galvanic readings (migration 0042).
        "galvanic_ma",
        "galvanic_duration_seconds",
        "galvanic_intensity_percent",
        "thermolysis_intensity_percent",
        "thermolysis_duration_seconds",
        "units_of_lye",
        // Appended: structured treatment-observation chips (migration 0108),
        // semicolon-separated. Free-text notes stay in the `comments` column.
        "observation_chips",
        // Appended: structured area + probe from the entry's session block
        // (migrations 0039 / 0041).
        "block_primary_area",
        "block_side",
        // Appended: the full multi-area set + laterality (migration 0128),
        // semicolon-separated ("Left cheek; Right sideburn"). block_primary_area
        // stays for back-compat; this is the complete, non-lossy area record.
        "block_areas",
        "block_custom_area_detail",
        "probe_key",
        "probe_brand",
        "probe_material",
        "probe_piece_type",
        "probe_shank",
        "probe_size_value",
        "probe_length",
        "probe_label",
      ],
      electRows,
    ),
  );

  zip.file(
    "laser_entries.csv",
    countedCsv(
      "laser_entries.csv",
      [
        "id",
        "session_id",
        "zone",
        "treatment_number",
        "fluence",
        "pulse_width",
        "spot_size",
        "observation_notes",
        "created_at",
      ],
      laserRows,
    ),
  );

  zip.file(
    "practitioners.csv",
    countedCsv(
      "practitioners.csv",
      ["id", "display_name", "email", "role", "active", "created_at"],
      practitionersRes.data ?? [],
    ),
  );

  zip.file(
    "client_pricing.csv",
    countedCsv(
      "client_pricing.csv",
      ["id", "client_id", "service_name", "price_cents", "notes", "effective_from"],
      pricingRes.data ?? [],
    ),
  );

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
  const appointmentRows = (
    (appointmentsRes.data ?? []) as AppointmentExportRow[]
  ).map((a) => ({
    ...a,
    client_name: a.client_id ? clientNameById.get(a.client_id) ?? null : null,
    practitioner_name: a.practitioner_id
      ? practitionerNameById.get(a.practitioner_id) ?? null
      : null,
    service_name: a.service_id
      ? serviceNameById.get(a.service_id) ?? null
      : null,
  }));

  zip.file(
    "appointments.csv",
    countedCsv(
      "appointments.csv",
      [
        "id",
        "client_id",
        "client_name",
        "practitioner_id",
        "practitioner_name",
        "service_id",
        "service_name",
        "starts_at",
        "ends_at",
        "duration_minutes",
        "status",
        "notes",
        "cancellation_reason",
        "cancelled_at",
        "cancelled_by",
        "created_at",
        "updated_at",
      ],
      appointmentRows,
    ),
  );

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

  const treatmentPlanRows = (
    (treatmentPlansRes.data ?? []) as PlanExportRow[]
  ).map((p) => {
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
  });

  zip.file(
    "treatment_plans.csv",
    countedCsv(
      "treatment_plans.csv",
      [
        "id",
        "client_id",
        "client_name",
        "name",
        "primary_area",
        "treatment_areas",
        "estimated_timeline_months_min",
        "estimated_timeline_months_max",
        "status",
        "suggested_visit_count",
        "treatment_goal_minutes_override",
        "budget_notes",
        "practitioner_notes",
        "created_by_practitioner_id",
        "closed_by_practitioner_id",
        "created_at",
        "closed_at",
      ],
      treatmentPlanRows,
    ),
  );

  type StageExportRow = {
    id: string;
    plan_id: string;
    [k: string]: unknown;
  };
  const treatmentPlanStageRows = (
    (treatmentPlanStagesRes.data ?? []) as StageExportRow[]
  ).map((st) => {
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
  });

  zip.file(
    "treatment_plan_stages.csv",
    countedCsv(
      "treatment_plan_stages.csv",
      [
        "id",
        "plan_id",
        "plan_name",
        "client_id",
        "client_name",
        "sort_order",
        "name",
        "how_often_unit",
        "visit_length_minutes",
        "stage_length_value",
        "stage_length_unit",
        "notes",
        "created_at",
        "updated_at",
      ],
      treatmentPlanStageRows,
    ),
  );

  // PR #312: record-keeping / inspection CSVs. Each is studio-scoped + read
  // through the owner's RLS client (see loads above). Column lists are explicit
  // so no image path / binary / payment field can slip in.
  zip.file(
    "record_keeping_sterile_items.csv",
    countedCsv(
      "record_keeping_sterile_items.csv",
      [
        "id",
        "date_purchased",
        "item_description",
        "manufacturer_name",
        "amount_purchased",
        "lot_number",
        "expiry_date",
        "date_discarded",
        "notes",
        "created_by_practitioner_id",
        "created_at",
        "updated_at",
      ],
      (sterileItemsRes.data ?? []) as Record<string, unknown>[],
    ),
  );

  zip.file(
    "record_keeping_disinfectants.csv",
    countedCsv(
      "record_keeping_disinfectants.csv",
      [
        "id",
        "date_prepared",
        "disinfectant_name",
        "concentration",
        "date_discarded",
        "discard_due_date",
        "operator_practitioner_id",
        "operator_name",
        "notes",
        "created_by_practitioner_id",
        "created_at",
        "updated_at",
      ],
      (disinfectantsRes.data ?? []) as Record<string, unknown>[],
    ),
  );

  // Owner-only (0088 RLS + the action's owner gate). Contains sensitive PII.
  zip.file(
    "record_keeping_exposure_incidents.csv",
    countedCsv(
      "record_keeping_exposure_incidents.csv",
      [
        "id",
        "incident_date",
        "exposed_person_full_name",
        "exposed_person_address",
        "exposed_person_phone",
        "exposure_details",
        "action_taken",
        "staff_involved_name",
        "notes",
        "created_by_practitioner_id",
        "created_at",
        "updated_at",
      ],
      (exposureIncidentsRes.data ?? []) as Record<string, unknown>[],
    ),
  );

  // Reduced: identity + action + changed-field NAMES + actor + timestamp only.
  // No `changes` value-snapshot JSON, no free-form `metadata` (see load above).
  zip.file(
    "record_keeping_audit_events.csv",
    countedCsv(
      "record_keeping_audit_events.csv",
      [
        "id",
        "record_type",
        "record_id",
        "action",
        "changed_fields",
        "actor_practitioner_id",
        "actor_display_name",
        "created_at",
      ],
      (auditEventsRes.data ?? []) as Record<string, unknown>[],
    ),
  );

  // The clinical narrative. Shaped by the pure builder so history retention,
  // lineage and author attribution are unit-testable; serialized through the
  // SAME rowsToCsv chokepoint as every other file, so the formula-injection
  // neutralization and RFC-4180 quoting in lib/csv.ts apply unchanged. Note
  // bodies routinely contain commas, quotation marks and line breaks.
  zip.file(
    CLINICAL_NOTES_CSV_FILENAME,
    countedCsv(
      CLINICAL_NOTES_CSV_FILENAME,
      CLINICAL_NOTES_CSV_HEADERS,
      buildClinicalNoteExportRows(
        (clinicalNotesRes.data ?? []) as ClinicalNoteExportSource[],
        { clientNameById, practitionerNameById },
      ),
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
    const budgetContextRows = budgetDecision.rows.map((row) => ({
      ...row,
      client_name:
        typeof row.client_id === "string"
          ? clientNameById.get(row.client_id) ?? null
          : null,
    }));
    zip.file(
      "client_budget_context.csv",
      countedCsv(
        "client_budget_context.csv",
        [
          "client_id",
          "client_name",
          "budget_level",
          "budget_notes",
          "updated_by_practitioner_id",
          "created_at",
          "updated_at",
        ],
        budgetContextRows,
      ),
    );
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
  // A file written without `countedCsv` would be missing here rather than
  // silently wrong, so the guard below fails the export instead of shipping an
  // incomplete manifest.
  // ---------------------------------------------------------------------
  const writtenCsvNames = Object.entries(zip.files)
    .filter(([name, entry]) => name.endsWith(".csv") && !entry.dir)
    .map(([name]) => name);
  const uncounted = writtenCsvNames.filter((n) => !(n in manifestCounts));
  if (uncounted.length > 0) {
    return {
      ok: false,
      error:
        `Export aborted: ${uncounted.join(", ")} was written without a recorded ` +
        `row count, so the manifest would be incomplete.`,
    };
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
    // merged into them. `status` is explicit in all three directions so a
    // failed count query can never read as a passed one.
    source_count_checks: countChecks.map((c) => ({
      table: c.table,
      exported_rows: c.fetched,
      studio_row_count: c.expected,
      status:
        c.expected === null
          ? "unavailable"
          : c.expected === c.fetched
            ? "matched"
            : "mismatched",
      ...(c.expected === null
        ? {
            unavailable_reason:
              c.error ??
              "The source count query did not return a count; completeness was NOT verified against the database for this table.",
          }
        : {}),
    })),
    source_count_not_available: {
      tables: ["electrolysis_entries", "laser_entries"],
      reason:
        "Neither table carries studio_id; RLS reaches them through the parent session, " +
        "so no safe studio-scoped count query exists. Their rows are filtered against the " +
        "exported session ids, so their completeness follows the sessions check above.",
    },
    ...(budgetContextExported
      ? {}
      : {
          omitted_files: {
            files: ["client_budget_context.csv"],
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
      "`source_count_checks` records what could be compared against the database, and says so explicitly when a check was unavailable.",
      "This export is NOT point-in-time transactionally consistent: each table is read independently, so rows written during the export may appear in some files and not others.",
      "It is therefore not a transactional database backup and does not replace Hone's or our infrastructure provider's disaster-recovery backups.",
    ],
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const readme = `Hone Data Export
Generated: ${generatedAt}
Studio: ${studio.name}

This is a portable copy of the supported Hone studio records listed below. Every
listed source is exported in full: reads are paginated, and the export refuses
rather than hand over a partial file.

WHAT THIS IS NOT: it is not a transactional database backup and it is NOT
point-in-time consistent. Each table is read independently, so records written
while the export runs may appear in some files and not others. It also does not
include uploaded images, payment records, or authentication data, and it does not
replace Hone's or our infrastructure provider's disaster-recovery backups.

Files included:
- manifest.json: Export format/version, generation time, studio, the number of rows actually exported to each CSV, and (recorded separately) whichever source-side count checks were available. It records what was exported; it is not by itself proof that the export matches the database at any single instant.
- clients.csv: Client master list with names, contact info, allergies, skin notes, Fitzpatrick type, emergency contacts.
- sessions.csv: One row per session: client, performer, started_at, ended_at, price_paid_cents, session_notes.
- electrolysis_entries.csv: Every electrolysis entry with area, mode, energy level, modality, machine frequency, pulse count, hairs treated, blend/galvanic and thermolysis readings (galvanic mA/duration/intensity, thermolysis intensity/duration, units of lye), the structured probe (brand, material, piece type, shank, size, length), the treatment area (primary area, side, specifics), structured observation chips, and free-text comments.
- laser_entries.csv: Every laser entry with zone, fluence, pulse width, treatment number, observations.
- practitioners.csv: Active practitioners at your studio.
- client_pricing.csv: Per-client custom pricing.
- appointments.csv: One row per appointment with client, practitioner, and service (IDs plus readable names), start/end times, duration, status, appointment notes, and cancellation details.
- treatment_plans.csv: One row per treatment plan with client, name, primary area, all treatment areas (pipe-joined), estimated timeline months window, status, estimated visit count, treatment-goal minutes override, and plan/budget notes.
- treatment_plan_stages.csv: Schedule stages for treatment plans (cadence, visit length, stage length, notes), with the parent plan and client for reference.
- record_keeping_sterile_items.csv: Sterile-supply inspection log: item, manufacturer, amount, lot number, purchase/expiry/discarded dates, notes. Expiry status is derivable from the expiry_date column (a date on or before today is expired); the in-app Records list and the print view flag expired / expires-today / expires-soon items. A date_discarded value means the practitioner recorded that this stock was physically thrown away on that date: it is then no longer current inventory (it raises no expiry reminder and is not offered as a probe lot), but the record and every treatment that used it are kept in full. An empty date_discarded means no discard was recorded.
- record_keeping_disinfectants.csv: Disinfectant preparation log: name, concentration, prepared/discarded/discard-due dates, operator, notes.
- record_keeping_exposure_incidents.csv: Exposure-incident log (OWNER-ONLY). Contains sensitive personal information about the exposed person (name, address, phone) and incident details.
- record_keeping_audit_events.csv: Record-keeping change history: record type/id, action, which fields changed, who made the change, and when. (Reduced: it does not include the before/after value snapshots.)
- client_clinical_notes.csv: The clinical narrative for every client: consultation notes and skin/hair analyses, with the authoring practitioner, the treatment areas tagged, when the note describes (occurred_at) and when it was recorded (created_at). FULL HISTORY: these records are append-only, so a correction appears as its own row whose supersedes_note_id points at the note it revised, and the superseded note is kept.
- client_budget_context.csv: The client's CURRENT budget context as recorded by the practitioner: a broad budget level (no_stated_limit / somewhat_limited / severely_limited, or empty when none was recorded) and free-text budget notes, with who last updated it and when. One row per client, and only for clients where something was recorded. This is practitioner-authored planning context, not a financial assessment of the client: it holds no income, no affordability score and no payment data, and it never affected pricing or charges. Historical plan-scoped budget notes written before this record existed remain in treatment_plans.csv and were deliberately not copied here.

IMPORTANT: SENSITIVE DATA: This ZIP now includes record-keeping / inspection data, including an exposure-incident log with personal information about exposed individuals. Store, transmit, and dispose of this export securely, and only share it with parties who are authorized to receive it (e.g. an inspector). Only a studio owner can generate this export.

Your data is yours. This export can be opened in Excel, Numbers, Google Sheets, or any spreadsheet tool. If you ever leave Hone, your records leave with you.

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
      files: [
        "clients.csv",
        "sessions.csv",
        "electrolysis_entries.csv",
        "laser_entries.csv",
        "practitioners.csv",
        "client_pricing.csv",
        "appointments.csv",
        "treatment_plans.csv",
        "treatment_plan_stages.csv",
        "client_clinical_notes.csv",
        ...(budgetContextExported ? ["client_budget_context.csv"] : []),
        "README.txt",
      ],
      row_counts: {
        clients: (clientsRes.data ?? []).length,
        sessions: (sessionsRes.data ?? []).length,
        electrolysis_entries: filteredElectrolysis.length,
        laser_entries: laserRows.length,
        practitioners: (practitionersRes.data ?? []).length,
        client_pricing: (pricingRes.data ?? []).length,
        appointments: appointmentRows.length,
        treatment_plans: treatmentPlanRows.length,
        treatment_plan_stages: treatmentPlanStageRows.length,
        client_clinical_notes: (clinicalNotesRes.data ?? []).length,
        ...(budgetContextExported
          ? {
              client_budget_context:
                budgetDecision.kind === "export"
                  ? budgetDecision.rows.length
                  : 0,
            }
          : {}),
      },
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
