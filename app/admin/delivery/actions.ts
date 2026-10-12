"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { logAdminAction } from "@/lib/audit/admin-actions";

// DELIVERY-VISIBILITY-02. Platform support closes a delivery incident
// (migration 0215, resolve_delivery_incident). Admin-only: the same
// ADMIN_EMAILS allowlist as every /admin action, re-checked here (the layout
// guard is defense in depth). Every attempt is audited, blocked ones included.
// The command closes an incident only while it is open, so two admins cannot
// clobber each other's resolution, and the next failure of the same kind opens
// a new incident rather than reviving this one.

const RESOLUTIONS = new Set(["fixed", "acknowledged", "not_actionable"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveDeliveryIncidentAction(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    await logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "delivery_incident_resolved",
      targetType: "delivery_incident",
      outcome: "blocked",
    });
    throw new Error("Unauthorized.");
  }

  const incidentId = formData.get("incident_id");
  const resolution = formData.get("resolution");
  if (typeof incidentId !== "string" || !UUID_RE.test(incidentId)) {
    throw new Error("Missing incident id.");
  }
  if (typeof resolution !== "string" || !RESOLUTIONS.has(resolution)) {
    throw new Error("Unknown resolution.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("resolve_delivery_incident", {
    p_incident_id: incidentId,
    p_resolution: resolution,
  });
  const result = typeof data === "string" ? data : null;
  const succeeded = !error && (result === "resolved" || result === "already_resolved");

  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    targetType: "delivery_incident",
    targetId: incidentId,
    action: "delivery_incident_resolved",
    outcome: succeeded ? "succeeded" : "failed",
    metadata: { resolution, result: result ?? "error" },
  });
  if (!succeeded) {
    throw new Error("Failed to resolve the incident.");
  }

  revalidatePath("/admin/delivery");
}
