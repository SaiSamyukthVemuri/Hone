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
// Every attempt is audited: blocked, invalid input, failed and succeeded.
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
  const idOk = typeof incidentId === "string" && UUID_RE.test(incidentId);
  const resolutionOk = typeof resolution === "string" && RESOLUTIONS.has(resolution);
  if (!idOk || !resolutionOk) {
    // Audited like every other attempt (Codex P2 4244834158). Only WHICH
    // field was rejected is logged, never the submitted values.
    await logAdminAction({
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetType: "delivery_incident",
      targetId: idOk ? (incidentId as string) : null,
      action: "delivery_incident_resolved",
      outcome: "failed",
      metadata: { result: "invalid_input", invalid: !idOk ? "incident_id" : "resolution" },
    });
    throw new Error(!idOk ? "Missing incident id." : "Unknown resolution.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("resolve_delivery_incident", {
    p_incident_id: incidentId,
    p_resolution: resolution,
  });
  const result = typeof data === "string" ? data : null;

  // A CONFLICTING SECOND RESOLUTION IS NOT A SUCCESS (Codex P2 4307695064).
  //
  // `resolve_delivery_incident` returns `already_resolved` WITHOUT updating
  // (0215:343), so when a second admin submits a DIFFERENT resolution the row
  // keeps the first one. This was recorded as `succeeded` with
  // `metadata.resolution` set to the SUBMITTED word — an audit trail asserting a
  // resolution that was never committed, which is worse than no record: it is
  // the one place a reviewer would look to find out what the incident was
  // closed as.
  //
  // The command cannot tell us what IS recorded, so the row is read on this
  // path only. A direct service-role read in an admin ACTION follows
  // app/admin/ops-alerts/actions.ts; the no-`.from(` rule is about the admin
  // PAGE, whose reads must all go through the support commands.
  //
  // Same-value `already_resolved` stays idempotent success: the outcome the
  // caller asked for is the outcome on record.
  let recordedResolution: string | null = null;
  let conflicted = false;
  if (!error && result === "already_resolved") {
    const { data: row } = await admin
      .from("delivery_incidents")
      .select("resolution")
      .eq("id", incidentId)
      .maybeSingle();
    recordedResolution = (row?.resolution as string | null) ?? null;
    conflicted = recordedResolution !== null && recordedResolution !== resolution;
  }

  const succeeded =
    !error && (result === "resolved" || (result === "already_resolved" && !conflicted));

  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    targetType: "delivery_incident",
    targetId: incidentId,
    action: "delivery_incident_resolved",
    outcome: succeeded ? "succeeded" : "failed",
    // On a conflict the submitted word is DELIBERATELY ABSENT: it was not
    // applied, and recording it is what made the old audit misleading. What is
    // recorded instead is the stored resolution and the fact that nothing moved.
    metadata: conflicted
      ? {
          result: "already_resolved_conflict",
          applied: false,
          recorded_resolution: recordedResolution,
        }
      : { resolution, result: result ?? "error" },
  });
  if (!succeeded) {
    throw new Error(
      conflicted
        ? `Already resolved as "${recordedResolution}". Your resolution was not applied.`
        : "Failed to resolve the incident.",
    );
  }

  revalidatePath("/admin/delivery");
}

// DELIVERY-VISIBILITY-04. Support closes an owner-reported delivery concern
// (0221, close_delivery_concern). Same gate and audit as resolving an
// incident; only the resolution word and the command's result are logged.
const CONCERN_RESOLUTIONS = new Set(["explained", "resent_by_studio", "provider_issue", "not_actionable"]);

export async function closeDeliveryConcernAction(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    await logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "delivery_concern_closed",
      targetType: "delivery_concern",
      outcome: "blocked",
    });
    throw new Error("Unauthorized.");
  }

  const concernId = formData.get("concern_id");
  const resolution = formData.get("resolution");
  const idOk = typeof concernId === "string" && UUID_RE.test(concernId);
  const resolutionOk = typeof resolution === "string" && CONCERN_RESOLUTIONS.has(resolution);
  if (!idOk || !resolutionOk) {
    // Audited like resolveDeliveryIncidentAction (Codex P2 4244834158): which
    // field was rejected, never the submitted values.
    await logAdminAction({
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetType: "delivery_concern",
      targetId: idOk ? (concernId as string) : null,
      action: "delivery_concern_closed",
      outcome: "failed",
      metadata: { result: "invalid_input", invalid: !idOk ? "concern_id" : "resolution" },
    });
    throw new Error(!idOk ? "Missing concern id." : "Unknown resolution.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("close_delivery_concern", {
    p_concern_id: concernId,
    p_resolution: resolution,
  });
  const result = typeof data === "string" ? data : null;
  let recordedResolution: string | null = null;
  if (!error && result === "already_closed") {
    // 0221 revokes direct service-role SELECT. Reuse the granted support read;
    // its 300-row/30-day window may omit this concern, which stays unverified.
    try {
      const { data: rows, error: readError } = await admin.rpc("support_delivery_concerns", {
        p_include_closed: true,
      });
      const matches = Array.isArray(rows)
        ? rows.filter((row) => row?.concern_id === concernId && row.state === "closed")
        : [];
      if (!readError && matches.length === 1 && typeof matches[0].resolution === "string" &&
          CONCERN_RESOLUTIONS.has(matches[0].resolution)) {
        recordedResolution = matches[0].resolution;
      }
    } catch {
      // Read failure cannot prove that the requested resolution is on record.
    }
  }
  const repeatNotApplied = !error && result === "already_closed" && recordedResolution !== resolution;
  const succeeded = !error && (result === "closed" || (result === "already_closed" && !repeatNotApplied));

  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    targetType: "delivery_concern",
    targetId: concernId,
    action: "delivery_concern_closed",
    outcome: succeeded ? "succeeded" : "failed",
    metadata: repeatNotApplied
      ? { result: "already_closed_not_applied", applied: false, recorded_resolution: recordedResolution }
      : { resolution, result: result ?? "error" },
  });
  if (!succeeded) {
    throw new Error(repeatNotApplied
      ? recordedResolution === null
        ? "Already closed; the recorded resolution could not be verified. Your resolution was not applied."
        : `Already closed as "${recordedResolution}". Your resolution was not applied.`
      : "Failed to close the concern.");
  }

  revalidatePath("/admin/delivery");
}
