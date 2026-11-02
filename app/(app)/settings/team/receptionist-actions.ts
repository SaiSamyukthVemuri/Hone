"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isDeskEnabled } from "@/lib/desk/flag";
import { dbErrorCode } from "@/lib/logging/error-class";
import { userFacingDbFailure } from "@/lib/logging/user-facing-db-failure";

// The owner's receptionist role assignment (Sam, 1 Nov: "Role assignment determines access ... No accounts
// should be created or roles assigned automatically"). Two owner-only commands:
//   1. invite: a pending_invitations row with role 'receptionist' (0218 widened the role check and made
//      link_invited_membership turn an accepted invitation into a studio_receptionists row, never a
//      practitioners row). No account is created here and no email is sent: the owner shares the sign-in
//      instruction, exactly as for a practitioner, and the membership appears only when the invitee accepts.
//   2. remove access: set_studio_receptionist_active(false) (0216), the locked command, through the service
//      client because 0216 revokes it from authenticated. The membership row stays (deactivated_at is set).
// INVITE is refused unless the desk flag is ON (a studio cannot be handed the role through the app while the
// feature is dark). REMOVE is never flag-gated: turning the flag off must not take away the owner's only app path
// to revoke access (the flag hides the desk; only this command revokes). Both require an ACTIVE OWNER (read from
// the session, never from the form), and the studio is always the session's studio: a studio id in the form is
// ignored.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PG_UNIQUE_VIOLATION = "23505";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReceptionistInviteResult = { ok: true; email: string } | { ok: false; error: string };
export type ReceptionistRemoveResult = { ok: true } | { ok: false; error: string };

const UNAVAILABLE = "This is not available.";
const OWNER_ONLY = "Only studio owners can manage the team.";

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}

async function ownerContext(): Promise<{ studioId: string; practitionerId: string } | { error: string }> {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner" || practitioner.active === false) return { error: OWNER_ONLY };
    return { studioId: studio.id, practitionerId: practitioner.id };
  } catch {
    return { error: "Unauthorized." };
  }
}

export async function inviteReceptionistAction(formData: FormData): Promise<ReceptionistInviteResult> {
  if (!isDeskEnabled()) return { ok: false, error: UNAVAILABLE };
  const ctx = await ownerContext();
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const rawEmail = nullableString(formData.get("email"));
  if (!rawEmail || !EMAIL_RE.test(rawEmail)) return { ok: false, error: "Enter a valid email address." };
  const email = rawEmail.toLowerCase();
  const displayName = nullableString(formData.get("display_name"));
  const { studioId, practitionerId } = ctx;
  const supabase = await createClient();

  const { data: practitioner, error: pErr } = await supabase
    .from("practitioners")
    .select("id")
    .eq("studio_id", studioId)
    .ilike("email", email)
    .eq("active", true)
    .maybeSingle();
  if (pErr) return { ok: false, error: "Could not check the team." };
  if (practitioner) return { ok: false, error: `${email} is already on the team as a practitioner.` };

  // The table is not in the generated types; the owner-only select policy (0216) scopes the read to this studio.
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: unknown) => {
          ilike: (c: string, v: string) => {
            eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
          };
        };
      };
    };
  };
  const { data: receptionist, error: rErr } = await loose
    .from("studio_receptionists")
    .select("id")
    .eq("studio_id", studioId)
    .ilike("email", email)
    .eq("active", true)
    .maybeSingle();
  if (rErr) return { ok: false, error: "Could not check the team." };
  if (receptionist) return { ok: false, error: `${email} already has receptionist access.` };

  const { data: pending, error: iErr } = await supabase
    .from("pending_invitations")
    .select("id")
    .eq("studio_id", studioId)
    .ilike("email", email)
    .eq("status", "pending")
    .maybeSingle();
  if (iErr) return { ok: false, error: "Could not check existing invitations." };
  if (pending) return { ok: false, error: `${email} already has a pending invite at this studio.` };

  const { error } = await supabase.from("pending_invitations").insert({
    studio_id: studioId,
    email,
    invited_by: practitionerId,
    role: "receptionist" as never,
    display_name: displayName,
    status: "pending",
  });
  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      return { ok: false, error: `${email} already has a pending invite at another studio. Ask them to accept or revoke that one first.` };
    }
    return { ok: false, error: userFacingDbFailure("send the invite", error, "team_receptionist_invite_failed") };
  }
  revalidatePath("/settings/team");
  return { ok: true, email };
}

export async function removeReceptionistAccessAction(formData: FormData): Promise<ReceptionistRemoveResult> {
  const ctx = await ownerContext();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const id = formData.get("id");
  if (typeof id !== "string" || !UUID_RE.test(id)) return { ok: false, error: "Receptionist not found." };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("set_studio_receptionist_active" as never, {
    p_studio_id: ctx.studioId,
    p_owner_practitioner_id: ctx.practitionerId,
    p_receptionist_id: id,
    p_active: false,
  } as never);
  if (error) {
    console.error(`team_action_db_error:remove_receptionist:${dbErrorCode(error)}`);
    return { ok: false, error: "Could not remove access. Please try again." };
  }
  if (data === "updated" || data === "no_change") {
    revalidatePath("/settings/team");
    return { ok: true };
  }
  if (data === "not_found") return { ok: false, error: "Receptionist not found." };
  console.error(`team_action_db_error:remove_receptionist:result_${typeof data === "string" ? data : "unknown"}`);
  return { ok: false, error: "Could not remove access. Please try again." };
}
