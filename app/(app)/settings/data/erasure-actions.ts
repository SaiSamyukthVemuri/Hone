"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { advanceErasure, correctErasureReason, requestErasure, withdrawErasure, type ErasureCtx } from "@/lib/erasure/commands";
import type { ErasureRequestRow } from "@/lib/erasure/requests";

// Erasure REQUESTS (R5, DN-18). Prepared, not wired: no page imports these yet and the held database commands (0295) are not applied.
// Recording a request deletes nothing. Each action takes the studio from the session, never from the form, and the database re-checks
// owner and studio, so a forged form field cannot reach another studio. Results are plain copy: no id, reason or name is echoed.

async function ctx(): Promise<ErasureCtx> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  return { practitioner, studio, supabase: await createClient() };
}

export type ErasureQueue =
  | { ok: true; requests: ErasureRequestRow[]; clients: Record<string, { preferred_name: string | null; name: string | null }> }
  | { ok: false; error: string };

/** The owner's queue (newest first). Non-owners get a refusal before any read, and RLS limits the rows to the owner of this studio anyway. */
export async function loadErasureQueue(): Promise<ErasureQueue> {
  const c = await ctx();
  if (!c.practitioner.active || c.practitioner.role !== "owner") return { ok: false, error: "Only the studio owner can manage erasure requests." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_erasure_requests")
    .select("id, client_id, state, reason, requested_at")
    .eq("studio_id", c.studio.id)
    .order("requested_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false, error: "Erasure requests are not available yet." };
  const requests = (data ?? []) as ErasureRequestRow[];
  const ids = [...new Set(requests.map((r) => r.client_id))];
  const clients: Record<string, { preferred_name: string | null; name: string | null }> = {};
  if (ids.length) {
    const { data: rows } = await supabase.from("clients").select("id, preferred_name, name").eq("studio_id", c.studio.id).in("id", ids);
    for (const r of (rows ?? []) as Array<{ id: string; preferred_name: string | null; name: string | null }>) clients[r.id] = { preferred_name: r.preferred_name, name: r.name };
  }
  return { ok: true, requests, clients };
}

export async function requestErasureAction(formData: FormData) {
  const r = await requestErasure(await ctx(), { clientId: formData.get("client_id"), reason: formData.get("reason") });
  if (r.ok) revalidatePath("/settings/data");
  return r;
}

export async function advanceErasureAction(formData: FormData) {
  const r = await advanceErasure(await ctx(), { requestId: formData.get("request_id"), to: formData.get("to") });
  if (r.ok) revalidatePath("/settings/data");
  return r;
}

export async function correctErasureReasonAction(formData: FormData) {
  const r = await correctErasureReason(await ctx(), { requestId: formData.get("request_id"), reason: formData.get("reason") });
  if (r.ok) revalidatePath("/settings/data");
  return r;
}

export async function withdrawErasureAction(formData: FormData) {
  const r = await withdrawErasure(await ctx(), { requestId: formData.get("request_id") });
  if (r.ok) revalidatePath("/settings/data");
  return r;
}
