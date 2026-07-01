"use server";

import JSZip from "jszip";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

export type ExportResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; error: string };

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else if (typeof value === "object") {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  // Quote whenever the value contains a comma, quote, CR, or LF.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  // Trailing newline so downstream tools recognize the last row consistently.
  return `${lines.join("\n")}\n`;
}

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
  ] = await Promise.all([
    supabase
      .from("clients")
      .select(
        "id, name, pronouns, date_of_birth, fitzpatrick_type, allergies, skin_notes, emergency_contact_name, emergency_contact_phone, email, phone, created_at",
      )
      .eq("studio_id", studio.id)
      .order("name", { ascending: true }),
    supabase
      .from("sessions")
      .select(
        "id, client_id, practitioner_id, performed_by_practitioner_id, modality, started_at, ended_at, price_paid_cents, session_notes, created_at",
      )
      .eq("studio_id", studio.id)
      .is("deleted_at", null)
      .order("started_at", { ascending: false }),
    supabase
      .from("electrolysis_entries")
      .select(
        "id, session_id, area, areas, probe_size, probe_lot_id, mode, intensity, duration_seconds, pulse_count, comments, created_at, block_id, energy_level, apilus_modality, machine_frequency, minutes_performed, probe_type, hairs_treated, galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent, thermolysis_intensity_percent, thermolysis_duration_seconds, units_of_lye",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("laser_entries")
      .select(
        "id, session_id, zone, session_number, equipment_params, observation_notes, created_at",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("practitioners")
      .select("id, display_name, email, role, active, created_at")
      .eq("studio_id", studio.id)
      .eq("active", true)
      .order("display_name", { ascending: true }),
    supabase
      .from("client_pricing")
      .select("id, client_id, service_name, price_cents, notes, effective_from")
      .eq("studio_id", studio.id)
      .order("effective_from", { ascending: false }),
    // Read-only lookup of the structured area + probe metadata that lives on
    // session_blocks (migrations 0039 / 0041). Merged onto each electrolysis
    // entry by block_id below so the export carries the structured probe and
    // area now collected by the one-page charting form. Includes deleted
    // blocks so any entry's block_id still resolves.
    supabase
      .from("session_blocks")
      .select(
        "id, primary_area, side, custom_area_detail, probe_key, probe_brand, probe_material, probe_piece_type, probe_shank, probe_size_value, probe_length, probe_label",
      )
      .eq("studio_id", studio.id),
    // Appointments (read-only). Studio-scoped. cancellation_token and the
    // internal scheduling snapshots (buffer_minutes_snapshot,
    // blocked_ends_at) are deliberately NOT selected — backup of human
    // booking data only, never opaque tokens or trigger-managed mechanics.
    supabase
      .from("appointments")
      .select(
        "id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, status, notes, cancellation_reason, cancelled_at, cancelled_by, created_at, updated_at",
      )
      .eq("studio_id", studio.id)
      .order("starts_at", { ascending: false }),
    // Treatment plans (read-only). Studio-scoped. budget_notes /
    // practitioner_notes live on this table and ARE plan data; private
    // warnings + personal notes live on the separate client_personal_notes
    // table and are never read here.
    supabase
      .from("treatment_plans")
      .select(
        "id, client_id, name, primary_area, treatment_areas, estimated_timeline_months_min, estimated_timeline_months_max, status, suggested_visit_count, treatment_goal_minutes_override, budget_notes, practitioner_notes, created_by_practitioner_id, closed_by_practitioner_id, created_at, closed_at",
      )
      .eq("studio_id", studio.id)
      .order("created_at", { ascending: false }),
    // Treatment plan stages (read-only). studio_id is denormalized on this
    // child table (migration 0034), so a direct studio-scoped read is safe.
    supabase
      .from("treatment_plan_stages")
      .select(
        "id, plan_id, sort_order, name, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit, notes, created_at, updated_at",
      )
      .eq("studio_id", studio.id)
      .order("plan_id", { ascending: true })
      .order("sort_order", { ascending: true }),
    // Name-resolution maps (read-only). All services and ALL practitioners
    // (including inactive) so appointment/plan rows can show a readable
    // name beside the stored ID even when the referenced row is inactive.
    supabase
      .from("services")
      .select("id, name")
      .eq("studio_id", studio.id),
    supabase
      .from("practitioners")
      .select("id, display_name")
      .eq("studio_id", studio.id),
    // PR #312: record-keeping / inspection tables (read-only). Studio-scoped
    // + read through the SAME RLS client, so exposure incidents (and their
    // audit rows) remain OWNER-ONLY per migration 0088 — enforced twice: the
    // action's role==="owner" gate above AND the owner-only RLS SELECT policy.
    // No image binaries / storage paths / payment tables here.
    supabase
      .from("record_keeping_sterile_items")
      .select(
        "id, date_purchased, item_description, manufacturer_name, amount_purchased, lot_number, expiry_date, notes, created_by_practitioner_id, created_at, updated_at",
      )
      .eq("studio_id", studio.id)
      .order("date_purchased", { ascending: false }),
    supabase
      .from("record_keeping_disinfectants")
      .select(
        "id, date_prepared, disinfectant_name, concentration, date_discarded, discard_due_date, operator_practitioner_id, operator_name, notes, created_by_practitioner_id, created_at, updated_at",
      )
      .eq("studio_id", studio.id)
      .order("date_prepared", { ascending: false }),
    // Exposure incidents carry sensitive PII (exposed-person name/address/
    // phone). SELECT is owner-only (0088); the RLS client returns them ONLY
    // because this action runs as the owner. Never switch to the admin client.
    supabase
      .from("record_keeping_exposure_incidents")
      .select(
        "id, incident_date, exposed_person_full_name, exposed_person_address, exposed_person_phone, exposure_details, action_taken, staff_involved_name, notes, created_by_practitioner_id, created_at, updated_at",
      )
      .eq("studio_id", studio.id)
      .order("incident_date", { ascending: false }),
    // Audit events: REDUCED export (PR #312). We export the record identity +
    // action + changed-field NAMES + actor + timestamp only. The full `changes`
    // value-snapshot JSON and free-form `metadata` are DELIBERATELY NOT selected
    // — that avoids duplicating exposure-incident PII into a second file.
    supabase
      .from("record_keeping_audit_events")
      .select(
        "id, record_type, record_id, action, changed_fields, actor_practitioner_id, actor_display_name, created_at",
      )
      .eq("studio_id", studio.id)
      .order("created_at", { ascending: false }),
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
  ]) {
    if (r.error) {
      return {
        ok: false,
        error: `Failed to load data for export: ${r.error.message}`,
      };
    }
  }

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

  zip.file(
    "clients.csv",
    rowsToCsv(
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
    rowsToCsv(
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
  };
  const blocksById = new Map<string, BlockExportRow>();
  for (const b of (blocksRes.data ?? []) as BlockExportRow[]) {
    blocksById.set(b.id, b);
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
      block_primary_area: b?.primary_area ?? null,
      block_side: b?.side ?? null,
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
    rowsToCsv(
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
        // Appended: structured area + probe from the entry's session block
        // (migrations 0039 / 0041).
        "block_primary_area",
        "block_side",
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
    rowsToCsv(
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
    rowsToCsv(
      ["id", "display_name", "email", "role", "active", "created_at"],
      practitionersRes.data ?? [],
    ),
  );

  zip.file(
    "client_pricing.csv",
    rowsToCsv(
      ["id", "client_id", "service_name", "price_cents", "notes", "effective_from"],
      pricingRes.data ?? [],
    ),
  );

  // ---------------------------------------------------------------------
  // Appointments + treatment plans + stages (export/backup readiness).
  // Human-readable name fields are resolved from in-memory maps built from
  // the studio-scoped reads above — no per-row (N+1) queries. A missing or
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
    rowsToCsv(
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
    rowsToCsv(
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
    rowsToCsv(
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
    rowsToCsv(
      [
        "id",
        "date_purchased",
        "item_description",
        "manufacturer_name",
        "amount_purchased",
        "lot_number",
        "expiry_date",
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
    rowsToCsv(
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
    rowsToCsv(
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
    rowsToCsv(
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

  const generatedAt = new Date().toISOString();
  const readme = `Hone Data Export
Generated: ${generatedAt}
Studio: ${studio.name}

This export contains all client records, sessions, entries, appointments, and treatment plans for your studio.

Files included:
- clients.csv: Client master list with names, contact info, allergies, skin notes, Fitzpatrick type, emergency contacts.
- sessions.csv: One row per session: client, performer, started_at, ended_at, price_paid_cents, session_notes.
- electrolysis_entries.csv: Every electrolysis entry with area, mode, energy level, modality, machine frequency, pulse count, hairs treated, blend/galvanic and thermolysis readings (galvanic mA/duration/intensity, thermolysis intensity/duration, units of lye), the structured probe (brand, material, piece type, shank, size, length), the treatment area (primary area, side, specifics), and comments.
- laser_entries.csv: Every laser entry with zone, fluence, pulse width, treatment number, observations.
- practitioners.csv: Active practitioners at your studio.
- client_pricing.csv: Per-client custom pricing.
- appointments.csv: One row per appointment with client, practitioner, and service (IDs plus readable names), start/end times, duration, status, appointment notes, and cancellation details.
- treatment_plans.csv: One row per treatment plan with client, name, primary area, all treatment areas (pipe-joined), estimated timeline months window, status, estimated visit count, treatment-goal minutes override, and plan/budget notes.
- treatment_plan_stages.csv: Schedule stages for treatment plans (cadence, visit length, stage length, notes), with the parent plan and client for reference.
- record_keeping_sterile_items.csv: Sterile-supply inspection log — item, manufacturer, amount, lot number, purchase/expiry dates, notes.
- record_keeping_disinfectants.csv: Disinfectant preparation log — name, concentration, prepared/discarded/discard-due dates, operator, notes.
- record_keeping_exposure_incidents.csv: Exposure-incident log (OWNER-ONLY). Contains sensitive personal information about the exposed person (name, address, phone) and incident details.
- record_keeping_audit_events.csv: Record-keeping change history — record type/id, action, which fields changed, who made the change, and when. (Reduced: it does not include the before/after value snapshots.)

IMPORTANT — SENSITIVE DATA: This ZIP now includes record-keeping / inspection data, including an exposure-incident log with personal information about exposed individuals. Store, transmit, and dispose of this export securely, and only share it with parties who are authorized to receive it (e.g. an inspector). Only a studio owner can generate this export.

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
