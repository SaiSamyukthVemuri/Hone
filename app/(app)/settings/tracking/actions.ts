"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { encryptTrackingProviderToken } from "@/lib/conversion/token-crypto";
import { TRACKING_PROVIDERS, type TrackingProvider } from "@/lib/conversion/types";

// Owner-only, self-serve marketing/analytics provider configuration. Studio
// owners add their own Pixel/Dataset id + CAPI token; the token is encrypted
// (AES-256-GCM) server-side and only the ciphertext + last4 are stored. Raw
// tokens are never persisted, never returned to the client, never logged.
// Ordinary practitioners are rejected here (owner-gate mirrors RLS 0107).

type Result = { ok: true; last4?: string | null } | { ok: false; error: string };

function fdStr(fd: FormData, k: string): string {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
}

function isProvider(v: string): v is TrackingProvider {
  return (TRACKING_PROVIDERS as readonly string[]).includes(v);
}

async function requireOwner() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.active) {
    return { ok: false as const, error: "Only the studio owner can manage tracking." };
  }
  return { ok: true as const, studioId: studio.id };
}

// Upsert a provider's config. If a non-empty token is supplied it is encrypted
// and stored (add or rotate); an empty token leaves the existing token intact.
export async function saveTrackingProviderConfigAction(
  formData: FormData,
): Promise<Result> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  const studioId = gate.studioId;

  const provider = fdStr(formData, "provider");
  if (!isProvider(provider)) return { ok: false, error: "Unknown provider." };
  const browserTagId = fdStr(formData, "browser_tag_id") || null;
  const testEventCode = fdStr(formData, "test_event_code") || null;
  const consentMode = fdStr(formData, "consent_mode") || "explicit";
  const enabled = formData.get("enabled") === "true";
  const rawToken = fdStr(formData, "token"); // optional; never stored raw

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("studio_tracking_providers")
    .select("id, token_status, server_token_added_at")
    .eq("studio_id", studioId)
    .eq("provider", provider)
    .maybeSingle();

  const patch: Record<string, unknown> = {
    studio_id: studioId,
    provider,
    browser_tag_id: browserTagId,
    test_event_code: testEventCode,
    consent_mode: consentMode,
    enabled,
  };
  let last4: string | null = null;

  if (rawToken) {
    const enc = encryptTrackingProviderToken(rawToken);
    if (!enc.ok) {
      // e.g. encryption key not configured: do NOT store anything.
      return { ok: false, error: `Could not secure the token (${enc.reason}).` };
    }
    patch.encrypted_server_token = enc.encrypted;
    patch.server_token_last4 = enc.last4;
    patch.token_status = "active";
    last4 = enc.last4;
    if (existing?.server_token_added_at) {
      patch.server_token_rotated_at = new Date().toISOString();
    } else {
      patch.server_token_added_at = new Date().toISOString();
    }
  }

  const query = existing
    ? admin.from("studio_tracking_providers").update(patch).eq("id", existing.id)
    : admin.from("studio_tracking_providers").insert(patch);
  const { error } = await query;
  if (error) return { ok: false, error: "Could not save provider configuration." };

  revalidatePath("/settings/tracking");
  return { ok: true, last4 };
}

// Remove a stored token (config row stays; token_status → absent → sender skips).
export async function clearTrackingTokenAction(
  formData: FormData,
): Promise<Result> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  const provider = fdStr(formData, "provider");
  if (!isProvider(provider)) return { ok: false, error: "Unknown provider." };

  const admin = createAdminClient();
  const { error } = await admin
    .from("studio_tracking_providers")
    .update({
      encrypted_server_token: null,
      server_token_last4: null,
      token_status: "absent",
      enabled: false, // no token → cannot send; disable to make intent explicit
    })
    .eq("studio_id", gate.studioId)
    .eq("provider", provider);
  if (error) return { ok: false, error: "Could not remove the token." };

  revalidatePath("/settings/tracking");
  return { ok: true };
}
