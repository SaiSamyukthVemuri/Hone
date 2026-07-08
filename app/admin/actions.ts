"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { logAdminAction } from "@/lib/audit/admin-actions";

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
