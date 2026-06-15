"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { parseNewStudioInput } from "@/lib/studios/new-studio";

const BASE = "/admin/studios/new";

// redirect() throws NEXT_REDIRECT; this action is NOT wrapped in try/catch, so
// the throw propagates correctly. Typed `never` so control-flow narrowing
// treats everything after a fail() as unreachable.
function fail(message: string): never {
  redirect(`${BASE}?error=${encodeURIComponent(message)}`);
}

// PR #254: internal New Studio Wizard. Operator-only. Automates the EXACT two
// service-role writes the operator performs by hand in docs/20 §2.1/§2.2:
//   1. insert studios(name, owner_email, slug, timezone)
//   2. insert pending_invitations(studio_id, email, role 'owner', display_name)
// The owner practitioner row is NEVER inserted here — it is created by the
// existing handle_new_user() trigger (migration 0081) on the owner's first
// invited sign-in, which stamps terms/privacy acceptance. No Stripe, no fee
// columns, no email automation, no services/availability seeding.
export async function createStudioWithOwnerInvite(
  formData: FormData,
): Promise<void> {
  // Operator gate. Defense-in-depth over app/admin/layout.tsx's isAdmin check;
  // this re-check is the real gate (matches app/admin/actions.ts assertAdmin).
  // isAdmin is fail-closed in production (empty ADMIN_EMAILS -> deny everyone).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    throw new Error("Not authorized.");
  }

  const parsed = parseNewStudioInput({
    name: formData.get("name"),
    slug: formData.get("slug"),
    ownerDisplayName: formData.get("owner_display_name"),
    ownerEmail: formData.get("owner_email"),
    timezone: formData.get("timezone"),
    bookingDescription: formData.get("booking_description"),
    address: formData.get("address"),
  });
  if (!parsed.ok) fail(parsed.error);
  const input = parsed.value;

  // Service-role: studios has NO INSERT policy and pending_invitations INSERT
  // is owner-only, so RLS blocks the operator (who is not yet an owner of this
  // studio) on both tables. Reached ONLY after the isAdmin gate above. This is
  // the same path the manual runbook uses ("Creation happens via service
  // role").
  const admin = createAdminClient();

  // Friendly pre-checks (the DB also enforces both: studios_slug_unique, and
  // the partial unique index on lower(email) where status='pending').
  const { data: slugTaken, error: slugErr } = await admin
    .from("studios")
    .select("id")
    .eq("slug", input.slug)
    .maybeSingle();
  if (slugErr) fail(`Could not verify slug: ${slugErr.message}`);
  if (slugTaken) fail(`Booking slug "${input.slug}" is already taken.`);

  // Case-insensitive exact match (the DB unique index is on lower(email), and
  // existing invites may be stored mixed-case). Escape ILIKE wildcards (% and
  // _) so an email whose local part contains them — e.g. first_last@x.com —
  // cannot over-match unrelated invitations.
  const ownerEmailPattern = input.ownerEmail.replace(/[\\%_]/g, "\\$&");
  const { data: dupInvite, error: dupErr } = await admin
    .from("pending_invitations")
    .select("id")
    .ilike("email", ownerEmailPattern)
    .eq("status", "pending")
    .maybeSingle();
  if (dupErr) fail(`Could not verify invitations: ${dupErr.message}`);
  if (dupInvite) {
    fail(
      `There is already a pending invitation for ${input.ownerEmail}. Resolve it before creating another studio for this owner.`,
    );
  }

  // 1. Create the studio. Only name + owner_email + slug + timezone are set;
  //    every other column keeps its safe default (fees NULL, no Stripe
  //    coupling, confirmation/reminder emails on, horizon 3mo). No fee or
  //    legal_entity_name columns are touched.
  const { data: studio, error: studioErr } = await admin
    .from("studios")
    .insert({
      name: input.name,
      owner_email: input.ownerEmail,
      slug: input.slug,
      timezone: input.timezone,
      ...(input.bookingDescription
        ? { booking_description: input.bookingDescription }
        : {}),
      ...(input.address ? { address: input.address } : {}),
    })
    .select("id")
    .single();
  if (studioErr || !studio) {
    fail(`Failed to create studio: ${studioErr?.message ?? "unknown error"}`);
  }

  // 2. Create the owner invitation. On failure, compensating-delete the
  //    just-created studio (it has no owner, no practitioner, and no client
  //    data yet) so a failed run never leaves an orphan studio behind.
  const { error: inviteErr } = await admin.from("pending_invitations").insert({
    studio_id: studio.id,
    email: input.ownerEmail,
    role: "owner",
    display_name: input.ownerDisplayName,
  });
  if (inviteErr) {
    const { error: cleanupErr } = await admin
      .from("studios")
      .delete()
      .eq("id", studio.id);
    if (cleanupErr) {
      // Rare: the invite insert failed AND the rollback delete failed. Log the
      // orphaned studio id (no owner/practitioner/clients; it consumes its
      // unique slug) so it is discoverable for manual cleanup rather than
      // silently stranded. No client data or secrets in the log line.
      console.error(
        JSON.stringify({
          event: "new_studio_orphan_cleanup_failed",
          studio_id: studio.id,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    fail(`Failed to create owner invitation: ${inviteErr.message}`);
  }

  redirect(`${BASE}?created=${studio.id}`);
}
