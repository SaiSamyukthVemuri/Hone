"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  limitWaitlistSubmit,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit/public";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PG_UNIQUE_VIOLATION = "23505";

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

  // Service-role write behind the limiter above (DN-29 / Q-F): the anonymous insert policy is retired by 0294, so a visitor can no
  // longer write the table directly with the public key and walk around the limit.
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("waitlist")
    .insert({ email: normalized, source: "landing" });

  if (error) {
    // Treat duplicate as success: the email is on the list either way.
    if (error.code === PG_UNIQUE_VIOLATION) {
      return { ok: true };
    }
    return { ok: false, error: "Something went wrong. Try again in a moment." };
  }

  return { ok: true };
}
