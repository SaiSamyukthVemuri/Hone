import { createAdminClient } from "@/lib/supabase/admin-server";
import { createClient } from "@/lib/supabase/server";
import { generateIntakeToken } from "./tokens";
import type { ClientIntakeForm } from "@/lib/types/database";

// P0-4: intake link lifetime. Reduced from 60 days to 14 days so a
// stale link (e.g. one forwarded to a personal email and never
// completed) cannot be reused indefinitely against the questionnaire.
// 14 days comfortably covers the in-flight booking horizon (real
// clients complete intake within 1-2 weeks of receiving the email),
// and matches the cadence at which reminder emails would otherwise
// have been sent.
//
// Token revocation: once the intake row's status transitions to
// 'submitted' or 'reviewed', the public page (app/intake/[token]/page.tsx)
// deliberately refuses to return saved responses, and
// app/intake/[token]/actions.ts refuses any further save/submit. The
// status itself is the revocation signal; we do not need a separate
// token-version column in this phase. A future enhancement may add
// client_intake_forms.token_version smallint and include it in the
// HMAC payload so a forwarded link can be revoked individually before
// submission.
const INTAKE_LINK_TTL_DAYS = 14;

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

// Practitioner-triggered intake reissue. Unlike ensureIntakeForClient
// (which prefers reusing an in-progress row and refuses entirely when
// the latest is submitted/reviewed), this helper ALWAYS inserts a new
// client_intake_forms row in status='in_progress', leaving every
// existing row untouched. The submitted/reviewed clinical record is
// preserved verbatim; the new row is what the fresh token addresses.
//
// Booking and reschedule confirmation flows MUST NOT call this; they
// continue to call ensureIntakeForClient so existing clients who book
// a follow-up do not silently get a duplicate intake link.
export async function createIntakeRequestForClient(params: {
  studioId: string;
  clientId: string;
  requestedBy: string | null;
  appOrigin: string;
}): Promise<{ id: string; url: string } | null> {
  const admin = createAdminClient();
  const { data: created, error: insertErr } = await admin
    .from("client_intake_forms")
    .insert({
      studio_id: params.studioId,
      client_id: params.clientId,
      // status, current_step, responses default to in_progress / 1 / {}.
      requested_at: new Date().toISOString(),
      requested_by: params.requestedBy,
    })
    .select("id")
    .single();
  if (insertErr || !created) {
    console.error(
      "Failed to create intake reissue row:",
      insertErr?.message,
    );
    return null;
  }
  const url = generateIntakeLinkUrl(created.id, params.appOrigin);
  return { id: created.id, url };
}

// All non-deleted intake forms for one client, newest first. Used by
// the per-client intake history surface so the practitioner can see
// every reissue and its outcome alongside the latest record.
export async function getIntakeHistoryForClient(
  studioId: string,
  clientId: string,
): Promise<ClientIntakeForm[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_intake_forms")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load intake history: ${error.message}`);
  return (data ?? []) as ClientIntakeForm[];
}

// Mint a fresh tokenized /intake URL for an existing intake row id.
// Used by the practitioner-side Copy link / Resend email actions; the
// underlying row is unchanged. Token signature, TTL, and verification
// path are identical to the booking-flow link. The intake page's own
// status guard (submitted/reviewed → no responses returned, no save
// accepted) remains the authoritative revocation primitive.
export function generateIntakeLinkUrl(
  intakeId: string,
  appOrigin: string,
): string {
  const expires = new Date(Date.now() + INTAKE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
  const token = generateIntakeToken(intakeId, expires);
  return `${appOrigin}/intake/${token}`;
}
