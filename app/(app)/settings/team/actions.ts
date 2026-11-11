"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { RemovalLeftover } from "@/lib/team/removal-leftovers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { PractitionerRole } from "@/lib/types/database";
import { resend, FROM_ADDRESS } from "@/lib/email/client";
import { buildInvitationEmail } from "@/lib/email/templates/invitation";
import { safeLog } from "@/lib/logging/safe-log";
import { dbErrorCode, failureCode } from "@/lib/logging/error-class";
import { userFacingDbFailure } from "@/lib/logging/user-facing-db-failure";
import { disconnectConnection, getOwnConnectionMetadata } from "@/lib/google-calendar/connection";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES: ReadonlyArray<PractitionerRole> = ["owner", "practitioner"];
const PG_UNIQUE_VIOLATION = "23505";

export type InviteResult =
  | { ok: true; email: string }
  | { ok: false; error: string };

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

type OwnerContext = {
  studioId: string;
  practitionerId: string;
  inviterName: string;
  studioName: string;
};

const OWNER_ONLY_MESSAGE = "Only studio owners can manage the team.";

async function assertOwner(): Promise<OwnerContext> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error(OWNER_ONLY_MESSAGE);
  }
  return {
    studioId: studio.id,
    practitionerId: practitioner.id,
    inviterName:
      practitioner.display_name?.trim() ||
      practitioner.email ||
      "A teammate",
    studioName: studio.name,
  };
}

// Sends the invitation email through Resend. Never throws; logs failures
// and lets the caller continue, since the pending_invitations row plus the
// share-message UI are the source of truth.
async function sendInvitationEmail(params: {
  inviteeEmail: string;
  inviteeDisplayName: string | null;
  studioName: string;
  inviterName: string;
}): Promise<void> {
  if (!resend) {
    console.warn(
      "Skipping invitation email: Resend client is not configured.",
    );
    return;
  }

  const { subject, html, text } = buildInvitationEmail(params);
  try {
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.inviteeEmail,
      subject,
      html,
      text,
    });
    if (error) {
      safeLog.error(invitationEmailFailure("provider_error", error));
    }
  } catch (error) {
    safeLog.error(invitationEmailFailure("transport_threw", error));
  }
}

// MSG-LOG-RAW-ERROR: the provider's error object and a thrown error can carry
// the destination address and provider text, so the log line is a closed
// category, an error name only when it is a bare identifier, and a retryable
// flag (429 and 5xx retry, other 4xx do not, a throw is a transport failure).
const ERROR_NAME_RE = /^[A-Za-z_]{1,64}$/;

function invitationEmailFailure(
  kind: "provider_error" | "transport_threw",
  error: unknown,
): string {
  const rawName =
    error && typeof error === "object" && "name" in error ? error.name : undefined;
  const name =
    typeof rawName === "string" && ERROR_NAME_RE.test(rawName) ? rawName : "unknown";
  const status =
    error && typeof error === "object" && "statusCode" in error
      ? error.statusCode
      : undefined;
  const retryable =
    kind === "transport_threw" ||
    typeof status !== "number" ||
    status === 429 ||
    status >= 500;
  return `team_invitation_email_failed:${kind}:${name}:retryable=${retryable}`;
}

export async function invitePractitionerAction(
  formData: FormData,
): Promise<InviteResult> {
  const rawEmail = nullableString(formData.get("email"));
  if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  const email = rawEmail.toLowerCase();

  const roleRaw = formData.get("role");
  const role =
    typeof roleRaw === "string" && VALID_ROLES.includes(roleRaw as PractitionerRole)
      ? (roleRaw as PractitionerRole)
      : "practitioner";
  const displayName = nullableString(formData.get("display_name"));

  let context: OwnerContext;
  try {
    context = await assertOwner();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.message === OWNER_ONLY_MESSAGE ? OWNER_ONLY_MESSAGE : "Unauthorized.",
    };
  }
  const { studioId, practitionerId, inviterName, studioName } = context;

  const supabase = await createClient();

  // Already an active practitioner in this studio?
  const { data: existingPractitioner, error: existingErr } = await supabase
    .from("practitioners")
    .select("id")
    .eq("studio_id", studioId)
    .ilike("email", email)
    .eq("active", true)
    .maybeSingle();
  if (existingErr) {
    return { ok: false, error: "Could not check existing practitioners." };
  }
  if (existingPractitioner) {
    return {
      ok: false,
      error: `${email} is already a practitioner at this studio.`,
    };
  }

  // Already invited at this studio (still pending)?
  const { data: existingInvite, error: inviteErr } = await supabase
    .from("pending_invitations")
    .select("id")
    .eq("studio_id", studioId)
    .ilike("email", email)
    .eq("status", "pending")
    .maybeSingle();
  if (inviteErr) {
    return { ok: false, error: "Could not check existing invitations." };
  }
  if (existingInvite) {
    return {
      ok: false,
      error: `${email} already has a pending invite at this studio.`,
    };
  }

  const { error } = await supabase.from("pending_invitations").insert({
    studio_id: studioId,
    email,
    invited_by: practitionerId,
    role,
    display_name: displayName,
    status: "pending",
  });

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      return {
        ok: false,
        error: `${email} already has a pending invite at another studio. Ask them to accept or revoke that one first.`,
      };
    }
    return { ok: false, error: userFacingDbFailure("send the invite", error, "team_invite_insert_failed") };
  }

  // Fire-and-forget the email. Any failure stays inside sendInvitationEmail
  // and is logged; the invite row + share-message UI cover the user path.
  await sendInvitationEmail({
    inviteeEmail: email,
    inviteeDisplayName: displayName,
    studioName,
    inviterName,
  });

  revalidatePath("/settings/team");
  return { ok: true, email };
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    throw new Error("Missing invitation id.");
  }

  const { studioId } = await assertOwner();
  const supabase = await createClient();
  const { error } = await supabase
    .from("pending_invitations")
    .update({ status: "revoked" })
    .eq("id", id)
    .eq("studio_id", studioId)
    .eq("status", "pending");
  if (error) {
    throw new Error(`Failed to revoke invitation: ${dbErrorCode(error)}`);
  }
  revalidatePath("/settings/team");
}

export async function removePractitionerAction(formData: FormData): Promise<void> {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    throw new Error("Missing practitioner id.");
  }

  const { studioId, practitionerId } = await assertOwner();
  if (id === practitionerId) {
    throw new Error("You cannot remove yourself.");
  }

  // Part 4 Item 2: deactivation goes through the locked command (studios row →
  // capacity advisory lock), which validates the target (same-studio, not the
  // owner) and sets active=false atomically, no raw active=false browser write,
  // no leaked DB text. This is per-practitioner deactivation, NOT studio
  // structural retirement; the target's appointments are preserved.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("set_practitioner_active_locked", {
    p_studio_id: studioId,
    p_actor_practitioner_id: practitionerId,
    p_target_practitioner_id: id,
    p_active: false,
  });
  if (error || data !== "ok") {
    console.error(
      `team_action_db_error:remove_practitioner:${error ? dbErrorCode(error) : failureCode(null, data)}`,
    );
    if (data === "cannot_modify_owner")
      throw new Error("The studio owner cannot be removed.");
    if (data === "invalid_practitioner")
      throw new Error("Practitioner not found in this studio.");
    throw new Error("Could not remove the practitioner. Please try again.");
  }

  // WHAT REMOVAL LEAVES BEHIND (RBAC G9; Sam's rule: removal ends outstanding invitations). Access is already cut, because every
  // request re-reads `active`; these two stop a removed person's old grants from outliving them.
  const leftovers = await endRemovedMemberLeftovers(admin, studioId, id);
  revalidatePath("/settings/team");
  if (leftovers.length > 0) {
    // NOT a throw: the removal HAPPENED, and a thrown error is redacted to "Something went wrong" in production. A fixed redirect code lets the
    // page say "removed; <X> could not be cleared" (lib/team/removal-leftovers.ts owns the wording).
    redirect(`/settings/team?removed=partial&left=${leftovers.join(",")}`);
  }
}

// The removed member's PENDING invitations to this studio (a pending invitation is honoured later and can REACTIVATE the person:
// link_invited_membership) and their Google Calendar connection (the studio's calendar-owner connection keeps syncing appointments
// to their Google account otherwise: the sync reads the connection, never `practitioners.active`). Both are scoped to this studio
// and to the target the locked command just deactivated. Returns what could not be cleared, plus the google_access NOTICE (Hone's stored credential was deleted; any grant at Google is the person's to remove); clears the rest regardless.
// A studio's pending invitations are read in pages below the API row cap; past the page ceiling the scan fails closed and is REPORTED, never ignored.
const PENDING_INVITATION_PAGE_SIZE = 500;
const PENDING_INVITATION_MAX_PAGES = 40;

async function endRemovedMemberLeftovers(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
  practitionerId: string,
): Promise<RemovalLeftover[]> {
  const failed: RemovalLeftover[] = [];

  try {
    const { data: target, error: readErr } = await admin
      .from("practitioners")
      .select("email")
      .eq("id", practitionerId)
      .eq("studio_id", studioId)
      .maybeSingle();
    if (readErr) throw readErr;
    const email = typeof target?.email === "string" ? target.email.trim().toLowerCase() : "";
    if (email) {
      // Match the email CASE-INSENSITIVELY, as sign-in and the invitation lookup do (lower(email) uniqueness, ilike): an invitation stored as
      // "Name@X.com" must still end when the member row says "name@x.com". An ilike filter would treat "_" and "%" in an address as wildcards and could
      // revoke a different person's invitation, so this reads the studio's pending invitations PAGE BY PAGE (a single read stops at the API row cap and
      // could miss the match) and compares in code, then revokes by id.
      const ids: string[] = [];
      for (let page = 0; ; page++) {
        if (page >= PENDING_INVITATION_MAX_PAGES) throw new Error("pending_invitations_scan_exceeded");
        const { data: rows, error: pendingErr } = await admin
          .from("pending_invitations")
          .select("id,email")
          .eq("studio_id", studioId)
          .eq("status", "pending")
          .order("id", { ascending: true })
          .range(page * PENDING_INVITATION_PAGE_SIZE, (page + 1) * PENDING_INVITATION_PAGE_SIZE - 1);
        if (pendingErr) throw pendingErr;
        const batch = (rows ?? []) as Array<{ id: string; email: string | null }>;
        for (const r of batch) if (typeof r.email === "string" && r.email.trim().toLowerCase() === email) ids.push(r.id);
        if (batch.length < PENDING_INVITATION_PAGE_SIZE) break;
      }
      if (ids.length > 0) {
        const { error: revokeErr } = await admin
          .from("pending_invitations")
          .update({ status: "revoked" })
          .in("id", ids)
          .eq("studio_id", studioId)
          .eq("status", "pending");
        if (revokeErr) throw revokeErr;
      }
    }
  } catch (e) {
    console.error(`team_action_db_error:remove_revoke_invitations:${dbErrorCode(e)}`);
    failed.push("invitations");
  }

  try {
    // MEMBERSHIP-SCOPED CLEANUP ONLY (Sam, Vercel finding 01M6SPYTZ01MAGB74CGWVV953E). Removal deletes THIS studio's stored credential and
    // marks THIS studio's connection disconnected; it never calls Google. A Google revoke acts on the person's grant to Hone, so it
    // could end the same person's sync in a DIFFERENT studio, which this studio's owner has no right to do. The grant at Google, if any,
    // is the person's to remove: google_access tells the owner so. It is reported whenever a connection row existed: a grant may remain at Google even when no local secret was stored.
    // Connection METADATA only, to fail early if the store cannot be read; the encrypted token is never read on this path.
    await getOwnConnectionMetadata(studioId, practitionerId);
    if (await disconnectConnection(studioId, practitionerId)) failed.push("google_access");
  } catch {
    console.error("team_action_error:remove_disconnect_google");
    failed.push("google_connection");
  }
  return failed;
}
