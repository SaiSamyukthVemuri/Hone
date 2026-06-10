"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
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

  const supabase = await createClient();
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
