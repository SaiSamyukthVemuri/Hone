import { createAdminClient } from "@/lib/supabase/admin-server";
import { createClient } from "@/lib/supabase/server";
import { generateIntakeToken } from "./tokens";
import type { ClientIntakeForm } from "@/lib/types/database";

const INTAKE_LINK_TTL_DAYS = 60;

// Returns the most recent non-deleted intake for the client, if any.
export async function getLatestIntakeForClient(
  studioId: string,
  clientId: string,
): Promise<ClientIntakeForm | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_intake_forms")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load intake: ${error.message}`);
  return (data ?? null) as ClientIntakeForm | null;
}

export async function getIntakeById(
  studioId: string,
  intakeId: string,
): Promise<ClientIntakeForm | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_intake_forms")
    .select("*")
    .eq("studio_id", studioId)
    .eq("id", intakeId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Failed to load intake: ${error.message}`);
  return (data ?? null) as ClientIntakeForm | null;
}

// Admin-client lookup used by the public /intake/[token] route. Token
// verification happens at the call site; this is just the row fetch.
export async function getIntakeByIdAdmin(
  intakeId: string,
): Promise<ClientIntakeForm | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_intake_forms")
    .select("*")
    .eq("id", intakeId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Failed to load intake: ${error.message}`);
  return (data ?? null) as ClientIntakeForm | null;
}

// Finds an in-progress intake for this client, or creates a new one.
// Used by the booking flow to attach a fresh link to the confirmation email.
// Returns { id, token } where token is a fresh signed link payload.
export async function ensureIntakeForClient(params: {
  studioId: string;
  clientId: string;
  appOrigin: string;
}): Promise<{ id: string; url: string } | null> {
  const admin = createAdminClient();

  // Prefer the most recent submitted/reviewed intake: those clients don't
  // need a fresh link, so we return null.
  const { data: existing, error: lookupErr } = await admin
    .from("client_intake_forms")
    .select("id, status")
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    console.error("Failed to look up intake for client:", lookupErr.message);
    return null;
  }
  if (existing && (existing.status === "submitted" || existing.status === "reviewed")) {
    return null;
  }

  let intakeId: string;
  if (existing) {
    intakeId = existing.id;
  } else {
    const { data: created, error: insertErr } = await admin
      .from("client_intake_forms")
      .insert({
        studio_id: params.studioId,
        client_id: params.clientId,
      })
      .select("id")
      .single();
    if (insertErr || !created) {
      console.error("Failed to create intake:", insertErr?.message);
      return null;
    }
    intakeId = created.id;
  }

  const expires = new Date(Date.now() + INTAKE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
  const token = generateIntakeToken(intakeId, expires);
  const url = `${params.appOrigin}/intake/${token}`;
  return { id: intakeId, url };
}
