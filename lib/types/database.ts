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
  contraindications: Record<string, unknown> | null;
  photo_consent: boolean;
  notes: string | null;
  created_at: string;
  created_by: string | null;
};

export type Session = {
  id: string;
  studio_id: string;
  client_id: string;
  practitioner_id: string;
  modality: Modality;
  started_at: string;
  ended_at: string | null;
  session_notes: string | null;
  created_at: string;
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
  comments: string | null;
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
