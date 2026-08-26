// ---------------------------------------------------------------------------
// F4. THE SELECT THAT PRODUCES A FILE'S ROWS, KEYED BY THE RESOURCE IT FEEDS
// ---------------------------------------------------------------------------
//
// The first version of this check collected observed SELECTs BY TABLE and
// unioned them, which cannot tell two queries apart — and `practitioners` is
// read TWICE: once for practitioners.csv, and once as a display-name lookup for
// appointments.csv. Dropping `display_name` from the EXPORT query therefore
// left the union satisfied by the LOOKUP query, and the audit stayed green
// while practitioners.csv emitted blank cells.
//
// The association is now structural rather than observed: one entry per
// EXPORTED resource, and the key IS the resource whose CSV those rows become.
// The lookup query keeps its own inline literal and is deliberately NOT in this
// map, so it can never stand in for the export query again.
//
// `as const` matters: supabase-js infers row types from the select STRING, so
// these must stay literal types rather than widening to `string`.
export const EXPORT_SELECTS = {
  clients:
    "id, name, pronouns, date_of_birth, fitzpatrick_type, allergies, skin_notes, emergency_contact_name, emergency_contact_phone, email, phone, created_at",
  sessions:
    "id, client_id, practitioner_id, performed_by_practitioner_id, modality, started_at, ended_at, price_paid_cents, session_notes, created_at",
  electrolysis_entries:
    "id, session_id, area, areas, probe_size, probe_lot_id, mode, intensity, duration_seconds, pulse_count, pulse_delay_seconds, comments, observation_chips, created_at, block_id, energy_level, apilus_modality, machine_frequency, minutes_performed, probe_type, hairs_treated, galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent, thermolysis_intensity_percent, thermolysis_duration_seconds, units_of_lye",
  laser_entries:
    "id, session_id, zone, session_number, equipment_params, observation_notes, created_at",
  practitioners:
    "id, display_name, email, role, active, created_at",
  client_pricing:
    "id, client_id, service_name, price_cents, notes, effective_from",
  appointments:
    "id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, status, notes, cancellation_reason, cancelled_at, cancelled_by, created_at, updated_at",
  treatment_plans:
    "id, client_id, name, primary_area, treatment_areas, estimated_timeline_months_min, estimated_timeline_months_max, status, suggested_visit_count, treatment_goal_minutes_override, budget_notes, practitioner_notes, created_by_practitioner_id, closed_by_practitioner_id, created_at, closed_at",
  treatment_plan_stages:
    "id, plan_id, sort_order, name, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit, notes, created_at, updated_at",
  record_keeping_sterile_items:
    "id, date_purchased, item_description, manufacturer_name, amount_purchased, lot_number, expiry_date, date_discarded, notes, created_by_practitioner_id, created_at, updated_at",
  record_keeping_disinfectants:
    "id, date_prepared, disinfectant_name, concentration, date_discarded, discard_due_date, operator_practitioner_id, operator_name, notes, created_by_practitioner_id, created_at, updated_at",
  record_keeping_exposure_incidents:
    "id, incident_date, exposed_person_full_name, exposed_person_address, exposed_person_phone, exposure_details, action_taken, staff_involved_name, notes, created_by_practitioner_id, created_at, updated_at",
  record_keeping_audit_events:
    "id, record_type, record_id, action, changed_fields, actor_practitioner_id, actor_display_name, created_at",
  client_clinical_notes:
    "id, client_id, practitioner_id, kind, body, areas, occurred_at, supersedes_note_id, created_at",
  client_budget_context:
    "client_id, budget_level, budget_notes, updated_by_practitioner_id, created_at, updated_at",
} as const;
