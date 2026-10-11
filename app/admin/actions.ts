"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { logAdminAction } from "@/lib/audit/admin-actions";
import { deliverPlatformLeadAlert } from "@/lib/platform-leads/alert-delivery";

export async function markDemoContactedAction(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    await logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "demo_request_contacted",
      targetType: "demo_request",
      outcome: "blocked",
    });
    throw new Error("Not authorized.");
  }

  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    throw new Error("Missing demo request id.");
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("demo_requests")
    .update({ status: "contacted" })
    .eq("id", id);
  if (error) {
    await logAdminAction({
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      targetType: "demo_request",
      targetId: id,
      action: "demo_request_contacted",
      outcome: "failed",
    });
    throw new Error(`Failed to update demo request: ${error.message}`);
  }
  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    targetType: "demo_request",
    targetId: id,
    action: "demo_request_contacted",
    outcome: "succeeded",
  });
  revalidatePath("/admin");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// LEAD-ALERT-01 (#826): the operator's explicit retry of a FAILED new-lead
// alert. The database requeues it (only a failed alert, with a fresh attempt
// budget, window and idempotency key) and it is sent after this response.
// The lead itself is never touched.
export async function retryLeadAlertAction(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    await logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "platform_lead_alert_retried",
      targetType: "platform_lead_alert",
      outcome: "blocked",
    });
    throw new Error("Not authorized.");
  }

  const id = formData.get("id");
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new Error("Missing lead alert id.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("requeue_platform_lead_alert", {
    p_alert_id: id,
  });
  const requeued = !error && data === "requeued";
  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    targetType: "platform_lead_alert",
    targetId: id,
    action: "platform_lead_alert_retried",
    outcome: requeued ? "succeeded" : "failed",
  });
  if (error) {
    throw new Error("Failed to retry the lead alert.");
  }
  // 'not_failed' means another retry already took it; nothing more to do.
  if (requeued) {
    after(() => deliverPlatformLeadAlert(id));
  }
  revalidatePath("/admin");
}
