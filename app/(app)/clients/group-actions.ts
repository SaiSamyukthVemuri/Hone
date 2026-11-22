"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { groupName, UUID } from "@/lib/client-groups/model";

export type GroupActionResult = { ok: true; message: string } | { ok: false; error: string };
const uncertain = { ok: false as const, error: "We couldn't confirm that change. Reload to check the current groups before trying again." };
const messages: Record<string, string> = {
  denied: "Only a studio owner can change client groups.",
  invalid: "Use a group name of 1–60 characters without control characters.",
  limit: "This studio already has 100 groups. Rename an existing group to organise it differently.",
  missing: "That client or group isn't available in this studio. Reload and try again.",
  stale: "Someone renamed this group since you opened it. Reload to see the current name before editing.",
  duplicate: "A group with that name already exists. Choose a different name.",
};

/** Session is resolved before inputs; the RPC independently verifies ownership and both tenant links. */
export async function changeClientGroup(input: {
  kind: "create" | "rename" | "membership";
  name?: string;
  groupId?: string;
  clientId?: string;
  assigned?: boolean;
  expectedName?: string;
  expectedUpdatedAt?: string;
}): Promise<GroupActionResult> {
  try {
  const identity = await getCurrentPractitionerWithStudio();
  if (identity.practitioner.role !== "owner") return { ok: false, error: messages.denied };
  if (!input || !["create", "rename", "membership"].includes(input.kind)) return { ok: false, error: "That group change isn't available." };
  const name = groupName(input.name);
  if (input.kind !== "membership" && !name) return { ok: false, error: messages.invalid };
  if (input.kind !== "create" && (!input.groupId || !UUID.test(input.groupId))) return { ok: false, error: messages.missing };
  if (input.kind === "membership" && (!input.clientId || !UUID.test(input.clientId) || typeof input.assigned !== "boolean")) return { ok: false, error: messages.missing };
  if (input.kind === "rename" && (!groupName(input.expectedName) || !input.expectedUpdatedAt || !Number.isFinite(Date.parse(input.expectedUpdatedAt)))) return { ok: false, error: messages.stale };
    const db = await createClient();
    const common = { p_studio_id: identity.studio.id };
    const { data, error } = input.kind === "create"
      ? await db.rpc("create_client_group", { ...common, p_name: name })
      : input.kind === "rename"
        ? await db.rpc("rename_client_group", { ...common, p_group_id: input.groupId, p_name: name, p_expected_name: input.expectedName, p_expected_updated_at: input.expectedUpdatedAt })
        : await db.rpc("set_client_group_membership", { ...common, p_client_id: input.clientId, p_group_id: input.groupId, p_assigned: input.assigned });
    if (error || !data || typeof data.status !== "string") return uncertain;
    const success = input.kind === "create" ? ["created", "exists"] : input.kind === "rename" ? ["renamed"] : ["saved"];
    if (!success.includes(data.status)) return { ok: false, error: messages[data.status] ?? uncertain.error };
    revalidatePath("/clients");
    revalidatePath("/clients/groups");
    if (input.kind === "membership") revalidatePath(`/clients/${input.clientId}`);
    else revalidatePath("/clients/[id]", "page");
    return { ok: true, message: data.status === "exists" ? "That group already exists." : input.kind === "create" ? "Group created." : input.kind === "rename" ? "Group renamed." : input.assigned ? "Group added." : "Group removed." };
  } catch { return uncertain; }
}
