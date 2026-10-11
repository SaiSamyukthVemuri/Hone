"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  limitDemoRequestSubmit,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit/public";
import { CONTACT_EMAIL } from "@/lib/marketing/content";
import { deliverPlatformLeadAlert } from "@/lib/platform-leads/alert-delivery";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PRACTICE_TYPES = ["electrolysis", "laser", "both"] as const;
const PRACTITIONER_COUNTS = ["1", "2-5", "5+"] as const;

type PracticeType = (typeof PRACTICE_TYPES)[number];
type PractitionerCount = (typeof PRACTITIONER_COUNTS)[number];

export type DemoPayload = {
  name: string;
  email: string;
  practice_name: string;
  location: string;
  practice_type: PracticeType | "";
  practitioner_count: PractitionerCount | "";
  current_tool: string;
  notes: string;
};

export type DemoResult = { ok: true } | { ok: false; error: string };

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function checkEnum<T extends string>(
  value: string,
  allowed: ReadonlyArray<T>,
): T | null {
  return (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : null;
}

export async function submitDemoRequest(
  payload: DemoPayload,
): Promise<DemoResult> {
  const name = payload.name.trim();
  if (!name) return { ok: false, error: "Enter your name." };

  const email = payload.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter an email address we can reply to." };
  }

  // Anonymous public form: rate-limit BEFORE the insert (PR #187).
  // 5/hour per IP + 2/day per normalized email; identifiers are hashed
  // inside the limiter and the refusal copy is the shared generic
  // message, so a 429 never reveals prior submissions.
  const rate = await limitDemoRequestSubmit({
    headers: await headers(),
    email,
  });
  if (!rate.allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  // LEAD-ALERT-01 (#826): the request and its operator alert are saved
  // together, in one transaction, by a service-role-only command (0213). The
  // columns and values are exactly what this form always saved. Every request
  // that gets this far is a new lead with its own single alert; the limiter
  // above is what bounds repeats.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("record_platform_demo_request", {
    p_name: name,
    p_email: email,
    p_practice_name: emptyToNull(payload.practice_name),
    p_location: emptyToNull(payload.location),
    p_practice_type: checkEnum(payload.practice_type, PRACTICE_TYPES),
    p_practitioner_count: checkEnum(
      payload.practitioner_count,
      PRACTITIONER_COUNTS,
    ),
    p_current_tool: emptyToNull(payload.current_tool),
    p_notes: emptyToNull(payload.notes),
  });
  const saved = (Array.isArray(data) ? data[0] : null) as
    | { result: string; alert_id: string | null }
    | null;

  if (error || saved?.result !== "recorded" || !saved.alert_id) {
    return {
      ok: false,
      error: `Your request didn't send. Try again in a moment, or email ${CONTACT_EMAIL}.`,
    };
  }

  // SAVED. The operator email goes out after this response, and whatever
  // happens to it is recorded on the alert: it cannot make this request look
  // unsaved, and nothing is ever sent to the person who asked.
  const alertId = saved.alert_id;
  after(() => deliverPlatformLeadAlert(alertId));
  return { ok: true };
}
