"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { PractitionerRole } from "@/lib/types/database";
import { resend, FROM_ADDRESS } from "@/lib/email/client";
import { buildInvitationEmail } from "@/lib/email/templates/invitation";

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

async function assertOwner(): Promise<OwnerContext> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can manage the team.");
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
      console.error("Failed to send invitation email:", error);
    }
  } catch (error) {
    console.error("Failed to send invitation email:", error);
  }
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
      error: err instanceof Error ? err.message : "Unauthorized.",
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
    return { ok: false, error: `Failed to send invite: ${error.message}` };
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
    throw new Error(`Failed to revoke invitation: ${error.message}`);
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

  const supabase = await createClient();

  // Confirm the target is in this studio and is not the owner.
  const { data: target, error: lookupErr } = await supabase
    .from("practitioners")
    .select("id, role, studio_id, active")
    .eq("id", id)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`Failed to look up practitioner: ${lookupErr.message}`);
  }
  if (!target) {
    throw new Error("Practitioner not found in this studio.");
  }
  if (target.role === "owner") {
    throw new Error("The studio owner cannot be removed.");
  }

  const { error } = await supabase
    .from("practitioners")
    .update({ active: false })
    .eq("id", id)
    .eq("studio_id", studioId);
  if (error) {
    throw new Error(`Failed to remove practitioner: ${error.message}`);
  }
  revalidatePath("/settings/team");
}
