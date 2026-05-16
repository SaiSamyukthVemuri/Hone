"use server";

import { createClient } from "@/lib/supabase/server";

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
