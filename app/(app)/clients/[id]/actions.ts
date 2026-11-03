"use server";

import { recordClientArchiveAudit } from "@/lib/audit/governed-writes";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  CHANGED_BY_SOMEONE_ELSE_ERROR,
  NOT_SAVED_ERROR,
  STALE_FORM_ERROR,
  describeConflicts,
  parseBaseline,
  planProfileUpdate,
  splitConditions,
  type ProfileConflict,
} from "@/lib/clients/profile-baseline";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { safeLog } from "@/lib/logging/safe-log";
import {
  findPossibleDuplicateClient,
  type PossibleDuplicate,
} from "@/lib/clients/possible-duplicate";
import { dbErrorCode } from "@/lib/logging/error-class";

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
  if (error) throw new Error(`Failed to load client: ${dbErrorCode(error)}`);
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
    safeLog.error(
      JSON.stringify({
        event: "client_visible_lookup_failed",
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
// HON-58 (I1): `possibleDuplicates` is set when an edit to the name, phone or
// date of birth makes this client match others (same phone, or same name and
// date of birth). Nothing was saved; ClientForm lists them and "Save as a new
// client anyway" resubmits with one confirm_possible_duplicate per client.
export type ClientSaveResult = {
  ok: false;
  error: string;
  possibleDuplicates?: PossibleDuplicate[];
  /** Zero rows because a changed field was changed by someone else: current vs yours, for review. */
  conflicts?: ProfileConflict[];
};

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
    safeLog.error(
      JSON.stringify({
        event: "client_duplicate_email_lookup_failed",
        code: dbErrorCode(error),
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

function editDuplicatesMessage(duplicates: PossibleDuplicate[]): string {
  const describe = (d: PossibleDuplicate) =>
    `${d.archived ? "an archived client, " : ""}${d.clientName} (${
      d.reason === "phone" ? "same phone number" : "same name and date of birth"
    })`;
  const who =
    duplicates.length === 1
      ? describe(duplicates[0])
      : `one of ${duplicates.length} existing clients: ${duplicates.map(describe).join("; ")}`;
  return `With this change, this client may be the same person as ${who}. Nothing was saved.`;
}

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
  // Who is asking comes first: nothing about the submission (validation messages, baseline checks) is
  // answered to a caller who is not an active owner or practitioner of a studio.
  const { studio } = await getCurrentPractitionerWithStudio();

  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  // The values the page loaded. Without them this is an older or foreign form: refuse it before anything is
  // read or written (it cannot be told apart from a stale tab, and guessing would overwrite newer values).
  const baseline = parseBaseline(formData.get("baseline"));
  if (!baseline) return { ok: false, error: STALE_FORM_ERROR };

  // Only fields the form submitted AND the staff member changed are written; an omitted field is never a
  // candidate, so it can never be cleared. Invalid input changes nothing.
  const plan = planProfileUpdate(formData, baseline);
  if (!plan.ok) return { ok: false, error: plan.error };

  const visible = await isClientVisible(studio.id, clientId);
  if (!visible) return { ok: false, error: "Client not found." };

  // Nothing changed: nothing to write, and nothing to claim was saved beyond what is already stored.
  if (Object.keys(plan.patch).length === 0) {
    revalidatePath(`/clients/${clientId}`);
    redirect(`/clients/${clientId}`);
  }

  const supabase = await createClient();

  const emailChanged = "email" in plan.patch;
  const email = emailChanged ? ((plan.patch.email as string | null) ?? null) : null;
  if (emailChanged) {
    const dupCheck = await checkDuplicateEmail(supabase, studio.id, email, clientId);
    if (dupCheck.kind === "active_duplicate" || dupCheck.kind === "archived_duplicate") {
      return duplicateErrorFromCheck(dupCheck);
    }
    if (dupCheck.kind === "lookup_failed") {
      return { ok: false, error: GENERIC_SAVE_ERROR };
    }
  }

  // HON-58 (Team review of #1084, I1): an edit can make this record a probable duplicate. Check only when the
  // edit changes the name, phone or date of birth (compared with what the page loaded), never count this
  // client, save only when every match was confirmed by id. A failed read refuses rather than implying "none".
  const identityChanged = "name" in plan.patch || "phone" in plan.patch || "date_of_birth" in plan.patch;
  if (identityChanged) {
    const check = await findPossibleDuplicateClient(supabase, studio.id, {
      name: typeof plan.patch.name === "string" ? plan.patch.name : (baseline.name as string | null) ?? "",
      phone: "phone" in plan.patch ? ((plan.patch.phone as string | null) ?? null) : ((baseline.phone as string | null) ?? null),
      dateOfBirth:
        "date_of_birth" in plan.patch
          ? ((plan.patch.date_of_birth as string | null) ?? null)
          : ((baseline.date_of_birth as string | null) ?? null),
    });
    if (check.kind === "unavailable") {
      safeLog.error(
        JSON.stringify({
          event: "client_update_possible_duplicate_lookup_failed",
          code: check.code,
          timestamp: new Date().toISOString(),
        }),
      );
      return { ok: false, error: GENERIC_SAVE_ERROR };
    }
    if (check.kind === "match") {
      const duplicates = check.duplicates.filter((d) => d.clientId !== clientId);
      const confirmed = new Set(formData.getAll("confirm_possible_duplicate"));
      if (duplicates.length > 0 && duplicates.some((d) => !confirmed.has(d.clientId))) {
        return {
          ok: false,
          error: editDuplicatesMessage(duplicates),
          possibleDuplicates: duplicates,
        };
      }
    }
  }

  // Only short conditions go in the URL (see splitConditions). A changed field whose baseline is too long for a URL
  // gets no equality condition on the write. Instead its CURRENT value is read here, in the same action just before
  // the write (a select, answered in the body, no URL condition), and compared with the baseline; a difference is
  // the "changed by someone else" review and nothing is written. What remains is the gap between that read and the
  // write for those fields only (allergies and address in practice); the atomic fix is a JSON-body database function.
  const { inUrl, unconditioned } = splitConditions(plan.conditions);
  if (unconditioned.length > 0) {
    const { data: current, error: currentError } = await supabase
      .from("clients")
      .select(unconditioned.map((c) => c.key).join(","))
      .eq("id", clientId)
      .eq("studio_id", studio.id)
      .maybeSingle();
    if (currentError) return { ok: false, error: NOT_SAVED_ERROR };
    if (!current) return { ok: false, error: "Client not found." };
    const moved = describeConflicts(
      { ...plan, conditions: unconditioned },
      current as unknown as Record<string, unknown>,
    );
    if (moved.length > 0) return { ok: false, error: CHANGED_BY_SOMEONE_ELSE_ERROR, conflicts: moved };
  }
  // ONE conditional UPDATE: it applies only while every column it changes still holds the value the page
  // loaded, and it returns the row it changed. Zero rows is "not saved", never success.
  // Chloe Session 1A: `clients.skin_notes` is retired as an editor and is never written here.
  // The column list is spelled out (undefined = unchanged, dropped from the request) so the write census can
  // prove which columns this action can ever touch.
  const p = plan.patch;
  let update = supabase
    .from("clients")
    .update({
      name: p.name,
      preferred_name: p.preferred_name,
      pronouns: p.pronouns,
      date_of_birth: p.date_of_birth,
      phone: p.phone,
      email: p.email,
      address: p.address,
      fitzpatrick_type: p.fitzpatrick_type,
      allergies: p.allergies,
      emergency_contact_name: p.emergency_contact_name,
      emergency_contact_phone: p.emergency_contact_phone,
    })
    .eq("id", clientId)
    .eq("studio_id", studio.id);
  for (const { key, value } of inUrl) {
    update = value === null ? update.is(key, null) : update.eq(key, value);
  }
  const { data: changed, error } = await update.select("id");

  if (error) {
    if (isClientDuplicateEmailDbError(error)) {
      // Race fallback: the pre-flight observed the email free, but a concurrent edit tripped the unique
      // index. Re-run the check to pick the correct copy; if it still says "ok" fall back to the
      // active-duplicate message, the safer assumption.
      const recheck = await checkDuplicateEmail(supabase, studio.id, email, clientId);
      if (recheck.kind === "archived_duplicate") {
        return { ok: false, error: ARCHIVED_DUPLICATE_ERROR };
      }
      return { ok: false, error: ACTIVE_DUPLICATE_ERROR };
    }
    safeLog.error(
      JSON.stringify({
        event: "client_update_failed",
        clientId,
        code: dbErrorCode(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: GENERIC_SAVE_ERROR };
  }

  if (!changed || changed.length === 0) {
    // Not saved. Say why: the client is gone, or one of the changed fields no longer holds what the page
    // loaded (somebody else changed it). The current values go only to this signed-in staff member.
    const { data: stored, error: readError } = await supabase
      .from("clients")
      .select(plan.conditions.map((c) => c.key).join(","))
      .eq("id", clientId)
      .eq("studio_id", studio.id)
      .maybeSingle();
    if (readError) return { ok: false, error: NOT_SAVED_ERROR };
    if (!stored) return { ok: false, error: "Client not found." };
    const conflicts = describeConflicts(plan, stored as unknown as Record<string, unknown>);
    if (conflicts.length === 0) return { ok: false, error: NOT_SAVED_ERROR };
    return { ok: false, error: CHANGED_BY_SOMEONE_ELSE_ERROR, conflicts };
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
    throw new Error(`Failed to archive client: ${dbErrorCode(error)}`);
  }

  const { error: auditErr } = await recordClientArchiveAudit({
    expectedStudioId: studio.id, clientId, change: "archive", archivedAt: nowIso,
  });
  if (auditErr) {
    safeLog.error(
      JSON.stringify({
        event: "client_archive_audit_failed",
        clientId,
        code: dbErrorCode(auditErr, ["audit_write_unavailable"]),
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
    throw new Error(`Failed to unarchive client: ${dbErrorCode(error)}`);
  }

  const { error: auditErr } = await recordClientArchiveAudit({
    expectedStudioId: studio.id, clientId, change: "unarchive",
  });
  if (auditErr) {
    safeLog.error(
      JSON.stringify({
        event: "client_unarchive_audit_failed",
        clientId,
        code: dbErrorCode(auditErr, ["audit_write_unavailable"]),
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

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // HON-44 (Sam decision 12): client prices are owner-only. The role comes from
  // the authenticated practitioner. APP half; client_pricing RLS admits any
  // member until 0254.
  if (practitioner.role !== "owner") throw new Error("Only the studio owner can change prices.");
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase.from("client_pricing").insert({
    studio_id: studio.id,
    client_id: clientId,
    service_name: serviceName,
    price_cents: priceCents,
    notes: nullableString(formData.get("notes")),
  });

  if (error) throw new Error(`Failed to add pricing: ${dbErrorCode(error)}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function deleteClientPricingAction(formData: FormData): Promise<void> {
  const id = formData.get("id");
  const clientId = formData.get("client_id");
  if (typeof id !== "string" || !id) throw new Error("Missing pricing id.");
  if (typeof clientId !== "string" || !clientId)
    throw new Error("Missing client id.");

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // HON-44 (Sam decision 12): client prices are owner-only. The role comes from
  // the authenticated practitioner. APP half; client_pricing RLS admits any
  // member until 0254.
  if (practitioner.role !== "owner") throw new Error("Only the studio owner can change prices.");
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_pricing")
    .delete()
    .eq("id", id)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId);
  if (error) throw new Error(`Failed to delete pricing: ${dbErrorCode(error)}`);
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
  if (error) throw new Error(`Failed to add tag: ${dbErrorCode(error)}`);
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
  if (error) throw new Error(`Failed to remove tag: ${dbErrorCode(error)}`);
  revalidatePath(`/clients/${clientId}`);
}
