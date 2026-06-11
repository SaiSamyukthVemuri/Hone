"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";

// PR #193. Resolve an ops alert from the admin dashboard. Admin-only
// (same ADMIN_EMAILS allowlist as every /admin action; the layout
// guard is defense-in-depth, this re-check is the real gate).
// Conditional UPDATE on resolved_at IS NULL so two admins resolving
// concurrently cannot clobber each other's resolution record.
// resolved_by_practitioner_id is the admin's practitioner row when
// one exists (an admin without a practitioner row resolves with a
// null resolver id, which the 0067 consistency CHECK allows).

export async function resolveOpsAlertAction(
  formData: FormData,
): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    throw new Error("Unauthorized.");
  }

  const alertId = formData.get("alert_id");
  if (typeof alertId !== "string" || !alertId) {
    throw new Error("Missing alert id.");
  }
  const rawNote = formData.get("resolution_note");
  const note =
    typeof rawNote === "string" && rawNote.trim().length > 0
      ? rawNote.trim().slice(0, 2000)
      : null;

  const admin = createAdminClient();

  const { data: practitionerRow } = await admin
    .from("practitioners")
    .select("id")
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  const { error } = await admin
    .from("ops_alerts")
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by_practitioner_id: practitionerRow?.id ?? null,
      resolution_note: note,
    })
    .eq("id", alertId)
    .is("resolved_at", null);
  if (error) {
    throw new Error(`Failed to resolve the alert: ${error.message}`);
  }

  revalidatePath("/admin/ops-alerts");
}
