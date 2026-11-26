"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  limitWaitlistSubmit,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit/public";
import { schedulePlatformLeadAlert } from "@/lib/platform-leads/alert-delivery";

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

  // LEAD-ALERT-01 (#826): the signup and its operator alert are saved
  // together by a service-role-only command (0213). An address already on the
  // list is the database's answer -- 'duplicate': nothing new is saved and
  // nobody is alerted -- and it still reads as success here, because the
  // address is on the list either way and the answer must not reveal which.
  // The command writes only the address; `source` keeps its column default.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("record_platform_early_access_signup", {
    p_email: normalized,
  });
  const saved = (Array.isArray(data) ? data[0] : null) as
    | { result: string; alert_id: string | null }
    | null;

  if (error || !saved) {
    return { ok: false, error: "Something went wrong. Try again in a moment." };
  }
  if (saved.result === "duplicate") {
    return { ok: true };
  }
  if (saved.result !== "recorded" || !saved.alert_id) {
    return { ok: false, error: "Something went wrong. Try again in a moment." };
  }

  // SAVED. The operator email goes out after this response; its outcome is
  // recorded on the alert and never reaches the person who signed up.
  const alertId = saved.alert_id;
  schedulePlatformLeadAlert(alertId);
  return { ok: true };
}
