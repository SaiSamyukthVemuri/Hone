"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

async function assertClientVisible(
  studioId: string,
  clientId: string,
): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load client: ${error.message}`);
  if (!data) throw new Error("Client not found.");
}

// Non-throwing variant for actions that want to return a clean
// { ok: false, error } shape instead of bubbling a redacted
// production-server-action crash. Returns true when the client is
// visible to this studio, false otherwise.
async function isClientVisible(
  studioId: string,
  clientId: string,
): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error) {
    console.error(
      JSON.stringify({
        event: "client_visible_lookup_failed",
        clientId,
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
  return !!data;
}

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function nullableInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

// Converts a dollar string like "150" or "150.50" to integer cents.
function dollarsToCents(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// Result type for the client save actions. Validation errors,
// duplicate-email collisions, and unexpected DB failures all return
// { ok: false, error } so the practitioner form can render a clean
// banner. Successful saves call redirect() and never return; the
// `void` half of the union covers that path for TypeScript.
//
// Why returned instead of thrown: Next.js redacts thrown server-
// action errors in production to the opaque "An error occurred in
// the Server Components render. The specific message is omitted in
// production builds" surface, so any throw here would crash the
// form even when the failure is a clean duplicate-email rejection.
// The ClientForm hostnow reads this return value to render the
// error inline.
export type ClientSaveResult = { ok: false; error: string };

// Pre-flight duplicate-email check that scopes by studio (matching
// the studio-scoped clients_studio_normalized_email_uniq partial
// index, migration 0032) and excludes the supplied client id when
// updating. Returns:
//   * { kind: "ok" }                 – the email is free
//   * { kind: "active_duplicate" }   – another active client owns it
//   * { kind: "archived_duplicate" } – an archived client owns it
//
// The portal login requires exactly one active client per email
// (PR #122 single-match gate), so we surface the archived case
// separately even though the unique index does not distinguish:
// the practitioner needs different copy depending on which client
// they would have to fix to free up the address.
async function checkDuplicateEmail(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  emailRaw: string | null,
  excludeClientId: string | null,
): Promise<
  | { kind: "ok" }
  | { kind: "active_duplicate" }
  | { kind: "archived_duplicate" }
  | { kind: "lookup_failed" }
> {
  if (!emailRaw) return { kind: "ok" };
  // Match the normalized_email generated column rule from migration
  // 0032: lower(trim(email)) and treat blank as null.
  const normalized = emailRaw.trim().toLowerCase();
  if (normalized.length === 0) return { kind: "ok" };
  let query = supabase
    .from("clients")
    .select("id, archived_at")
    .eq("studio_id", studioId)
    .eq("normalized_email", normalized);
  if (excludeClientId) {
    query = query.neq("id", excludeClientId);
  }
  const { data, error } = await query.limit(1);
  if (error) {
    console.error(
      JSON.stringify({
        event: "client_duplicate_email_lookup_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { kind: "lookup_failed" };
  }
  if (!data || data.length === 0) return { kind: "ok" };
  return data[0].archived_at != null
    ? { kind: "archived_duplicate" }
    : { kind: "active_duplicate" };
}

const ACTIVE_DUPLICATE_ERROR =
  "That email is already used by another active client. Use a different email or archive the duplicate client first.";
const ARCHIVED_DUPLICATE_ERROR =
  "That email belongs to an archived client. Unarchive that client or use a different email.";
const GENERIC_SAVE_ERROR = "Couldn't save the client. Please try again.";

// Translate the DuplicateCheck outcome into the action's return
// shape. Pulled out so both the pre-flight and the DB unique-
// violation fallback paths use the exact same wording.
function duplicateErrorFromCheck(
  outcome:
    | { kind: "active_duplicate" }
    | { kind: "archived_duplicate" },
): ClientSaveResult {
  if (outcome.kind === "archived_duplicate") {
    return { ok: false, error: ARCHIVED_DUPLICATE_ERROR };
  }
  return { ok: false, error: ACTIVE_DUPLICATE_ERROR };
}

// Best-effort recognition of the studio-scoped duplicate-email
// unique-index violation so a race between the pre-flight check and
// the UPDATE/INSERT also surfaces a clean error rather than the
// production server-action redaction. We match both the sqlstate
// code (23505 = unique_violation) and the index name from migration
// 0032 to avoid stealing other 23505 errors that might surface
// somewhere else.
function isClientDuplicateEmailDbError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code !== "23505") return false;
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes("clients_studio_normalized_email_uniq") ||
    msg.includes("normalized_email")
  );
}

export async function updateClientAction(
  formData: FormData,
): Promise<ClientSaveResult | void> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const name = nullableString(formData.get("name"));
  if (!name) return { ok: false, error: "Name is required." };

  const { studio } = await getCurrentPractitionerWithStudio();
  const visible = await isClientVisible(studio.id, clientId);
  if (!visible) return { ok: false, error: "Client not found." };

  const supabase = await createClient();

  const email = nullableString(formData.get("email"));
  const dupCheck = await checkDuplicateEmail(
    supabase,
    studio.id,
    email,
    clientId,
  );
  if (dupCheck.kind === "active_duplicate" || dupCheck.kind === "archived_duplicate") {
    return duplicateErrorFromCheck(dupCheck);
  }
  if (dupCheck.kind === "lookup_failed") {
    return { ok: false, error: GENERIC_SAVE_ERROR };
  }

  const { error } = await supabase
    .from("clients")
    .update({
      name,
      pronouns: nullableString(formData.get("pronouns")),
      phone: nullableString(formData.get("phone")),
      email,
      address: nullableString(formData.get("address")),
      date_of_birth: nullableString(formData.get("date_of_birth")),
      fitzpatrick_type: nullableInt(formData.get("fitzpatrick_type")),
      skin_notes: nullableString(formData.get("skin_notes")),
      allergies: nullableString(formData.get("allergies")),
      emergency_contact_name: nullableString(
        formData.get("emergency_contact_name"),
      ),
      emergency_contact_phone: nullableString(
        formData.get("emergency_contact_phone"),
      ),
    })
    .eq("id", clientId)
    .eq("studio_id", studio.id);

  if (error) {
    if (isClientDuplicateEmailDbError(error)) {
      // Race fallback: the pre-flight observed the email free, but a
      // concurrent edit (or a row we did not see because of a stale
      // read) tripped the unique index. Re-run the check to pick the
      // correct copy; if it still says "ok" we fall back to the
      // active-duplicate message which is the safer assumption.
      const recheck = await checkDuplicateEmail(
        supabase,
        studio.id,
        email,
        clientId,
      );
      if (recheck.kind === "archived_duplicate") {
        return { ok: false, error: ARCHIVED_DUPLICATE_ERROR };
      }
      return { ok: false, error: ACTIVE_DUPLICATE_ERROR };
    }
    console.error(
      JSON.stringify({
        event: "client_update_failed",
        clientId,
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: GENERIC_SAVE_ERROR };
  }
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/clients");
  redirect(`/clients/${clientId}`);
}

// Soft-archive a client. Stamps clients.archived_at + archived_by.
// The row stays in the table so every foreign-key reference
// (appointments, sessions, intake forms, treatment plans, audit) keeps
// working; the active client list, calendar quick-book picker, and
// birthday surface filter on archived_at IS NULL. The detail page
// still resolves so the practitioner can un-archive later.
//
// Hard delete is intentionally NOT supported: destroying a client row
// while the clinical history graph references it is data loss with no
// operational upside for the actual use cases (test clients during
// pilot setup and duplicate-entry rows from a typo).
//
// One audit_logs row is inserted so there is a durable trace of who
// archived which client; audit failure logs but does not block the
// archive itself (the archive is the safety action, an audit row
// missing later is recoverable).
export async function archiveClientAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("clients")
    .update({
      archived_at: nowIso,
      archived_by: practitioner.id,
    })
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .is("archived_at", null);
  if (error) {
    throw new Error(`Failed to archive client: ${error.message}`);
  }

  const { error: auditErr } = await supabase.from("audit_logs").insert({
    studio_id: studio.id,
    actor_id: practitioner.id,
    action: "client_archived",
    entity_type: "client",
    entity_id: clientId,
    metadata: { archived_at: nowIso },
  });
  if (auditErr) {
    console.error(
      JSON.stringify({
        event: "client_archive_audit_failed",
        clientId,
        code: auditErr.code,
        message: auditErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/clients");
  redirect("/clients");
}

// Reverse of archiveClientAction. Clears archived_at + archived_by so
// the client returns to the active list. Safe to call any number of
// times; the conditional WHERE in archiveClientAction prevents a
// no-op archive from advancing the timestamp once it is already set.
export async function unarchiveClientAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({
      archived_at: null,
      archived_by: null,
    })
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .not("archived_at", "is", null);
  if (error) {
    throw new Error(`Failed to unarchive client: ${error.message}`);
  }

  const { error: auditErr } = await supabase.from("audit_logs").insert({
    studio_id: studio.id,
    actor_id: practitioner.id,
    action: "client_unarchived",
    entity_type: "client",
    entity_id: clientId,
    metadata: {},
  });
  if (auditErr) {
    console.error(
      JSON.stringify({
        event: "client_unarchive_audit_failed",
        clientId,
        code: auditErr.code,
        message: auditErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/clients");
  redirect(`/clients/${clientId}`);
}

export async function addClientPricingAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId)
    throw new Error("Missing client id.");

  const serviceName = nullableString(formData.get("service_name"));
  if (!serviceName) throw new Error("Service is required.");

  const priceCents = dollarsToCents(formData.get("price"));
  if (priceCents == null) throw new Error("Price must be a non-negative number.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase.from("client_pricing").insert({
    studio_id: studio.id,
    client_id: clientId,
    service_name: serviceName,
    price_cents: priceCents,
    notes: nullableString(formData.get("notes")),
  });

  if (error) throw new Error(`Failed to add pricing: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function deleteClientPricingAction(formData: FormData): Promise<void> {
  const id = formData.get("id");
  const clientId = formData.get("client_id");
  if (typeof id !== "string" || !id) throw new Error("Missing pricing id.");
  if (typeof clientId !== "string" || !clientId)
    throw new Error("Missing client id.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_pricing")
    .delete()
    .eq("id", id)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId);
  if (error) throw new Error(`Failed to delete pricing: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function addClientTagAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  const label = nullableString(formData.get("label"));
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }
  if (!label) throw new Error("Tag label is required.");
  if (label.length > 60) throw new Error("Tag label must be 60 characters or fewer.");

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase.from("client_tags").insert({
    studio_id: studio.id,
    client_id: clientId,
    label,
    created_by: practitioner.id,
  });
  if (error) throw new Error(`Failed to add tag: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function removeClientTagAction(formData: FormData): Promise<void> {
  const tagId = formData.get("tag_id");
  const clientId = formData.get("client_id");
  if (typeof tagId !== "string" || !tagId) throw new Error("Missing tag id.");
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_tags")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: practitioner.id,
    })
    .eq("id", tagId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId)
    .is("deleted_at", null);
  if (error) throw new Error(`Failed to remove tag: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
}
