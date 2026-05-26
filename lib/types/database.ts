// Hand-rolled minimal database types. Regenerate from Supabase later with:
//   npx supabase gen types typescript --project-id <ref> > lib/types/database.ts

export type Modality = "electrolysis" | "laser";
export type ElectrolysisMode = "thermo" | "galv" | "blend";
export type PractitionerRole = "owner" | "practitioner";
export type PhotoType = "before" | "after" | "progress";
export type FitzpatrickType = 1 | 2 | 3 | 4 | 5 | 6;

export type Studio = {
  id: string;
  name: string;
  legal_entity_name: string | null;
  owner_email: string;
  created_at: string;
  // Booking v1 additions (migration 0010)
  timezone: string;
  default_appointment_duration_minutes: number;
  buffer_minutes: number;
  slug: string;
  address: string | null;
  booking_description: string | null;
  // Migration 0025: studio-level email toggles.
  send_confirmation_emails: boolean;
  send_24h_reminders: boolean;
  send_2h_reminders: boolean;
  auto_mark_no_shows: boolean;
  send_no_show_followup: boolean;
  // Migration 0026: opt-in display of client treatment time in emails.
  show_treatment_time_to_clients: boolean;
  // Migration 0036: how many months ahead the public booking page shows
  // available slots. Allowed values: 3, 4, 6. Default 3 (matches the
  // previously-hardcoded BOOKING_HORIZON_DAYS). Internal practitioner
  // booking is not subject to this limit.
  public_booking_horizon_months: 3 | 4 | 6;
};

export type TreatmentGoalStatus = "active" | "reached" | "revised" | "archived";

// Migration 0026: single estimated-total per client. Editing the row in
// place is the supported flow; status moves from active → reached or
// active → revised as the practitioner judges.
export type TreatmentGoal = {
  id: string;
  client_id: string;
  studio_id: string;
  estimated_total_minutes: number;
  notes: string | null;
  status: TreatmentGoalStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioAvailabilityDefault = {
  id: string;
  studio_id: string;
  day_of_week: number; // 0 = Sunday, 6 = Saturday
  is_open: boolean;
  open_time: string | null; // "HH:MM:SS"
  close_time: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioAvailabilityOverride = {
  id: string;
  studio_id: string;
  effective_date: string; // "YYYY-MM-DD"
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioBlockout = {
  id: string;
  studio_id: string;
  starts_on: string;
  ends_on: string;
  reason: string | null;
  created_at: string;
};

// Migration 0030: one-off time-specific blocks (lunch, meeting,
// emergency, etc). Categories are stored lowercase; the UI renders
// them in title case.
export type StudioTimedBlockCategory =
  | "lunch"
  | "break"
  | "meeting"
  | "emergency"
  | "personal"
  | "training"
  | "admin"
  | "other";

export type StudioTimedBlock = {
  id: string;
  studio_id: string;
  starts_at: string;
  ends_at: string;
  category: StudioTimedBlockCategory;
  private_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// Migration 0031: weekly recurring break rules + materialized
// occurrences. Each occurrence mirrors into
// studio_calendar_reservations with source_kind =
// 'recurring_break_occurrence' so the unified gist exclusion
// enforces it the same way it enforces appointments, one-off
// blocks, and full-day blockouts.
export type StudioRecurringBreakLabel =
  | "lunch"
  | "break"
  | "admin"
  | "other";

export type StudioRecurringBreakRule = {
  id: string;
  studio_id: string;
  label: StudioRecurringBreakLabel;
  days_of_week: number[];
  start_local_time: string;
  end_local_time: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioRecurringBreakOccurrence = {
  id: string;
  rule_id: string | null;
  studio_id: string;
  occurrence_date: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
};

// Migration 0030: unified shadow table. Source_kind covers
// appointment, timed_block, full_day_blockout, and (Phase 2)
// recurring_break_occurrence.
export type StudioCalendarReservationKind =
  | "appointment"
  | "timed_block"
  | "full_day_blockout"
  | "recurring_break_occurrence";

export type StudioCalendarReservation = {
  id: string;
  studio_id: string;
  source_kind: StudioCalendarReservationKind;
  source_id: string;
  starts_at: string;
  ends_at: string;
};

export type Service = {
  id: string;
  studio_id: string;
  name: string;
  description: string | null;
  default_duration_minutes: number;
  price_cents: number | null;
  active: boolean;
  // Migration 0021: free-text modality grouping for the booking menu. Common
  // values: 'electrolysis', 'laser', 'consultation'. Null renders as "Other".
  modality: string | null;
  sort_order: number;
  // Migration 0025: optional pre-care text included in confirmation +
  // reminder emails for appointments of this service.
  pre_care_instructions: string | null;
  created_at: string;
  updated_at: string;
};

// Known modality values surfaced in UI dropdowns. The DB column accepts any
// string, so studios can introduce custom modalities later without a
// migration; KNOWN_MODALITIES is for the picker convenience only.
export type ServiceModality = "electrolysis" | "laser" | "consultation";
export const KNOWN_MODALITIES: ReadonlyArray<{
  value: ServiceModality;
  label: string;
}> = [
  { value: "electrolysis", label: "Electrolysis" },
  { value: "laser", label: "Laser" },
  { value: "consultation", label: "Consultation" },
];

export type AppointmentStatus =
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

export type CancelledBy = "client" | "practitioner" | "owner";

export type Appointment = {
  id: string;
  studio_id: string;
  practitioner_id: string | null;
  client_id: string;
  service_id: string | null;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  status: AppointmentStatus;
  notes: string | null;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  cancelled_by: CancelledBy | null;
  created_at: string;
  updated_at: string;
  // Migration 0025: email tracking + opaque token used in cancel and
  // reschedule URLs.
  confirmation_sent_at: string | null;
  reminder_24h_sent_at: string | null;
  reminder_2h_sent_at: string | null;
  no_show_email_sent_at: string | null;
  confirmation_send_attempts: number;
  reminder_24h_send_attempts: number;
  reminder_2h_send_attempts: number;
  // Migration 0028: attempts counter for the no-show follow-up email,
  // added so the no-show path has the same 3-strike behavior as the others.
  no_show_email_send_attempts: number;
  cancellation_token: string | null;
  // Migration 0029: trailing-only protected interval
  // [starts_at, blocked_ends_at). buffer_minutes_snapshot is a copy
  // of studios.buffer_minutes at the moment the row was inserted or
  // last had its starts_at/ends_at/studio_id changed. Both columns
  // are populated by the snapshot_appointment_buffer trigger; the
  // app never writes them directly. The exclusion constraint
  // enforces non-overlap on this interval per studio.
  buffer_minutes_snapshot: number;
  blocked_ends_at: string;
};

export type AppointmentAudit = {
  id: string;
  appointment_id: string;
  actor_type: "practitioner" | "client" | "system";
  actor_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  created_at: string;
};

export type Practitioner = {
  id: string;
  studio_id: string;
  user_id: string | null;
  display_name: string;
  email: string;
  role: PractitionerRole;
  active: boolean;
  // Migration 0023: token from lib/practitioner-colors PRACTITIONER_COLORS.
  // Free text in the DB; UI resolves via resolvePractitionerColor.
  color: string;
  created_at: string;
};

export type Client = {
  id: string;
  studio_id: string;
  name: string;
  pronouns: string | null;
  date_of_birth: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  fitzpatrick_type: FitzpatrickType | null;
  skin_notes: string | null;
  allergies: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  contraindications: Record<string, unknown> | null;
  photo_consent: boolean;
  notes: string | null;
  created_at: string;
  created_by: string | null;
};

export type ApilusModality =
  | "Multiplex"
  | "Microflash"
  | "Picoflash"
  | "Synchro"
  | "Thermoflash"
  | "Meloflash"
  | "Evolublend"
  | "Omniblend"
  | "Picoblend"
  | "Synchroblend"
  | "Multiblend";

export type ProbeType =
  | "Stainless steel regular"
  | "Stainless steel gold"
  | "IBL"
  | "ITH";
export type MachineFrequency = "13.56 MHz" | "27.12 MHz";

export type Session = {
  id: string;
  studio_id: string;
  client_id: string;
  practitioner_id: string;
  performed_by_practitioner_id: string | null;
  modality: Modality;
  started_at: string;
  started_at_original: string;
  ended_at: string | null;
  session_notes: string | null;
  price_paid_cents: number | null;
  created_at: string;
  // Migration 0013: soft delete.
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  // Migration 0024: optional attachment to a multi-session treatment plan.
  treatment_plan_id: string | null;
};

export type TreatmentPlanStatus = "active" | "closed";

// Migration 0024: tracks multi-session electrolysis work against a target
// visit count. Sessions opt in via sessions.treatment_plan_id.
//
// Migration 0034 (Treatment Plan v2 schema, Phase B): adds three nullable
// columns — budget_notes, practitioner_notes, treatment_goal_minutes_override.
// suggested_visit_count is retained as NOT NULL; the legacy
// "Estimated visits" UI keeps writing it. Stage data (cadence + visit
// length + duration) lives on the child treatment_plan_stages table.
export type TreatmentPlan = {
  id: string;
  client_id: string;
  studio_id: string;
  name: string;
  suggested_visit_count: number;
  status: TreatmentPlanStatus;
  created_by_practitioner_id: string | null;
  closed_by_practitioner_id: string | null;
  created_at: string;
  closed_at: string | null;
  // Migration 0034 additive columns (nullable; legacy rows are still valid).
  budget_notes: string | null;
  practitioner_notes: string | null;
  treatment_goal_minutes_override: number | null;
  // Migration 0038 (Body Chart v1 Phase A): optional structured primary
  // area for this plan, e.g. "Chin" or "Underarms". Free-form 1..60
  // chars; the practitioner UI uses lib/constants.ts AREA_REGIONS as
  // the canonical picker but "Other" + custom strings are allowed.
  primary_area: string | null;
};

// Migration 0034: one stage of a treatment plan. A plan can contain
// multiple stages (e.g. weekly 15-min visits for 3 months, then monthly
// maintenance visits for 12 months). studio_id is denormalized for RLS
// and is always derived from the parent plan by a BEFORE trigger.
export type TreatmentPlanStageHowOftenUnit =
  | "weekly"
  | "every_2_weeks"
  | "monthly";
export type TreatmentPlanStageLengthUnit = "weeks" | "months";

export type TreatmentPlanStage = {
  id: string;
  plan_id: string;
  studio_id: string;
  sort_order: number;
  name: string | null;
  how_often_unit: TreatmentPlanStageHowOftenUnit;
  visit_length_minutes: number;
  stage_length_value: number;
  stage_length_unit: TreatmentPlanStageLengthUnit;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionAudit = {
  id: string;
  session_id: string;
  edited_by_practitioner_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  edited_at: string;
};

export type ElectrolysisEntry = {
  id: string;
  session_id: string;
  // Legacy single-area field. Always populated for backwards compatibility
  // (first entry of `areas`). New code should prefer `areas`.
  area: string;
  // Migration 0017: multiple areas treated with the same settings.
  areas: string[] | null;
  probe_size: string | null;
  probe_lot_id: string | null;
  mode: ElectrolysisMode | null;
  intensity: number | null;
  duration_seconds: number | null;
  pulse_count: number;
  comments: string | null;
  // Migration 0011: parameters moved from session level to entry level.
  apilus_modality: ApilusModality | null;
  energy_level: number | null;
  minutes_performed: number | null;
  probe_type: ProbeType | null;
  machine_frequency: MachineFrequency | null;
  // Migration 0012: optional total hair count per entry.
  hairs_treated: number | null;
  // Migration 0019: pointer to the block this entry belongs to. Nullable
  // because legacy rows existed before blocks; 0020 backfilled them. All
  // new inserts get a block_id via ensureEntryHasBlock().
  block_id: string | null;
  created_at: string;
};

// Migration 0019: block-level treatment params. SessionMode mirrors the
// existing ElectrolysisMode values (thermo / blend / galv).
export type SessionMode = ElectrolysisMode;

// Body Chart v1 Phase B (migration 0039): structured anatomical area
// metadata for analytics. `side` is a small closed enum enforced by a DB
// CHECK; the other two columns are length-bounded free text. All three
// are nullable and additive — legacy blocks are unaffected.
export type SessionBlockSide =
  | "center"
  | "left"
  | "right"
  | "bilateral"
  | "n/a";

export type SessionBlock = {
  id: string;
  studio_id: string;
  session_id: string;
  sort_order: number;
  block_name: string | null;
  block_notes: string | null;
  mode: SessionMode | null;
  apilus_modality: ApilusModality | null;
  energy_level: number | null;
  minutes_performed: number | null;
  probe_type: ProbeType | null;
  probe_size: string | null;
  machine_frequency: MachineFrequency | null;
  started_at: string | null;
  ended_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  created_at: string;
  updated_at: string;
  // Migration 0039 additive columns (nullable; legacy rows are still valid).
  primary_area: string | null;
  side: SessionBlockSide | null;
  custom_area_detail: string | null;
};

export type LaserEntry = {
  id: string;
  session_id: string;
  zone: string;
  session_number: number | null;
  equipment_params: Record<string, unknown> | null;
  observation_notes: string | null;
  ejection_results: string | null;
  created_at: string;
};

export type ProbeLot = {
  id: string;
  studio_id: string;
  probe_size: string;
  lot_number: string | null;
  expiry_date: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
};

export type ClientPricing = {
  id: string;
  studio_id: string;
  client_id: string | null;
  service_name: string;
  price_cents: number;
  notes: string | null;
  effective_from: string;
};

export type Photo = {
  id: string;
  studio_id: string;
  client_id: string;
  session_id: string | null;
  area: string | null;
  storage_path: string;
  photo_type: PhotoType | null;
  taken_at: string;
};

export type InvitationStatus = "pending" | "accepted" | "revoked";

export type PendingInvitation = {
  id: string;
  studio_id: string;
  email: string;
  invited_by: string | null;
  role: PractitionerRole;
  display_name: string | null;
  status: InvitationStatus;
  created_at: string;
  accepted_at: string | null;
};

// Migration 0022: practitioner-authored short notes pinned to a client and
// surfaced everywhere that client appears (profile, appointment detail,
// today's roster). No edit-in-place: remove and re-add to change.
export type ClientPinnedNote = {
  id: string;
  client_id: string;
  studio_id: string;
  text: string;
  created_by_practitioner_id: string | null;
  created_at: string;
};

// Migration 0035: practitioner-only relationship memory + sensitive
// warnings. One row per client (UNIQUE on client_id). studio_id is
// derived from the parent client by trigger; the row is created lazily
// on first save. These fields are NEVER exposed to client/public/email
// surfaces — see the privacy contract in the migration comment and the
// import audit in PR #27.
export type ClientPersonalNotes = {
  id: string;
  client_id: string;
  studio_id: string;
  personal_notes: string;
  private_warnings: string;
  updated_by_practitioner_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ClientTag = {
  id: string;
  studio_id: string;
  client_id: string;
  label: string;
  color: string | null;
  created_at: string;
  created_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
};

export type IntakeStatus = "in_progress" | "submitted" | "reviewed";

export type ClientIntakeForm = {
  id: string;
  studio_id: string;
  client_id: string;
  status: IntakeStatus;
  current_step: number;
  responses: Record<string, unknown>;
  started_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  practitioner_notes: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditLog = {
  id: string;
  studio_id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
