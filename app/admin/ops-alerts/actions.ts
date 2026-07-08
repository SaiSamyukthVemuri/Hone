"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { logAdminAction } from "@/lib/audit/admin-actions";

// PR #193. Resolve an ops alert from the admin dashboard. Admin-only
// (same ADMIN_EMAILS allowlist as every /admin action; the layout
// guard is defense-in-depth, this re-check is the real gate).
// Conditional UPDATE on resolved_at IS NULL so two admins resolving
// concurrently cannot clobber each other's resolution record.
// resolved_by_practitioner_id is the admin's practitioner row when
// one exists (an admin without a practitioner row resolves with a
// null resolver id, which the 0067 consistency CHECK allows).

// PR #195. Deterministic app-path smoke for the alert pipeline:
// exercises the REAL recordOpsAlert path (durable ops_alerts row +
// critical email to OPS_ALERT_EMAILS) on demand. Admin-only; no
// Stripe/payment/client surface; reusable for any future
// alert-channel verification (new operator email, Slack, etc.).
export async function sendTestCriticalAlertAction(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    throw new Error("Unauthorized.");
  }

  await recordOpsAlert({
    severity: "critical",
    event: "smoke_test_critical_alert_app_path",
    message: "PR #195 app-path smoke test critical alert",
    safeDetails: {
      smoke: true,
      pr: 195,
      path: "app",
    },
  });

  revalidatePath("/admin/ops-alerts");
}

export async function resolveOpsAlertAction(
  formData: FormData,
): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    await logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "ops_alert_resolved",
      targetType: "ops_alert",
      outcome: "blocked",
    });
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
    await logAdminAction({
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetType: "ops_alert",
      targetId: alertId,
      action: "ops_alert_resolved",
      outcome: "failed",
      metadata: { has_resolution_note: note != null },
    });
    throw new Error(`Failed to resolve the alert: ${error.message}`);
  }

  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    targetType: "ops_alert",
    targetId: alertId,
    action: "ops_alert_resolved",
    outcome: "succeeded",
    // Log WHETHER a note was added, never the note text (free-text operator input).
    metadata: { has_resolution_note: note != null },
  });

  revalidatePath("/admin/ops-alerts");
}
