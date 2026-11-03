"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  limitWaitlistSubmit,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit/public";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type WaitlistResult = { ok: true } | { ok: false; error: string };

export async function submitWaitlistEntry(
  email: string,
): Promise<WaitlistResult> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return { ok: false, error: "That doesn't look like a valid email." };
  }

  // Anonymous public form: rate-limit BEFORE the insert (PR #187).
  // 5/hour per IP + 2/day per normalized email; identifiers are hashed
  // inside the limiter and the refusal copy is the shared generic
  // message, so a 429 never reveals whether an email is on the list.
  const rate = await limitWaitlistSubmit({
    headers: await headers(),
    email: normalized,
  });
  if (!rate.allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  // Service-role COMMAND behind the limiter above (DN-29 / Q-F, Privacy Q1). The anonymous insert policy is retired by 0294, so a
  // visitor can no longer write the table with the public key and walk around the limit; the only write path is the 0213 definer
  // command, which also raises the platform lead alert intent in the same transaction. A duplicate address is the database's
  // answer (on conflict do nothing) and is success: the email is on the list either way.
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("record_platform_early_access_signup", { p_email: normalized });
  const result = (Array.isArray(data) ? data[0] : data) as { result?: string } | null | undefined;

  if (error || !result || (result.result !== "recorded" && result.result !== "duplicate")) {
    return { ok: false, error: "Something went wrong. Try again in a moment." };
  }

  return { ok: true };
}
