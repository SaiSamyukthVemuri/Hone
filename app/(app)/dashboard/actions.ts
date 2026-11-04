"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Needs attention: dismiss and restore a REMINDER (migration 0298, held).
// ---------------------------------------------------------------------------
// Owner-only, enforced here AND by the database command (which also scopes to the caller's own user id). Hiding a button is cosmetic;
// this is the check. Neither action reads or writes a balance, a payment, a setup status, a message or any access: the database
// command stores an opaque key and token and nothing else.

export type AttentionActionResult = { ok: true } | { ok: false; code: "refused" | "invalid_item" | "unavailable" };

const SHAPE = /^[A-Za-z0-9:_.-]{1,200}$/;

async function ownerStudioId(): Promise<string | null> {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  return practitioner.role === "owner" ? studio.id : null;
}

function asResult(data: unknown, error: unknown): AttentionActionResult {
  if (error || typeof data !== "object" || data === null) return { ok: false, code: "unavailable" };
  const d = data as { ok?: unknown; code?: unknown };
  if (d.ok === true) return { ok: true };
  return { ok: false, code: d.code === "refused" ? "refused" : d.code === "invalid_item" ? "invalid_item" : "unavailable" };
}

export async function dismissAttentionAction(itemKey: unknown, instanceToken: unknown): Promise<AttentionActionResult> {
  const studioId = await ownerStudioId();
  if (!studioId) return { ok: false, code: "refused" };
  if (typeof itemKey !== "string" || typeof instanceToken !== "string" || !SHAPE.test(itemKey) || !SHAPE.test(instanceToken)) {
    return { ok: false, code: "invalid_item" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dismiss_attention_item", { p_studio: studioId, p_item_key: itemKey, p_instance_token: instanceToken });
  const result = asResult(data, error);
  if (result.ok) revalidatePath("/dashboard");
  return result;
}

export async function restoreAttentionAction(itemKey: unknown): Promise<AttentionActionResult> {
  const studioId = await ownerStudioId();
  if (!studioId) return { ok: false, code: "refused" };
  if (typeof itemKey !== "string" || !SHAPE.test(itemKey)) return { ok: false, code: "invalid_item" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("restore_attention_item", { p_studio: studioId, p_item_key: itemKey });
  const result = asResult(data, error);
  if (result.ok) revalidatePath("/dashboard");
  return result;
}
