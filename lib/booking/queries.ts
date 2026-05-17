import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type {
  Appointment,
  Service,
  Studio,
  StudioAvailabilityDefault,
  StudioAvailabilityOverride,
  StudioBlockout,
} from "@/lib/types/database";

// Active services for the studio, ordered by name.
export async function getActiveServices(studioId: string): Promise<Service[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select("*")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("name");
  if (error) throw new Error(`Failed to load services: ${error.message}`);
  return (data ?? []) as Service[];
}

export async function getAllServices(studioId: string): Promise<Service[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select("*")
    .eq("studio_id", studioId)
    .order("active", { ascending: false })
    .order("name");
  if (error) throw new Error(`Failed to load services: ${error.message}`);
  return (data ?? []) as Service[];
}

export async function getAvailabilityDefaults(
  studioId: string,
): Promise<StudioAvailabilityDefault[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_availability_default")
    .select("*")
    .eq("studio_id", studioId)
    .order("day_of_week");
  if (error)
    throw new Error(`Failed to load weekly defaults: ${error.message}`);
  return (data ?? []) as StudioAvailabilityDefault[];
}

export async function getOverridesForRange(
  studioId: string,
  startDate: string,
  endDate: string,
): Promise<StudioAvailabilityOverride[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_availability_overrides")
    .select("*")
    .eq("studio_id", studioId)
    .gte("effective_date", startDate)
    .lte("effective_date", endDate)
    .order("effective_date");
  if (error) throw new Error(`Failed to load overrides: ${error.message}`);
  return (data ?? []) as StudioAvailabilityOverride[];
}

export async function getBlockouts(studioId: string): Promise<StudioBlockout[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_blockouts")
    .select("*")
    .eq("studio_id", studioId)
    .order("starts_on");
  if (error) throw new Error(`Failed to load blockouts: ${error.message}`);
  return (data ?? []) as StudioBlockout[];
}

export async function getAppointmentsForRange(
  studioId: string,
  startIso: string,
  endIso: string,
): Promise<Appointment[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("studio_id", studioId)
    .gte("starts_at", startIso)
    .lt("starts_at", endIso)
    .order("starts_at");
  if (error) throw new Error(`Failed to load appointments: ${error.message}`);
  return (data ?? []) as Appointment[];
}

// Service-role lookup of a studio by public slug. Used by /book/[slug] and
// /cancel/[token] — both pre-auth flows.
export async function getStudioBySlug(slug: string): Promise<Studio | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studios")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`Failed to load studio: ${error.message}`);
  return (data ?? null) as Studio | null;
}
