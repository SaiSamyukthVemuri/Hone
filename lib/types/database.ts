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

export type Service = {
  id: string;
  studio_id: string;
  name: string;
  description: string | null;
  default_duration_minutes: number;
  price_cents: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

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

export type ProbeType = "Regular" | "IBL" | "ITH";
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
  area: string;
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
  created_at: string;
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
