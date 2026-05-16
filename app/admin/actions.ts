"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";

async function assertAdmin(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    throw new Error("Not authorized.");
  }
}

export async function markDemoContactedAction(formData: FormData): Promise<void> {
  await assertAdmin();

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
    throw new Error(`Failed to update demo request: ${error.message}`);
  }
  revalidatePath("/admin");
}
